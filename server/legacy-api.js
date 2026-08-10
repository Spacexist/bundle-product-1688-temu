const http = require("http");
const fs = require("fs");
const path = require("path");
const createWorkflowService = require("./workflow-service").createWorkflowService;
const createBindingService = require("./binding-service").createBindingService;
const ImageTaskQueue = require("./services/image-task-queue").ImageTaskQueue;

const port = Number(process.env.PORT || 5173);
const projectRoot = path.resolve(__dirname, "..");
const root = path.join(projectRoot, "web");
const cacheDirectory = path.join(projectRoot, "cache");
const imageCacheDirectory = path.join(cacheDirectory, "image");
const cacheFilePath = path.join(cacheDirectory, "cache.json");
const ImageCacheService = require("./services/image-cache.service").ImageCacheService;
const generatedImageCache = new ImageCacheService({
  cacheDirectory: "../cache",
  imageDirectory: "../cache/image"
});
const legacyCacheFilePath = path.join(root, "cache.json");
const imageEditConfigPath = path.join(__dirname, "config.json");
const eventClients = [];
const apiRequestLogs = [];
const maxApiRequestLogs = 100;
const serverLogClients = [];
const serverLogEntries = [];
const maxServerLogEntries = 300;
let serverLogSequence = 0;
const operationUndoEntries = {};
const operationUndoOrder = [];
const maxOperationUndoEntries = 200;
let workflowService = null;
let bindingService = null;
const imageTaskQueue = new ImageTaskQueue({ getConcurrency: getImageTaskConcurrency });

if (!fs.existsSync(cacheDirectory)) {
  fs.mkdirSync(cacheDirectory, { recursive: true });
}
if (!fs.existsSync(cacheFilePath) && fs.existsSync(legacyCacheFilePath)) {
  fs.copyFileSync(legacyCacheFilePath, cacheFilePath);
}

/** Return the default long-lived cache payload. */
function createEmptyCachePayload() {
  return {
    version: "1.0",
    updated_at: "",
    records: []
  };
}

/** Format the cache update time without ISO T/Z characters. */
function formatCacheTime(date) {
  const value = new Date(date);
  const pad = function padCacheTimePart(number) {
    return String(number).padStart(2, "0");
  };
  return value.getFullYear() + "-"
    + pad(value.getMonth() + 1) + "-"
    + pad(value.getDate()) + " "
    + pad(value.getHours()) + ":"
    + pad(value.getMinutes()) + ":"
    + pad(value.getSeconds());
}

/** Create a terminal-safe copy of request data with secrets and large images hidden. */
function createSafeLogValue(value, keyName) {
  const normalizedKey = String(keyName || "").toLowerCase();
  if (normalizedKey.indexOf("apikey") >= 0
    || normalizedKey.indexOf("api_key") >= 0
    || normalizedKey.indexOf("authorization") >= 0
    || normalizedKey === "token") {
    return "[REDACTED]";
  }
  if (typeof value === "string") {
    if (normalizedKey.indexOf("base64") >= 0) {
      return "[BASE64 DATA, " + value.length + " chars]";
    }
    if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(value)) {
      const commaIndex = value.indexOf(",");
      const mimeType = value.slice(5, value.indexOf(";", 5));
      const base64Length = commaIndex >= 0 ? value.length - commaIndex - 1 : value.length;
      return "[BASE64 IMAGE " + mimeType + ", " + base64Length + " chars]";
    }
    if (value.length > 2000) {
      return value.slice(0, 500) + "... [TRUNCATED, " + value.length + " chars]";
    }
    return value;
  }
  if (Array.isArray(value)) {
    const safeArray = [];
    const arrayLimit = Math.min(value.length, 20);
    for (let index = 0; index < arrayLimit; index += 1) {
      safeArray.push(createSafeLogValue(value[index], keyName));
    }
    if (value.length > arrayLimit) {
      safeArray.push("... [" + (value.length - arrayLimit) + " items omitted]");
    }
    return safeArray;
  }
  if (value && typeof value === "object") {
    const safeObject = {};
    const keys = Object.keys(value);
    const objectLimit = Math.min(keys.length, 50);
    for (let index = 0; index < objectLimit; index += 1) {
      const childKey = keys[index];
      safeObject[childKey] = createSafeLogValue(value[childKey], childKey);
    }
    if (keys.length > objectLimit) {
      safeObject.__omitted_keys__ = keys.length - objectLimit;
    }
    return safeObject;
  }
  return value;
}

/** Map one lifecycle direction to the transport flow shown by server/logs. */
function resolveLogFlow(direction) {
  const normalizedDirection = String(direction || "INFO").toUpperCase();
  if (normalizedDirection === "RECEIVE" || normalizedDirection === "RECEIVE BODY") {
    return { key: "frontend_request", label: "前端 → 后端" };
  }
  if (normalizedDirection === "BROADCAST") {
    return { key: "backend_broadcast", label: "后端 → 前端广播" };
  }
  if (normalizedDirection === "OUTBOUND" || normalizedDirection === "UPSTREAM") {
    return { key: "backend_proxy", label: "后端 → 上游中转" };
  }
  if (normalizedDirection === "SEND" || normalizedDirection === "DONE") {
    return { key: "backend_response", label: "后端 → 前端响应" };
  }
  return { key: "system", label: "服务器内部" };
}

/** Send one new server log entry to every connected log page. */
function broadcastServerLogEntry(entry) {
  const message = "data: " + JSON.stringify(entry) + "\n\n";
  for (let index = serverLogClients.length - 1; index >= 0; index -= 1) {
    try {
      serverLogClients[index].write(message);
    } catch (error) {
      serverLogClients.splice(index, 1);
    }
  }
}

/** Print and retain one structured server event in real time. */
function writeServerLog(direction, label, payload, requestId) {
  const time = formatCacheTime(new Date());
  const normalizedRequestId = String(requestId || "-");
  const flow = resolveLogFlow(direction);
  const safePayload = payload === undefined ? null : createSafeLogValue(payload, "");
  const entry = {
    event_id: ++serverLogSequence,
    time: time,
    request_id: normalizedRequestId,
    direction: String(direction || "INFO"),
    flow: flow.key,
    flow_label: flow.label,
    label: String(label || ""),
    payload: safePayload
  };
  const prefix = "[" + time + "]"
    + " [" + normalizedRequestId + "]"
    + " [" + flow.label + "]"
    + " [" + direction + "] " + label;
  serverLogEntries.push(entry);
  if (serverLogEntries.length > maxServerLogEntries) {
    serverLogEntries.splice(0, serverLogEntries.length - maxServerLogEntries);
  }
  console.log(prefix);
  if (payload !== undefined) {
    console.log(JSON.stringify(safePayload, null, 2));
  }
  broadcastServerLogEntry(entry);
}

/** Read the persistent cache file, returning an empty payload when it is absent. */
function readCachePayload(callback) {
  fs.readFile(cacheFilePath, "utf8", function handleCacheRead(error, content) {
    if (error) {
      callback(null, createEmptyCachePayload());
      return;
    }
    try {
      const payload = JSON.parse(content);
      callback(null, payload && typeof payload === "object" ? payload : createEmptyCachePayload());
    } catch (parseError) {
      callback(parseError, createEmptyCachePayload());
    }
  });
}

/** Send a JSON response with the local API CORS headers. */
function sendJson(response, statusCode, payload) {
  let responsePayload = payload;
  const requestId = response.getHeader("X-Request-Id");
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    responsePayload = Object.assign({}, payload);
    if (requestId && !responsePayload.request_id) {
      responsePayload.request_id = String(requestId);
    }
  }
  if (!response.skipPayloadLog) {
    writeServerLog(
      "SEND",
      String(response.apiRequestLabel || "API response") + " -> " + statusCode,
      responsePayload,
      requestId
    );
  }
  response.writeHead(statusCode, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-cache"
  });
  response.end(JSON.stringify(responsePayload));
}

