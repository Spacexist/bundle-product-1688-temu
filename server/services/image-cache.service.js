const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

/** Persist product images as content-addressed files under the project cache. */
class ImageCacheService {
  /** Resolve storage paths and create the supported image cache directories. */
  constructor(options) {
    const settings = options || {};
    this.cacheDirectory = path.resolve(__dirname, "..", settings.cacheDirectory || "../../cache");
    this.imageDirectory = path.resolve(__dirname, "..", settings.imageDirectory || "../../cache/image");
    this.publicPrefix = "/api/v1/cache/image";
    this.sourceIndexPath = path.join(this.imageDirectory, "source-index.json");
    this.ensureDirectories();
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
  }

  /** Return whether a source already points at the local image API. */
  isLocalImageUrl(source) {
    return String(source || "").indexOf(this.publicPrefix + "/") === 0;
  }

  /** Read one local image API URL from the server cache for ZIP export. */
  readLocalImage(localUrl) {
    if (!this.isLocalImageUrl(localUrl)) {
      return null;
    }
    const relativePath = String(localUrl || "").slice(this.publicPrefix.length).replace(/^[/\\]+/, "");
    if (!relativePath || relativePath.indexOf("..") >= 0) {
      return null;
    }
    const filePath = path.join(this.imageDirectory, relativePath);
    if (!fs.existsSync(filePath)) {
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
    if (!fs.existsSync(this.sourceIndexPath)) {
      return {};
    }
    try {
      const payload = JSON.parse(fs.readFileSync(this.sourceIndexPath, "utf8"));
      return payload && typeof payload === "object" ? payload : {};
    } catch (error) {
      return {};
    }
  }

  /** Resolve one local API URL to its cache file and verify that it still exists. */
  localUrlExists(localUrl) {
    const relativePath = String(localUrl || "").slice(this.publicPrefix.length).replace(/^[/\\]+/, "");
    if (!relativePath || relativePath.indexOf("..") >= 0) {
      return false;
    }
    return fs.existsSync(path.join(this.imageDirectory, relativePath));
  }

  /** Return a previously cached file for the exact same remote source URL. */
  findSourceCache(source) {
    if (!/^https?:\/\//i.test(String(source || ""))) {
      return "";
    }
    const sourceHash = crypto.createHash("sha256").update(String(source)).digest("hex");
    const index = this.readSourceIndex();
    const localUrl = String(index[sourceHash] || "");
    return this.localUrlExists(localUrl) ? localUrl : "";
  }

  /** Record the exact remote source hash after an image has been cached. */
  rememberSourceCache(source, localUrl) {
    if (!/^https?:\/\//i.test(String(source || "")) || !localUrl) {
      return;
    }
    const sourceHash = crypto.createHash("sha256").update(String(source)).digest("hex");
    const index = this.readSourceIndex();
    index[sourceHash] = localUrl;
    fs.writeFileSync(this.sourceIndexPath, JSON.stringify(index, null, 2), "utf8");
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
  async readRemoteUrl(source) {
    const response = await fetch(String(source), {
      signal: AbortSignal.timeout(15000),
      headers: {
        "User-Agent": "Mozilla/5.0",
        Referer: "https://www.1688.com/"
      }
    });
    if (!response.ok) {
      throw new Error("图片下载失败，HTTP " + response.status + "。");
    }
    const mimeType = String(response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (mimeType.indexOf("image/") !== 0) {
      throw new Error("远程地址返回的不是图片。");
    }
    return { mimeType: mimeType, buffer: Buffer.from(await response.arrayBuffer()) };
  }

  /** Read one Base64 or HTTP image source without changing the original on failure. */
  async readSource(source) {
    const dataImage = this.readDataUrl(source);
    if (dataImage) {
      return dataImage;
    }
    if (/^https?:\/\//i.test(String(source || ""))) {
      return this.readRemoteUrl(source);
    }
    return null;
  }

  /** Persist one image by content hash and return its stable local API URL. */
  async cacheImage(source, platform, kind, generated) {
    if (!source || this.isLocalImageUrl(source)) {
      return String(source || "");
    }
    const existingUrl = this.findSourceCache(source);
    if (existingUrl) {
      return existingUrl;
    }
    const image = await this.readSource(source);
    if (!image || !image.buffer.length) {
      return String(source || "");
    }
    const extension = this.getExtension(image.mimeType);
    if (!extension) {
      return String(source || "");
    }
    const safePlatform = generated ? "transfer" : String(platform || "temu").toLowerCase() === "1688" ? "1688" : "temu";
    const safeKind = generated ? "generated" : ["main", "detail", "sku"].indexOf(kind) >= 0 ? kind : "main";
    const hash = crypto.createHash("sha256").update(image.buffer).digest("hex");
    const fileName = hash + extension;
    const directory = path.join(this.imageDirectory, safePlatform, safeKind);
    const filePath = path.join(directory, fileName);
    fs.mkdirSync(directory, { recursive: true });
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, image.buffer);
    }
    const localUrl = this.publicPrefix + "/" + safePlatform + "/" + safeKind + "/" + fileName;
    this.rememberSourceCache(source, localUrl);
    return localUrl;
  }

  /** Cache every URL in one image list while retaining order and failed sources. */
  async cacheImageList(sources, platform, kind) {
    const input = Array.isArray(sources) ? sources : [];
    const output = [];
    for (let index = 0; index < input.length; index += 1) {
      try {
        output.push(await this.cacheImage(input[index], platform, kind, false));
      } catch (error) {
        output.push(input[index]);
      }
    }
    return output;
  }

  /** Cache strings or image objects without changing the collector's array shape. */
  async cacheImageEntries(entries, platform, kind) {
    const input = Array.isArray(entries) ? entries : [];
    for (let index = 0; index < input.length; index += 1) {
      const entry = input[index];
      if (typeof entry === "string") {
        try {
          input[index] = await this.cacheImage(entry, platform, kind, false);
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
            entry[fieldName] = await this.cacheImage(entry[fieldName], platform, kind, false);
          } catch (error) {
            entry[fieldName] = entry[fieldName];
          }
        }
      }
    }
    return input;
  }

