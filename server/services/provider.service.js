const { TubaAsyncImageService, PROVIDER_TIMEOUT_MS } = require("./tuba-async-image.service");
const crypto = require("crypto");
const { reportImageFailure } = require("./image-failure.service");

const DEFAULT_MASK_CUTOUT_PROMPT = "第一张输入图是完整原图，第二张输入图是用户画笔抠出的局部区域。请以完整原图作为上下文，只修改第二张图中非透明抠图对应的位置；透明区域不代表要补全，不要扩散到抠图外。保持边缘干净清晰，不要羽化。";

/** Create one provider error carrying its intended HTTP status code. */
function createProviderError(message, statusCode, code) {
  const error = new Error(String(message || "上游服务请求失败。"));
  error.statusCode = Number(statusCode || 500);
  if (code) {
    error.code = String(code);
  }
  return error;
}

/** Preserve one valid upstream HTTP error status for the local API response. */
function normalizeProviderStatusCode(statusCode) {
  const value = Number(statusCode || 0);
  return value >= 400 && value <= 599 ? value : 502;
}

/** Read one stable provider error code from an OpenAI-compatible payload. */
function readProviderErrorCode(payload, fallback) {
  const source = payload && typeof payload === "object" ? payload : {};
  const providerError = source.error && typeof source.error === "object" ? source.error : {};
  return String(providerError.code || source.code || providerError.type || fallback || "UPSTREAM_ERROR");
}

/** Return a diagnostic-safe image source URL without retaining base64 image bytes. */
function summarizeImageSourceForLog(source) {
  const value = String(source || "").trim();
  if (!value) {
    return "";
  }
  const dataUrlMatch = /^data:(image\/[a-z0-9.+-]+);base64,/i.exec(value);
  if (dataUrlMatch) {
    return "data-url:" + dataUrlMatch[1].toLowerCase();
  }
  return value.length > 1200 ? value.slice(0, 1200) + "...[truncated]" : value;
}

/** Build one configured Kimi chat-completions endpoint URL. */
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

/** Remove image payloads and oversized values before sending Listing data upstream. */
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

/** Provide the provider integrations without depending on HTTP request objects. */
class ProviderService {
  /** Store provider, cache, queue, and diagnostics dependencies. */
  constructor(options) {
    const settings = options || {};
    this.readConfig = settings.readConfig;
    this.images = settings.images;
    this.imageTaskQueue = settings.imageTaskQueue;
    this.asyncImages = settings.asyncImages || new TubaAsyncImageService();
    this.diagnostics = settings.diagnostics;
    this.undoEntries = {};
    this.undoOrder = [];
    this.maxUndoEntries = 200;
  }

  /** Write one provider lifecycle event to the shared diagnostics service. */
  writeLog(direction, label, payload, requestId) {
    if (this.diagnostics && typeof this.diagnostics.write === "function") {
      this.diagnostics.write(direction, label, payload, requestId);
    }
  }

  /** Read the current private provider configuration. */
  getConfig() {
    return this.readConfig();
  }

  /** Return the configured Kimi endpoint for the workflow service. */
  getKimiEndpoint(config) {
    return getKimiEndpoint(config);
  }

  /** Return the compact value function used by the workflow service. */
  compactValue(value, depth) {
    return compactListingValue(value, depth);
  }

  /** Create one bounded in-memory undo token for a provider operation. */
  createUndoToken(type, payload) {
    const token = String(type || "operation") + "-"
      + Date.now().toString(36) + "-"
      + Math.random().toString(36).slice(2, 10);
    this.undoEntries[token] = {
      type: String(type || ""),
      payload: payload,
      created_at: new Date().toISOString()
    };
    this.undoOrder.push(token);
    while (this.undoOrder.length > this.maxUndoEntries) {
      const expiredToken = this.undoOrder.shift();
      delete this.undoEntries[expiredToken];
    }
    return token;
  }