/** Read a complete request body from a local cache update request. */
function readRequestBody(request, callback) {
  const chunks = [];
  request.on("data", function handleRequestData(chunk) {
    chunks.push(chunk);
  });
  request.on("end", function handleRequestEnd() {
    callback(Buffer.concat(chunks).toString("utf8"));
  });
}

/** Read a complete request body as a Buffer for multipart API requests. */
function readRequestBuffer(request, callback) {
  const chunks = [];
  request.on("data", function handleRequestBufferData(chunk) {
    chunks.push(chunk);
  });
  request.on("end", function handleRequestBufferEnd() {
    callback(Buffer.concat(chunks));
  });
}

/** Create a short request identifier suitable for local API debugging. */
function createApiRequestId() {
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

/** Store one server-side operation snapshot and return its one-time undo token. */
function createOperationUndoToken(type, payload) {
  const token = type + "-" + createApiRequestId() + "-" + Math.random().toString(36).slice(2, 8);
  operationUndoEntries[token] = {
    type: String(type || ""),
    payload: payload,
    created_at: formatCacheTime(new Date())
  };
  operationUndoOrder.push(token);
  while (operationUndoOrder.length > maxOperationUndoEntries) {
    const expiredToken = operationUndoOrder.shift();
    delete operationUndoEntries[expiredToken];
  }
  return token;
}

/** Consume and remove one matching server-side undo snapshot. */
function consumeOperationUndoToken(token, type) {
  const normalizedToken = String(token || "").trim();
  const entry = operationUndoEntries[normalizedToken];
  if (!entry || entry.type !== String(type || "")) {
    return null;
  }
  delete operationUndoEntries[normalizedToken];
  for (let index = 0; index < operationUndoOrder.length; index += 1) {
    if (operationUndoOrder[index] === normalizedToken) {
      operationUndoOrder.splice(index, 1);
      break;
    }
  }
  return entry.payload;
}

/** Start tracking one local API request without recording credentials or bodies. */
function startApiRequestTrace(request, response) {
  const requestUrl = new URL(request.url || "/", "http://127.0.0.1:" + port);
  if (requestUrl.pathname.indexOf("/api/") !== 0) {
    return;
  }
  if (request.skipLegacyTrace) {
    return;
  }
  const startedAt = Date.now();
  const hasExternalTrace = Boolean(request.requestId);
  const requestId = String(request.requestId || createApiRequestId());
  request.apiRequestId = requestId;
  if (!response.apiRequestLabel) {
    response.apiRequestLabel = String(request.method || "GET") + " " + requestUrl.pathname;
  }
  response.setHeader("X-Request-Id", requestId);
  if (!hasExternalTrace) {
    writeServerLog(
      "RECEIVE",
      String(request.method || "GET") + " " + requestUrl.pathname + requestUrl.search,
      undefined,
      requestId
    );
  }
  /** Store a completed API request summary for the local debug endpoint. */
  response.on("finish", function handleApiRequestFinished() {
    apiRequestLogs.unshift({
      request_id: requestId,
      method: String(request.method || "GET"),
      path: requestUrl.pathname,
      status: response.statusCode,
      duration_ms: Date.now() - startedAt,
      time: formatCacheTime(new Date())
    });
    if (apiRequestLogs.length > maxApiRequestLogs) {
      apiRequestLogs.length = maxApiRequestLogs;
    }
    if (!hasExternalTrace) {
      writeServerLog(
        "DONE",
        String(request.method || "GET") + " " + requestUrl.pathname,
        { status: response.statusCode, duration_ms: Date.now() - startedAt },
        requestId
      );
    }
  });
}

/** Return the request identifier assigned by the local API tracer. */
function getApiRequestId(request) {
  return String(request && (request.apiRequestId || request.requestId) || "");
}

/** Notify all real-time Vue clients that the cache file changed. */
function broadcastCachePayload(payload, requestId) {
  const message = "data: " + JSON.stringify(payload) + "\n\n";
  const subscriberCount = eventClients.length;
  let deliveredCount = 0;
  for (let index = eventClients.length - 1; index >= 0; index -= 1) {
    try {
      eventClients[index].write(message);
      deliveredCount += 1;
    } catch (error) {
      eventClients.splice(index, 1);
    }
  }
  writeServerLog("BROADCAST", "Cache SSE broadcast", {
    stream: "product-cache",
    subscriber_count: subscriberCount,
    delivered_count: deliveredCount,
    version: payload && payload.version,
    record_count: payload && Array.isArray(payload.records) ? payload.records.length : 0,
    update_instruction: payload && payload.update_instruction ? payload.update_instruction : null
  }, requestId);
}

/** Persist a cache update and broadcast it to connected Vue clients. */
function writeCachePayload(payload, callback, requestId) {
  fs.writeFile(cacheFilePath, JSON.stringify(payload, null, 2), "utf8", function handleCacheWrite(error) {
    if (!error) {
      broadcastCachePayload(payload, requestId);
    }
    callback(error);
  });
}

/** Normalize one remote CDN URL and reject unsupported hosts. */
function normalizeRemoteUrl(rawUrl) {
  let value = String(rawUrl || "").trim();
  if (!value) {
    return "";
  }
  value = value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/\\\//g, "/")
    .replace(/[),;}\]]+$/, "");
  if (value.indexOf("//") === 0) {
    value = "https:" + value;
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "";
    }
    if (!isAllowedRemoteHost(parsed.hostname)) {
      return "";
    }
    return parsed.toString();
  } catch (error) {
    return "";
  }
}

/** Limit the local proxy to the product image and detail CDN hosts in use. */
function isAllowedRemoteHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  const suffixes = ["alicdn.com", "kwcdn.com", "tmall.com", "taobao.com"];
  for (let index = 0; index < suffixes.length; index += 1) {
    const suffix = suffixes[index];
    if (host === suffix || host.endsWith("." + suffix)) {
      return true;
    }
  }
  return false;
}

/** Choose the page referer that normally owns one supported CDN resource. */
function getRemoteReferer(remoteUrl) {
  try {
    const hostname = new URL(remoteUrl).hostname.toLowerCase();
    if (hostname.endsWith("kwcdn.com")) {
      return "https://www.temu.com/";
    }
  } catch (error) {
    return "https://detail.1688.com/";
  }
  return "https://detail.1688.com/";
}

/** Build ordinary browser-compatible headers for a product resource request. */
function createRemoteHeaders(remoteUrl, accept) {
  return {
    "Accept": accept,
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
    "Referer": getRemoteReferer(remoteUrl),
    "Sec-Fetch-Dest": accept.indexOf("image/") >= 0 ? "image" : "empty",
    "Sec-Fetch-Mode": "no-cors",
    "Sec-Fetch-Site": "cross-site",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
  };
}

/** Read the local image-edit configuration without exposing its API key. */
function readImageEditConfig() {
  if (!fs.existsSync(imageEditConfigPath)) {
    return null;
  }
  try {
    const content = fs.readFileSync(imageEditConfigPath, "utf8");
    const config = JSON.parse(content);
    return config && typeof config === "object" ? config : null;
  } catch (error) {
    return null;
  }
}

