const fs = require("fs");
const path = require("path");

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
      error: "",
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
    this.eventClients = [];
    this.eventHistory = [];
    this.eventSequence = 0;
    this.maxEventHistory = Number(settings.maxEventHistory || 100);
    this.eventHeartbeatMs = Number(settings.eventHeartbeatMs || 15000);
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

  /** Create one workflow SSE frame with a browser-resumable event identifier. */
  createEventMessage(payload, eventId) {
    const idLine = eventId === undefined || eventId === null ? "" : "id: " + String(eventId) + "\n";
    return idLine + "data: " + JSON.stringify(payload) + "\n\n";
  }

  /** Read the last workflow event cursor sent by a browser during reconnect. */
  getEventCursor(request) {
    const headers = request && request.headers ? request.headers : {};
    const query = request && request.query ? request.query : {};
    const headerValue = headers["last-event-id"] || headers["Last-Event-ID"];
    const queryValue = query.after || query.lastEventId || query.last_event_id;
    const cursor = Number(headerValue || queryValue || 0);
    return Number.isFinite(cursor) && cursor > 0 ? cursor : 0;
  }

  /** Store one bounded workflow snapshot for reconnect replay. */
  rememberEvent(payload) {
    this.eventHistory.push(payload);
    if (this.eventHistory.length > this.maxEventHistory) {
      this.eventHistory.splice(0, this.eventHistory.length - this.maxEventHistory);
    }
  }

  /** Create and remember one workflow stream snapshot. */
  createEventPayload(payload) {
    const eventPayload = Object.assign({}, payload || {});
    eventPayload.event_id = ++this.eventSequence;
    this.rememberEvent(eventPayload);
    return eventPayload;
  }

  /** Remove one workflow SSE client and stop its heartbeat timer. */
  removeEventClient(client) {
    if (!client || client.closed) {
      return;
    }
    client.closed = true;
    if (client.heartbeat) {
      clearInterval(client.heartbeat);
      client.heartbeat = null;
    }
    const index = this.eventClients.indexOf(client);
    if (index >= 0) {
      this.eventClients.splice(index, 1);
    }
  }

  /** Write one workflow SSE frame and evict a slow or disconnected client. */
  writeEventClient(client, message) {
    if (!client || client.closed) {
      return false;
    }
    try {
      const writable = client.response.write(message);
      if (writable === false) {
        this.removeEventClient(client);
        if (client.response && typeof client.response.destroy === "function") {
          client.response.destroy();
        }
        return false;
      }
      return true;
    } catch (error) {
      this.removeEventClient(client);
      return false;
    }
  }

  /** Start a bounded heartbeat that keeps one workflow stream observable. */
  startEventHeartbeat(client) {
    const service = this;
    /** Write one heartbeat comment and remove an unresponsive client. */
    function writeHeartbeat() {
      service.writeEventClient(client, ": heartbeat\n\n");
    }
    client.heartbeat = setInterval(writeHeartbeat, this.eventHeartbeatMs);
    if (client.heartbeat && typeof client.heartbeat.unref === "function") {
      client.heartbeat.unref();
    }
  }

  /** Broadcast one task snapshot to all workflow SSE clients. */
  broadcast(payload, requestId) {
    const eventPayload = this.createEventPayload(payload);
    const message = this.createEventMessage(eventPayload, eventPayload.event_id);
    const subscriberCount = this.eventClients.length;
    let deliveredCount = 0;
    for (let index = this.eventClients.length - 1; index >= 0; index -= 1) {
      if (this.writeEventClient(this.eventClients[index], message)) {
        deliveredCount += 1;
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
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no"
    });
    if (typeof response.flushHeaders === "function") {
      response.flushHeaders();
    }
    const client = { response: response, heartbeat: null, closed: false };
    const cursor = this.getEventCursor(request);
    this.eventClients.push(client);
    this.writeEventClient(client, "retry: 1000\n\n");
    let replayedCount = 0;
    if (cursor > 0) {
      for (let index = 0; index < this.eventHistory.length; index += 1) {
        const eventPayload = this.eventHistory[index];
        if (Number(eventPayload.event_id) <= cursor) {
          continue;
        }
        if (!this.writeEventClient(client, this.createEventMessage(eventPayload, eventPayload.event_id))) {
          break;
        }
        replayedCount += 1;
      }
    }
    if (cursor === 0 || replayedCount === 0) {
      const initialPayload = this.createEventPayload(this.readPayload());
      this.writeEventClient(client, this.createEventMessage(initialPayload, initialPayload.event_id));
    }
    if (!client.closed) {
      this.startEventHeartbeat(client);
    }
    if (typeof this.writeLog === "function") {
      this.writeLog("BROADCAST", "Workflow SSE initial snapshot", {
        stream: "workflow",
        subscriber_count: this.eventClients.length,
        delivered_count: client.closed ? 0 : 1,
        replayed_count: replayedCount,
        cursor: cursor
      }, request.requestId);
    }
    const service = this;
    /** Remove one disconnected workflow page from the live stream. */
    request.on("close", function handleWorkflowClientClose() {
      service.removeEventClient(client);
    });
    if (typeof response.on === "function") {
      /** Remove one workflow client when the response stream fails. */
      response.on("error", function handleWorkflowResponseError() {
        service.removeEventClient(client);
      });
    }
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

  /** Start one non-blocking background generation job for the current workflow task. */
  scheduleImageGeneration(temuMainId, requestedIndex, requestId, promptSnapshot) {
    this.generationQueue.push({
      temu_main_id: String(temuMainId || ""),
      requested_index: requestedIndex,
      request_id: String(requestId || ""),
      prompts: Array.isArray(promptSnapshot) ? promptSnapshot : []
    });
    this.pumpGenerationQueue();
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

  /** Start the next workflow generation job without holding an HTTP request open. */
  pumpGenerationQueue() {
    if (this.generationQueueActive || !this.generationQueue.length) {
      return;
    }
    this.generationQueueActive = true;
    const service = this;
    const job = this.generationQueue.shift();
    /** Run one queued workflow job on the next event-loop turn. */
    function runQueuedGenerationJob() {
      service.generateImagesInBackground(
        job.temu_main_id,
        job.requested_index,
        job.request_id,
        job.prompts
      ).then(function finishQueuedGenerationJob() {
        service.generationQueueActive = false;
        service.pumpGenerationQueue();
      }, function handleQueuedGenerationJobError() {
        service.generationQueueActive = false;
        service.pumpGenerationQueue();
      });
    }
    setImmediate(runQueuedGenerationJob);
  }

  /** Generate candidate images in the background and publish every intermediate result. */
  async generateImagesInBackground(temuMainId, requestedIndex, requestId, promptSnapshot) {
    try {
      const config = this.readConfig();
      const requestedPrompts = Array.isArray(promptSnapshot) ? promptSnapshot : [];
      const workflow = this.readPayload();
      const task = workflow.tasks && workflow.tasks[temuMainId];
      if (!task || !Array.isArray(task.prompts)) {
        return;
      }
      let generatedCount = 0;
      let failedCount = 0;
      let lastError = "";
      for (let index = 0; index < task.prompts.length; index += 1) {
        if (requestedIndex >= 0 && index !== requestedIndex) {
          continue;
        }
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
        item.search_url = "";
        item.search_status = "";
        item.search_error = "";
        this.writePayload(currentWorkflow, requestId);
        try {
          item.image_url = await this.generateOneImage(config, item.prompt, requestId);
          item.status = "generated";
          generatedCount += 1;
        } catch (error) {
          item.status = "error";
          item.error = error.message || "生图失败。";
          failedCount += 1;
          lastError = item.error;
          if (requestedIndex >= 0) {
            const failedWorkflow = this.readPayload();
            const failedTask = failedWorkflow.tasks && failedWorkflow.tasks[temuMainId];
            if (failedTask && !this.hasPendingGeneration(temuMainId)) {
              failedTask.status = "generation_error";
              failedTask.error = item.error;
              this.writePayload(failedWorkflow, requestId);
            }
            return;
          }
        }
        const latestWorkflow = this.readPayload();
        const latestTask = latestWorkflow.tasks && latestWorkflow.tasks[temuMainId];
        if (latestTask && latestTask.prompts && latestTask.prompts[index]) {
          latestTask.prompts[index] = item;
          this.writePayload(latestWorkflow, requestId);
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
      } else {
        finalTask.status = hasGeneratedImage ? "images_ready" : "generation_error";
        finalTask.error = hasGeneratedImage ? "" : lastError || (failedCount ? "图片生成失败。" : "四张图片均生成失败。");
      }
      this.writePayload(finalWorkflow, requestId);
    } catch (error) {
      const failedWorkflow = this.readPayload();
      const failedTask = failedWorkflow.tasks && failedWorkflow.tasks[temuMainId];
      if (failedTask && !this.hasPendingGeneration(temuMainId)) {
        failedTask.status = "generation_error";
        failedTask.error = error.message || "后台生图失败。";
        this.writePayload(failedWorkflow, requestId);
      }
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
    for (let index = 0; index < task.prompts.length; index += 1) {
      if (requestedIndex >= 0 && index !== requestedIndex) {
        continue;
      }
      task.prompts[index].status = "queued";
      task.prompts[index].image_url = "";
      task.prompts[index].error = "";
      task.prompts[index].search_url = "";
      task.prompts[index].search_status = "";
      task.prompts[index].search_error = "";
      promptSnapshot[index] = task.prompts[index].prompt;
    }
    this.writePayload(workflow, requestId);
    this.scheduleImageGeneration(temuMainId, requestedIndex, requestId, promptSnapshot);
    return { ok: true, task: task };
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
