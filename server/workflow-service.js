const fs = require("fs");
const path = require("path");

/** Keep one synchronous image generation request bounded to five minutes. */
const WORKFLOW_GENERATION_TIMEOUT_MS = 300000;

/** Create one workflow error carrying its HTTP status and stable error code. */
function createWorkflowError(message, statusCode, code) {
  const error = new Error(String(message || "智能组货请求失败。"));
  error.statusCode = Number(statusCode || 500);
  error.code = String(code || "WORKFLOW_ERROR");
  return error;
}

/** Read one generated image from common OpenAI-compatible response fields. */
function readWorkflowGeneratedImage(payload) {
  if (!payload || typeof payload !== "object") {
    return "";
  }
  const candidates = Array.isArray(payload.data) ? payload.data : [];
  for (let index = 0; index < candidates.length; index += 1) {
    const item = candidates[index] || {};
    const encoded = item.b64_json || item.base64 || item.data;
    if (encoded && typeof encoded === "string") {
      return "data:image/png;base64," + encoded.replace(/[\r\n\s]/g, "");
    }
    const imageUrl = item.url || item.image_url || item.imageUrl;
    if (imageUrl) {
      return String(imageUrl);
    }
  }
  return "";
}

/** Extract one concise upstream provider error message. */
function readWorkflowProviderError(payload, fallbackText) {
  if (payload && payload.error) {
    if (typeof payload.error === "string") {
      return payload.error;
    }
    if (payload.error.message) {
      return String(payload.error.message);
    }
  }
  const text = String(fallbackText || "").trim();
  return text ? text.slice(0, 300) : "上游服务请求失败。";
}

/** Preserve one valid upstream HTTP error status for the workflow API. */
function normalizeWorkflowStatusCode(statusCode) {
  const value = Number(statusCode || 0);
  return value >= 400 && value <= 599 ? value : 502;
}

/** Read one stable Kimi error code from an OpenAI-compatible payload. */
function readWorkflowProviderCode(payload, fallback) {
  const source = payload && typeof payload === "object" ? payload : {};
  const providerError = source.error && typeof source.error === "object" ? source.error : {};
  return String(providerError.code || source.code || providerError.type || fallback || "UPSTREAM_ERROR");
}

/** Parse exactly four structured product suggestions from a Kimi response. */
function parseWorkflowPromptContent(content) {
  let text = String(content || "").trim();
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    const firstBrace = text.indexOf("{");
    const lastBrace = text.lastIndexOf("}");
    if (firstBrace < 0 || lastBrace <= firstBrace) {
      throw createWorkflowError("Kimi 未返回有效的四组提示词 JSON。", 502);
    }
    payload = JSON.parse(text.slice(firstBrace, lastBrace + 1));
  }
  const sourcePrompts = payload && Array.isArray(payload.products)
    ? payload.products
    : payload && Array.isArray(payload.prompts) ? payload.prompts : [];
  if (sourcePrompts.length !== 4) {
    throw createWorkflowError("Kimi 必须返回四个组货商品。", 502);
  }
  const prompts = [];
  for (let index = 0; index < sourcePrompts.length; index += 1) {
    const source = sourcePrompts[index] && typeof sourcePrompts[index] === "object" ? sourcePrompts[index] : {};
    const productIntro = String(source.product_intro || source.product_name || source.product || "").trim();
    const prompt = String(source.image_prompt || source.prompt || "").trim();
    if (!productIntro) {
      throw createWorkflowError("Kimi 返回的第 " + (index + 1) + " 个商品简介为空。", 502);
    }
    if (!prompt) {
      throw createWorkflowError("Kimi 返回的第 " + (index + 1) + " 个生图提示词为空。", 502);
    }
    if (!/[\u3400-\u9fff]/.test(prompt)) {
      throw createWorkflowError("Kimi 返回的第 " + (index + 1) + " 个生图提示词不是中文，请重新生成。", 502, "WORKFLOW_PROMPT_LANGUAGE_INVALID");
    }
    prompts.push({
      relation: String(source.relation || "组货方向 " + (index + 1)).trim(),
      product_name: String(source.product_name || productIntro).trim(),
      product_intro: productIntro,
      prompt: prompt,
      image_url: "",
      status: "prompt_ready",
      error: "",
      error_code: "",
      error_status: 0,
      search_url: "",
      search_status: "",
      search_error: ""
    });
  }
  return prompts;
}