/** Read the shared edits and generation concurrency from server/config.json. */
function getImageTaskConcurrency() {
  const config = readImageEditConfig() || {};
  const queue = config.image_queue && typeof config.image_queue === "object" ? config.image_queue : {};
  const configured = Number(queue.concurrency || config.image_queue_concurrency || 3);
  if (!Number.isFinite(configured) || configured < 1) {
    return 3;
  }
  return Math.max(1, Math.min(32, Math.floor(configured)));
}

/** Build the configured Kimi chat-completions endpoint URL. */
function getKimiEndpoint(config) {
  const kimi = config && config.kimi && typeof config.kimi === "object" ? config.kimi : {};
  const baseurl = String(kimi.baseurl || kimi.baseUrl || "").trim();
  const endpoint = String(kimi.endpoint || "/chat/completions").trim();
  if (!baseurl) {
    return "";
  }
  try {
    return new URL(endpoint.replace(/^\/+/, ""), baseurl.replace(/\/$/, "") + "/").toString();
  } catch (error) {
    return "";
  }
}

/** Normalize one Kimi Listing result to the title field used by the Vue editor. */
function normalizeListingResult(rawListing) {
  const source = rawListing && typeof rawListing === "object" ? rawListing : {};
  return {
    title: String(source.title || "").trim()
  };
}

/** Parse a JSON object from a strict or fenced Kimi response. */
function parseKimiListingContent(content) {
  let text = String(content || "").trim();
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  try {
    return normalizeListingResult(JSON.parse(text));
  } catch (error) {
    const firstBrace = text.indexOf("{");
    const lastBrace = text.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      return normalizeListingResult(JSON.parse(text.slice(firstBrace, lastBrace + 1)));
    }
    throw new Error("Kimi 未返回有效的 Listing JSON。");
  }
}

/** Return a concise upstream Kimi error without exposing credentials. */
function extractKimiError(payload, fallbackText) {
  if (payload && payload.error) {
    if (typeof payload.error === "string") {
      return payload.error;
    }
    if (payload.error.message) {
      return String(payload.error.message);
    }
  }
  const text = String(fallbackText || "").trim();
  return text ? text.slice(0, 300) : "Kimi 合并 Listing 失败。";
}

/** Remove image payloads and oversized nested values before sending Listing data to Kimi. */
function compactListingValue(value, depth) {
  if (depth > 4) {
    return undefined;
  }
  if (typeof value === "string") {
    if (/^data:image\//i.test(value) || /^https?:\/\//i.test(value)) {
      return undefined;
    }
    return value.length > 800 ? value.slice(0, 800) : value;
  }
  if (Array.isArray(value)) {
    const compactArray = [];
    const arrayLimit = Math.min(value.length, 20);
    for (let index = 0; index < arrayLimit; index += 1) {
      const compactItem = compactListingValue(value[index], depth + 1);
      if (compactItem !== undefined) {
        compactArray.push(compactItem);
      }
    }
    return compactArray;
  }
  if (value && typeof value === "object") {
    const compactObject = {};
    const keys = Object.keys(value);
    const objectLimit = Math.min(keys.length, 40);
    for (let index = 0; index < objectLimit; index += 1) {
      const key = keys[index];
      if (/image|img|picture|photo|video|url|binary|base64/i.test(key)) {
        continue;
      }
      const compactChild = compactListingValue(value[key], depth + 1);
      if (compactChild !== undefined) {
        compactObject[key] = compactChild;
      }
    }
    return compactObject;
  }
  return value;
}

/** Ask Kimi to merge the selected Temu and 1688 products into strict Listing JSON. */
async function processListingMergeRequest(body, request, response) {
  let input;
  try {
    input = JSON.parse(body || "{}");
  } catch (error) {
    sendJson(response, 400, { ok: false, error: "Listing 合并请求 JSON 格式错误。" });
    return;
  }
  writeServerLog("RECEIVE BODY", "Listing merge input", input, getApiRequestId(request));
  const config = readImageEditConfig();
  const kimi = config && config.kimi && typeof config.kimi === "object" ? config.kimi : {};
  const endpoint = getKimiEndpoint(config);
  if (!endpoint || !kimi.apikey) {
    sendJson(response, 500, { ok: false, error: "server/config.json 未配置 Kimi。" });
    return;
  }
  const rawTemu = input.temu_listing || input.temu;
  const rawAli = input.ali_listing || input["1688"];
  const temu = rawTemu && typeof rawTemu === "object" ? rawTemu : null;
  const ali = rawAli && typeof rawAli === "object" ? rawAli : null;
  if (!temu || !ali) {
    sendJson(response, 400, { ok: false, error: "请选择 Temu 和 1688 商品后再合并。" });
    return;
  }
  const systemPrompt = String(kimi.system_prompt || "").trim();
  const taskPrompt = String(kimi.prompt || "").trim();
  if (!systemPrompt || !taskPrompt) {
    sendJson(response, 500, { ok: false, error: "server/config.json 未配置 Kimi 提示词。" });
    return;
  }
  const compactTemu = compactListingValue(temu, 0);
  const compactAli = compactListingValue(ali, 0);
  const userPrompt = taskPrompt + "\n\nTemu Listing：\n" + JSON.stringify(compactTemu, null, 2) + "\n\n1688 Listing：\n" + JSON.stringify(compactAli, null, 2);
  try {
    const providerRequestPayload = {
      model: String(kimi.model || "kimi-k2.6"),
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      thinking: { type: "disabled" },
      temperature: 0.6,
      response_format: { type: "json_object" }
    };
    writeServerLog(
      "OUTBOUND",
      "Kimi POST " + endpoint,
      providerRequestPayload,
      getApiRequestId(request)
    );
    const configuredTimeout = Number(kimi.timeout_ms || 60000);
    const timeoutMs = Math.max(10000, Math.min(configuredTimeout, 180000));
    const controller = new AbortController();
    const timeoutHandle = setTimeout(function abortKimiRequest() {
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
    writeServerLog(
      "UPSTREAM",
      "Kimi response " + providerResponse.status,
      Object.keys(providerPayload).length ? providerPayload : providerText,
      getApiRequestId(request)
    );
    if (!providerResponse.ok) {
      sendJson(response, 502, { ok: false, error: extractKimiError(providerPayload, providerText) });
      return;
    }
    const choices = Array.isArray(providerPayload.choices) ? providerPayload.choices : [];
    const message = choices.length && choices[0].message ? choices[0].message : {};
    const listing = parseKimiListingContent(message.content);
    if (!listing.title) {
      sendJson(response, 502, { ok: false, error: "Kimi 返回的 Listing 缺少标题。" });
      return;
    }
    const undoToken = createOperationUndoToken("listing", {
      listing: normalizeListingResult(temu)
    });
    sendJson(response, 200, {
      ok: true,
      request_id: getApiRequestId(request),
      provider: "kimi",
      model: String(kimi.model || "kimi-k2.6"),
      listing: listing,
      undo_token: undoToken
    });
  } catch (error) {
    if (error && error.name === "AbortError") {
      writeServerLog("UPSTREAM", "Kimi request timeout", { timeout_ms: Number(kimi.timeout_ms || 60000) }, getApiRequestId(request));
      sendJson(response, 504, { ok: false, error: "Kimi 请求超时，请稍后重试。" });
      return;
    }
    sendJson(response, 502, { ok: false, error: error.message || "Kimi 合并 Listing 失败。" });
  }
}

/** Read and dispatch one Kimi Listing merge request body. */
function handleListingMergeRequest(request, response) {
  readRequestBody(request, function handleListingMergeBody(body) {
    processListingMergeRequest(body, request, response);
  });
}

/** Restore the original Listing snapshot through the server API. */
function processListingUndoRequest(body, request, response) {
  let input;
  try {
    input = JSON.parse(body || "{}");
  } catch (error) {
    sendJson(response, 400, { ok: false, error: "Listing 返回请求 JSON 格式错误。" });
    return;
  }
  writeServerLog("RECEIVE BODY", "Listing undo input", input, getApiRequestId(request));
  const snapshot = consumeOperationUndoToken(input.undo_token, "listing");
  if (!snapshot) {
    sendJson(response, 404, { ok: false, error: "Listing 返回记录不存在或已经使用。" });
    return;
  }
  sendJson(response, 200, {
    ok: true,
    request_id: getApiRequestId(request),
    listing: normalizeListingResult(snapshot.listing)
  });
}

/** Read and dispatch one Listing undo API request. */
function handleListingUndoRequest(request, response) {
  readRequestBody(request, function handleListingUndoBody(body) {
    processListingUndoRequest(body, request, response);
  });
}

/** Normalize one configured image-edit size to the values accepted by the service. */
function normalizeImageEditSize(rawSize) {
  const requested = String(rawSize || "1k").trim().toLowerCase();
  const sizes = ["1k", "2k", "4K"];
  for (let index = 0; index < sizes.length; index += 1) {
    if (sizes[index].toLowerCase() === requested) {
      return sizes[index];
    }
  }
  return "1k";
}

/** Return only non-secret image-edit settings for the Vue control. */
function getPublicImageEditConfig() {
  const config = readImageEditConfig() || {};
  const prices = {};
  const sizes = ["1k", "2k", "4K"];
  const configuredPrices = config.price && typeof config.price === "object" ? config.price : {};
  for (let index = 0; index < sizes.length; index += 1) {
    const size = sizes[index];
    if (configuredPrices[size] !== undefined) {
      prices[size] = configuredPrices[size];
    }
  }
  return {
    ok: true,
    model: String(config.model || ""),
    sizes: sizes,
    prices: prices,
    edit_prompt: String(config.edit_prompt || ""),
    fusion_prompt: String(config.fusion_prompt || "")
  };
}

/** Decode one browser data URL into an image buffer for multipart upload. */
function readDataImageSource(rawSource) {
  const value = String(rawSource || "").trim();
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\r\n]+)$/i.exec(value);
  if (!match) {
    return null;
  }
  const buffer = Buffer.from(match[2].replace(/[\r\n\s]/g, ""), "base64");
  if (!buffer.length) {
    return null;
  }
  return {
    buffer: buffer,
    mimeType: match[1].toLowerCase()
  };
}