  /** Consume one matching provider undo token exactly once. */
  consumeUndoToken(token, type) {
    const normalizedToken = String(token || "").trim();
    const entry = this.undoEntries[normalizedToken];
    if (!entry || entry.type !== String(type || "")) {
      return null;
    }
    delete this.undoEntries[normalizedToken];
    for (let index = 0; index < this.undoOrder.length; index += 1) {
      if (this.undoOrder[index] === normalizedToken) {
        this.undoOrder.splice(index, 1);
        break;
      }
    }
    return entry.payload;
  }

  /** Normalize one Kimi Listing response to the editable title field. */
  normalizeListingResult(rawListing) {
    const source = rawListing && typeof rawListing === "object" ? rawListing : {};
    return { title: String(source.title || "").trim() };
  }

  /** Parse a strict or fenced JSON Listing response from Kimi. */
  parseListingContent(content) {
    let text = String(content || "").trim();
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
    try {
      return this.normalizeListingResult(JSON.parse(text));
    } catch (error) {
      const firstBrace = text.indexOf("{");
      const lastBrace = text.lastIndexOf("}");
      if (firstBrace >= 0 && lastBrace > firstBrace) {
        return this.normalizeListingResult(JSON.parse(text.slice(firstBrace, lastBrace + 1)));
      }
      throw createProviderError("Kimi 未返回有效的 Listing JSON。", 502);
    }
  }

  /** Return a concise Kimi error without exposing credentials. */
  readProviderError(payload, fallbackText, fallbackMessage) {
    if (payload && payload.error) {
      if (typeof payload.error === "string") {
        return payload.error;
      }
      if (payload.error.message) {
        return String(payload.error.message);
      }
    }
    const text = String(fallbackText || "").trim();
    return text ? text.slice(0, 300) : String(fallbackMessage || "上游服务请求失败。");
  }

  /** Merge one Temu Listing and one 1688 Listing through the configured Kimi endpoint. */
  async mergeListing(input, requestId) {
    const source = input && typeof input === "object" ? input : {};
    const temu = source.temu_listing && typeof source.temu_listing === "object" ? source.temu_listing : null;
    const ali = source.ali_listing && typeof source.ali_listing === "object" ? source.ali_listing : null;
    if (!temu || !ali) {
      throw createProviderError("请选择 Temu 和 1688 商品后再合并。", 400);
    }
    const config = this.getConfig() || {};
    const kimi = config.kimi && typeof config.kimi === "object" ? config.kimi : {};
    const endpoint = getKimiEndpoint(config);
    const systemPrompt = String(kimi.listing_system_prompt || kimi.system_prompt || "").trim();
    const taskPrompt = String(kimi.listing_prompt || kimi.prompt || "").trim();
    if (!endpoint || !kimi.apikey) {
      throw createProviderError("server/config.json 未配置 Kimi。", 500);
    }
    if (!systemPrompt || !taskPrompt) {
      throw createProviderError("server/config.json 未配置 Kimi 提示词。", 500);
    }
    const compactTemu = compactListingValue(temu, 0);
    const compactAli = compactListingValue(ali, 0);
    const userPrompt = taskPrompt
      + "\n\nTemu Listing：\n" + JSON.stringify(compactTemu, null, 2)
      + "\n\n1688 Listing：\n" + JSON.stringify(compactAli, null, 2);
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
    this.writeLog("OUTBOUND", "Kimi Listing merge POST " + endpoint, providerRequestPayload, requestId);
    const timeoutMs = Math.max(10000, Math.min(Number(kimi.timeout_ms || 60000), 180000));
    const controller = new AbortController();
    /** Abort one Kimi request after its configured timeout. */
    const timeoutHandle = setTimeout(function abortListingRequest() {
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
        throw createProviderError("Kimi 请求超时，请稍后重试。", 504, "KIMI_TIMEOUT");
      }
      throw createProviderError("Kimi 网络请求失败：" + (error.message || "未知错误。"), 502, "KIMI_NETWORK_ERROR");
    } finally {
      clearTimeout(timeoutHandle);
    }
    let providerPayload = {};
    try {
      providerPayload = JSON.parse(providerText || "{}");
    } catch (error) {
      providerPayload = {};
    }
    this.writeLog("UPSTREAM", "Kimi Listing response " + providerResponse.status,
      Object.keys(providerPayload).length ? providerPayload : providerText, requestId);
    if (!providerResponse.ok) {
      const statusCode = normalizeProviderStatusCode(providerResponse.status);
      const errorCode = readProviderErrorCode(providerPayload, "KIMI_HTTP_" + statusCode);
      throw createProviderError(this.readProviderError(providerPayload, providerText, "Kimi 合并 Listing 失败。"), statusCode, errorCode);
    }
    const choices = Array.isArray(providerPayload.choices) ? providerPayload.choices : [];
    const message = choices.length && choices[0].message ? choices[0].message : {};
    const listing = this.parseListingContent(message.content);
    if (!listing.title) {
      throw createProviderError("Kimi 返回的 Listing 缺少标题。", 502);
    }
    return {
      provider: "kimi",
      model: String(kimi.model || "kimi-k2.6"),
      listing: listing,
      undo_token: this.createUndoToken("listing", { listing: this.normalizeListingResult(temu) })
    };
  }

