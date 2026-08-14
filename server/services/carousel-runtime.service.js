const fs = require("fs");
const path = require("path");

/** Create one carousel error with an HTTP status and stable code. */
function createCarouselError(message, statusCode, code, details) {
  const error = new Error(String(message || "轮播任务处理失败。"));
  error.statusCode = Number(statusCode || 500);
  error.code = String(code || "CAROUSEL_ERROR");
  error.details = details || null;
  return error;
}

/** Persist and coordinate one active carousel-generation task per Temu product. */
class CarouselRuntimeService {
  /** Store provider dependencies and recover interrupted task states. */
  constructor(options) {
    const settings = options || {};
    this.runtimeDirectory = path.join(settings.cacheDirectory, "runtime", "carousel");
    this.readConfig = settings.readConfig;
    this.getKimiEndpoint = settings.getKimiEndpoint;
    this.readImageSource = settings.readImageSource;
    this.writeLog = settings.writeLog;
    this.images = settings.images;
    fs.mkdirSync(this.runtimeDirectory, { recursive: true });
    this.recoverInterruptedTasks();
  }

  /** Return one filesystem-safe task identifier. */
  normalizeTaskId(taskId) {
    return String(taskId || "").replace(/[^a-zA-Z0-9-]/g, "");
  }

  /** Return the JSON path for one runtime task. */
  getTaskPath(taskId) {
    return path.join(this.runtimeDirectory, this.normalizeTaskId(taskId) + ".json");
  }