/** Return the MIME type represented by one cached image filename. */
function getCachedImageMimeType(filePath) {
  const extension = path.extname(String(filePath || "")).toLowerCase();
  const mimeTypes = {
    ".avif": "image/avif",
    ".bmp": "image/bmp",
    ".gif": "image/gif",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp"
  };
  return mimeTypes[extension] || "";
}

/** Resolve one public cache image URL without allowing access outside the image cache. */
function resolveCachedImagePath(rawSource, cacheRoot) {
  const publicPrefix = "/api/v1/cache/image/";
  const value = String(rawSource || "").trim();
  let publicPath = value;
  if (!value) {
    return "";
  }
  if (/^https?:\/\//i.test(value)) {
    try {
      const sourceUrl = new URL(value);
      const hostname = sourceUrl.hostname.toLowerCase();
      if (hostname !== "127.0.0.1" && hostname !== "localhost" && hostname !== "[::1]") {
        return "";
      }
      publicPath = sourceUrl.pathname;
    } catch (error) {
      return "";
    }
  } else {
    publicPath = value.split(/[?#]/)[0];
  }
  if (publicPath.indexOf(publicPrefix) !== 0) {
    return "";
  }
  let relativePath = "";
  try {
    relativePath = decodeURIComponent(publicPath.slice(publicPrefix.length));
  } catch (error) {
    return "";
  }
  if (!relativePath || relativePath.indexOf("\0") >= 0) {
    return "";
  }
  const resolvedRoot = path.resolve(cacheRoot || imageCacheDirectory);
  const resolvedPath = path.resolve(resolvedRoot, relativePath.replace(/\//g, path.sep));
  if (resolvedPath !== resolvedRoot && resolvedPath.indexOf(resolvedRoot + path.sep) !== 0) {
    return "";
  }
  return resolvedPath;
}

/** Read one image from the public local cache URL into a multipart source. */
function readCachedImageSource(rawSource, cacheRoot) {
  const filePath = resolveCachedImagePath(rawSource, cacheRoot);
  const mimeType = getCachedImageMimeType(filePath);
  if (!filePath || !mimeType || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return null;
  }
  const buffer = fs.readFileSync(filePath);
  if (!buffer.length) {
    return null;
  }
  return {
    buffer: buffer,
    mimeType: mimeType
  };
}

/** Read one base64, local cache, or remote image before calling an upstream API. */
async function readImageEditSource(rawSource, requestId) {
  const dataSource = readDataImageSource(rawSource);
  if (dataSource) {
    return dataSource;
  }
  const cachedSource = readCachedImageSource(rawSource);
  if (cachedSource) {
    return cachedSource;
  }
  const sourceUrl = normalizeRemoteUrl(rawSource);
  if (!sourceUrl) {
    throw new Error("图片不是有效的 base64、本地缓存或远程图片地址。");
  }
  writeServerLog("OUTBOUND", "Fusion source image GET", { url: sourceUrl }, requestId);
  const imageResponse = await fetch(sourceUrl, {
    method: "GET",
    headers: createRemoteHeaders(sourceUrl, "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.9,*/*;q=0.5"),
    redirect: "follow"
  });
  const contentType = String(imageResponse.headers.get("content-type") || "image/jpeg").split(";")[0].trim();
  if (!imageResponse.ok) {
    writeServerLog(
      "UPSTREAM",
      "Fusion source image response " + imageResponse.status,
      { url: sourceUrl, content_type: contentType },
      requestId
    );
    throw new Error("SKU 图片读取失败（HTTP " + imageResponse.status + "）。");
  }
  const buffer = Buffer.from(await imageResponse.arrayBuffer());
  if (!buffer.length || contentType.indexOf("image/") !== 0) {
    throw new Error("SKU 图片响应不是有效图片。");
  }
  writeServerLog(
    "UPSTREAM",
    "Fusion source image response " + imageResponse.status,
    { url: sourceUrl, content_type: contentType, bytes: buffer.length },
    requestId
  );
  return {
    buffer: buffer,
    mimeType: contentType
  };
}

/** Build the configured image-edit endpoint URL without logging its credentials. */
function getImageEditEndpoint(config) {
  const baseurl = String(config && config.baseurl || "").trim();
  const endpoint = String(config && config.endpoint || "").trim();
  if (!baseurl || !endpoint) {
    return "";
  }
  try {
    return new URL(endpoint, baseurl).toString();
  } catch (error) {
    return "";
  }
}

/** Convert one generated-image response candidate into a browser image source. */
function readGeneratedImageCandidate(candidate, mimeType) {
  if (candidate && typeof candidate === "object") {
    const candidateMimeType = candidate.mime_type || candidate.mimeType || mimeType;
    const encoded = candidate.b64_json || candidate.base64 || candidate.data;
    if (encoded && typeof encoded === "string") {
      return readGeneratedImageCandidate(encoded, candidateMimeType);
    }
    const imageUrl = candidate.url || candidate.image_url || candidate.imageUrl;
    if (imageUrl) {
      return String(imageUrl).trim();
    }
    return "";
  }
  const value = String(candidate || "").trim();
  if (!value) {
    return "";
  }
  if (value.indexOf("data:image/") === 0 || /^https?:\/\//i.test(value)) {
    return value;
  }
  if (value.length > 16 && /^[a-z0-9+/=\r\n]+$/i.test(value)) {
    return "data:" + String(mimeType || "image/png") + ";base64," + value.replace(/[\r\n\s]/g, "");
  }
  return "";
}

/** Extract a base64 image or URL from common OpenAI-compatible edit responses. */
function extractGeneratedImageData(payload) {
  if (!payload || typeof payload !== "object") {
    return "";
  }
  const outputMimeType = payload.output_format ? "image/" + String(payload.output_format).toLowerCase() : "image/png";
  if (Array.isArray(payload.data)) {
    for (let index = 0; index < payload.data.length; index += 1) {
      const image = readGeneratedImageCandidate(payload.data[index], outputMimeType);
      if (image) {
        return image;
      }
    }
  }
  const candidateNames = ["b64_json", "base64", "image_url", "imageUrl", "url", "image", "output", "result", "data"];
  for (let index = 0; index < candidateNames.length; index += 1) {
    const image = readGeneratedImageCandidate(payload[candidateNames[index]], outputMimeType);
    if (image) {
      return image;
    }
  }
  return "";
}

/** Return a short provider error without leaking request credentials to the browser. */
function extractImageEditError(payload, fallbackText) {
  if (payload && payload.error) {
    if (typeof payload.error === "string") {
      return payload.error;
    }
    if (payload.error.message) {
      return String(payload.error.message);
    }
  }
  const text = String(fallbackText || "").trim();
  return text ? text.slice(0, 300) : "溶图服务没有返回图片。";
}

/** Process one image-edit request and return its generated image to the Vue page. */
async function executeImageEditRequest(body, request, response, mode) {
  let input;
  try {
    input = JSON.parse(body || "{}");
  } catch (error) {
    sendJson(response, 400, { ok: false, error: "溶图请求 JSON 格式错误。" });
    return;
  }
  const requestMode = mode === "edit" ? "edit" : "fusion";
  writeServerLog("RECEIVE BODY", requestMode === "edit" ? "Image edit input" : "Image fusion input", input, getApiRequestId(request));
  const config = readImageEditConfig();
  if (!config || !config.apikey || !getImageEditEndpoint(config)) {
    sendJson(response, 500, { ok: false, error: "server/config.json 未配置完整。" });
    return;
  }
  const imageUrls = Array.isArray(input.image_urls) ? input.image_urls : Array.isArray(input.images) ? input.images : [];
  const expectedImageCount = requestMode === "edit" ? 1 : 2;
  if (imageUrls.length !== expectedImageCount) {
    sendJson(response, 400, { ok: false, error: requestMode === "edit" ? "单图编辑必须提交一张图片。" : "溶图必须提交两张图片。" });
    return;
  }
  const defaultPrompt = requestMode === "edit" ? config.edit_prompt : config.fusion_prompt;
  const prompt = String(input.prompt || defaultPrompt || "").trim();
  if (!prompt) {
    sendJson(response, 400, { ok: false, error: "图片编辑提示词不能为空。" });
    return;
  }
  const size = normalizeImageEditSize(input.size);
  let requestStage = "prepare_images";
  try {
    const form = new FormData();
    const preparedImages = [];
    form.append("model", String(config.model || "gpt-image-2"));
    form.append("prompt", prompt);
    form.append("size", size);
    form.append("n", "1");
    for (let index = 0; index < imageUrls.length; index += 1) {
      const source = await readImageEditSource(imageUrls[index], getApiRequestId(request));
      const blob = new Blob([source.buffer], { type: source.mimeType });
      form.append("image", blob, "blend-" + (index + 1) + "." + source.mimeType.split("/")[1]);
      preparedImages.push({
        index: index + 1,
        mime_type: source.mimeType,
        bytes: source.buffer.length,
        base64_chars: source.buffer.toString("base64").length
      });
    }
    writeServerLog(
      "OUTBOUND",
      "BeeAPI " + (requestMode === "edit" ? "edit" : "fusion") + " POST " + getImageEditEndpoint(config),
      {
        model: String(config.model || "gpt-image-2"),
        prompt: prompt,
        size: size,
        n: 1,
        images: preparedImages
      },
      getApiRequestId(request)
    );
    requestStage = "beeapi_request";
    const providerResponse = await fetch(getImageEditEndpoint(config), {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + String(config.apikey)
      },
      body: form
    });
    const providerText = await providerResponse.text();
    let providerPayload = {};
    try {
      providerPayload = JSON.parse(providerText || "{}");
    } catch (error) {
      providerPayload = {};
    }
    writeServerLog(
      "UPSTREAM",
      "BeeAPI response " + providerResponse.status,
      Object.keys(providerPayload).length ? providerPayload : providerText,
      getApiRequestId(request)
    );
    if (!providerResponse.ok) {
      sendJson(response, 502, { ok: false, error: extractImageEditError(providerPayload, providerText) });
      return;
    }
    let imageUrl = extractGeneratedImageData(providerPayload);
    if (!imageUrl) {
      sendJson(response, 502, { ok: false, error: "溶图服务已响应，但没有找到生成图片。" });
      return;
    }
    requestStage = "generated_image_cache";
    imageUrl = await generatedImageCache.cacheImage(imageUrl, "transfer", "generated", true);
    const prices = config.price && typeof config.price === "object" ? config.price : {};
    const undoToken = createOperationUndoToken("image-fusion", {
      image_urls: imageUrls.slice()
    });
    sendJson(response, 200, {
      ok: true,
      request_id: getApiRequestId(request),
      provider: "beeapi",
      mode: requestMode,
      model: String(config.model || "gpt-image-2"),
      image_url: imageUrl,
      size: size,
      price: prices[size] === undefined ? null : prices[size],
      undo_token: undoToken
    });
  } catch (error) {
    const stageMessages = {
      prepare_images: "本地图片读取或转换失败",
      beeapi_request: "BeeAPI 网络请求失败",
      generated_image_cache: "生成图片下载缓存失败"
    };
    const stageMessage = stageMessages[requestStage] || "溶图请求失败";
    const cause = error && error.cause && error.cause.message ? String(error.cause.message) : "";
    writeServerLog(
      "ERROR",
      stageMessage,
      { message: error && error.message ? error.message : "", cause: cause },
      getApiRequestId(request)
    );
    sendJson(response, 502, {
      ok: false,
      error: stageMessage + "：" + (cause || error.message || "未知错误。")
    });
  }
}

/** Queue one edits or fusion provider request behind the shared image limit. */
function processImageEditRequest(body, request, response, mode) {
  const requestId = getApiRequestId(request);
  imageTaskQueue.run(function executeQueuedImageEdit() {
    return executeImageEditRequest(body, request, response, mode);
  }, { type: "edits", request_id: requestId }).catch(function handleQueuedImageEditError(error) {
    if (response.writableEnded) {
      return;
    }
    sendJson(response, 502, {
      ok: false,
      error: error && error.message ? error.message : "图片服务请求失败。"
    });
  });
}

/** Read and dispatch one local image-edit request body. */
function handleImageEditRequest(request, response) {
  readRequestBody(request, function handleImageEditBody(body) {
    processImageEditRequest(body, request, response, "edit");
  });
}

/** Restore the two original SKU images through the server API. */
function processImageFusionUndoRequest(body, request, response) {
  let input;
  try {
    input = JSON.parse(body || "{}");
  } catch (error) {
    sendJson(response, 400, { ok: false, error: "溶图返回请求 JSON 格式错误。" });
    return;
  }
  writeServerLog("RECEIVE BODY", "Image fusion undo input", input, getApiRequestId(request));
  const snapshot = consumeOperationUndoToken(input.undo_token, "image-fusion");
  if (!snapshot) {
    sendJson(response, 404, { ok: false, error: "溶图返回记录不存在或已经使用。" });
    return;
  }
  sendJson(response, 200, {
    ok: true,
    request_id: getApiRequestId(request),
    image_urls: Array.isArray(snapshot.image_urls) ? snapshot.image_urls : []
  });
}

/** Read and dispatch one image-fusion undo API request. */
function handleImageFusionUndoRequest(request, response) {
  readRequestBody(request, function handleImageFusionUndoBody(body) {
    processImageFusionUndoRequest(body, request, response);
  });
}

/** Parse two multipart image files using Node's standards-based FormData parser. */
async function parseImageFusionMultipart(request, bodyBuffer) {
  const contentType = String(request.headers["content-type"] || "");
  const formRequest = new Request("http://127.0.0.1/image-fusion", {
    method: "POST",
    headers: { "Content-Type": contentType },
    body: bodyBuffer
  });
  const form = await formRequest.formData();
  const entries = form.getAll("image");
  const images = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry || typeof entry.arrayBuffer !== "function") {
      continue;
    }
    const buffer = Buffer.from(await entry.arrayBuffer());
    const mimeType = String(entry.type || "image/jpeg");
    images.push("data:" + mimeType + ";base64," + buffer.toString("base64"));
  }
  return {
    images: images,
    prompt: String(form.get("prompt") || ""),
    size: String(form.get("size") || "1k")
  };
}

/** Accept image fusion as source-compatible multipart files or JSON base64. */
function handleImageFusionRequest(request, response) {
  const contentType = String(request.headers["content-type"] || "").toLowerCase();
  if (contentType.indexOf("multipart/form-data") >= 0) {
    readRequestBuffer(request, function handleImageFusionBuffer(bodyBuffer) {
      parseImageFusionMultipart(request, bodyBuffer).then(function handleParsedImageFusion(input) {
        processImageEditRequest(JSON.stringify(input), request, response, "fusion");
      }).catch(function handleImageFusionParseError(error) {
        sendJson(response, 400, { ok: false, error: error.message || "multipart 图片解析失败。" });
      });
    });
    return;
  }
  readRequestBody(request, function handleImageFusionBody(body) {
    processImageEditRequest(body, request, response, "fusion");
  });
}

/** Reply to a CORS preflight request for the local image-edit APIs. */
function sendApiOptions(response) {
  response.writeHead(204, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
  });
  response.end();
}

