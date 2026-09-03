const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { assertImageActive, waitForImageTick, imageError } = require("./tuba-async-image.service");
const { reportImageFailure } = require("./image-failure.service");

/** Persist product images as content-addressed files under the external cache. */
class ImageCacheService {
  /** Resolve storage paths and create the supported image cache directories. */
  constructor(options) {
    const settings = options || {};
    this.cacheDirectory = path.resolve(__dirname, "..", settings.cacheDirectory || "D:/自动组货/cache");
    this.imageDirectory = path.resolve(__dirname, "..", settings.imageDirectory || "D:/自动组货/cache/image");
    this.publicPrefix = "/api/v1/cache/image";
    this.sourceIndexPath = path.join(this.imageDirectory, "source-index.json");
    this.referenceIndexPath = path.join(this.imageDirectory, "reference-index.json");
    this.productRootDirectory = path.join(this.imageDirectory, "products");
    this.candidateRequests = new Map();
    this.candidateQueue = [];
    this.candidateActiveCount = 0;
    this.candidateCachePauses = 0;
    this.ensureDirectories();
  }

  /** Cache displayed CLIP images in the shared store, coalescing identical in-flight URLs. */
  cacheCandidateImage(source) {
    if (this.candidateCachePauses) {
      return Promise.reject(imageError("正在清空缓存。", "CACHE_CLEARING", 409));
    }
    const value = String(source || "");
    const cachedUrl = this.findSourceCache(value, "", "main");
    if (cachedUrl) {
      return Promise.resolve(cachedUrl);
    }
    const existing = this.candidateRequests.get(value);
    if (existing) {
      return existing.promise;
    }
    const controller = new AbortController();
    const entry = { controller: controller };
    const service = this;
    entry.promise = new Promise(/** Queue one ordinary image download without using the generation queue. */ function queueCandidate(resolve, reject) {
      entry.reject = reject;
      /** Download once, release the slot on every outcome, and retain newer requests after clearing. */
      entry.run = async function runCandidateDownload() {
        try {
          resolve(await service.cacheImage(value, "temu", "main", false, undefined, { signal: controller.signal }));
        } catch (error) {
          reject(error);
        } finally {
          if (service.candidateRequests.get(value) === entry) {
            service.candidateRequests.delete(value);
          }
          service.candidateActiveCount -= 1;
          service.drainCandidateQueue();
        }
      };
    });
    this.candidateRequests.set(value, entry);
    this.candidateQueue.push(entry);
    this.drainCandidateQueue();
    return entry.promise;
  }

  /** Limit on-demand candidate downloads across all connected browsers to four at once. */
  drainCandidateQueue() {
    while (!this.candidateCachePauses && this.candidateActiveCount < 4 && this.candidateQueue.length) {
      const entry = this.candidateQueue.shift();
      this.candidateActiveCount += 1;
      entry.run();
    }
  }

  /** Cancel candidate downloads before clearing files, including writes after a late response. */
  pauseCandidateCache() {
    this.candidateCachePauses += 1;
    for (const entry of this.candidateRequests.values()) {
      entry.controller.abort();
      entry.reject(imageError("候选图片缓存已清空。", "CACHE_CLEARING", 409));
    }
    this.candidateQueue = [];
    this.candidateRequests.clear();
  }

  /** Allow future candidate downloads once every concurrent cache clear has finished. */
  resumeCandidateCache() {
    this.candidateCachePauses = Math.max(0, this.candidateCachePauses - 1);
    this.drainCandidateQueue();
  }

  /** Create every stable platform and image-kind directory. */
  ensureDirectories() {
    const platforms = ["temu", "1688"];
    const kinds = ["main", "detail", "sku"];
    for (let platformIndex = 0; platformIndex < platforms.length; platformIndex += 1) {
      for (let kindIndex = 0; kindIndex < kinds.length; kindIndex += 1) {
        fs.mkdirSync(path.join(this.imageDirectory, platforms[platformIndex], kinds[kindIndex]), { recursive: true });
      }
    }
    fs.mkdirSync(path.join(this.imageDirectory, "transfer", "generated"), { recursive: true });
    fs.mkdirSync(path.join(this.imageDirectory, "transfer", "temp"), { recursive: true });
    fs.mkdirSync(this.productRootDirectory, { recursive: true });
  }

