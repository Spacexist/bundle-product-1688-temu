const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

/** Keep one synchronous image generation request bounded by local config. */
const DEFAULT_IMAGE_TIMEOUT_MS = 300000;

/** Keep manual CLIP keyword translation from delaying the user's search too long. */
const CLIP_KEYWORD_TRANSLATE_TIMEOUT_MS = 3500;

/** Create one workflow error carrying its HTTP status and stable error code. */
function createWorkflowError(message, statusCode, code) {
  const error = new Error(String(message || "智能组货请求失败。"));
  error.statusCode = Number(statusCode || 500);
  error.code = String(code || "WORKFLOW_ERROR");
  return error;
}

/** Return whether a manual keyword contains Chinese text that benefits from EN CLIP search. */
function containsChineseText(value) {
  return /[\u3400-\u9fff]/.test(String(value || ""));
}

/** Extract one translated text string from the googletrans-compatible response shape. */
function readGoogletransText(payload) {
  if (!Array.isArray(payload) || !Array.isArray(payload[0])) {
    return "";
  }
  const chunks = [];
  for (let index = 0; index < payload[0].length; index += 1) {
    const item = payload[0][index];
    if (Array.isArray(item) && item[0]) {
      chunks.push(String(item[0]));
    }
  }
  return chunks.join("").trim();
}

/** Extract one translated text string from the Baidu translate response shape. */
function readBaiduTranslateText(payload) {
  const results = payload && Array.isArray(payload.trans_result) ? payload.trans_result : [];
  const chunks = [];
  for (let index = 0; index < results.length; index += 1) {
    const item = results[index] || {};
    if (item.dst) {
      chunks.push(String(item.dst));
    }
  }
  return chunks.join(" ").trim();
}

/** Create one MD5 signature required by Baidu translate API. */
function createBaiduTranslateSign(appid, text, salt, secretKey) {
  return crypto.createHash("md5").update(String(appid) + String(text) + String(salt) + String(secretKey), "utf8").digest("hex");
}

/** Translate one manual CLIP keyword to English through Baidu translate API. */
async function translateKeywordWithBaidu(keyword, settings) {
  const text = String(keyword || "").trim();
  const appid = String(settings && (settings.baidu_appid || settings.appid) || process.env.BAIDU_TRANSLATE_APPID || "").trim();
  const secretKey = String(settings && (settings.baidu_secret_key || settings.secret_key) || process.env.BAIDU_TRANSLATE_SECRET_KEY || "").trim();
  if (!text || !appid || !secretKey || typeof fetch !== "function") {
    return "";
  }
  const timeoutMs = Math.max(800, Number(settings && settings.timeout_ms || 1500));
  const controller = new AbortController();
  const timer = setTimeout(function abortBaiduTranslateKeywordRequest() {
    controller.abort();
  }, timeoutMs);
  try {
    const salt = String(Date.now());
    const body = new URLSearchParams({
      q: text,
      from: "auto",
      to: "en",
      appid: appid,
      salt: salt,
      sign: createBaiduTranslateSign(appid, text, salt, secretKey)
    });
    const response = await fetch("https://fanyi-api.baidu.com/api/trans/vip/translate", {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString()
    });
    if (!response.ok) {
      return "";
    }
    const payload = await response.json();
    if (payload && payload.error_code) {
      return "";
    }
    return readBaiduTranslateText(payload);
  } finally {
    clearTimeout(timer);
  }
}

/** Translate one manual CLIP keyword to English through Google's googletrans endpoint. */
async function translateKeywordWithGoogletrans(keyword, timeoutMs) {
  const text = String(keyword || "").trim();
  if (!text || typeof fetch !== "function") {
    return "";
  }
  const controller = new AbortController();
  const timer = setTimeout(function abortGoogletransKeywordRequest() {
    controller.abort();
  }, Math.max(1000, Number(timeoutMs || CLIP_KEYWORD_TRANSLATE_TIMEOUT_MS)));
  try {
    const url = "https://translate.googleapis.com/translate_a/single"
      + "?client=gtx&sl=auto&tl=en&dt=t&q=" + encodeURIComponent(text);
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 AutoBundle/1.0" }
    });
    if (!response.ok) {
      return "";
    }
    return readGoogletransText(await response.json());
  } finally {
    clearTimeout(timer);
  }
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