  /** Read one task without exposing malformed runtime data. */
  readTask(taskId) {
    const safeTaskId = this.normalizeTaskId(taskId);
    const filePath = this.getTaskPath(safeTaskId);
    if (!safeTaskId || !fs.existsSync(filePath)) {
      return null;
    }
    try {
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (error) {
      return null;
    }
  }

  /** Atomically persist one runtime task through a temporary file. */
  writeTask(task) {
    const target = task && typeof task === "object" ? task : null;
    if (!target || !target.id) {
      throw createCarouselError("轮播任务缺少 ID。", 500, "CAROUSEL_TASK_INVALID");
    }
    fs.mkdirSync(this.runtimeDirectory, { recursive: true });
    target.updated_at = new Date().toISOString();
    const filePath = this.getTaskPath(target.id);
    const temporaryPath = filePath + "." + process.pid + "." + Date.now() + ".tmp";
    fs.writeFileSync(temporaryPath, JSON.stringify(target, null, 2), "utf8");
    try {
      fs.renameSync(temporaryPath, filePath);
    } catch (error) {
      if (error.code !== "EPERM" && error.code !== "EEXIST") {
        throw error;
      }
      fs.copyFileSync(temporaryPath, filePath);
      fs.unlinkSync(temporaryPath);
    }
    return target;
  }

  /** Return all valid runtime tasks currently stored on disk. */
  readTasks() {
    const tasks = [];
    if (!fs.existsSync(this.runtimeDirectory)) {
      return tasks;
    }
    const names = fs.readdirSync(this.runtimeDirectory);
    for (let index = 0; index < names.length; index += 1) {
      if (!names[index].endsWith(".json")) {
        continue;
      }
      const task = this.readTask(names[index].slice(0, -5));
      if (task) {
        tasks.push(task);
      }
    }
    return tasks;
  }

  /** Find the single active task for one Temu product. */
  findTaskByTemuMainId(temuMainId) {
    const key = String(temuMainId || "");
    const tasks = this.readTasks();
    for (let index = 0; index < tasks.length; index += 1) {
      if (String(tasks[index].temu_main_id || "") === key) {
        return tasks[index];
      }
    }
    return null;
  }

  /** Compare two source-image sets without considering selection order. */
  hasSameSources(firstSources, secondSources) {
    const first = Array.isArray(firstSources) ? firstSources.slice() : [];
    const second = Array.isArray(secondSources) ? secondSources.slice() : [];
    first.sort();
    second.sort();
    return first.length === 2 && first[0] === second[0] && first[1] === second[1];
  }

  /** Create a new planning task while enforcing one active task per product. */
  createTask(input) {
    const source = input && typeof input === "object" ? input : {};
    if (Number(source.source_indices[0]) === Number(source.source_indices[1])) {
      throw createCarouselError("轮播任务必须选择两个不同图片位置。", 400, "CAROUSEL_SOURCE_INDEX_INVALID");
    }
    const existing = this.findTaskByTemuMainId(source.temu_main_id);
    if (existing) {
      if (this.hasSameSources(existing.source_image_urls, source.image_urls)) {
        return { task: existing, existing: true };
      }
      throw createCarouselError("该 Temu 商品已有未完成轮播任务。", 409, "CAROUSEL_TASK_EXISTS", { task: existing });
    }
    const taskId = "carousel-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
    const task = {
      id: taskId,
      temu_main_id: String(source.temu_main_id || ""),
      temu_platform_id: String(source.temu_platform_id || ""),
      source_image_urls: source.image_urls.slice(),
      source_indices: source.source_indices.slice(),
      gallery_snapshot: source.gallery_snapshot.slice(),
      count: Number(source.count),
      market_language: String(source.market_language || "美国 / English"),
      requirement: String(source.prompt || ""),
      mode: source.advanced ? "advanced" : "basic",
      reasoning_enabled: Boolean(source.reasoning_enabled),
      size: String(source.size || "1k"),
      status: "planning",
      estimated_tokens: 0,
      pages: [],
      error: "",
      error_code: "",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    this.writeTask(task);
    return { task: task, existing: false };
  }

  /** Parse a structured carousel plan and enforce the requested page count. */
  parsePlan(content, count) {
    let text = String(content || "").trim();
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
    let payload;
    try {
      payload = JSON.parse(text);
    } catch (error) {
      const firstBrace = text.indexOf("{");
      const lastBrace = text.lastIndexOf("}");
      if (firstBrace < 0 || lastBrace <= firstBrace) {
        throw createCarouselError("Kimi 未返回有效轮播 JSON。", 502, "CAROUSEL_PLAN_JSON_INVALID");
      }
      payload = JSON.parse(text.slice(firstBrace, lastBrace + 1));
    }
    const sourcePages = payload && Array.isArray(payload.pages)
      ? payload.pages
      : payload && Array.isArray(payload.prompts) ? payload.prompts : [];
    if (sourcePages.length !== Number(count)) {
      throw createCarouselError("Kimi 返回的分镜数量与请求数量不一致。", 502, "CAROUSEL_PLAN_COUNT_INVALID");
    }
    const pages = [];
    for (let index = 0; index < sourcePages.length; index += 1) {
      const item = sourcePages[index];
      const prompt = typeof item === "string" ? item : String(item && (item.image_prompt || item.prompt) || "").trim();
      const purpose = typeof item === "object" && item ? String(item.purpose || item.title || "") : "";
      if (!prompt) {
        throw createCarouselError("Kimi 返回的第 " + (index + 1) + " 条提示词为空。", 502, "CAROUSEL_PLAN_PROMPT_EMPTY");
      }
      if (!/[\u3400-\u9fff]/.test(purpose) || !/[\u3400-\u9fff]/.test(prompt)) {
        throw createCarouselError("Kimi 返回的第 " + (index + 1) + " 条分镜不是中文，请重新规划。", 502, "CAROUSEL_PLAN_LANGUAGE_INVALID");
      }
      pages.push({ index: index, purpose: purpose, prompt: prompt, status: "pending", image_url: "", selected: true, error: "", error_code: "" });
    }
    return pages;
  }

  /** Consume one OpenAI-compatible stream and report safe token estimates. */
  async readKimiStream(response, task, reportProgress) {
    if (!response.body) {
      throw createCarouselError("Kimi 未返回可读取的流。", 502, "KIMI_STREAM_UNAVAILABLE");
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pendingText = "";
    let content = "";
    let reasoningCharacters = 0;
    let finished = false;
    while (!finished) {
      const readResult = await reader.read();
      finished = readResult.done;
      pendingText += decoder.decode(readResult.value || new Uint8Array(), { stream: !finished });
      const lines = pendingText.split(/\r?\n/);
      pendingText = lines.pop() || "";
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index].trim();
        if (!line.startsWith("data:") || line.slice(5).trim() === "[DONE]") {
          continue;
        }
        let payload;
        try {
          payload = JSON.parse(line.slice(5).trim());
        } catch (error) {
          continue;
        }
        const choice = payload.choices && payload.choices[0] ? payload.choices[0] : {};
        const delta = choice.delta && typeof choice.delta === "object" ? choice.delta : {};
        if (typeof delta.reasoning_content === "string") {
          reasoningCharacters += delta.reasoning_content.length;
        }
        if (typeof delta.content === "string") {
          content += delta.content;
        }
        const estimatedTokens = Math.max(1, Math.ceil((reasoningCharacters + content.length) / 3));
        if (estimatedTokens >= Number(task.estimated_tokens || 0) + 32) {
          task.estimated_tokens = estimatedTokens;
          this.writeTask(task);
          reportProgress(task);
        }
      }
    }
    if (!content) {
      throw createCarouselError("Kimi 流式响应没有最终内容。", 502, "KIMI_STREAM_EMPTY");
    }
    return content;
  }

  /** Ask Kimi in the selected thinking mode for a multi-page carousel plan. */
  async planTask(input, requestId, reportProgress) {
    const created = this.createTask(input);
    if (created.existing) {
      reportProgress(created.task, "complete");
      return created.task;
    }
    const task = created.task;
    try {
      const config = this.readConfig() || {};
      const kimi = config.kimi && typeof config.kimi === "object" ? config.kimi : {};
      const endpoint = this.getKimiEndpoint(config);
      const systemPrompt = String(kimi.carousel_system_prompt || "").trim();
      const taskPrompt = String(kimi.carousel_prompt || "").trim();
      if (!endpoint || !kimi.apikey || !systemPrompt || !taskPrompt) {
        throw createCarouselError("server/config.json 未配置轮播模式 Kimi 提示词。", 500, "CAROUSEL_KIMI_CONFIG_MISSING");
      }
      const content = [{ type: "text", text: taskPrompt + "\n\n生成数量：" + task.count + "\n市场语言：" + task.market_language + "\n用户补充要求：" + task.requirement }];
      for (let index = 0; index < task.source_image_urls.length; index += 1) {
        const image = await this.readImageSource(task.source_image_urls[index], requestId);
        content.push({ type: "image_url", image_url: { url: "data:" + image.mimeType + ";base64," + image.buffer.toString("base64") } });
      }
      const reasoningEnabled = Boolean(task.reasoning_enabled);
      const requestPayload = {
        model: String(kimi.model || "kimi-k2.6"),
        messages: [{ role: "system", content: systemPrompt }, { role: "user", content: content }],
        thinking: { type: reasoningEnabled ? "enabled" : "disabled" },
        temperature: reasoningEnabled ? 1 : 0.6,
        response_format: { type: "json_object" },
        stream: true
      };
      this.writeLog("OUTBOUND", "Kimi carousel planning POST " + endpoint, requestPayload, requestId);
      const controller = new AbortController();
      const timeoutHandle = setTimeout(function abortCarouselPlanningRequest() {
        controller.abort();
      }, 300000);
      let response;
      try {
        response = await fetch(endpoint, {
          method: "POST",
          headers: { "Authorization": "Bearer " + String(kimi.apikey), "Content-Type": "application/json" },
          body: JSON.stringify(requestPayload),
          signal: controller.signal
        });
      } catch (error) {
        if (error && error.name === "AbortError") {
          throw createCarouselError("Kimi 轮播规划超过五分钟。", 504, "KIMI_TIMEOUT");
        }
        throw createCarouselError("Kimi 网络请求失败：" + (error.message || "未知错误。"), 502, "KIMI_NETWORK_ERROR");
      } finally {
        clearTimeout(timeoutHandle);
      }
      if (!response.ok) {
        const providerText = await response.text();
        throw createCarouselError(providerText.slice(0, 300) || "Kimi 轮播规划失败。", response.status, "KIMI_HTTP_" + response.status);
      }
      const responseContent = await this.readKimiStream(response, task, reportProgress);
      if (!this.readTask(task.id)) {
        throw createCarouselError("轮播任务已被清理。", 409, "CAROUSEL_TASK_CANCELLED");
      }
      task.pages = this.parsePlan(responseContent, task.count);
      task.status = task.mode === "advanced" ? "awaiting_review" : "ready";
      task.error = "";
      task.error_code = "";
      this.writeTask(task);
      reportProgress(task, "complete");
      return task;
    } catch (error) {
      if (this.readTask(task.id)) {
        task.status = "failed";
        task.error = String(error.message || "轮播规划失败。");
        task.error_code = String(error.code || "CAROUSEL_PLAN_FAILED");
        this.writeTask(task);
      }
      throw error;
    }
  }

  /** Replace the editable advanced-mode plan before generation starts. */
  updateTaskPlan(taskId, input) {
    const task = this.readTask(taskId);
    if (!task) {
      throw createCarouselError("轮播任务不存在。", 404, "CAROUSEL_TASK_NOT_FOUND");
    }
    if (task.status !== "awaiting_review") {
      throw createCarouselError("当前任务不能再修改分镜。", 409, "CAROUSEL_TASK_NOT_EDITABLE");
    }
    const sourcePages = Array.isArray(input.pages) ? input.pages : [];
    if (!sourcePages.length || sourcePages.length > 10) {
      throw createCarouselError("分镜数量必须为 1 到 10。", 400, "CAROUSEL_PAGE_COUNT_INVALID");
    }
    task.pages = [];
    for (let index = 0; index < sourcePages.length; index += 1) {
      const prompt = String(sourcePages[index] && sourcePages[index].prompt || "").trim();
      if (!prompt) {
        throw createCarouselError("第 " + (index + 1) + " 条提示词不能为空。", 400, "CAROUSEL_PROMPT_EMPTY");
      }
      task.pages.push({ index: index, purpose: String(sourcePages[index].purpose || ""), prompt: prompt, status: "pending", image_url: "", selected: true, error: "", error_code: "" });
    }
    task.count = task.pages.length;
    task.status = "ready";
    return this.writeTask(task);
  }

  /** Update one editable carousel page while other pages continue generating. */
  updateTaskPage(taskId, pageIndex, input) {
    const task = this.readTask(taskId);
    const index = Number(pageIndex);
    if (!task || !task.pages[index]) {
      throw createCarouselError("轮播分镜不存在。", 404, "CAROUSEL_PAGE_NOT_FOUND");
    }
    if (task.pages[index].status === "generating") {
      throw createCarouselError("当前分镜正在生成，暂时不能修改。", 409, "CAROUSEL_PAGE_GENERATING");
    }
    task.pages[index].purpose = String(input.purpose || "").trim();
    task.pages[index].prompt = String(input.prompt || "").trim();
    task.pages[index].error = "";
    task.pages[index].error_code = "";
    return this.writeTask(task);
  }

  /** Mark one page as running before its shared Fusion request starts. */
  markPageGenerating(taskId, pageIndex) {
    const task = this.readTask(taskId);
    const index = Number(pageIndex);
    if (!task || !task.pages[index]) {
      throw createCarouselError("轮播分镜不存在。", 404, "CAROUSEL_PAGE_NOT_FOUND");
    }
    task.status = "generating";
    task.pages[index].status = "generating";
    task.pages[index].error = "";
    task.pages[index].error_code = "";
    return this.writeTask(task);
  }

  /** Persist one successful Fusion page result. */
  markPageSucceeded(taskId, pageIndex, imageUrl) {
    const task = this.readTask(taskId);
    const index = Number(pageIndex);
    if (!task || !task.pages[index]) {
      return null;
    }
    if (task.pages[index].image_url && task.pages[index].image_url !== imageUrl) {
      this.deleteGeneratedImage(task.pages[index].image_url);
    }
    task.pages[index].status = "succeeded";
    task.pages[index].image_url = String(imageUrl || "");
    task.pages[index].selected = true;
    this.refreshGenerationStatus(task);
    return this.writeTask(task);
  }

  /** Persist one failed Fusion page result and its stable error code. */
  markPageFailed(taskId, pageIndex, error) {
    const task = this.readTask(taskId);
    const index = Number(pageIndex);
    if (!task || !task.pages[index]) {
      return null;
    }
    task.pages[index].status = "failed";
    task.pages[index].error = String(error && error.message || "图片生成失败。");
    task.pages[index].error_code = String(error && error.code || "IMAGE_GENERATION_FAILED");
    this.refreshGenerationStatus(task);
    return this.writeTask(task);
  }

  /** Derive the overall generation state from every page. */
  refreshGenerationStatus(task) {
    let pending = 0;
    let running = 0;
    for (let index = 0; index < task.pages.length; index += 1) {
      if (task.pages[index].status === "pending") {
        pending += 1;
      }
      if (task.pages[index].status === "generating") {
        running += 1;
      }
    }
    task.status = pending || running ? "generating" : "generated";
  }

  /** Delete one local generated image owned by an abandoned runtime task. */
  deleteGeneratedImage(imageUrl) {
    const value = String(imageUrl || "");
    const prefix = this.images && this.images.publicPrefix ? this.images.publicPrefix : "/api/v1/cache/image";
    if (value.indexOf(prefix + "/transfer/generated/") !== 0) {
      return;
    }
    const relativePath = value.slice(prefix.length).replace(/^[/\\]+/, "");
    const filePath = path.resolve(this.images.imageDirectory, relativePath);
    const generatedDirectory = path.resolve(this.images.imageDirectory, "transfer", "generated");
    if (filePath.indexOf(generatedDirectory + path.sep) === 0 && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }

  /** Delete one task and optionally remove its un-applied generated images. */
  deleteTask(taskId, removeImages) {
    const task = this.readTask(taskId);
    if (!task) {
      return null;
    }
    if (removeImages) {
      for (let index = 0; index < task.pages.length; index += 1) {
        this.deleteGeneratedImage(task.pages[index].image_url);
      }
    }
    const filePath = this.getTaskPath(task.id);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    return task;
  }

  /** Mark unfinished work as interrupted after a server restart. */
  recoverInterruptedTasks() {
    const tasks = this.readTasks();
    for (let taskIndex = 0; taskIndex < tasks.length; taskIndex += 1) {
      const task = tasks[taskIndex];
      if (task.status === "planning" || task.status === "generating") {
        task.status = "interrupted";
        task.error = "服务器已重启，请重新规划或重试失败分镜。";
        task.error_code = "CAROUSEL_TASK_INTERRUPTED";
        for (let pageIndex = 0; pageIndex < task.pages.length; pageIndex += 1) {
          if (task.pages[pageIndex].status === "generating") {
            task.pages[pageIndex].status = "failed";
            task.pages[pageIndex].error = task.error;
            task.pages[pageIndex].error_code = task.error_code;
          }
        }
        this.writeTask(task);
      }
    }
  }
}

module.exports = { CarouselRuntimeService: CarouselRuntimeService, createCarouselError: createCarouselError };