/** Persistent intelligent-packing domain service used by the local HTTP server. */
class WorkflowService {
  /** Store domain dependencies without coupling the module to HTTP routing. */
  constructor(options) {
    const settings = options || {};
    this.filePath = path.join(settings.cacheDirectory, "workflows.json");
    this.readConfig = settings.readConfig;
    this.getKimiEndpoint = settings.getKimiEndpoint;
    this.compactValue = settings.compactValue;
    this.readImageSource = settings.readImageSource;
    this.cacheGeneratedImage = settings.cacheGeneratedImage;
    this.imageTaskQueue = settings.imageTaskQueue;
    this.writeLog = settings.writeLog;
    this.formatTime = settings.formatTime;
    this.generationQueue = [];
    this.generationQueueActive = false;
    this.recoverInterruptedTasks();
  }

  /** Return the default persistent workflow payload. */
  createEmptyPayload() {
    return {
      version: "1.0",
      updated_at: "",
      active_temu_main_id: "",
      tasks: {}
    };
  }

  /** Read all intelligent-packing tasks from disk. */
  readPayload() {
    if (!fs.existsSync(this.filePath)) {
      return this.createEmptyPayload();
    }
    try {
      const content = fs.readFileSync(this.filePath, "utf8");
      const payload = JSON.parse(content);
      if (!payload || typeof payload !== "object") {
        return this.createEmptyPayload();
      }
      if (!payload.tasks || typeof payload.tasks !== "object") {
        payload.tasks = {};
      }
      return payload;
    } catch (error) {
      return this.createEmptyPayload();
    }
  }

  /** Persist all tasks for direct HTTP responses and later GET requests. */
  writePayload(payload, requestId) {
    const state = payload && typeof payload === "object" ? payload : this.createEmptyPayload();
    state.updated_at = this.formatTime(new Date());
    fs.writeFileSync(this.filePath, JSON.stringify(state, null, 2), "utf8");
    return state;
  }

  /** Return or create one task for a Temu main identifier. */
  getOrCreateTask(payload, temuMainId) {
    const state = payload && typeof payload === "object" ? payload : this.createEmptyPayload();
    const key = String(temuMainId || "").trim();
    if (!state.tasks || typeof state.tasks !== "object") {
      state.tasks = {};
    }
    if (!state.tasks[key] || typeof state.tasks[key] !== "object") {
      state.tasks[key] = {
        temu_main_id: key,
        status: "idle",
        selected_image_url: "",
        custom_prompt: "",
        prompts: [],
        selected_result_index: -1,
        search_url: "",
        search_offers: [],
        bound_ali_main_id: "",
        bound_ali_platform_id: "",
        error: ""
      };
    }
    return state.tasks[key];
  }

  /** Return the public active-task payload used by the browser extension. */
  getActivePayload() {
    const workflow = this.readPayload();
    const activeTemuMainId = String(workflow.active_temu_main_id || "");
    const activeTask = activeTemuMainId && workflow.tasks ? workflow.tasks[activeTemuMainId] : null;
    return {
      ok: true,
      active_temu_main_id: activeTemuMainId,
      task: activeTask
    };
  }

  /** Persist the Temu product that the 1688 extension should keep selected. */
  setActiveTemuMainId(temuMainId, requestId) {
    const key = String(temuMainId || "").trim();
    if (!key) {
      return;
    }
    const workflow = this.readPayload();
    workflow.active_temu_main_id = key;
    this.writePayload(workflow, requestId);
  }