  /** Return whether a source already points at the local image API. */
  isLocalImageUrl(source) {
    return String(source || "").indexOf(this.publicPrefix + "/") === 0;
  }

  /** Read one local image API URL from the server cache for ZIP export. */
  readLocalImage(localUrl) {
    const filePath = this.resolveLocalImagePath(localUrl);
    if (!filePath || !fs.existsSync(filePath)) {
      return null;
    }
    const extension = path.extname(filePath).toLowerCase();
    const mimeTypes = {
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".webp": "image/webp",
      ".gif": "image/gif",
      ".avif": "image/avif",
      ".bmp": "image/bmp"
    };
    return {
      buffer: fs.readFileSync(filePath),
      extension: extension || ".jpg",
      mimeType: mimeTypes[extension] || "application/octet-stream"
    };
  }

  /** Read the source-URL hash index used to bypass repeat CDN requests. */
  readSourceIndex() {
    return this.readJsonObject(this.sourceIndexPath);
  }

  /** Read one JSON object file and hide corrupt-file details from callers. */
  readJsonObject(filePath) {
    if (!fs.existsSync(filePath)) {
      return {};
    }
    try {
      const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
      return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
    } catch (error) {
      return {};
    }
  }

  /** Persist one small JSON object through the image cache directory. */
  writeJsonObject(filePath, payload) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(payload && typeof payload === "object" ? payload : {}, null, 2), "utf8");
  }

  /** Return the normalized relative path for one local image URL. */
  getLocalRelativePath(localUrl) {
    if (!this.isLocalImageUrl(localUrl)) {
      return "";
    }
    const relativePath = String(localUrl || "").slice(this.publicPrefix.length).replace(/^[/\\]+/, "");
    return relativePath && relativePath.indexOf("..") < 0 ? relativePath.replace(/\\/g, "/") : "";
  }

  /** Resolve one local image URL to a file path that stays inside imageDirectory. */
  resolveLocalImagePath(localUrl) {
    const relativePath = this.getLocalRelativePath(localUrl);
    if (!relativePath) {
      return "";
    }
    const filePath = path.resolve(this.imageDirectory, relativePath);
    const imageRoot = path.resolve(this.imageDirectory);
    return filePath === imageRoot || filePath.indexOf(imageRoot + path.sep) === 0 ? filePath : "";
  }

  /** Resolve one local API URL to its cache file and verify that it still exists. */
  localUrlExists(localUrl) {
    const filePath = this.resolveLocalImagePath(localUrl);
    return Boolean(filePath && fs.existsSync(filePath));
  }

  /** Normalize the source platform into the two product platform folders. */
  normalizePlatform(platform) {
    return String(platform || "").toLowerCase() === "1688" ? "1688" : "temu";
  }

  /** Convert arbitrary product identifiers into filesystem-safe path segments. */
  safePathSegment(value, fallback) {
    const text = String(value || "").trim();
    const safeText = text.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
    if (safeText) {
      return safeText;
    }
    const hash = crypto.createHash("sha256").update(text || String(fallback || "product")).digest("hex").slice(0, 16);
    return String(fallback || "product") + "-" + hash;
  }

  /** Build the per-product relative cache folder for one product record. */
  getProductRelativePath(record, fallbackPlatform) {
    const item = record && typeof record === "object" ? record : {};
    const platform = this.normalizePlatform(item.platform || fallbackPlatform);
    const platformId = String(item.platform_id || "").trim();
    const identity = platformId
      || String(item.product_id || item.main_id || item.mainid || item.product_name || "").trim();
    const segment = platformId
      ? this.safePathSegment(platformId, "product")
      : this.safePathSegment(identity, "product");
    return "products/" + platform + "/" + segment;
  }

  /** Return whether one local URL already belongs to the target product folder. */
  isUrlInProductPath(localUrl, productPath) {
    const relativePath = this.getLocalRelativePath(localUrl);
    const relativeProductPath = String(productPath || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    return Boolean(relativePath && relativeProductPath && relativePath.indexOf(relativeProductPath + "/") === 0);
  }

  /** Convert a relative cache path into the public image API URL. */
  toLocalUrl(relativePath) {
    return this.publicPrefix + "/" + String(relativePath || "").replace(/\\/g, "/").replace(/^\/+/, "");
  }

  /** Copy one existing local image into a product folder and return the new URL. */
  cacheLocalImageToProduct(localUrl, productPath, kind) {
    const sourcePath = this.resolveLocalImagePath(localUrl);
    if (!sourcePath || !fs.existsSync(sourcePath)) {
      return "";
    }
    if (this.isUrlInProductPath(localUrl, productPath)) {
      return String(localUrl || "");
    }
    const extension = path.extname(sourcePath).toLowerCase() || ".jpg";
    const buffer = fs.readFileSync(sourcePath);
    const hash = crypto.createHash("sha256").update(buffer).digest("hex");
    const relativeDirectory = path.join(String(productPath || ""), kind);
    const directory = path.join(this.imageDirectory, relativeDirectory);
    const fileName = hash + extension;
    fs.mkdirSync(directory, { recursive: true });
    const filePath = path.join(directory, fileName);
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, buffer);
    }
    return this.toLocalUrl(path.join(relativeDirectory, fileName));
  }

  /** Build the source index key for either global or product-scoped reuse. */
  getSourceIndexKey(source, productPath) {
    const sourceHash = crypto.createHash("sha256").update(String(source)).digest("hex");
    const scope = String(productPath || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    return scope ? scope + "|" + sourceHash : sourceHash;
  }

  /** Return a previously cached file for the exact same remote source URL. */
  findSourceCache(source, productPath, kind) {
    if (!/^https?:\/\//i.test(String(source || ""))) {
      return "";
    }
    const index = this.readSourceIndex();
    const scopedKey = this.getSourceIndexKey(source, productPath);
    const scopedUrl = String(index[scopedKey] || "");
    if (this.localUrlExists(scopedUrl)) {
      return scopedUrl;
    }
    if (!productPath) {
      return "";
    }
    const legacyUrl = String(index[this.getSourceIndexKey(source, "")] || "");
    const copiedUrl = this.cacheLocalImageToProduct(legacyUrl, productPath, kind);
    if (copiedUrl) {
      index[scopedKey] = copiedUrl;
      this.writeJsonObject(this.sourceIndexPath, index);
    }
    return copiedUrl;
  }

  /** Record the exact remote source hash after an image has been cached. */
  rememberSourceCache(source, localUrl, productPath) {
    if (!/^https?:\/\//i.test(String(source || "")) || !localUrl) {
      return;
    }
    const index = this.readSourceIndex();
    index[this.getSourceIndexKey(source, productPath)] = localUrl;
    if (!productPath) {
      index[this.getSourceIndexKey(source, "")] = localUrl;
    }
    this.writeJsonObject(this.sourceIndexPath, index);
  }

  /** Convert a supported image MIME type to a safe file extension. */
  getExtension(mimeType) {
    const mime = String(mimeType || "").toLowerCase().split(";")[0].trim();
    const extensions = {
      "image/jpeg": ".jpg",
      "image/png": ".png",
      "image/webp": ".webp",
      "image/gif": ".gif",
      "image/avif": ".avif",
      "image/bmp": ".bmp"
    };
    return extensions[mime] || "";
  }

  /** Decode one browser data URL into its image bytes and MIME type. */
  readDataUrl(source) {
    const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/.exec(String(source || ""));
    if (!match) {
      return null;
    }
    return { mimeType: match[1].toLowerCase(), buffer: Buffer.from(match[2], "base64") };
  }

  /** Download one remote image through the backend to avoid browser CDN restrictions. */
  async readRemoteUrl(source, options) {
    const settings = options || {};
    assertImageActive(settings);
    const timeoutSignal = AbortSignal.timeout(15000);
    let response;
    try {
      response = await fetch(String(source), {
        signal: settings.signal ? AbortSignal.any([settings.signal, timeoutSignal]) : timeoutSignal,
        headers: {
          "User-Agent": "Mozilla/5.0",
          Referer: "https://www.1688.com/"
        }
      });
      if (!response.ok) {
        throw imageError("图片下载失败，HTTP " + response.status + "。", "IMAGE_HTTP_" + response.status);
      }
      const mimeType = String(response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      if (mimeType.indexOf("image/") !== 0) {
        throw imageError("远程地址返回的不是图片（" + mimeType + "）。", "IMAGE_CONTENT_TYPE");
      }
      return { mimeType: mimeType, buffer: Buffer.from(await response.arrayBuffer()), http_status: response.status, failure_url: response.url || String(source) };
    } catch (error) {
      let failure = error;
      if (!error.code || typeof error.code === "number") {
        failure = Object.assign(imageError(error.message, error.name === "TimeoutError" ? "IMAGE_DOWNLOAD_TIMEOUT" : "IMAGE_DOWNLOAD_NETWORK"), { cause: error });
      }
      throw Object.assign(failure, {
        image_stage: "result_download", failure_url: response && response.url || String(source),
        http_status: response && response.status || 0
      });
    }
  }

  /** Read one Base64 or HTTP image source without changing the original on failure. */
  async readSource(source, options) {
    const dataImage = this.readDataUrl(source);
    if (dataImage) {
      return dataImage;
    }
    if (/^https?:\/\//i.test(String(source || ""))) {
      return this.readRemoteUrl(source, options);
    }
    return null;
  }

  /** Persist one image by content hash and return its stable local API URL. */
  async cacheImage(source, platform, kind, generated, productPath, options) {
    assertImageActive(options);
    if (!source) {
      return String(source || "");
    }
    const safePlatform = generated ? "transfer" : this.normalizePlatform(platform);
    const safeKind = generated ? "generated" : ["main", "detail", "sku"].indexOf(kind) >= 0 ? kind : "main";
    if (this.isLocalImageUrl(source)) {
      if (productPath && !generated) {
        return this.cacheLocalImageToProduct(source, productPath, safeKind) || String(source || "");
      }
      return String(source || "");
    }
    const existingUrl = this.findSourceCache(source, productPath, safeKind);
    if (existingUrl) {
      return existingUrl;
    }
    const image = await this.readSource(source, options);
    assertImageActive(options);
    if (!image || !image.buffer.length) {
      if (generated) { throw Object.assign(imageError("生成结果内容为空。", "IMAGE_EMPTY_CONTENT"), { image_stage: "result_validation", http_status: image && image.http_status }); }
      return String(source || "");
    }
    const extension = this.getExtension(image.mimeType);
    if (!extension) {
      if (generated) { throw Object.assign(imageError("生成结果格式不受支持：" + image.mimeType, "IMAGE_UNSUPPORTED_TYPE"), { image_stage: "result_validation", http_status: image.http_status }); }
      return String(source || "");
    }
    const hash = crypto.createHash("sha256").update(image.buffer).digest("hex");
    const fileName = hash + extension;
    const relativeDirectory = productPath && !generated
      ? path.join(productPath, safeKind)
      : path.join(safePlatform, safeKind);
    const directory = path.join(this.imageDirectory, relativeDirectory);
    const filePath = path.join(directory, fileName);
    try {
      fs.mkdirSync(directory, { recursive: true });
      if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, image.buffer);
      }
      const localUrl = this.toLocalUrl(path.join(relativeDirectory, fileName));
      this.rememberSourceCache(source, localUrl, productPath);
      return localUrl;
    } catch (error) {
      error.image_stage = "cache_write";
      throw error;
    }
  }

  /** Require a real local image after three bounded downloads; never return an uncached provider URL. */
  async cacheGeneratedImage(source, options) {
    const value = String(source || "");
    const settings = options || {};
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      assertImageActive(settings);
      if (typeof settings.onProgress === "function") {
        try { settings.onProgress({ attempt: attempt + 1 }); } catch (observerError) { /* Diagnostics must not interrupt a paid image download. */ }
      }
      try {
        const localUrl = await this.cacheImage(value, "transfer", "generated", true, undefined, settings);
        assertImageActive(settings);
        if (!this.isLocalImageUrl(localUrl) || !this.localUrlExists(localUrl)) {
          throw Object.assign(imageError("生成结果未写入本地图片缓存。", "IMAGE_CACHE_MISSING"), { image_stage: "cache_validation" });
        }
        return localUrl;
      } catch (error) {
        assertImageActive(settings);
        lastError = error;
        reportImageFailure(settings, error, {
          stage: "cache_write", method: error.image_stage === "result_download" ? "GET" : "",
          attempt: attempt + 1, url: value
        });
        if (attempt < 2) {
          await waitForImageTick(2000, settings.signal);
        }
      }
    }
    throw Object.assign(imageError("图片连续三次下载或缓存失败，请手动重新生成。", "DOWNLOAD_FAILED"), {
      cause: lastError, image_failure_event: lastError && lastError.image_failure_event
    });
  }

  /** Read the compact product-reference index used for quick generated-image cleanup. */
  readReferenceIndex() {
    const index = this.readJsonObject(this.referenceIndexPath);
    if (!index.products || typeof index.products !== "object" || Array.isArray(index.products)) {
      index.products = {};
    }
    return index;
  }

  /** Persist the compact product-reference index. */
  writeReferenceIndex(index) {
    const payload = index && typeof index === "object" ? index : {};
    payload.updated_at = new Date().toISOString();
    this.writeJsonObject(this.referenceIndexPath, payload);
  }

  /** Collect every local image URL nested inside one value. */
  collectLocalImageUrls(value, target) {
    const output = target && typeof target === "object" ? target : {};
    if (typeof value === "string") {
      if (this.isLocalImageUrl(value)) {
        output[value] = true;
      }
      return output;
    }
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        this.collectLocalImageUrls(value[index], output);
      }
      return output;
    }
    if (value && typeof value === "object") {
      const keys = Object.keys(value);
      for (let keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
        this.collectLocalImageUrls(value[keys[keyIndex]], output);
      }
    }
    return output;
  }

  /** Build the lightweight product data file stored beside cached images. */
  createProductManifest(record) {
    const item = record && typeof record === "object" ? record : {};
    return {
      updated_at: new Date().toISOString(),
      platform: String(item.platform || ""),
      platform_id: String(item.platform_id || ""),
      main_id: String(item.main_id || item.mainid || ""),
      product_id: String(item.product_id || ""),
      product_name: String(item.product_name || ""),
      version: Number(item.version || 1),
      images: {
        main_image_url: String(item.main_image_url || ""),
        gallery_image_urls: Array.isArray(item.gallery_image_urls) ? item.gallery_image_urls.slice() : [],
        detail_image_urls: Array.isArray(item.detail_image_urls) ? item.detail_image_urls.slice() : [],
        sku: Array.isArray(item.sku) ? item.sku : []
      }
    };
  }

  /** Write one product's cached data snapshot beside its images. */
  writeProductManifest(record, productPath) {
    const relativeProductPath = String(productPath || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    if (!relativeProductPath) {
      return;
    }
    const directory = path.join(this.imageDirectory, relativeProductPath);
    fs.mkdirSync(directory, { recursive: true });
    const manifest = this.createProductManifest(record);
    fs.writeFileSync(path.join(directory, "data.json"), JSON.stringify(manifest, null, 2), "utf8");
    const urls = Object.keys(this.collectLocalImageUrls(manifest, {}));
    const index = this.readReferenceIndex();
    index.products[relativeProductPath] = urls;
    this.writeReferenceIndex(index);
  }

  /** Remove one product folder and its fast-reference entries. */
  deleteProductCache(record) {
    const productPath = this.getProductRelativePath(record, record && record.platform);
    const relativeProductPath = String(productPath || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    if (!relativeProductPath) {
      return false;
    }
    const directory = path.resolve(this.imageDirectory, relativeProductPath);
    if (directory.indexOf(path.resolve(this.productRootDirectory) + path.sep) !== 0) {
      return false;
    }
    let changed = false;
    if (fs.existsSync(directory)) {
      fs.rmSync(directory, { recursive: true, force: true });
      changed = true;
    }
    const referenceIndex = this.readReferenceIndex();
    if (referenceIndex.products[relativeProductPath]) {
      delete referenceIndex.products[relativeProductPath];
      this.writeReferenceIndex(referenceIndex);
      changed = true;
    }
    const sourceIndex = this.readSourceIndex();
    const sourceKeys = Object.keys(sourceIndex);
    for (let index = 0; index < sourceKeys.length; index += 1) {
      if (sourceKeys[index].indexOf(relativeProductPath + "|") === 0
        || String(sourceIndex[sourceKeys[index]] || "").indexOf(this.toLocalUrl(relativeProductPath + "/")) === 0) {
        delete sourceIndex[sourceKeys[index]];
        changed = true;
      }
    }
    if (changed) {
      this.writeJsonObject(this.sourceIndexPath, sourceIndex);
    }
    return changed;
  }

  /** Rebuild the fast-reference index from the currently active product records. */
  rebuildReferenceIndex(records) {
    const list = Array.isArray(records) ? records : [];
    const index = { products: {} };
    for (let recordIndex = 0; recordIndex < list.length; recordIndex += 1) {
      const productPath = this.getProductRelativePath(list[recordIndex], list[recordIndex] && list[recordIndex].platform);
      index.products[productPath] = Object.keys(this.collectLocalImageUrls(this.createProductManifest(list[recordIndex]), {}));
    }
    this.writeReferenceIndex(index);
  }

  /** Return whether any indexed product data still references one local image URL. */
  isImageReferencedByIndex(localUrl) {
    if (!fs.existsSync(this.referenceIndexPath)) {
      return null;
    }
    const value = String(localUrl || "");
    const index = this.readReferenceIndex();
    const productPaths = Object.keys(index.products);
    for (let productIndex = 0; productIndex < productPaths.length; productIndex += 1) {
      const urls = Array.isArray(index.products[productPaths[productIndex]]) ? index.products[productPaths[productIndex]] : [];
      if (urls.indexOf(value) >= 0) {
        return true;
      }
    }
    return false;
  }

  /** Return whether any persisted business JSON still references one local image URL. */
  isImageReferenced(localUrl) {
    const value = String(localUrl || "");
    if (!value || !fs.existsSync(this.cacheDirectory)) {
      return false;
    }
    const pendingDirectories = [this.cacheDirectory];
    while (pendingDirectories.length) {
      const directory = pendingDirectories.pop();
      const entries = fs.readdirSync(directory, { withFileTypes: true });
      for (let index = 0; index < entries.length; index += 1) {
        const entryPath = path.join(directory, entries[index].name);
        if (entries[index].isDirectory()) {
          pendingDirectories.push(entryPath);
          continue;
        }
        if (path.extname(entries[index].name).toLowerCase() !== ".json"
          || path.resolve(entryPath) === path.resolve(this.sourceIndexPath)) {
          continue;
        }
        try {
          if (fs.readFileSync(entryPath, "utf8").indexOf(value) >= 0) {
            return true;
          }
        } catch (error) {
          continue;
        }
      }
    }
    return false;
  }

  /** Delete one generated image only after all persisted business references disappear. */
  deleteUnreferencedGeneratedImage(localUrl) {
    const value = String(localUrl || "");
    const generatedPrefix = this.publicPrefix + "/transfer/generated/";
    const indexedReference = this.isImageReferencedByIndex(value);
    const referenced = indexedReference === null ? this.isImageReferenced(value) : indexedReference;
    if (value.indexOf(generatedPrefix) !== 0 || referenced) {
      return false;
    }
    const relativePath = value.slice(this.publicPrefix.length).replace(/^[/\\]+/, "");
    const filePath = path.resolve(this.imageDirectory, relativePath);
    const generatedDirectory = path.resolve(this.imageDirectory, "transfer", "generated");
    if (filePath.indexOf(generatedDirectory + path.sep) !== 0) {
      return false;
    }
    let changed = false;
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      changed = true;
    }
    const sourceIndex = this.readSourceIndex();
    const sourceKeys = Object.keys(sourceIndex);
    for (let index = 0; index < sourceKeys.length; index += 1) {
      if (String(sourceIndex[sourceKeys[index]] || "") === value) {
        delete sourceIndex[sourceKeys[index]];
        changed = true;
      }
    }
    if (changed) {
      fs.writeFileSync(this.sourceIndexPath, JSON.stringify(sourceIndex, null, 2), "utf8");
    }
    return changed;
  }

  /** Cache every URL in one image list while retaining order and failed sources. */
  async cacheImageList(sources, platform, kind, productPath) {
    const input = Array.isArray(sources) ? sources : [];
    const output = [];
    for (let index = 0; index < input.length; index += 1) {
      try {
        output.push(await this.cacheImage(input[index], platform, kind, false, productPath));
      } catch (error) {
        output.push(input[index]);
      }
    }
    return output;
  }

  /** Cache strings or image objects without changing the collector's array shape. */
  async cacheImageEntries(entries, platform, kind, productPath) {
    const input = Array.isArray(entries) ? entries : [];
    for (let index = 0; index < input.length; index += 1) {
      const entry = input[index];
      if (typeof entry === "string") {
        try {
          input[index] = await this.cacheImage(entry, platform, kind, false, productPath);
        } catch (error) {
          input[index] = entry;
        }
        continue;
      }
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const fieldNames = ["url", "imageUrl", "thumbUrl"];
      for (let fieldIndex = 0; fieldIndex < fieldNames.length; fieldIndex += 1) {
        const fieldName = fieldNames[fieldIndex];
        if (entry[fieldName]) {
          try {
            entry[fieldName] = await this.cacheImage(entry[fieldName], platform, kind, false, productPath);
          } catch (error) {
            entry[fieldName] = entry[fieldName];
          }
        }
      }
    }
    return input;
  }

  /** Cache known image fields in one SKU object. */
  async cacheSkuImages(sku, platform, productPath) {
    const target = sku && typeof sku === "object" ? sku : {};
    if (Array.isArray(target.sku_image_urls)) {
      target.sku_image_urls = await this.cacheImageList(target.sku_image_urls, platform, "sku", productPath);
      target.sku_image_url = target.sku_image_urls[0] || "";
    } else if (target.sku_image_url) {
      target.sku_image_url = await this.cacheImage(target.sku_image_url, platform, "sku", false, productPath);
    }
    if (target.imageUrl) {
      target.imageUrl = await this.cacheImage(target.imageUrl, platform, "sku", false, productPath);
    }
    if (target.thumbUrl) {
      target.thumbUrl = await this.cacheImage(target.thumbUrl, platform, "sku", false, productPath);
    }
    return target;
  }

  /** Cache only editable canonical image fields for quick product CRUD saves. */
  async cacheEditableRecordImages(record) {
    const target = record && typeof record === "object" ? record : {};
    const platform = this.normalizePlatform(target.platform || "temu");
    const productPath = this.getProductRelativePath(target, platform);
    if (target.main_image_url) {
      target.main_image_url = await this.cacheImage(target.main_image_url, platform, "main", false, productPath);
    }
    if (Array.isArray(target.gallery_image_urls)) {
      target.gallery_image_urls = await this.cacheImageList(target.gallery_image_urls, platform, "main", productPath);
      target.main_image_url = target.gallery_image_urls[0] || target.main_image_url || "";
    }
    if (Array.isArray(target.detail_image_urls)) {
      target.detail_image_urls = await this.cacheImageList(target.detail_image_urls, platform, "detail", productPath);
    }
    if (Array.isArray(target.sku)) {
      for (let skuIndex = 0; skuIndex < target.sku.length; skuIndex += 1) {
        await this.cacheSkuImages(target.sku[skuIndex], platform, productPath);
      }
    }
    this.writeProductManifest(target, productPath);
    return target;
  }

  /** Cache canonical and collected image fields for one product record. */
  async cacheRecordImages(record) {
    const target = await this.cacheEditableRecordImages(record);
    const platform = this.normalizePlatform(target.platform || "temu");
    const productPath = this.getProductRelativePath(target, platform);
    await this.cacheCollectedImages(target.source_data, platform, productPath);
    this.writeProductManifest(target, productPath);
    return target;
  }

  /** Cache the normalized image fields retained inside extension source data. */
  async cacheCollectedImages(sourceData, platform, productPath) {
    const source = sourceData && typeof sourceData === "object" ? sourceData : {};
    if (source.mainImageUrl) {
      source.mainImageUrl = await this.cacheImage(source.mainImageUrl, platform, "main", false, productPath);
    }
    if (Array.isArray(source.galleryImageUrls)) {
      source.galleryImageUrls = await this.cacheImageList(source.galleryImageUrls, platform, "main", productPath);
    }
    if (Array.isArray(source.detailImageUrls)) {
      source.detailImageUrls = await this.cacheImageList(source.detailImageUrls, platform, "detail", productPath);
    }
    if (Array.isArray(source.skuRows)) {
      for (let skuIndex = 0; skuIndex < source.skuRows.length; skuIndex += 1) {
        await this.cacheSkuImages(source.skuRows[skuIndex], platform, productPath);
      }
    }
    const goods = source.goods && typeof source.goods === "object" ? source.goods : null;
    if (goods) {
      if (goods.mainImageUrl) {
        goods.mainImageUrl = await this.cacheImage(goods.mainImageUrl, platform, "main", false, productPath);
      }
      if (Array.isArray(goods.galleryImageUrls)) {
        goods.galleryImageUrls = await this.cacheImageList(goods.galleryImageUrls, platform, "main", productPath);
      }
      if (Array.isArray(goods.detailImageUrls)) {
        goods.detailImageUrls = await this.cacheImageList(goods.detailImageUrls, platform, "detail", productPath);
      }
      if (Array.isArray(goods.gallery)) {
        goods.gallery = await this.cacheImageEntries(goods.gallery, platform, "main", productPath);
      }
      if (Array.isArray(goods.detailList)) {
        goods.detailList = await this.cacheImageEntries(goods.detailList, platform, "detail", productPath);
      }
    }
    const skuSource = source.sku && typeof source.sku === "object" ? source.sku : null;
    if (skuSource && Array.isArray(skuSource.rows)) {
      for (let rowIndex = 0; rowIndex < skuSource.rows.length; rowIndex += 1) {
        await this.cacheSkuImages(skuSource.rows[rowIndex], platform, productPath);
      }
    }
    if (Array.isArray(source.sku)) {
      for (let sourceSkuIndex = 0; sourceSkuIndex < source.sku.length; sourceSkuIndex += 1) {
        await this.cacheSkuImages(source.sku[sourceSkuIndex], platform, productPath);
      }
    }
  }
}

module.exports = { ImageCacheService: ImageCacheService };