  /** Cache known image fields in one SKU object. */
  async cacheSkuImages(sku, platform) {
    const target = sku && typeof sku === "object" ? sku : {};
    if (Array.isArray(target.sku_image_urls)) {
      target.sku_image_urls = await this.cacheImageList(target.sku_image_urls, platform, "sku");
      target.sku_image_url = target.sku_image_urls[0] || "";
    } else if (target.sku_image_url) {
      target.sku_image_url = await this.cacheImage(target.sku_image_url, platform, "sku", false);
    }
    if (target.imageUrl) {
      target.imageUrl = await this.cacheImage(target.imageUrl, platform, "sku", false);
    }
    if (target.thumbUrl) {
      target.thumbUrl = await this.cacheImage(target.thumbUrl, platform, "sku", false);
    }
    return target;
  }

  /** Cache canonical and collected image fields for one product record. */
  async cacheRecordImages(record) {
    const target = record && typeof record === "object" ? record : {};
    const platform = String(target.platform || "temu").toLowerCase() === "1688" ? "1688" : "temu";
    if (target.main_image_url) {
      target.main_image_url = await this.cacheImage(target.main_image_url, platform, "main", false);
    }
    if (Array.isArray(target.gallery_image_urls)) {
      target.gallery_image_urls = await this.cacheImageList(target.gallery_image_urls, platform, "main");
      target.main_image_url = target.gallery_image_urls[0] || target.main_image_url || "";
    }
    if (Array.isArray(target.detail_image_urls)) {
      target.detail_image_urls = await this.cacheImageList(target.detail_image_urls, platform, "detail");
    }
    if (Array.isArray(target.sku)) {
      for (let skuIndex = 0; skuIndex < target.sku.length; skuIndex += 1) {
        await this.cacheSkuImages(target.sku[skuIndex], platform);
      }
    }
    await this.cacheCollectedImages(target.source_data, platform);
    return target;
  }

  /** Cache the normalized image fields retained inside extension source data. */
  async cacheCollectedImages(sourceData, platform) {
    const source = sourceData && typeof sourceData === "object" ? sourceData : {};
    if (source.mainImageUrl) {
      source.mainImageUrl = await this.cacheImage(source.mainImageUrl, platform, "main", false);
    }
    if (Array.isArray(source.galleryImageUrls)) {
      source.galleryImageUrls = await this.cacheImageList(source.galleryImageUrls, platform, "main");
    }
    if (Array.isArray(source.detailImageUrls)) {
      source.detailImageUrls = await this.cacheImageList(source.detailImageUrls, platform, "detail");
    }
    if (Array.isArray(source.skuRows)) {
      for (let skuIndex = 0; skuIndex < source.skuRows.length; skuIndex += 1) {
        await this.cacheSkuImages(source.skuRows[skuIndex], platform);
      }
    }
    const goods = source.goods && typeof source.goods === "object" ? source.goods : null;
    if (goods) {
      if (goods.mainImageUrl) {
        goods.mainImageUrl = await this.cacheImage(goods.mainImageUrl, platform, "main", false);
      }
      if (Array.isArray(goods.galleryImageUrls)) {
        goods.galleryImageUrls = await this.cacheImageList(goods.galleryImageUrls, platform, "main");
      }
      if (Array.isArray(goods.detailImageUrls)) {
        goods.detailImageUrls = await this.cacheImageList(goods.detailImageUrls, platform, "detail");
      }
      if (Array.isArray(goods.gallery)) {
        goods.gallery = await this.cacheImageEntries(goods.gallery, platform, "main");
      }
      if (Array.isArray(goods.detailList)) {
        goods.detailList = await this.cacheImageEntries(goods.detailList, platform, "detail");
      }
    }
    const skuSource = source.sku && typeof source.sku === "object" ? source.sku : null;
    if (skuSource && Array.isArray(skuSource.rows)) {
      for (let rowIndex = 0; rowIndex < skuSource.rows.length; rowIndex += 1) {
        await this.cacheSkuImages(skuSource.rows[rowIndex], platform);
      }
    }
    if (Array.isArray(source.sku)) {
      for (let sourceSkuIndex = 0; sourceSkuIndex < source.sku.length; sourceSkuIndex += 1) {
        await this.cacheSkuImages(source.sku[sourceSkuIndex], platform);
      }
    }
  }
}

module.exports = { ImageCacheService: ImageCacheService };