  /** Ask Kimi for four white-background products related to one Temu item. */
  async generatePrompts(input, requestId) {
    const temuMainId = String(input.temu_main_id || "").trim();
    const imageUrl = String(input.image_url || "").trim();
    const customPrompt = String(input.custom_prompt || "").trim();
    const product = input.product && typeof input.product === "object" ? input.product : {};
    if (!temuMainId || !imageUrl || !customPrompt) {
      throw createWorkflowError("请选择 Temu 商品及分析主图。", 400);
    }
    const config = this.readConfig();
    const kimi = config && config.kimi && typeof config.kimi === "object" ? config.kimi : {};
    const endpoint = this.getKimiEndpoint(config);
    const systemPrompt = String(kimi.workflow_system_prompt || "").trim();
    if (!endpoint || !kimi.apikey || !systemPrompt) {
      throw createWorkflowError("server/config.json 未配置智能组货 Kimi 提示词。", 500);
    }
    const sourceImage = await this.readImageSource(imageUrl, requestId);
    const dataUrl = "data:" + sourceImage.mimeType + ";base64," + sourceImage.buffer.toString("base64");
    const productText = customPrompt + "\n\nTemu 商品信息：\n" + JSON.stringify(this.compactValue(product, 0), null, 2);
    const providerRequestPayload = {
      model: String(kimi.model || "kimi-k2.6"),
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: dataUrl } },
            { type: "text", text: productText }
          ]
        }
      ],
      thinking: { type: "disabled" },
      temperature: 0.6,
      response_format: { type: "json_object" }
    };
    this.writeLog("OUTBOUND", "Kimi workflow POST " + endpoint, providerRequestPayload, requestId);
    const timeoutMs = Math.max(10000, Math.min(Number(kimi.timeout_ms || 60000), 180000));
    const controller = new AbortController();
    const timeoutHandle = setTimeout(function abortWorkflowKimiRequest() {
      controller.abort();
    }, timeoutMs);
    let providerResponse;
    let providerText;
    try {
      providerResponse = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + String(kimi.apikey),
          "Content-Type": "application/json"
        },
        body: JSON.stringify(providerRequestPayload),
        signal: controller.signal
      });
      providerText = await providerResponse.text();
    } catch (error) {
      if (error && error.name === "AbortError") {
        throw createWorkflowError("Kimi 请求超时，请稍后重试。", 504, "KIMI_TIMEOUT");
      }
      throw createWorkflowError("Kimi 网络请求失败：" + (error.message || "未知错误。"), 502, "KIMI_NETWORK_ERROR");
    } finally {
      clearTimeout(timeoutHandle);
    }
    let providerPayload = {};
    try {
      providerPayload = JSON.parse(providerText || "{}");
    } catch (error) {
      providerPayload = {};
    }
    this.writeLog("UPSTREAM", "Kimi workflow response " + providerResponse.status, Object.keys(providerPayload).length ? providerPayload : providerText, requestId);
    if (!providerResponse.ok) {
      const statusCode = normalizeWorkflowStatusCode(providerResponse.status);
      const errorCode = readWorkflowProviderCode(providerPayload, "KIMI_HTTP_" + statusCode);
      throw createWorkflowError(readWorkflowProviderError(providerPayload, providerText), statusCode, errorCode);
    }
    const choices = Array.isArray(providerPayload.choices) ? providerPayload.choices : [];
    const message = choices.length && choices[0].message ? choices[0].message : {};
    const prompts = parseWorkflowPromptContent(message.content);
    const workflow = this.readPayload();
    const task = this.getOrCreateTask(workflow, temuMainId);
    task.status = "prompts_ready";
    task.selected_image_url = imageUrl;
    task.custom_prompt = customPrompt;
    task.prompts = prompts;
    task.selected_result_index = -1;
    task.search_url = "";
    task.search_offers = [];
    task.error = "";
    this.writePayload(workflow, requestId);
    return { ok: true, task: task };
  }

  /** Execute one candidate image request through the configured BeeAPI endpoint. */
  async executeGeneratedImageRequest(config, prompt, requestId) {
    const baseurl = String(config && config.baseurl || "").trim();
    const endpointPath = String(config && config.generation_endpoint || "").trim();
    if (!baseurl || !endpointPath) {
      throw createWorkflowError("server/config.json 未配置 BeeAPI 生图 endpoint。", 500);
    }
    const endpoint = new URL(endpointPath, baseurl).toString();
    const providerRequestPayload = {
      model: String(config.model || "gpt-image-2"),
      prompt: String(prompt || "").trim(),
      size: String(config.generation_size || "1024x1024"),
      n: 1
    };
    this.writeLog("OUTBOUND", "BeeAPI generation POST " + endpoint, providerRequestPayload, requestId);
    const controller = new AbortController();
    /** Abort one BeeAPI generation request after five minutes. */
    const timeoutHandle = setTimeout(function abortWorkflowGenerationRequest() {
      controller.abort();
    }, WORKFLOW_GENERATION_TIMEOUT_MS);
    let providerResponse;
    let providerText;
    try {
      providerResponse = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + String(config.apikey),
          "Content-Type": "application/json"
        },
        body: JSON.stringify(providerRequestPayload),
        signal: controller.signal
      });
      providerText = await providerResponse.text();
    } catch (error) {
      if (error && error.name === "AbortError") {
        throw createWorkflowError("BeeAPI 生图请求超过五分钟。", 504, "BEEAPI_TIMEOUT");
      }
      throw createWorkflowError("BeeAPI 网络请求失败：" + (error.message || "未知错误。"), 502, "BEEAPI_NETWORK_ERROR");
    } finally {
      clearTimeout(timeoutHandle);
    }
    let providerPayload = {};
    try {
      providerPayload = JSON.parse(providerText || "{}");
    } catch (error) {
      providerPayload = {};
    }
    this.writeLog("UPSTREAM", "BeeAPI generation response " + providerResponse.status, Object.keys(providerPayload).length ? providerPayload : providerText, requestId);
    if (!providerResponse.ok) {
      const upstreamMessage = providerPayload && providerPayload.error
        ? readWorkflowProviderError(providerPayload, providerText)
        : "BeeAPI 上游返回 HTTP " + providerResponse.status + "。";
      const statusCode = normalizeWorkflowStatusCode(providerResponse.status);
      const errorCode = readWorkflowProviderCode(providerPayload, "BEEAPI_HTTP_" + statusCode);
      throw createWorkflowError(upstreamMessage, statusCode, errorCode);
    }
    const imageUrl = readWorkflowGeneratedImage(providerPayload);
    if (!imageUrl) {
      throw createWorkflowError("BeeAPI 已响应，但没有找到生成图片。", 502, "BEEAPI_EMPTY_IMAGE");
    }
    if (typeof this.cacheGeneratedImage === "function") {
      return this.cacheGeneratedImage(imageUrl);
    }
    return imageUrl;
  }

  /** Queue one generation provider request behind the shared edits limit. */
  async generateOneImage(config, prompt, requestId) {
    if (this.imageTaskQueue && typeof this.imageTaskQueue.run === "function") {
      const service = this;
      return this.imageTaskQueue.run(function executeQueuedImageGeneration() {
        return service.executeGeneratedImageRequest(config, prompt, requestId);
      }, { type: "gen", request_id: requestId });
    }
    return this.executeGeneratedImageRequest(config, prompt, requestId);
  }

  /** Reset generation markers left behind when the server stopped mid-task. */
  recoverInterruptedTasks() {
    const workflow = this.readPayload();
    let changed = false;
    const tasks = workflow && workflow.tasks && typeof workflow.tasks === "object" ? workflow.tasks : {};
    const taskKeys = Object.keys(tasks);
    for (let taskIndex = 0; taskIndex < taskKeys.length; taskIndex += 1) {
      const task = tasks[taskKeys[taskIndex]];
      if (!task || task.status !== "generating") {
        continue;
      }
      let hasGeneratedImage = false;
      const prompts = Array.isArray(task.prompts) ? task.prompts : [];
      for (let promptIndex = 0; promptIndex < prompts.length; promptIndex += 1) {
        const prompt = prompts[promptIndex];
        if (!prompt || typeof prompt !== "object") {
          continue;
        }
        if (prompt.image_url) {
          hasGeneratedImage = true;
        }
        if (prompt.status === "queued" || prompt.status === "generating") {
          prompt.status = "prompt_ready";
          prompt.error = "";
        }
      }
      task.status = hasGeneratedImage ? "images_ready" : "prompts_ready";
      task.error = "上次后台生图在服务器重启时中断，请重新提交。";
      changed = true;
    }
    if (changed) {
      this.writePayload(workflow, "");
    }
  }

  /** Queue one generation job and resolve it only after the HTTP result is ready. */
  scheduleImageGeneration(temuMainId, requestedIndex, requestId, promptSnapshot) {
    const service = this;
    /** Store one queued generation job and connect it to the waiting HTTP response. */
    return new Promise(function createGenerationJobPromise(resolve, reject) {
      service.generationQueue.push({
        temu_main_id: String(temuMainId || ""),
        requested_index: requestedIndex,
        request_id: String(requestId || ""),
        prompts: Array.isArray(promptSnapshot) ? promptSnapshot : [],
        resolve: resolve,
        reject: reject
      });
      service.pumpGenerationQueue();
    });
  }

  /** Return whether one Temu item still has a generation job waiting in the queue. */
  hasPendingGeneration(temuMainId) {
    const key = String(temuMainId || "");
    for (let index = 0; index < this.generationQueue.length; index += 1) {
      if (String(this.generationQueue[index].temu_main_id || "") === key) {
        return true;
      }
    }
    return false;
  }

  /** Start the next workflow generation job and settle its waiting HTTP request. */
  pumpGenerationQueue() {
    if (this.generationQueueActive || !this.generationQueue.length) {
      return;
    }
    this.generationQueueActive = true;
    const service = this;
    const job = this.generationQueue.shift();
    /** Run one queued workflow job on the next event-loop turn. */
    function runQueuedGenerationJob() {
      service.generateImagesAndPersist(
        job.temu_main_id,
        job.requested_index,
        job.request_id,
        job.prompts
      ).then(function finishQueuedGenerationJob(result) {
        job.resolve(result);
        service.generationQueueActive = false;
        service.pumpGenerationQueue();
      }, function handleQueuedGenerationJobError(error) {
        job.reject(error);
        service.generationQueueActive = false;
        service.pumpGenerationQueue();
      });
    }
    setImmediate(runQueuedGenerationJob);
  }

  /** Persist one candidate image state without overwriting other candidates. */
  persistGeneratedImageState(temuMainId, index, updates, requestId) {
    const workflow = this.readPayload();
    const task = workflow.tasks && workflow.tasks[temuMainId];
    const prompts = task && Array.isArray(task.prompts) ? task.prompts : [];
    const item = prompts[index];
    if (!item) {
      return null;
    }
    const patch = updates && typeof updates === "object" ? updates : {};
    const keys = Object.keys(patch);
    for (let keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
      item[keys[keyIndex]] = patch[keys[keyIndex]];
    }
    this.writePayload(workflow, requestId);
    return item;
  }

  /** Generate one candidate image and persist its success or failure state. */
  generateOneWorkflowCandidate(config, temuMainId, index, prompt, requestId) {
    const service = this;
    return this.generateOneImage(config, prompt, requestId).then(
      /** Persist one successful candidate response. */
      function handleWorkflowCandidateSuccess(imageUrl) {
        service.persistGeneratedImageState(temuMainId, index, {
          image_url: String(imageUrl || ""),
          status: "generated",
          error: "",
          error_code: "",
          error_status: 0
        }, requestId);
        return { generated: true, error: "", error_code: "", error_status: 0 };
      },
      /** Persist one failed candidate response. */
      function handleWorkflowCandidateFailure(error) {
        const message = error && error.message ? error.message : "生图失败。";
        const code = String(error && error.code || "WORKFLOW_GENERATION_ERROR");
        const statusCode = Number(error && error.statusCode || 500);
        service.persistGeneratedImageState(temuMainId, index, {
          status: "error",
          error: message,
          error_code: code,
          error_status: statusCode
        }, requestId);
        return { generated: false, error: message, error_code: code, error_status: statusCode };
      }
    );
  }

  /** Generate candidate images and return the final task for the waiting HTTP request. */
  async generateImagesAndPersist(temuMainId, requestedIndex, requestId, promptSnapshot) {
    try {
      const config = this.readConfig();
      const requestedPrompts = Array.isArray(promptSnapshot) ? promptSnapshot : [];
      const workflow = this.readPayload();
      const task = workflow.tasks && workflow.tasks[temuMainId];
      if (!task || !Array.isArray(task.prompts)) {
        return { task: null, results: [] };
      }
      const requestedIndexes = [];
      for (let index = 0; index < task.prompts.length; index += 1) {
        if (requestedIndex < 0 || index === requestedIndex) {
          requestedIndexes.push(index);
        }
      }
      const generationJobs = [];
      for (let requestIndex = 0; requestIndex < requestedIndexes.length; requestIndex += 1) {
        const index = requestedIndexes[requestIndex];
        const currentWorkflow = this.readPayload();
        const currentTask = currentWorkflow.tasks && currentWorkflow.tasks[temuMainId];
        const item = currentTask && currentTask.prompts ? currentTask.prompts[index] : null;
        if (!item) {
          continue;
        }
        if (requestedPrompts[index] !== undefined) {
          item.prompt = String(requestedPrompts[index] || "").trim();
        }
        item.status = "generating";
        item.error = "";
        item.error_code = "";
        item.error_status = 0;
        item.search_url = "";
        item.search_status = "";
        item.search_error = "";
        this.writePayload(currentWorkflow, requestId);
        generationJobs.push(this.generateOneWorkflowCandidate(config, temuMainId, index, item.prompt, requestId));
      }
      const results = await Promise.all(generationJobs);
      let failedCount = 0;
      let lastError = "";
      let lastErrorCode = "";
      let lastErrorStatus = 0;
      for (let resultIndex = 0; resultIndex < results.length; resultIndex += 1) {
        if (!results[resultIndex].generated) {
          failedCount += 1;
          lastError = results[resultIndex].error || lastError;
          lastErrorCode = results[resultIndex].error_code || lastErrorCode;
          lastErrorStatus = results[resultIndex].error_status || lastErrorStatus;
        }
      }
      const finalWorkflow = this.readPayload();
      const finalTask = finalWorkflow.tasks && finalWorkflow.tasks[temuMainId];
      if (!finalTask) {
        return;
      }
      let hasGeneratedImage = false;
      for (let index = 0; index < finalTask.prompts.length; index += 1) {
        if (finalTask.prompts[index] && finalTask.prompts[index].image_url) {
          hasGeneratedImage = true;
          break;
        }
      }
      if (this.hasPendingGeneration(temuMainId)) {
        finalTask.status = "generating";
        finalTask.error = "";
        finalTask.error_code = "";
        finalTask.error_status = 0;
      } else {
        finalTask.status = hasGeneratedImage ? "images_ready" : "generation_error";
        finalTask.error = hasGeneratedImage ? "" : lastError || (failedCount ? "图片生成失败。" : "四张图片均生成失败。");
        finalTask.error_code = hasGeneratedImage ? "" : lastErrorCode || "WORKFLOW_GENERATION_ERROR";
        finalTask.error_status = hasGeneratedImage ? 0 : lastErrorStatus || 500;
      }
      this.writePayload(finalWorkflow, requestId);
      return { task: finalTask, results: results };
    } catch (error) {
      const failedWorkflow = this.readPayload();
      const failedTask = failedWorkflow.tasks && failedWorkflow.tasks[temuMainId];
      if (failedTask && !this.hasPendingGeneration(temuMainId)) {
        failedTask.status = "generation_error";
        failedTask.error = error.message || "后台生图失败。";
        failedTask.error_code = String(error.code || "WORKFLOW_GENERATION_ERROR");
        failedTask.error_status = Number(error.statusCode || 500);
        this.writePayload(failedWorkflow, requestId);
        return { task: failedTask, results: [] };
      }
      throw error;
    }
  }

  /** Generate all four images or regenerate one selected candidate. */
  async generateImages(input, requestId) {
    const temuMainId = String(input.temu_main_id || "").trim();
    const workflow = this.readPayload();
    const task = workflow.tasks && workflow.tasks[temuMainId];
    if (!temuMainId || !task || !Array.isArray(task.prompts) || task.prompts.length !== 4) {
      throw createWorkflowError("请先为当前 Temu 商品生成四组提示词。", 400);
    }
    if (Array.isArray(input.prompts) && input.prompts.length === 4) {
      for (let promptIndex = 0; promptIndex < task.prompts.length; promptIndex += 1) {
        task.prompts[promptIndex].prompt = String(input.prompts[promptIndex] || "").trim();
      }
    }
    const requestedIndex = input.index === undefined || input.index === null ? -1 : Number(input.index);
    if (!Number.isInteger(requestedIndex) || requestedIndex < -1 || requestedIndex >= task.prompts.length) {
      throw createWorkflowError("生图索引无效。", 400);
    }
    const config = this.readConfig();
    if (!config || !config.apikey || !config.generation_endpoint) {
      throw createWorkflowError("server/config.json 未配置完整的 BeeAPI 生图接口。", 500);
    }
    for (let index = 0; index < task.prompts.length; index += 1) {
      if (requestedIndex >= 0 && index !== requestedIndex) {
        continue;
      }
      if (!String(task.prompts[index].prompt || "").trim()) {
        throw createWorkflowError("第 " + (index + 1) + " 组提示词不能为空。", 400);
      }
    }
    const promptSnapshot = [];
    task.status = "generating";
    task.error = "";
    task.error_code = "";
    task.error_status = 0;
    for (let index = 0; index < task.prompts.length; index += 1) {
      if (requestedIndex >= 0 && index !== requestedIndex) {
        continue;
      }
      task.prompts[index].status = "queued";
      task.prompts[index].image_url = "";
      task.prompts[index].error = "";
      task.prompts[index].error_code = "";
      task.prompts[index].error_status = 0;
      task.prompts[index].search_url = "";
      task.prompts[index].search_status = "";
      task.prompts[index].search_error = "";
      promptSnapshot[index] = task.prompts[index].prompt;
    }
    this.writePayload(workflow, requestId);
    return this.scheduleImageGeneration(temuMainId, requestedIndex, requestId, promptSnapshot);
  }

  /** Mark one Temu workflow as bound to an extension-collected 1688 record. */
  complete(input, requestId) {
    const workflow = this.readPayload();
    const temuMainId = String(input.temu_main_id || workflow.active_temu_main_id || "").trim();
    if (!temuMainId) {
      throw createWorkflowError("请选择需要绑定的 Temu 商品。", 400);
    }
    const task = this.getOrCreateTask(workflow, temuMainId);
    task.status = "completed";
    task.bound_ali_main_id = String(input.ali_main_id || "");
    task.bound_ali_platform_id = String(input.ali_platform_id || "");
    task.error = "";
    workflow.active_temu_main_id = "";
    this.writePayload(workflow, requestId);
    return { ok: true, task: task };
  }
}

/** Create the intelligent-packing domain service for one local server process. */
function createWorkflowService(options) {
  return new WorkflowService(options);
}

module.exports = {
  createWorkflowService: createWorkflowService
};
