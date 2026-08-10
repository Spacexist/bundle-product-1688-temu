const fs = require("fs");
const path = require("path");
const search1688ByImage = require("./1688-image-search").search1688ByImage;

/** Create one workflow error carrying its intended HTTP status code. */
function createWorkflowError(message, statusCode) {
  const error = new Error(String(message || "智能组货请求失败。"));
  error.statusCode = Number(statusCode || 500);
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
  const fixedRelations = ["相似替代品", "功能互补品", "配套附件", "同风格关联品"];
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
    prompts.push({
      relation: fixedRelations[index],
      product_name: String(source.product_name || productIntro).trim(),
      product_intro: productIntro,
      prompt: prompt,
      image_url: "",
      status: "prompt_ready",
      error: ""
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
    this.eventClients = [];
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

  /** Broadcast one task snapshot to all workflow SSE clients. */
  broadcast(payload, requestId) {
    const message = "data: " + JSON.stringify(payload) + "\n\n";
    const subscriberCount = this.eventClients.length;
    let deliveredCount = 0;
    for (let index = this.eventClients.length - 1; index >= 0; index -= 1) {
      try {
        this.eventClients[index].write(message);
        deliveredCount += 1;
      } catch (error) {
        this.eventClients.splice(index, 1);
      }
    }
    if (typeof this.writeLog === "function") {
      this.writeLog("BROADCAST", "Workflow SSE broadcast", {
        stream: "workflow",
        subscriber_count: subscriberCount,
        delivered_count: deliveredCount,
        active_temu_main_id: payload && payload.active_temu_main_id,
        updated_at: payload && payload.updated_at
      }, requestId);
    }
  }

  /** Persist all tasks and notify connected workflow pages. */
  writePayload(payload, requestId) {
    const state = payload && typeof payload === "object" ? payload : this.createEmptyPayload();
    state.updated_at = this.formatTime(new Date());
    fs.writeFileSync(this.filePath, JSON.stringify(state, null, 2), "utf8");
    this.broadcast(state, requestId);
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

  /** Open an SSE stream for intelligent-packing state updates. */
  handleEvents(request, response) {
    response.writeHead(200, {
      "Access-Control-Allow-Origin": "*",
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive"
    });
    const initialPayload = this.readPayload();
    response.write("data: " + JSON.stringify(initialPayload) + "\n\n");
    this.eventClients.push(response);
    if (typeof this.writeLog === "function") {
      this.writeLog("BROADCAST", "Workflow SSE initial snapshot", {
        stream: "workflow",
        subscriber_count: this.eventClients.length,
        delivered_count: 1,
        active_temu_main_id: initialPayload.active_temu_main_id,
        updated_at: initialPayload.updated_at
      }, request.requestId);
    }
    const service = this;
    /** Remove one disconnected workflow page from the live stream. */
    request.on("close", function handleWorkflowClientClose() {
      const index = service.eventClients.indexOf(response);
      if (index >= 0) {
        service.eventClients.splice(index, 1);
      }
    });
  }

  /** Ask Kimi for four white-background products related to one Temu item. */
  async generatePrompts(input, requestId) {
    const temuMainId = String(input.temu_main_id || "").trim();
    const imageUrl = String(input.image_url || "").trim();
    const product = input.product && typeof input.product === "object" ? input.product : {};
    if (!temuMainId || !imageUrl) {
      throw createWorkflowError("请选择 Temu 商品及分析主图。", 400);
    }
    const config = this.readConfig();
    const kimi = config && config.kimi && typeof config.kimi === "object" ? config.kimi : {};
    const endpoint = this.getKimiEndpoint(config);
    const systemPrompt = String(kimi.workflow_system_prompt || "").trim();
    const taskPrompt = String(kimi.workflow_prompt || "").trim();
    if (!endpoint || !kimi.apikey || !systemPrompt || !taskPrompt) {
      throw createWorkflowError("server/config.json 未配置智能组货 Kimi 提示词。", 500);
    }
    const sourceImage = await this.readImageSource(imageUrl, requestId);
    const dataUrl = "data:" + sourceImage.mimeType + ";base64," + sourceImage.buffer.toString("base64");
    const productText = taskPrompt + "\n\nTemu 商品信息：\n" + JSON.stringify(this.compactValue(product, 0), null, 2);
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
      throw createWorkflowError(readWorkflowProviderError(providerPayload, providerText), 502);
    }
    const choices = Array.isArray(providerPayload.choices) ? providerPayload.choices : [];
    const message = choices.length && choices[0].message ? choices[0].message : {};
    const prompts = parseWorkflowPromptContent(message.content);
    const workflow = this.readPayload();
    const task = this.getOrCreateTask(workflow, temuMainId);
    task.status = "prompts_ready";
    task.selected_image_url = imageUrl;
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
    const providerResponse = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + String(config.apikey),
        "Content-Type": "application/json"
      },
      body: JSON.stringify(providerRequestPayload)
    });
    const providerText = await providerResponse.text();
    let providerPayload = {};
    try {
      providerPayload = JSON.parse(providerText || "{}");
    } catch (error) {
      providerPayload = {};
    }
    this.writeLog("UPSTREAM", "BeeAPI generation response " + providerResponse.status, Object.keys(providerPayload).length ? providerPayload : providerText, requestId);
    if (!providerResponse.ok) {
      throw createWorkflowError(readWorkflowProviderError(providerPayload, providerText), 502);
    }
    const imageUrl = readWorkflowGeneratedImage(providerPayload);
    if (!imageUrl) {
      throw createWorkflowError("BeeAPI 已响应，但没有找到生成图片。", 502);
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
    const config = this.readConfig();
    if (!config || !config.apikey || !config.generation_endpoint) {
      throw createWorkflowError("server/config.json 未配置完整的 BeeAPI 生图接口。", 500);
    }
    task.status = "generating";
    task.error = "";
    this.writePayload(workflow, requestId);
    let generatedCount = 0;
    for (let index = 0; index < task.prompts.length; index += 1) {
      if (requestedIndex >= 0 && index !== requestedIndex) {
        continue;
      }
      const item = task.prompts[index];
      if (!String(item.prompt || "").trim()) {
        throw createWorkflowError("第 " + (index + 1) + " 组提示词不能为空。", 400);
      }
      item.status = "generating";
      item.error = "";
      this.writePayload(workflow, requestId);
      try {
        item.image_url = await this.generateOneImage(config, item.prompt, requestId);
        item.status = "generated";
        generatedCount += 1;
      } catch (error) {
        item.status = "error";
        item.error = error.message || "生图失败。";
        if (requestedIndex >= 0) {
          task.status = "generation_error";
          task.error = item.error;
          this.writePayload(workflow, requestId);
          throw error;
        }
      }
      this.writePayload(workflow, requestId);
    }
    task.status = generatedCount > 0 ? "images_ready" : "generation_error";
    task.error = generatedCount > 0 ? "" : "四张图片均生成失败。";
    this.writePayload(workflow, requestId);
    if (!generatedCount) {
      throw createWorkflowError(task.error, 502);
    }
    return { ok: true, task: task };
  }

  /** Search 1688 using the exact source module copied from project1. */
  async searchImage(input, requestId) {
    const temuMainId = String(input.temu_main_id || "").trim();
    const selectedIndex = Number(input.index);
    const workflow = this.readPayload();
    const task = workflow.tasks && workflow.tasks[temuMainId];
    if (!task || !Array.isArray(task.prompts) || !task.prompts[selectedIndex] || !task.prompts[selectedIndex].image_url) {
      throw createWorkflowError("请选择一张已生成的组货图片。", 400);
    }
    try {
      const source = await this.readImageSource(task.prompts[selectedIndex].image_url, requestId);
      const imageBase64 = source.buffer.toString("base64");
      this.writeLog("OUTBOUND", "1688 image search module POST https://search.1688.com/service/uploadErpImgSearch", {
        imgBase64: imageBase64,
        searchType: "imageSearch",
        appName: "pcErpImage",
        urlType: "main"
      }, requestId);
      const result = await search1688ByImage(imageBase64);
      const searchUrl = String(result.url || "");
      this.writeLog("UPSTREAM", "1688 image search module response", {
        url: searchUrl,
        offer_count: Array.isArray(result.offers) ? result.offers.length : 0,
        raw: result.raw
      }, requestId);
      workflow.active_temu_main_id = temuMainId;
      task.status = "waiting_1688_confirmation";
      task.selected_result_index = selectedIndex;
      task.search_url = searchUrl;
      task.search_offers = Array.isArray(result.offers) ? result.offers : [];
      task.error = "";
      this.writePayload(workflow, requestId);
      return { ok: true, search_url: searchUrl, offers: task.search_offers, task: task };
    } catch (error) {
      task.status = "search_error";
      task.error = error.message || "1688 图搜失败。";
      this.writePayload(workflow, requestId);
      if (!error.statusCode) {
        error.statusCode = 502;
      }
      throw error;
    }
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
