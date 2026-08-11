const fs = require("fs");
const path = require("path");
const searchModule = require("../1688-image-search");

/** Provide server-side image preparation for the 1688 image-search endpoint. */
class ImageSearchService {
  /** Store the existing image cache dependency for local image resolution. */
  constructor(options) {
    const settings = options || {};
    this.images = settings.images;
    this.publicPrefix = this.images && this.images.publicPrefix ? this.images.publicPrefix : "/api/v1/cache/image";
    this.imageDirectory = this.images && this.images.imageDirectory ? this.images.imageDirectory : "";
  }

  /** Create one image-search error with a client-facing HTTP status code. */
  createImageSearchError(message, statusCode) {
    const error = new Error(String(message || "1688 搜图失败。"));
    error.statusCode = Number(statusCode || 400);
    return error;
  }

  /** Decode one browser data URL into an image buffer. */
  readDataUrl(source) {
    const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/.exec(String(source || ""));
    if (!match) {
      return null;
    }
    return { mime_type: match[1].toLowerCase(), buffer: Buffer.from(match[2], "base64") };
  }

  /** Resolve a local cached image URL to its protected server file. */
  readLocalImage(source) {
    const value = String(source || "");
    const relativePath = value.slice(this.publicPrefix.length).replace(/^[/\\]+/, "");
    if (!relativePath || relativePath.indexOf("..") >= 0 || !this.imageDirectory) {
      return null;
    }
    const filePath = path.join(this.imageDirectory, relativePath);
    if (!fs.existsSync(filePath)) {
      return null;
    }
    return { mime_type: this.getMimeType(filePath), buffer: fs.readFileSync(filePath) };
  }

  /** Return the image MIME type that matches one cached file extension. */
  getMimeType(filePath) {
    const extension = path.extname(String(filePath || "")).toLowerCase();
    const mimeTypes = {
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".webp": "image/webp",
      ".gif": "image/gif",
      ".avif": "image/avif",
      ".bmp": "image/bmp"
    };
    return mimeTypes[extension] || "image/jpeg";
  }

  /** Download one remote image so the upstream 1688 service receives image bytes. */
  async readRemoteImage(source) {
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
      throw new Error("图片地址返回的不是图片。");
    }
    return { mime_type: mimeType, buffer: Buffer.from(await response.arrayBuffer()) };
  }

  /** Read a data URL, local cache URL or remote image URL into one buffer. */
  async readImageSource(source) {
    const value = String(source || "").trim();
    if (!value) {
      throw this.createImageSearchError("请选择一张图片进行 1688 搜图。", 400);
    }
    const dataImage = this.readDataUrl(value);
    if (dataImage) {
      return dataImage;
    }
    const parsedUrl = new URL(value, "http://127.0.0.1");
    if (parsedUrl.pathname.indexOf(this.publicPrefix + "/") === 0) {
      const localImage = this.readLocalImage(parsedUrl.pathname);
      if (!localImage) {
        throw this.createImageSearchError("本地图片不存在或已经失效。", 404);
      }
      return localImage;
    }
    if (/^https?:$/i.test(parsedUrl.protocol)) {
      return this.readRemoteImage(parsedUrl.toString());
    }
    throw this.createImageSearchError("不支持的图片地址。", 400);
  }

  /** Search 1688 by one product image and return the generated search page. */
  async search1688(input) {
    const source = input && (input.image_url || input.source);
    const image = await this.readImageSource(source);
    if (!image.buffer || !image.buffer.length) {
      throw new Error("图片内容为空，无法进行 1688 搜图。");
    }
    const result = await searchModule.search1688ByImage(image.buffer.toString("base64"));
    return {
      image_id: String(result.image_id || ""),
      search_url: String(result.url || ""),
      offers: Array.isArray(result.offers) ? result.offers : []
    };
  }
}

module.exports = { ImageSearchService: ImageSearchService };