/** Extract product detail image URLs from HTML or JSON-wrapped detail content. */
function extractDetailImageUrls(content) {
  const text = String(content || "")
    .replace(/\\"/g, '"')
    .replace(/\\\//g, "/")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"');
  const patterns = [
    /(?:src|data-src|data-original|data-lazy-src|data-ks-lazyload)\s*[:=]\s*["']([^"']+)["']/gi,
    /https?:\/\/[^"'\\\s<>]+/gi
  ];
  const result = [];
  const seen = {};
  for (let patternIndex = 0; patternIndex < patterns.length; patternIndex += 1) {
    const pattern = patterns[patternIndex];
    let match = pattern.exec(text);
    while (match) {
      const candidate = match[1] || match[0] || "";
      const imageUrl = normalizeRemoteUrl(candidate);
      if (imageUrl && /\.(?:jpg|jpeg|png|webp|gif)(?:[?#]|$)/i.test(imageUrl) && !seen[imageUrl]) {
        seen[imageUrl] = true;
        result.push(imageUrl);
      }
      match = pattern.exec(text);
    }
  }
  return result;
}

/** Read one product detail description and return its image URL list without persistence. */
async function handleDetailImagesRequest(request, response) {
  const requestUrl = new URL(request.url || "/", "http://127.0.0.1:" + port);
  const detailUrl = normalizeRemoteUrl(requestUrl.searchParams.get("url"));
  if (!detailUrl) {
    sendJson(response, 400, { ok: false, error: "详情描述地址无效。" });
    return;
  }
  try {
    writeServerLog(
      "OUTBOUND",
      "Detail image GET",
      { url: detailUrl },
      getApiRequestId(request)
    );
    const remoteResponse = await fetch(detailUrl, {
      headers: createRemoteHeaders(detailUrl, "text/html,application/json;q=0.9,*/*;q=0.8")
    });
    if (!remoteResponse.ok) {
      throw new Error("详情描述请求失败：" + remoteResponse.status);
    }
    const content = await remoteResponse.text();
    const imageUrls = extractDetailImageUrls(content);
    writeServerLog(
      "UPSTREAM",
      "Detail image response " + remoteResponse.status,
      { content_chars: content.length, image_count: imageUrls.length, image_urls: imageUrls },
      getApiRequestId(request)
    );
    sendJson(response, 200, {
      ok: true,
      cached: false,
      image_urls: imageUrls
    });
  } catch (error) {
    sendJson(response, 502, { ok: false, error: error.message || "详情描述读取失败。" });
  }
}

/** Return non-secret provider and route readiness for local debugging. */
function getApiHealthPayload(request) {
  const config = readImageEditConfig() || {};
  const kimi = config.kimi && typeof config.kimi === "object" ? config.kimi : {};
  return {
    ok: true,
    request_id: getApiRequestId(request),
    service: "temu-1688-local-api",
    time: formatCacheTime(new Date()),
    providers: {
      kimi: {
        configured: Boolean(kimi.apikey && getKimiEndpoint(config)),
        model: String(kimi.model || "")
      },
      beeapi: {
        configured: Boolean(config.apikey && getImageEditEndpoint(config)),
        model: String(config.model || "")
      }
    }
  };
}

/** Describe the two public local API modules and their accepted payloads. */
function getApiDocsPayload(request) {
  return {
    ok: true,
    request_id: getApiRequestId(request),
    base_url: "http://127.0.0.1:" + port,
    endpoints: {
      health: {
        method: "GET",
        path: "/api/health"
      },
      listing_merge: {
        method: "POST",
        path: "/api/listing/merge",
        content_type: "application/json",
        body: {
          temu_listing: { title: "Temu 标题" },
          ali_listing: { title: "1688 标题" }
        },
        response: { ok: true, request_id: "...", undo_token: "...", listing: { title: "" } }
      },
      listing_undo: {
        method: "POST",
        path: "/api/listing/undo",
        content_type: "application/json",
        body: { undo_token: "Listing 合并返回的 token" }
      },
      image_fusion_json: {
        method: "POST",
        path: "/api/image/fusion",
        content_type: "application/json",
        body: { images: ["data:image/png;base64,...", "data:image/png;base64,..."], size: "1k" }
      },
      image_edit_json: {
        method: "POST",
        path: "/api/image/edits",
        content_type: "application/json",
        body: { images: ["data:image/png;base64,..."], prompt: "单图编辑提示词", size: "1k" }
      },
      image_fusion_multipart: {
        method: "POST",
        path: "/api/image/fusion",
        content_type: "multipart/form-data",
        fields: ["size", "image(文件1)", "image(文件2)"]
      },
      image_fusion_undo: {
        method: "POST",
        path: "/api/image/fusion/undo",
        content_type: "application/json",
        body: { undo_token: "溶图返回的 token" }
      },
      request_logs: {
        method: "GET",
        path: "/api/debug/requests",
        note: "只记录方法、路径、状态、耗时和 request_id，不记录密钥、请求体或 base64。"
      },
      terminal_logs: {
        command: "npm run dev",
        directions: ["RECEIVE", "RECEIVE BODY", "OUTBOUND", "UPSTREAM", "SEND", "DONE"],
        page: "/server/logs",
        history_api: "/api/debug/logs",
        events_api: "/api/debug/logs/events",
        note: "终端和日志页实时打印 API 收发及上游调用；API Key 会脱敏，Base64 图片只打印类型和长度。"
      }
    }
  };
}

/** Open a Server-Sent Events connection for the dedicated server log page. */
function handleServerLogEventsRequest(request, response) {
  response.writeHead(200, {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive"
  });
  response.write("retry: 1000\n\n");
  serverLogClients.push(response);
  /** Remove one disconnected log page from the live stream. */
  request.on("close", function handleServerLogClientClose() {
    const index = serverLogClients.indexOf(response);
    if (index >= 0) {
      serverLogClients.splice(index, 1);
    }
  });
}

/** Return the shared intelligent-packing domain service. */
function getWorkflowService() {
  if (!workflowService) {
    workflowService = createWorkflowService({
      cacheDirectory: cacheDirectory,
      readConfig: readImageEditConfig,
      getKimiEndpoint: getKimiEndpoint,
      compactValue: compactListingValue,
      readImageSource: readImageEditSource,
      cacheGeneratedImage: cacheWorkflowGeneratedImage,
      imageTaskQueue: imageTaskQueue,
      writeLog: writeServerLog,
      formatTime: formatCacheTime
    });
  }
  return workflowService;
}

/** Persist one workflow-generated image so later 1688 searches always read a local source. */
async function cacheWorkflowGeneratedImage(source) {
  return generatedImageCache.cacheImage(source, "transfer", "generated", true);
}

/** Return the shared server-side Temu and 1688 binding service. */
function getBindingService() {
  if (!bindingService) {
    bindingService = createBindingService({
      cacheDirectory: cacheDirectory,
      formatTime: formatCacheTime
    });
  }
  return bindingService;
}

/** Add a transient binding-completed instruction to one cache SSE payload. */
function createBindingCacheUpdate(cachePayload, binding) {
  const payload = cachePayload && typeof cachePayload === "object" ? cachePayload : { records: [] };
  const source = binding && typeof binding === "object" ? binding : {};
  payload.update_instruction = {
    type: "binding_completed",
    temu_main_id: String(source.temu_main_id || ""),
    temu_platform_id: String(source.temu_platform_id || ""),
    ali_main_id: String(source.ali_main_id || ""),
    ali_platform_id: String(source.ali_platform_id || "")
  };
  return payload;
}

/** Read one workflow request body and dispatch it to the domain service. */
function handleWorkflowOperation(request, response, operationName, logLabel) {
  readRequestBody(request, function handleWorkflowOperationBody(body) {
    let input;
    try {
      input = JSON.parse(body || "{}");
    } catch (error) {
      sendJson(response, 400, { ok: false, error: "智能组货请求 JSON 格式错误。" });
      return;
    }
    const requestId = getApiRequestId(request);
    writeServerLog("RECEIVE BODY", logLabel, input, requestId);
    let operationResult;
    try {
      operationResult = getWorkflowService()[operationName](input, requestId);
    } catch (error) {
      sendJson(response, Number(error.statusCode || 500), { ok: false, error: error.message || "智能组货请求失败。" });
      return;
    }
    Promise.resolve(operationResult)
      .then(function handleWorkflowOperationSuccess(payload) {
        sendJson(response, 200, payload);
      })
      .catch(function handleWorkflowOperationFailure(error) {
        sendJson(response, Number(error.statusCode || 502), { ok: false, error: error.message || "智能组货请求失败。" });
      });
  });
}

/** Persist one Temu-to-1688 binding before completing its workflow task. */
function handleWorkflowBindingOperation(request, response) {
  readRequestBody(request, function handleWorkflowBindingBody(body) {
    let input;
    try {
      input = JSON.parse(body || "{}");
    } catch (error) {
      sendJson(response, 400, { ok: false, error: "绑定请求 JSON 格式错误。" });
      return;
    }
    const requestId = getApiRequestId(request);
    writeServerLog("RECEIVE BODY", "Workflow binding input", input, requestId);
    try {
      const binding = getBindingService().bindTemuTo1688(input);
      const payload = getWorkflowService().complete(input, requestId);
      payload.binding = binding;
      broadcastCachePayload(createBindingCacheUpdate(getBindingService().readCachePayload(), binding), requestId);
      sendJson(response, 200, payload);
    } catch (error) {
      sendJson(response, Number(error.statusCode || 500), { ok: false, error: error.message || "服务器绑定失败。" });
    }
  });
}

/** Accept raw 1688 extension data and complete the entire binding on the server. */
function handleWorkflowCollectionBindingOperation(request, response) {
  readRequestBody(request, function handleWorkflowCollectionBindingBody(body) {
    let input;
    try {
      input = JSON.parse(body || "{}");
    } catch (error) {
      sendJson(response, 400, { ok: false, error: "绑定请求 JSON 格式错误。" });
      return;
    }
    const requestId = getApiRequestId(request);
    writeServerLog("RECEIVE BODY", "Extension 1688 binding input", input, requestId);
    try {
      const result = getBindingService().collectAndBind1688(input);
      const workflowPayload = getWorkflowService().complete(result.binding, requestId);
      broadcastCachePayload(createBindingCacheUpdate(result.cache, result.binding), requestId);
      sendJson(response, 200, {
        ok: true,
        workflow_completed: true,
        linked_temu_main_id: result.binding.temu_main_id,
        main_id: result.record.main_id,
        platform_id: result.record.platform_id,
        record: result.record,
        binding: result.binding,
        task: workflowPayload.task
      });
    } catch (error) {
      sendJson(response, Number(error.statusCode || 500), { ok: false, error: error.message || "服务器绑定失败。" });
    }
  });
}

/** Handle the local cache API and the Server-Sent Events stream. */
function handleApiRequest(request, response) {
  const requestUrl = new URL(request.url || "/", "http://127.0.0.1:" + port);
  if (requestUrl.pathname === "/api/health" && request.method === "GET") {
    sendJson(response, 200, getApiHealthPayload(request));
    return true;
  }
  if (requestUrl.pathname === "/api/docs" && request.method === "GET") {
    sendJson(response, 200, getApiDocsPayload(request));
    return true;
  }
  if (requestUrl.pathname === "/api/debug/requests" && request.method === "GET") {
    response.skipPayloadLog = true;
    sendJson(response, 200, { ok: true, request_id: getApiRequestId(request), requests: apiRequestLogs });
    return true;
  }
  if (requestUrl.pathname === "/api/debug/logs" && request.method === "GET") {
    response.skipPayloadLog = true;
    sendJson(response, 200, { ok: true, request_id: getApiRequestId(request), logs: serverLogEntries });
    return true;
  }
  if (requestUrl.pathname === "/api/debug/logs/events" && request.method === "GET") {
    handleServerLogEventsRequest(request, response);
    return true;
  }
  if (requestUrl.pathname === "/api/workflow" && request.method === "GET") {
    sendJson(response, 200, { ok: true, workflow: getWorkflowService().readPayload() });
    return true;
  }
  if (requestUrl.pathname === "/api/workflow/events" && request.method === "GET") {
    getWorkflowService().handleEvents(request, response);
    return true;
  }
  if (requestUrl.pathname === "/api/workflow/active" && request.method === "GET") {
    sendJson(response, 200, getWorkflowService().getActivePayload());
    return true;
  }
  if (requestUrl.pathname.indexOf("/api/workflow/") === 0 && request.method === "OPTIONS") {
    sendApiOptions(response);
    return true;
  }
  if (requestUrl.pathname === "/api/workflow/prompts" && request.method === "POST") {
    handleWorkflowOperation(request, response, "generatePrompts", "Workflow prompt input");
    return true;
  }
  if (requestUrl.pathname === "/api/workflow/generate" && request.method === "POST") {
    handleWorkflowOperation(request, response, "generateImages", "Workflow generation input");
    return true;
  }
  if (requestUrl.pathname === "/api/workflow/search" && request.method === "POST") {
    handleWorkflowOperation(request, response, "searchImage", "Workflow 1688 search input");
    return true;
  }
  if (requestUrl.pathname === "/api/workflow/complete" && request.method === "POST") {
    handleWorkflowBindingOperation(request, response);
    return true;
  }
  if (requestUrl.pathname === "/api/workflow/bind" && request.method === "POST") {
    handleWorkflowCollectionBindingOperation(request, response);
    return true;
  }
  if ((requestUrl.pathname === "/api/listing/merge" || requestUrl.pathname === "/api/listing-merge") && request.method === "OPTIONS") {
    sendApiOptions(response);
    return true;
  }
  if ((requestUrl.pathname === "/api/listing/merge" || requestUrl.pathname === "/api/listing-merge") && request.method === "POST") {
    handleListingMergeRequest(request, response);
    return true;
  }
  if (requestUrl.pathname === "/api/listing/undo" && request.method === "OPTIONS") {
    sendApiOptions(response);
    return true;
  }
  if (requestUrl.pathname === "/api/listing/undo" && request.method === "POST") {
    handleListingUndoRequest(request, response);
    return true;
  }
  if (requestUrl.pathname === "/api/image-edit-config" && request.method === "GET") {
    sendJson(response, 200, getPublicImageEditConfig());
    return true;
  }
  if (requestUrl.pathname === "/api/image/edits" && request.method === "OPTIONS") {
    sendApiOptions(response);
    return true;
  }
  if (requestUrl.pathname === "/api/image/edits" && request.method === "POST") {
    handleImageEditRequest(request, response);
    return true;
  }
  if ((requestUrl.pathname === "/api/image/fusion" || requestUrl.pathname === "/api/image-edit") && request.method === "OPTIONS") {
    sendApiOptions(response);
    return true;
  }
  if ((requestUrl.pathname === "/api/image/fusion" || requestUrl.pathname === "/api/image-edit") && request.method === "POST") {
    handleImageFusionRequest(request, response);
    return true;
  }
  if (requestUrl.pathname === "/api/image/fusion/undo" && request.method === "OPTIONS") {
    sendApiOptions(response);
    return true;
  }
  if (requestUrl.pathname === "/api/image/fusion/undo" && request.method === "POST") {
    handleImageFusionUndoRequest(request, response);
    return true;
  }
  if (requestUrl.pathname === "/api/detail-images" && request.method === "GET") {
    handleDetailImagesRequest(request, response);
    return true;
  }
  if (requestUrl.pathname === "/cache.json" && request.method === "GET") {
    readCachePayload(function handleDirectCacheRead(error, payload) {
      sendJson(response, error ? 500 : 200, payload);
    });
    return true;
  }
  if (requestUrl.pathname === "/api/cache/events" && request.method === "GET") {
    response.writeHead(200, {
      "Access-Control-Allow-Origin": "*",
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive"
    });
    eventClients.push(response);
    readCachePayload(function handleInitialCache(error, payload) {
      response.write("data: " + JSON.stringify(payload) + "\n\n");
    });
    /** Remove a disconnected client from the event stream list. */
    request.on("close", function handleEventClientClose() {
      const index = eventClients.indexOf(response);
      if (index >= 0) {
        eventClients.splice(index, 1);
      }
    });
    return true;
  }
  if (requestUrl.pathname !== "/api/cache") {
    return false;
  }
  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
    });
    response.end();
    return true;
  }
  if (request.method === "GET") {
    readCachePayload(function handleCacheGet(error, payload) {
      sendJson(response, error ? 500 : 200, payload);
    });
    return true;
  }
  if (request.method === "POST") {
    readRequestBody(request, function handleCachePost(body) {
      try {
        const input = JSON.parse(body || "[]");
        writeServerLog("RECEIVE BODY", "Cache update input", input, getApiRequestId(request));
        const records = Array.isArray(input) ? input : Array.isArray(input.records) ? input.records : [];
        const payload = {
          version: "1.0",
          updated_at: formatCacheTime(new Date()),
          records: records
        };
        writeCachePayload(payload, function handleCacheWrite(error) {
          sendJson(response, error ? 500 : 200, error ? { ok: false, error: error.message } : payload);
        }, getApiRequestId(request));
      } catch (error) {
        sendJson(response, 400, { ok: false, error: "缓存 JSON 格式错误。" });
      }
    });
    return true;
  }
  sendJson(response, 405, { ok: false, error: "不支持的缓存请求方法。" });
  return true;
}

/** Resolve the requested URL to a safe file inside the web directory. */
function resolveStaticFile(requestUrl) {
  const pathname = decodeURIComponent(String(requestUrl || "/").split("?")[0]);
  const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = path.resolve(root, relativePath);
  return filePath.startsWith(root) ? filePath : path.join(root, "index.html");
}

/** Return the content type used by the local preview server. */
function getContentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const types = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp"
  };
  return types[extension] || "application/octet-stream";
}