/** Return the configured timeout for image generation calls. */
function normalizeWorkflowImageTimeoutMs(config) {
  const source = config && config.image && typeof config.image === "object" ? config.image : config || {};
  const timeoutMs = Number(source.image_timeout_ms || source.timeout_ms || DEFAULT_IMAGE_TIMEOUT_MS);
  return Math.max(10000, Math.min(timeoutMs, 900000));
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

/** Normalize workflow image quality to a provider-supported value. */
function normalizeWorkflowImageQuality(rawQuality) {
  const quality = String(rawQuality || "medium").trim().toLowerCase();
  if (quality === "low" || quality === "high") {
    return quality;
  }
  return "medium";
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
    this.stateFilePath = path.join(settings.cacheDirectory, "workflow-state.json");
    this.readConfig = settings.readConfig;
    this.getKimiEndpoint = settings.getKimiEndpoint;
    this.compactValue = settings.compactValue;
    this.readImageSource = settings.readImageSource;
    this.cacheGeneratedImage = settings.cacheGeneratedImage;
    this.imageTaskQueue = settings.imageTaskQueue;
    this.clipWorker = settings.clipWorker;
    this.writeLog = settings.writeLog;
    this.formatTime = settings.formatTime;
    this.publishEvent = settings.publishEvent;
    this.generationQueue = [];
    this.generationQueueActive = false;
    this.recoverInterruptedTasks();
    this.reconcileTemporaryStates();
  }

  /** Return the default persistent workflow payload. */
  createEmptyPayload() {
    return {
      version: "1.0",
      updated_at: "",
      active_temu_main_id: "",
      active_source_mode: "",
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

  /** Return the default payload for refresh-safe temporary workflow phases. */
  createEmptyTemporaryStatePayload() {
    return {
      version: "1.0",
      updated_at: "",
      tasks: {}
    };
  }

  /** Read temporary workflow phases without exposing malformed state files. */
  readTemporaryStatePayload() {
    if (!fs.existsSync(this.stateFilePath)) {
      return this.createEmptyTemporaryStatePayload();
    }
    try {
      const content = fs.readFileSync(this.stateFilePath, "utf8");
      const payload = JSON.parse(content);
      if (!payload || typeof payload !== "object") {
        return this.createEmptyTemporaryStatePayload();
      }
      if (!payload.tasks || typeof payload.tasks !== "object") {
        payload.tasks = {};
      }
      return payload;
    } catch (error) {
      return this.createEmptyTemporaryStatePayload();
    }
  }

  /** Atomically persist temporary workflow phases and notify connected workbenches. */
  writeTemporaryStatePayload(payload, requestId) {
    const state = payload && typeof payload === "object" ? payload : this.createEmptyTemporaryStatePayload();
    state.updated_at = this.formatTime(new Date());
    fs.mkdirSync(path.dirname(this.stateFilePath), { recursive: true });
    const temporaryPath = this.stateFilePath + "." + process.pid + "." + Date.now() + ".tmp";
    fs.writeFileSync(temporaryPath, JSON.stringify(state, null, 2), "utf8");
    try {
      fs.renameSync(temporaryPath, this.stateFilePath);
    } catch (error) {
      fs.copyFileSync(temporaryPath, this.stateFilePath);
      fs.unlinkSync(temporaryPath);
    }
    if (typeof this.publishEvent === "function") {
      this.publishEvent({
        resource: "workflow",
        action: "state_updated",
        ids: [],
        version: Date.now()
      }, requestId);
    }
    return state;
  }

  /** Persist one product's temporary workflow phase independently from business results. */
  setTemporaryState(temuMainId, status, error, errorCode, requestId, mode) {
    const key = String(temuMainId || "").trim();
    if (!key) {
      return null;
    }
    const taskKey = this.buildTaskKey(key, mode || "legacy");
    const payload = this.readTemporaryStatePayload();
    payload.tasks[taskKey] = {
      temu_main_id: key,
      source_mode: this.normalizeTaskMode(mode || "legacy"),
      status: String(status || "idle"),
      error: String(error || ""),
      error_code: String(errorCode || ""),
      updated_at: this.formatTime(new Date())
    };
    this.writeTemporaryStatePayload(payload, requestId);
    return payload.tasks[taskKey];
  }

  /** Convert one durable workflow result into its matching non-busy UI phase. */
  inferTemporaryStateStatus(task) {
    const status = String(task && task.status || "idle");
    if (status === "generating") {
      return "generating";
    }
    if (status === "generation_error" || status === "search_error") {
      return "error";
    }
    if (status === "prompts_ready") {
      return "prompts_ready";
    }
    if (status === "clip_ready" || status === "images_ready" || status === "completed") {
      return "ready";
    }
    return "idle";
  }

  /** Rebuild missing or interrupted temporary phases from durable workflow tasks at startup. */
  reconcileTemporaryStates() {
    const workflow = this.readPayload();
    const workflowTasks = workflow && workflow.tasks && typeof workflow.tasks === "object" ? workflow.tasks : {};
    const state = this.readTemporaryStatePayload();
    const reconciledTasks = {};
    const taskKeys = Object.keys(workflowTasks);
    for (let index = 0; index < taskKeys.length; index += 1) {
      const key = String(taskKeys[index]);
      const task = workflowTasks[key] || {};
      const temuMainId = String(task.temu_main_id || key).split("::")[0];
      const sourceMode = this.normalizeTaskMode(task.source_mode || (key.indexOf("::clip") >= 0 ? "clip" : "legacy"));
      const status = this.inferTemporaryStateStatus(task);
      reconciledTasks[key] = {
        temu_main_id: temuMainId,
        source_mode: sourceMode,
        status: status,
        error: status === "error" ? String(task.error || "") : "",
        error_code: status === "error" ? String(task.error_code || "") : "",
        updated_at: this.formatTime(new Date())
      };
    }
    state.tasks = reconciledTasks;
    this.writeTemporaryStatePayload(state, "");
  }

  /** Return durable workflow results together with their independent temporary phases. */
  readWorkflowSnapshot() {
    return {
      workflow: this.readPayload(),
      state: this.readTemporaryStatePayload()
    };
  }

  /** Persist all tasks for direct HTTP responses and later GET requests. */
  writePayload(payload, requestId) {
    const state = payload && typeof payload === "object" ? payload : this.createEmptyPayload();
    state.updated_at = this.formatTime(new Date());
    fs.writeFileSync(this.filePath, JSON.stringify(state, null, 2), "utf8");
    return state;
  }

  /** Normalize one workflow mode string for durable task separation. */
  normalizeTaskMode(mode) {
    return String(mode || "") === "clip" ? "clip" : "legacy";
  }

  /** Build one durable task key from the Temu id and workflow mode. */
  buildTaskKey(temuMainId, mode) {
    const key = String(temuMainId || "").trim();
    const sourceMode = this.normalizeTaskMode(mode);
    return key ? key + "::" + sourceMode : "";
  }

  /** Return or create one mode-specific task for a Temu main identifier. */
  getOrCreateTask(payload, temuMainId, mode) {
    const state = payload && typeof payload === "object" ? payload : this.createEmptyPayload();
    const key = String(temuMainId || "").trim();
    const sourceMode = this.normalizeTaskMode(mode);
    const taskKey = this.buildTaskKey(key, sourceMode);
    if (!state.tasks || typeof state.tasks !== "object") {
      state.tasks = {};
    }
    if (!state.tasks[taskKey] || typeof state.tasks[taskKey] !== "object") {
      state.tasks[taskKey] = {
        temu_main_id: key,
        source_mode: sourceMode,
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
    state.tasks[taskKey].temu_main_id = key;
    state.tasks[taskKey].source_mode = sourceMode;
    return state.tasks[taskKey];
  }

  /** Return one existing mode-specific task without creating cross-mode data. */
  findTask(payload, temuMainId, mode) {
    const state = payload && typeof payload === "object" ? payload : this.createEmptyPayload();
    const key = String(temuMainId || "").trim();
    const tasks = state.tasks && typeof state.tasks === "object" ? state.tasks : {};
    if (!key) {
      return null;
    }
    if (mode) {
      const sourceMode = this.normalizeTaskMode(mode);
      const separatedTask = tasks[this.buildTaskKey(key, sourceMode)];
      if (separatedTask && typeof separatedTask === "object") {
        separatedTask.source_mode = sourceMode;
        return separatedTask;
      }
      const nakedTask = tasks[key];
      const nakedMode = nakedTask && nakedTask.source_mode ? this.normalizeTaskMode(nakedTask.source_mode) : "legacy";
      return nakedTask && nakedMode === sourceMode ? nakedTask : null;
    }
    return tasks[this.buildTaskKey(key, "clip")] || tasks[this.buildTaskKey(key, "legacy")] || tasks[key] || null;
  }

  /** Return the public active-task payload used by the browser extension. */
  getActivePayload() {
    const workflow = this.readPayload();
    const activeTemuMainId = String(workflow.active_temu_main_id || "");
    const activeSourceMode = this.normalizeTaskMode(workflow.active_source_mode || "legacy");
    const activeTask = activeTemuMainId ? this.findTask(workflow, activeTemuMainId, activeSourceMode) : null;
    return {
      ok: true,
      active_temu_main_id: activeTemuMainId,
      active_source_mode: activeSourceMode,
      task: activeTask
    };
  }

  /** Persist the Temu product that the 1688 extension should keep selected. */
  setActiveTemuMainId(temuMainId, requestId, mode) {
    const key = String(temuMainId || "").trim();
    if (!key) {
      return;
    }
    const workflow = this.readPayload();
    workflow.active_temu_main_id = key;
    workflow.active_source_mode = this.normalizeTaskMode(mode || "legacy");
    this.writePayload(workflow, requestId);
  }

  /** Return workflow settings with defaults already supplied by config-loader. */
  getWorkflowSettings(config) {
    const source = config && config.workflow && typeof config.workflow === "object" ? config.workflow : {};
    return {
      clip_candidate_count: Math.max(1, Math.min(Number(source.clip_candidate_count || 10), 40)),
      legacy_candidate_count: Math.max(1, Math.min(Number(source.legacy_candidate_count || 4), 10)),
      clip_kimi_system_prompt: String(source.clip_kimi_system_prompt || ""),
      clip_kimi_prompt: String(source.clip_kimi_prompt || "")
    };
  }

  /** Read a clear CLIP service error from its JSON or text response. */
  readClipProviderError(payload, fallbackText) {
    if (payload && payload.error) {
      if (payload.error && typeof payload.error === "object" && payload.error.message) {
        return String(payload.error.message).slice(0, 300);
      }
      return String(payload.error).slice(0, 300);
    }
    const text = String(fallbackText || "").trim();
    return text ? text.slice(0, 300) : "CLIP 组货服务请求失败。";
  }

  /** Normalize one value for duplicate detection across CLIP prompt groups. */
  normalizeClipDuplicateValue(value) {
    return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
  }

  /** Build duplicate-detection keys for one CLIP product. */
  buildClipDuplicateKeys(product) {
    const source = product && typeof product === "object" ? product : {};
    const keys = [];
    const productId = this.normalizeClipDuplicateValue(source.id || source.product_id || source.offer_id || source.item_id);
    const imageUrl = this.normalizeClipDuplicateValue(source.img_url || source.image_url || source.MAINIMAGE || source.local_img);
    const familyKey = this.normalizeClipDuplicateValue(source.family_key || source.listing_key);
    const title = this.normalizeClipDuplicateValue(source.title || source.listing_text || source.title_en);
    if (productId) {
      keys.push("id:" + productId);
    }
    if (imageUrl) {
      keys.push("image:" + imageUrl);
    }
    if (familyKey) {
      keys.push("family:" + familyKey);
    }
    if (title) {
      keys.push("title:" + title);
    }
    return keys;
  }

  /** Return whether one CLIP product has already appeared in the candidate list. */
  isDuplicateClipProduct(product, seenKeys) {
    const keys = this.buildClipDuplicateKeys(product);
    for (let index = 0; index < keys.length; index += 1) {
      if (seenKeys[keys[index]]) {
        return true;
      }
    }
    for (let index = 0; index < keys.length; index += 1) {
      seenKeys[keys[index]] = true;
    }
    return false;
  }

  /** Convert one CLIP product result into the existing workflow candidate shape. */
  normalizeClipCandidate(product, index, manualKeyword, manualQuery) {
    const source = product && typeof product === "object" ? product : {};
    const title = String(source.title || source.listing_text || source.title_en || source.search_prompt || "CLIP 候选商品").trim();
    const keyword = String(manualKeyword || "").trim();
    const query = String(manualQuery || "").trim();
    const promptText = String(source.search_prompt || query || keyword || title).trim();
    const promptTextEn = String(source.search_prompt_en || query || keyword).trim();
    const rawPrice = source.price_usd === undefined || source.price_usd === null ? source.price : source.price_usd;
    const numericPrice = Number(rawPrice);
    const priceLabel = rawPrice === undefined || rawPrice === null || rawPrice === ""
      ? ""
      : Number.isFinite(numericPrice) ? "$" + numericPrice.toFixed(2) : String(rawPrice).trim();
    const rawSales = source.sales_total === undefined || source.sales_total === null ? source.sales : source.sales_total;
    const salesLabel = rawSales === undefined || rawSales === null || rawSales === "" ? "" : "销量 " + String(rawSales).trim();
    return {
      relation: "组货方向 " + (index + 1),
      product_name: title,
      product_intro: title,
      match_query: promptText,
      prompt: promptText,
      clip_prompt_en: promptTextEn,
      price_label: priceLabel,
      sales_label: salesLabel,
      image_url: String(source.img_url || source.image_url || source.MAINIMAGE || ""),
      status: "generated",
      source_mode: "clip",
      clip_product: source,
      error: "",
      error_code: "",
      error_status: 0,
      search_url: "",
      search_status: "",
      search_error: ""
    };
  }

  /** Convert a CLIP assemble payload into the candidate list shown by the workbench. */
  normalizeClipCandidates(payload, limit, manualKeyword, manualQuery) {
    const candidates = [];
    const seenKeys = {};
    const results = payload && Array.isArray(payload.results) ? payload.results : [];
    for (let index = 0; index < results.length; index += 1) {
      if (candidates.length >= limit) {
        break;
      }
      const result = results[index];
      const candidate = this.normalizeClipCandidate(result, candidates.length, manualKeyword, manualQuery);
      if (!candidate.image_url) {
        continue;
      }
      if (this.isDuplicateClipProduct(result, seenKeys)) {
        continue;
      }
      candidates.push(candidate);
    }
    return candidates;
  }

  /** Resolve translation provider settings used by manual CLIP keyword search. */
  getClipTranslationSettings(config) {
    const workflow = config && config.workflow && typeof config.workflow === "object" ? config.workflow : {};
    const source = workflow.clip_translation && typeof workflow.clip_translation === "object" ? workflow.clip_translation : {};
    const provider = String(source.provider || "baidu").trim().toLowerCase();
    return {
      provider: provider === "google" ? "google" : "baidu",
      baidu_appid: String(source.baidu_appid || source.appid || process.env.BAIDU_TRANSLATE_APPID || "").trim(),
      baidu_secret_key: String(source.baidu_secret_key || source.secret_key || process.env.BAIDU_TRANSLATE_SECRET_KEY || "").trim(),
      timeout_ms: Math.max(800, Number(source.timeout_ms || 1500)),
      google_timeout_ms: Math.max(1000, Number(source.google_timeout_ms || CLIP_KEYWORD_TRANSLATE_TIMEOUT_MS))
    };
  }

  /** Translate one manual CLIP keyword with the configured provider. */
  async translateManualClipKeyword(keyword, settings, requestId) {
    const provider = settings && settings.provider === "google" ? "google" : "baidu";
    if (provider === "google") {
      return {
        provider: "google",
        text: await translateKeywordWithGoogletrans(keyword, settings.google_timeout_ms)
      };
    }
    if (!settings.baidu_appid || !settings.baidu_secret_key) {
      this.writeLog("UPSTREAM", "Baidu keyword translation skipped", {
        reason: "missing_baidu_translate_credentials"
      }, requestId);
      return { provider: "baidu", text: "" };
    }
    return {
      provider: "baidu",
      text: await translateKeywordWithBaidu(keyword, settings)
    };
  }

  /** Resolve the actual CLIP query for one manual keyword, translating Chinese to English when possible. */
  async resolveManualClipQuery(keyword, requestId, config) {
    const originalKeyword = String(keyword || "").trim();
    if (!containsChineseText(originalKeyword)) {
      return {
        original_keyword: originalKeyword,
        query: originalKeyword,
        translated_keyword: "",
        translation_status: "skipped",
        translation_provider: "none"
      };
    }
    const settings = this.getClipTranslationSettings(config);
    try {
      const result = await this.translateManualClipKeyword(originalKeyword, settings, requestId);
      const translated = String(result.text || "").trim();
      if (!translated || containsChineseText(translated)) {
        this.writeLog("UPSTREAM", "CLIP keyword translation fallback", {
          provider: result.provider,
          keyword: originalKeyword,
          translated_keyword: translated,
          reason: translated ? "translated_text_still_chinese" : "empty_translation"
        }, requestId);
        return {
          original_keyword: originalKeyword,
          query: originalKeyword,
          translated_keyword: "",
          translation_status: "empty_fallback",
          translation_provider: result.provider
        };
      }
      this.writeLog("UPSTREAM", "CLIP keyword translation success", {
        provider: result.provider,
        keyword: originalKeyword,
        translated_keyword: translated
      }, requestId);
      return {
        original_keyword: originalKeyword,
        query: translated,
        translated_keyword: translated,
        translation_status: "translated",
        translation_provider: result.provider
      };
    } catch (error) {
      this.writeLog("UPSTREAM", "CLIP keyword translation fallback", {
        provider: settings.provider,
        keyword: originalKeyword,
        error: error && error.message ? error.message : String(error || "")
      }, requestId);
      return {
        original_keyword: originalKeyword,
        query: originalKeyword,
        translated_keyword: "",
        translation_status: "error_fallback",
        translation_provider: settings.provider
      };
    }
  }

  /** Ask the local CLIP service to generate and search real listing candidates. */
  async requestClipAssemble(input, requestId) {
    const config = this.readConfig();
    const workflow = this.getWorkflowSettings(config);
    const imageUrl = String(input.image_url || "").trim();
    const sourceImage = await this.readImageSource(imageUrl, requestId);
    const recallPerPrompt = 1;
    const systemPrompt = String(workflow.clip_kimi_system_prompt || "").trim();
    const customPrompt = String(input.custom_prompt || workflow.clip_kimi_prompt || "").trim();
    this.writeLog("OUTBOUND", "CLIP workflow assemble worker", {
      top_k: recallPerPrompt,
      candidate_count: workflow.clip_candidate_count,
      image_bytes: sourceImage.buffer.length
    }, requestId);
    if (!this.clipWorker) {
      throw createWorkflowError("CLIP worker 未初始化。", 500, "CLIP_WORKER_MISSING");
    }
    try {
      return await this.clipWorker.assemble({
        request_id: requestId,
        image_base64: sourceImage.buffer.toString("base64"),
        top_k: recallPerPrompt,
        kimi_system_prompt: systemPrompt,
        kimi_prompt: customPrompt,
        min_price: input.min_price,
        max_price: input.max_price,
        listing: this.compactValue(input.product || {}, 0)
      });
    } catch (error) {
      throw createWorkflowError("CLIP 组货 worker 失败：" + (error.message || "未知错误。"), 502, "CLIP_WORKER_ERROR");
    }
  }

  /** Search the local CLIP listing index with one manual keyword. */
  async requestClipTextSearch(input, requestId) {
    const config = this.readConfig();
    const keyword = String(input.keyword || "").trim();
    const queryInfo = await this.resolveManualClipQuery(keyword, requestId, config);
    this.writeLog("OUTBOUND", "CLIP workflow text search worker", {
      keyword: keyword,
      query: queryInfo.query,
      translated_keyword: queryInfo.translated_keyword,
      translation_status: queryInfo.translation_status,
      translation_provider: queryInfo.translation_provider,
      top_k: 10
    }, requestId);
    if (!this.clipWorker) {
      throw createWorkflowError("CLIP worker 未初始化。", 500, "CLIP_WORKER_MISSING");
    }
    try {
      const payload = await this.clipWorker.searchText({
        request_id: requestId,
        query: queryInfo.query,
        top_k: 10,
        min_price: input.min_price,
        max_price: input.max_price
      });
      payload.manual_keyword = keyword;
      payload.manual_keyword_en = queryInfo.translated_keyword || "";
      payload.clip_query = queryInfo.query;
      payload.translation_status = queryInfo.translation_status;
      payload.translation_provider = queryInfo.translation_provider;
      return payload;
    } catch (error) {
      throw createWorkflowError("CLIP 手动匹配 worker 失败：" + (error.message || "未知错误。"), 502, "CLIP_SEARCH_WORKER_ERROR");
    }
  }

  /** Generate real-product candidates through the local CLIP listing service. */
  async assembleClip(input, requestId) {
    const temuMainId = String(input.temu_main_id || "").trim();
    const imageUrl = String(input.image_url || "").trim();
    if (!temuMainId || !imageUrl) {
      throw createWorkflowError("请选择 Temu 商品及分析主图。", 400);
    }
    const config = this.readConfig();
    const workflowConfig = this.getWorkflowSettings(config);
    const payload = await this.requestClipAssemble(input, requestId);
    const candidates = this.normalizeClipCandidates(payload, workflowConfig.clip_candidate_count);
    if (!candidates.length) {
      throw createWorkflowError("CLIP 未返回可展示的候选商品。", 502, "CLIP_EMPTY_RESULTS");
    }
    const workflow = this.readPayload();
    const task = this.getOrCreateTask(workflow, temuMainId, "clip");
    task.status = "clip_ready";
    task.source_mode = "clip";
    task.selected_image_url = imageUrl;
    task.custom_prompt = String(input.custom_prompt || workflowConfig.clip_kimi_prompt || "");
    task.prompts = candidates;
    task.selected_result_index = -1;
    task.search_url = "";
    task.search_offers = [];
    task.error = "";
    task.error_code = "";
    task.error_status = 0;
    this.writePayload(workflow, requestId);
    return { ok: true, task: task };
  }

  /** Search and persist ten manual keyword CLIP candidates for one Temu item. */
  async searchClip(input, requestId) {
    const temuMainId = String(input.temu_main_id || "").trim();
    const keyword = String(input.keyword || "").trim();
    if (!temuMainId || !keyword) {
      throw createWorkflowError("请输入手动匹配 keyword。", 400);
    }
    const payload = await this.requestClipTextSearch(input, requestId);
    const clipQuery = String(payload.clip_query || keyword);
    const candidates = this.normalizeClipCandidates(payload, 10, keyword, clipQuery);
    if (!candidates.length) {
      throw createWorkflowError("CLIP 未返回可展示的手动匹配商品。", 502, "CLIP_SEARCH_EMPTY_RESULTS");
    }
    const workflow = this.readPayload();
    const task = this.getOrCreateTask(workflow, temuMainId, "clip");
    task.status = "clip_ready";
    task.source_mode = "clip";
    task.selected_image_url = String(input.image_url || task.selected_image_url || "");
    task.manual_keyword = keyword;
    task.manual_keyword_en = String(payload.manual_keyword_en || "");
    task.clip_search_query = clipQuery;
    task.clip_translation_status = String(payload.translation_status || "skipped");
    task.clip_translation_provider = String(payload.translation_provider || "");
    task.prompts = candidates;
    task.selected_result_index = -1;
    task.search_url = "";
    task.search_offers = [];
    task.error = "";
    task.error_code = "";
    task.error_status = 0;
    this.writePayload(workflow, requestId);
    return { ok: true, task: task };
  }

  /** Search CLIP top 10 directly with one English listing keyword. */
  async searchClipTop10(input, requestId) {
    const keyword = String(input.keyword || "").trim();
    if (!keyword) {
      throw createWorkflowError("请输入 CLIP 英文检索关键词。", 400);
    }
    this.writeLog("OUTBOUND", "CLIP workflow top10 text worker", {
      query: keyword,
      top_k: 10
    }, requestId);
    if (!this.clipWorker) {
      throw createWorkflowError("CLIP worker 未初始化。", 500, "CLIP_WORKER_MISSING");
    }
    let payload = {};
    try {
      payload = await this.clipWorker.searchText({
        request_id: requestId,
        query: keyword,
        top_k: 10,
        min_price: input.min_price,
        max_price: input.max_price
      });
    } catch (error) {
      throw createWorkflowError("CLIP Top10 worker 失败：" + (error.message || "未知错误。"), 502, "CLIP_TOP10_WORKER_ERROR");
    }
    const candidates = this.normalizeClipCandidates(payload, 10, keyword, keyword);
    if (!candidates.length) {
      throw createWorkflowError("CLIP Top10 未返回可展示的候选商品。", 502, "CLIP_TOP10_EMPTY_RESULTS");
    }
    for (let index = 0; index < candidates.length; index += 1) {
      candidates[index].relation = "CLIP Top " + (index + 1);
      candidates[index].product_intro = candidates[index].product_name || candidates[index].product_intro;
      candidates[index].prompt = keyword;
      candidates[index].clip_prompt_en = keyword;
      candidates[index].clip_top10 = true;
      candidates[index].clip_top10_query = keyword;
    }
    return { ok: true, query: keyword, candidates: candidates };
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
    const task = this.getOrCreateTask(workflow, temuMainId, "legacy");
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
      size: "1024x1024",
      quality: normalizeWorkflowImageQuality(config.quality),
      n: 1
    };
    this.writeLog("OUTBOUND", "BeeAPI generation POST " + endpoint, providerRequestPayload, requestId);
    const controller = new AbortController();
    const timeoutMs = normalizeWorkflowImageTimeoutMs(config);
    /** Abort one BeeAPI generation request after the configured image timeout. */
    const timeoutHandle = setTimeout(function abortWorkflowGenerationRequest() {
      controller.abort();
    }, timeoutMs);
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
        throw createWorkflowError("BeeAPI 生图请求超过配置超时时间。", 504, "BEEAPI_TIMEOUT");
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
    const task = this.findTask(workflow, temuMainId, "legacy");
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
    if (typeof this.publishEvent === "function") {
      this.publishEvent({
        resource: "workflow",
        action: "candidate_updated",
        ids: [String(temuMainId || ""), String(index)],
        version: Date.now()
      }, requestId);
    }
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
      const task = this.findTask(workflow, temuMainId, "legacy");
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
        const currentTask = this.findTask(currentWorkflow, temuMainId, "legacy");
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
      const finalTask = this.findTask(finalWorkflow, temuMainId, "legacy");
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
      let temporaryStatus = "ready";
      if (finalTask.status === "generating") {
        temporaryStatus = "generating";
      } else if (finalTask.status === "generation_error") {
        temporaryStatus = "error";
      }
      this.setTemporaryState(
        temuMainId,
        temporaryStatus,
        finalTask.error,
        finalTask.error_code,
        requestId,
        "legacy"
      );
      return { task: finalTask, results: results };
    } catch (error) {
      const failedWorkflow = this.readPayload();
      const failedTask = this.findTask(failedWorkflow, temuMainId, "legacy");
      if (failedTask && !this.hasPendingGeneration(temuMainId)) {
        failedTask.status = "generation_error";
        failedTask.error = error.message || "后台生图失败。";
        failedTask.error_code = String(error.code || "WORKFLOW_GENERATION_ERROR");
        failedTask.error_status = Number(error.statusCode || 500);
        this.writePayload(failedWorkflow, requestId);
        this.setTemporaryState(temuMainId, "error", failedTask.error, failedTask.error_code, requestId, "legacy");
        return { task: failedTask, results: [] };
      }
      throw error;
    }
  }

  /** Generate all four images or regenerate one selected candidate. */
  async generateImages(input, requestId) {
    const temuMainId = String(input.temu_main_id || "").trim();
    const workflow = this.readPayload();
    const task = this.findTask(workflow, temuMainId, "legacy");
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
    this.setTemporaryState(temuMainId, "generating", "", "", requestId, "legacy");
    return this.scheduleImageGeneration(temuMainId, requestedIndex, requestId, promptSnapshot);
  }

  /** Mark one Temu workflow as bound to an extension-collected 1688 record. */
  complete(input, requestId) {
    const workflow = this.readPayload();
    const temuMainId = String(input.temu_main_id || workflow.active_temu_main_id || "").trim();
    if (!temuMainId) {
      throw createWorkflowError("请选择需要绑定的 Temu 商品。", 400);
    }
    const requestedMode = input.source_mode ? this.normalizeTaskMode(input.source_mode) : this.normalizeTaskMode(workflow.active_source_mode || "clip");
    const task = this.findTask(workflow, temuMainId, requestedMode) || this.getOrCreateTask(workflow, temuMainId, requestedMode);
    task.status = "completed";
    task.bound_ali_main_id = String(input.ali_main_id || "");
    task.bound_ali_platform_id = String(input.ali_platform_id || "");
    task.error = "";
    workflow.active_temu_main_id = "";
    workflow.active_source_mode = "";
    this.writePayload(workflow, requestId);
    this.setTemporaryState(temuMainId, "ready", "", "", requestId, task.source_mode);
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