  /** Restore one Listing snapshot through a one-time undo token. */
  undoListing(input) {
    const source = input && typeof input === "object" ? input : {};
    const snapshot = this.consumeUndoToken(source.undo_token, "listing");
    if (!snapshot) {
      throw createProviderError("Listing 返回记录不存在或已经使用。", 404);
    }
    return { listing: this.normalizeListingResult(snapshot.listing) };
  }

  /** Normalize and validate one remote product CDN URL. */
  normalizeRemoteUrl(rawUrl) {
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
      if ((parsed.protocol !== "http:" && parsed.protocol !== "https:")
        || !this.isAllowedRemoteHost(parsed.hostname)) {
        return "";
      }
      return parsed.toString();
    } catch (error) {
      return "";
    }
  }

  /** Limit upstream proxy requests to the product CDN hosts used by collectors. */
  isAllowedRemoteHost(hostname) {
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

  /** Select the browser referer expected by one supported product CDN. */
  getRemoteReferer(remoteUrl) {
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

  /** Build ordinary browser-compatible headers for a supported product resource. */
  createRemoteHeaders(remoteUrl, accept) {
    return {
      "Accept": accept,
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      "Cache-Control": "no-cache",
      "Pragma": "no-cache",
      "Referer": this.getRemoteReferer(remoteUrl),
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36"
    };
  }

  /** Resolve one local cache URL into the image cache service without allowing traversal. */
  readLocalImageSource(source) {
    const value = String(source || "").trim();
    let pathname = value;
    if (/^https?:\/\//i.test(value)) {
      try {
        const parsed = new URL(value);
        if (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost" && parsed.hostname !== "[::1]") {
          return null;
        }
        pathname = parsed.pathname;
      } catch (error) {
        return null;
      }
    }
    const publicPrefix = this.images && this.images.publicPrefix ? this.images.publicPrefix : "/api/v1/cache/image";
    if (pathname.indexOf(publicPrefix + "/") !== 0) {
      return null;
    }
    return this.images.readLocalImage(pathname);
  }

  /** Download one allow-listed product image with bounded redirects and response size. */
  async readRemoteImage(source, redirectDepth) {
    const depth = Number(redirectDepth || 0);
    if (depth > 3) {
      throw createProviderError("图片地址重定向次数过多。", 400);
    }
    let response;
    try {
      response = await fetch(source, {
        signal: AbortSignal.timeout(15000),
        redirect: "manual",
        headers: this.createRemoteHeaders(source, "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.9,*/*;q=0.5")
      });
    } catch (error) {
      throw Object.assign(createProviderError("图片网络请求失败：" + (error.message || "未知错误。"), 502), { cause: error, failure_url: source });
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      const nextUrl = this.normalizeRemoteUrl(location ? new URL(location, source).toString() : "");
      if (!nextUrl) {
        throw createProviderError("图片地址重定向到了不支持的域名。", 400);
      }
      return this.readRemoteImage(nextUrl, depth + 1);
    }
    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > 20 * 1024 * 1024) {
      throw Object.assign(createProviderError("图片文件超过 20MB 限制。", 413), { http_status: response.status, failure_url: source });
    }
    const mimeType = String(response.headers.get("content-type") || "image/jpeg").split(";")[0].trim().toLowerCase();
    if (!response.ok) {
      throw Object.assign(createProviderError("图片读取失败（HTTP " + response.status + "）。", 502), { http_status: response.status, failure_url: source });
    }
    if (mimeType.indexOf("image/") !== 0) {
      throw Object.assign(createProviderError("图片响应不是有效图片。", 502), { http_status: response.status, failure_url: source });
    }
    let buffer;
    try { buffer = Buffer.from(await response.arrayBuffer()); } catch (error) {
      throw Object.assign(createProviderError("图片响应读取失败。", 502), { cause: error, http_status: response.status, failure_url: source });
    }
    if (!buffer.length || buffer.length > 20 * 1024 * 1024) {
      throw Object.assign(createProviderError("图片文件超过 20MB 限制。", 413), { http_status: response.status, failure_url: source });
    }
    return { buffer: buffer, mimeType: mimeType };
  }

  /** Read one data URL, local cache URL, or allow-listed remote image. */
  async readImageSource(source, requestId) {
    const value = String(source || "").trim();
    if (!value) {
      throw createProviderError("图片地址不能为空。", 400);
    }
    const dataImage = this.images.readDataUrl(value);
    if (dataImage && dataImage.buffer.length) {
      return dataImage;
    }
    const localImage = this.readLocalImageSource(value);
    if (localImage) {
      return { buffer: localImage.buffer, mimeType: localImage.mimeType };
    }
    const remoteUrl = this.normalizeRemoteUrl(value);
    if (!remoteUrl) {
      throw createProviderError("图片不是有效的 base64、本地缓存或受支持的远程地址。", 400);
    }
    this.writeLog("OUTBOUND", "Provider source image GET", { url: remoteUrl }, requestId);
    const image = await this.readRemoteImage(remoteUrl, 0);
    this.writeLog("UPSTREAM", "Provider source image response", {
      url: remoteUrl,
      content_type: image.mimeType,
      bytes: image.buffer.length
    }, requestId);
    return image;
  }

  /** Return the image provider configuration without exposing its API key. */
  getImageConfig() {
    const config = this.getConfig() || {};
    return config.image && typeof config.image === "object" ? config.image : config;
  }

  /** Build the final provider prompt and enforce the configured guard for every local edit scope. */
  buildImageEditPrompt(config, source, requestMode, maskUrl) {
    const imageConfig = config || {};
    const defaultPrompt = requestMode === "edit" ? imageConfig.edit_prompt : imageConfig.fusion_prompt;
    const rawPrompt = String(source && source.prompt || defaultPrompt || "").trim();
    if (source && source.mask_mode === "cutout") {
      const cutoutPrompt = String(imageConfig.mask_cutout_prompt || DEFAULT_MASK_CUTOUT_PROMPT).trim();
      return {
        prompt: rawPrompt && rawPrompt.indexOf(cutoutPrompt) < 0 ? rawPrompt + "\n\n" + cutoutPrompt : rawPrompt || cutoutPrompt,
        mask_prompt: false,
        mask_cutout_prompt: true
      };
    }
    const maskPrompt = String(imageConfig.mask_prompt || "").trim();
    if (!maskUrl) {
      return { prompt: rawPrompt, mask_prompt: false, mask_cutout_prompt: false };
    }
    if (!maskPrompt) {
      throw createProviderError("server/config.json 缺少 mask_prompt，不能提交局部重绘。", 500, "IMAGE_MASK_PROMPT_MISSING");
    }
    const prompt = rawPrompt && rawPrompt.indexOf(maskPrompt) < 0
      ? rawPrompt + "\n\n" + maskPrompt
      : rawPrompt || maskPrompt;
    return { prompt: prompt, mask_prompt: true, mask_cutout_prompt: false };
  }

  /** Append the configured PNG mask to one provider edit form and return safe diagnostics. */
  async appendImageMaskToForm(form, maskUrl, source, requestId) {
    const value = String(maskUrl || "").trim();
    if (!value) {
      return null;
    }
    this.throwIfImageEditCancelled(source);
    const mask = await this.readImageSource(value, requestId);
    if (mask.mimeType !== "image/png") {
      throw createProviderError("局部重绘遮罩必须是 PNG。", 400, "IMAGE_MASK_FORMAT_INVALID");
    }
    form.append("mask", new Blob([mask.buffer], { type: mask.mimeType }), "mask.png");
    return { source_url: summarizeImageSourceForLog(value), mime_type: mask.mimeType, bytes: mask.buffer.length };
  }

  /** Return the fixed total Tuba polling deadline shared by every image call. */
  getImageTimeoutMs(config) {
    return PROVIDER_TIMEOUT_MS;
  }

  /** Build one configured BeeAPI image endpoint URL. */
  getImageEditEndpoint(config) {
    const source = config || {};
    const baseurl = String(source.baseurl || source.baseUrl || "").trim();
    const endpoint = String(source.endpoint || "").trim();
    if (!baseurl || !endpoint) {
      return "";
    }
    try {
      return new URL(endpoint, baseurl).toString();
    } catch (error) {
      return "";
    }
  }

  /** Normalize one image-edit size to the provider-supported values. */
  normalizeImageEditSize(rawSize) {
    return "1024x1024";
  }

  /** Normalize image quality to a provider-supported level. */
  normalizeImageQuality(rawQuality) {
    const quality = String(rawQuality || "medium").trim().toLowerCase();
    if (quality === "low" || quality === "high") {
      return quality;
    }
    return "medium";
  }

  /** Extract one generated image URL or data URL from an OpenAI-compatible response. */
  readGeneratedImage(candidate, mimeType) {
    if (candidate && typeof candidate === "object") {
      const encoded = candidate.b64_json || candidate.base64 || candidate.data;
      if (encoded && typeof encoded === "string") {
        return this.readGeneratedImage(encoded, candidate.mime_type || candidate.mimeType || mimeType);
      }
      const imageUrl = candidate.url || candidate.image_url || candidate.imageUrl;
      return imageUrl ? String(imageUrl).trim() : "";
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

  /** Find one generated image in common provider response fields. */
  readGeneratedImageFromPayload(payload) {
    if (!payload || typeof payload !== "object") {
      return "";
    }
    const outputMimeType = payload.output_format ? "image/" + String(payload.output_format).toLowerCase() : "image/png";
    if (Array.isArray(payload.data)) {
      for (let index = 0; index < payload.data.length; index += 1) {
        const image = this.readGeneratedImage(payload.data[index], outputMimeType);
        if (image) {
          return image;
        }
      }
    }
    const candidateNames = ["b64_json", "base64", "image_url", "imageUrl", "url", "image", "output", "result", "data"];
    for (let index = 0; index < candidateNames.length; index += 1) {
      const image = this.readGeneratedImage(payload[candidateNames[index]], outputMimeType);
      if (image) {
        return image;
      }
    }
    return "";
  }

  /** Return whether one queued image provider request has been cancelled upstream. */
  isImageEditCancelled(source) {
    const input = source && typeof source === "object" ? source : {};
    if (input.cancel_signal && input.cancel_signal.aborted) {
      return true;
    }
    if (typeof input.is_cancelled === "function") {
      return Boolean(input.is_cancelled());
    }
    return false;
  }

  /** Throw a stable provider error when an image request should stop early. */
  throwIfImageEditCancelled(source) {
    if (this.isImageEditCancelled(source)) {
      throw createProviderError("图片任务已被放弃。", 409, "IMAGE_TASK_CANCELLED");
    }
  }

  /** Submit and poll one Tuba edit or fusion while holding its shared queue slot. */
  async executeImageEdit(input, mode, requestId) {
    const requestMode = mode === "edit" ? "edit" : "fusion";
    const source = input && typeof input === "object" ? input : {};
    this.throwIfImageEditCancelled(source);
    const imageUrls = Array.isArray(source.image_urls) ? source.image_urls : [];
    const isCutoutEdit = requestMode === "edit" && source.mask_mode === "cutout";
    const isMultiFusion = requestMode === "fusion"
      && (source.task_scope === "multi-fusion" || source.multi_fusion_task_id);
    const imageCountValid = requestMode === "edit"
      ? isCutoutEdit ? imageUrls.length === 2 : imageUrls.length === 1
      : isMultiFusion ? imageUrls.length >= 3 : imageUrls.length === 2;
    if (!imageCountValid) {
      const message = requestMode === "edit"
        ? isCutoutEdit ? "局部抠图编辑必须提交完整原图和抠图。" : "单图编辑必须提交一张图片。"
        : isMultiFusion ? "多图融合至少需要提交三张图片。" : "溶图必须提交两张图片。";
      throw createProviderError(message, 400);
    }
    const config = this.getImageConfig();
    const endpoint = this.getImageEditEndpoint(config);
    if (!config.apikey || !endpoint) {
      throw createProviderError("server/config.json 未配置完整。", 500);
    }
    const maskUrl = String(source.mask_url || "").trim();
    const promptPayload = this.buildImageEditPrompt(config, source, requestMode, maskUrl);
    const prompt = promptPayload.prompt;
    if (!prompt) {
      throw createProviderError("图片编辑提示词不能为空。", 400);
    }
    const size = this.normalizeImageEditSize(source.size);
    const quality = this.normalizeImageQuality(config.quality);
    const form = new FormData();
    const preparedImages = [];
    if (maskUrl && requestMode !== "edit") {
      throw createProviderError("遮罩只支持单图编辑。", 400, "IMAGE_MASK_MODE_INVALID");
    }
    form.append("model", String(config.model || "gpt-image-2"));
    form.append("prompt", prompt);
    form.append("size", size);
    form.append("quality", quality);
    form.append("n", "1");
    for (let index = 0; index < imageUrls.length; index += 1) {
      this.throwIfImageEditCancelled(source);
      let image;
      try { image = await this.readImageSource(imageUrls[index], requestId); } catch (error) {
        reportImageFailure({ onFailure: source.on_image_failure, sensitiveValues: [config.apikey, prompt] }, error, {
          stage: "reference_download", method: /^https?:/i.test(imageUrls[index]) ? "GET" : "",
          attempt: 1, source_index: index, url: imageUrls[index], code: "REFERENCE_IMAGE_READ_FAILED"
        });
        throw error;
      }
      this.throwIfImageEditCancelled(source);
      const blob = new Blob([image.buffer], { type: image.mimeType });
      form.append("image", blob, "blend-" + (index + 1) + "." + image.mimeType.split("/")[1]);
      preparedImages.push({ index: index + 1, source_url: summarizeImageSourceForLog(imageUrls[index]), mime_type: image.mimeType, bytes: image.buffer.length });
    }
    const preparedMask = await this.appendImageMaskToForm(form, maskUrl, source, requestId);
    this.writeLog("OUTBOUND", "Tuba async " + requestMode + " POST " + endpoint, {
      carousel_task_id: String(source.carousel_task_id || ""),
      carousel_page_index: source.carousel_page_index === undefined ? "" : Number(source.carousel_page_index),
      multi_fusion_task_id: String(source.multi_fusion_task_id || ""),
      multi_fusion_page_index: source.multi_fusion_page_index === undefined ? "" : Number(source.multi_fusion_page_index),
      generation_id: String(source.generation_id || ""),
      model: String(config.model || "gpt-image-2"),
      prompt: prompt,
      mask_prompt: promptPayload.mask_prompt,
      mask_cutout_prompt: promptPayload.mask_cutout_prompt,
      size: size,
      quality: quality,
      async: true,
      response_format: "url",
      images: preparedImages,
      mask: preparedMask,
      timeout_ms: this.getImageTimeoutMs(config)
    }, requestId);
    const service = this;
    const generatedSource = await this.asyncImages.generate({
      endpoint: endpoint,
      apiKey: String(config.apikey),
      body: form,
      signal: source.cancel_signal,
      /** Retain the runtime's ownership check through polling and downloading. */
      isCancelled: function isEditAbandoned() {
        return service.isImageEditCancelled(source);
      },
      onState: source.on_provider_state,
      onFailure: source.on_image_failure,
      writeLog: this.writeLog.bind(this),
      requestId: requestId
    });
    this.throwIfImageEditCancelled(source);
    const imageUrl = await this.images.cacheGeneratedImage(generatedSource, {
      signal: source.cancel_signal,
      onProgress: source.on_download_progress,
      onFailure: source.on_image_failure,
      /** Prevent a deleted or superseded task from writing a downloaded image. */
      isCancelled: function isDownloadAbandoned() {
        return service.isImageEditCancelled(source);
      }
    });
    if (this.isImageEditCancelled(source)) {
      if (this.images && typeof this.images.deleteUnreferencedGeneratedImage === "function") {
        this.images.deleteUnreferencedGeneratedImage(imageUrl);
      }
      this.throwIfImageEditCancelled(source);
    }
    const prices = config.price && typeof config.price === "object" ? config.price : {};
    return {
      provider: "beeapi",
      mode: requestMode,
      model: String(config.model || "gpt-image-2"),
      image_url: imageUrl,
      size: size,
      quality: quality,
      price: prices[size] === undefined ? null : prices[size],
      undo_token: requestMode === "fusion"
        ? this.createUndoToken("image-fusion", { image_urls: imageUrls.slice() })
        : ""
    };
  }

  /** Queue one image edit or fusion operation behind the shared image limit. */
  editImages(input, mode, requestId) {
    const source = Object.assign({}, input && typeof input === "object" ? input : {});
    if (!this.imageTaskQueue) {
      return this.executeImageEdit(source, mode, requestId);
    }
    const service = this;
    const executionId = String(source.direct_task_id || source.generation_id || crypto.randomUUID());
    const persistProviderState = source.on_provider_state;
    /** Buffer sanitized failures until the queue knows whether the execution finally failed. */
    source.on_image_failure = function observeEditFailure(event) {
      service.imageTaskQueue.recordFailure(executionId, event);
    };
    /** Mirror provider transitions before the business callback can reject a deleted runtime. */
    source.on_provider_state = function observeEditProviderState(state) {
      service.imageTaskQueue.observeProviderState(executionId, state);
      if (typeof persistProviderState === "function") { return persistProviderState(state); }
    };
    /** Count actual download attempts separately from successful upstream generation. */
    source.on_download_progress = function observeEditDownload(progress) {
      service.imageTaskQueue.updateTask(executionId, { phase: "downloading", download_attempt: progress.attempt });
    };
    /** Execute one queued provider image task when the shared slot is available. */
    return this.imageTaskQueue.run(function executeQueuedImageProviderTask() {
      return service.executeImageEdit(source, mode, requestId);
    }, {
      type: "edits",
      execution_id: executionId,
      source: source.multi_fusion_task_id ? "multi-fusion" : source.carousel_task_id ? "carousel" : source.task_scope === "sku" ? "sku-fusion" : mode === "fusion" ? "fusion" : "single-edit",
      temu_main_id: source.temu_main_id,
      temu_platform_id: source.temu_platform_id,
      sku_id: source.sku_id,
      sku_index: source.sku_index,
      request_id: requestId,
      direct_task_id: String(source.direct_task_id || ""),
      carousel_task_id: String(source.carousel_task_id || ""),
      carousel_page_index: source.carousel_page_index === undefined ? "" : Number(source.carousel_page_index),
      multi_fusion_task_id: String(source.multi_fusion_task_id || ""),
      multi_fusion_page_index: source.multi_fusion_page_index === undefined ? "" : Number(source.multi_fusion_page_index),
      generation_id: String(source.generation_id || "")
    });
  }

  /** Cancel queued image provider work whose metadata matches one predicate. */
  cancelImageTasks(predicate) {
    if (!this.imageTaskQueue || typeof this.imageTaskQueue.cancelWhere !== "function") {
      return 0;
    }
    return this.imageTaskQueue.cancelWhere(predicate, "图片任务已被放弃。");
  }

  /** Restore the two original SKU images through a one-time fusion token. */
  undoImageFusion(input) {
    const source = input && typeof input === "object" ? input : {};
    const snapshot = this.consumeUndoToken(source.undo_token, "image-fusion");
    if (!snapshot) {
      throw createProviderError("溶图返回记录不存在或已经使用。", 404);
    }
    return { image_urls: Array.isArray(snapshot.image_urls) ? snapshot.image_urls : [] };
  }

  /** Extract product detail image URLs from HTML or JSON-wrapped detail content. */
  extractDetailImageUrls(content) {
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
        const imageUrl = this.normalizeRemoteUrl(candidate);
        if (imageUrl && /\.(?:jpg|jpeg|png|webp|gif)(?:[?#]|$)/i.test(imageUrl) && !seen[imageUrl]) {
          seen[imageUrl] = true;
          result.push(imageUrl);
        }
        match = pattern.exec(text);
      }
    }
    return result;
  }

  /** Fetch one detail description and return its allow-listed image URL list. */
  async getDetailImages(rawUrl, requestId) {
    const detailUrl = this.normalizeRemoteUrl(rawUrl);
    if (!detailUrl) {
      throw createProviderError("详情描述地址无效。", 400);
    }
    this.writeLog("OUTBOUND", "Detail image GET", { url: detailUrl }, requestId);
    let response;
    try {
      response = await fetch(detailUrl, {
        signal: AbortSignal.timeout(15000),
        redirect: "manual",
        headers: this.createRemoteHeaders(detailUrl, "text/html,application/json;q=0.9,*/*;q=0.8")
      });
    } catch (error) {
      throw createProviderError("详情描述请求失败：" + (error.message || "网络错误。"), 502);
    }
    if (response.status >= 300 && response.status < 400) {
      throw createProviderError("详情描述地址发生了不支持的重定向。", 502);
    }
    if (!response.ok) {
      throw createProviderError("详情描述请求失败：" + response.status, 502);
    }
    const content = await response.text();
    if (content.length > 10 * 1024 * 1024) {
      throw createProviderError("详情描述内容超过 10MB 限制。", 413);
    }
    const imageUrls = this.extractDetailImageUrls(content);
    this.writeLog("UPSTREAM", "Detail image response " + response.status, {
      content_chars: content.length,
      image_count: imageUrls.length
    }, requestId);
    return { cached: false, image_urls: imageUrls };
  }
}

module.exports = {
  ProviderService: ProviderService,
  createProviderError: createProviderError,
  getKimiEndpoint: getKimiEndpoint,
  compactListingValue: compactListingValue
};