/** Serve one static file or route the local cache API. */
function serveStaticFile(request, response) {
  startApiRequestTrace(request, response);
  if (handleApiRequest(request, response)) {
    return;
  }
  const requestUrl = new URL(request.url || "/", "http://127.0.0.1:" + port);
  const serverLogAliases = ["/server/log", "/servers/log", "/servers/logs"];
  if (serverLogAliases.indexOf(requestUrl.pathname) >= 0) {
    response.writeHead(302, {
      "Location": "/server/logs",
      "Cache-Control": "no-cache"
    });
    response.end();
    return;
  }
  let filePath = requestUrl.pathname === "/server/logs" || requestUrl.pathname === "/server/logs/"
    ? path.join(__dirname, "logs.html")
    : requestUrl.pathname === "/workflow" || requestUrl.pathname === "/workflow/"
      ? path.join(root, "workflow.html")
      : resolveStaticFile(request.url);
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    filePath = path.join(root, "index.html");
  }
  /** Complete the HTTP response after reading a static file. */
  fs.readFile(filePath, function handleFileRead(error, content) {
    if (error) {
      response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("本地页面读取失败。");
      return;
    }
    response.writeHead(200, {
      "Content-Type": getContentType(filePath),
      "Cache-Control": "no-cache"
    });
    response.end(content);
  });
}

/** Start the local Vue preview and cache server. */
function startServer() {
  const server = http.createServer(serveStaticFile);
  /** Report the local address after the server begins listening. */
  server.listen(port, "127.0.0.1", function handleServerListen() {
    console.log("Temu + 1688 Vue 工作台：http://127.0.0.1:" + port);
  });
}

if (require.main === module) {
  startServer();
}

module.exports = {
  handleApiRequest: handleApiRequest,
  createSafeLogValue: createSafeLogValue,
  writeServerLog: writeServerLog,
  formatCacheTime: formatCacheTime,
  readImageEditConfig: readImageEditConfig,
  getKimiEndpoint: getKimiEndpoint,
  compactListingValue: compactListingValue,
  readCachedImageSource: readCachedImageSource,
  readImageEditSource: readImageEditSource,
  getWorkflowService: getWorkflowService
};
