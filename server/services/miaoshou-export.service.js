const archiver = require("archiver");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const stream = require("stream");
const XLSX = require("xlsx");

const MIAOSHOU_BASE_URL = "https://erp.91miaoshou.com";
const MIAOSHOU_WEB_INIT_CONFIG_PATH = "/api/home/home/getWebInitConfig";
const MIAOSHOU_GET_STS_PATH = "/api/app_media/app_attach_file/getOssUploadTempFileStsConfig";
const MIAOSHOU_PROCESS_PATH = "/api/move/common_collect_box/processImportCopyV2";
const MIAOSHOU_APP_SIGN_AES_KEY = "c70528119f323ee2";
const MIAOSHOU_APP_SIGN_REPLACE_KEY = "50fb8857276b7c76b871754755571d76";
const MIAOSHOU_COOKIE_EXPIRY_SKEW_MS = 60000;

/** Return an array or a safe empty list for one cache field. */
function asArray(value) {
  return Array.isArray(value) ? value : [];
}

/** Read ordered image URLs from the normalized cache representation. */
function readImageUrls(value) {
  const result = [];
  const list = asArray(value);
  for (let index = 0; index < list.length; index += 1) {
    const item = list[index];
    const url = typeof item === "string" ? item : item && (item.url || item.imageUrl);
    if (url) {
      result.push(String(url));
    }
  }
  return result;
}

/** Split one SKU specification into its display value. */
function parseSpecValue(value, fallbackName) {
  const raw = String(value || "").trim();
  if (!raw) {
    return { name: fallbackName, value: "" };
  }
  const separatorIndex = raw.indexOf(":");
  if (separatorIndex > 0) {
    return { name: raw.slice(0, separatorIndex).trim() || fallbackName, value: raw.slice(separatorIndex + 1).trim() };
  }
  return { name: fallbackName, value: raw };
}

/** Preserve numeric prices while leaving non-numeric source text unchanged. */
function parseMiaoshouPrice(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  const text = String(value === undefined || value === null ? "" : value).trim();
  if (!text) {
    return "";
  }
  const normalized = text.replace(/,/g, "");
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(normalized)) {
    return Number(normalized);
  }
  return text;
}

/** Convert an empty or invalid stock/weight value to the requested fallback. */
function parseMiaoshouNumber(value, fallback) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  const text = String(value === undefined || value === null ? "" : value).trim().replace(/,/g, "");
  if (!text) {
    return fallback;
  }
  const number = Number(text);
  return Number.isFinite(number) ? number : fallback;
}

/** Format SKU length, width and height as the 妙手 CM dimension value. */
function formatMiaoshouDimensions(sku) {
  const source = sku && typeof sku === "object" ? sku : {};
  const length = source.sku_length !== undefined && source.sku_length !== ""
    ? source.sku_length
    : source.skuLength !== undefined && source.skuLength !== "" ? source.skuLength : source.length;
  const width = source.sku_width !== undefined && source.sku_width !== ""
    ? source.sku_width
    : source.skuWidth !== undefined && source.skuWidth !== "" ? source.skuWidth : source.width;
  const height = source.sku_height !== undefined && source.sku_height !== ""
    ? source.sku_height
    : source.skuHeight !== undefined && source.skuHeight !== "" ? source.skuHeight : source.height;
  if ((length === undefined || length === "")
    && (width === undefined || width === "")
    && (height === undefined || height === "")) {
    return "";
  }
  const lengthText = length === undefined || length === null ? "" : String(length);
  const widthText = width === undefined || width === null ? "" : String(width);
  const heightText = height === undefined || height === null ? "" : String(height);
  return [lengthText, widthText, heightText].join("*");
}

/** Join Temu attributes into the description column expected by 妙手. */
function buildMiaoshouDescription(value) {
  const rows = asArray(value);
  const result = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (!row || typeof row !== "object") {
      continue;
    }
    const key = String(row.key || row.name || row.label || "").trim();
    const values = row.values === undefined ? row.value : row.values;
    const valueList = Array.isArray(values) ? values : [values];
    const readableValues = [];
    for (let valueIndex = 0; valueIndex < valueList.length; valueIndex += 1) {
      const item = valueList[valueIndex];
      if (item !== undefined && item !== null && String(item).trim()) {
        readableValues.push(String(item).trim());
      }
    }
    if (key && readableValues.length) {
      result.push(key + "：" + readableValues.join("、"));
    } else if (readableValues.length) {
      result.push(readableValues.join("、"));
    }
  }
  return result.join("；");
}

/** Reject local or remote image URLs that belong to the abandoned 1688 source. */
function isTemuImage(value) {
  const source = String(value || "").trim().toLowerCase();
  if (!source) {
    return false;
  }
  return source.indexOf("/1688/") < 0
    && source.indexOf("1688.com") < 0
    && source.indexOf("alicdn.com") < 0
    && source.indexOf("taobao.com") < 0;
}

/** Collect unique Temu image URLs while keeping the original order. */
function collectImageUrls(primary, values) {
  const result = [];
  const candidates = [];
  if (primary) {
    candidates.push(primary);
  }
  const stored = readImageUrls(values);
  for (let index = 0; index < stored.length; index += 1) {
    candidates.push(stored[index]);
  }
  for (let index = 0; index < candidates.length; index += 1) {
    const source = String(candidates[index] || "").trim();
    if (isTemuImage(source) && result.indexOf(source) < 0) {
      result.push(source);
    }
  }
  return result;
}

/** Convert a product or SKU label into a safe Windows ZIP entry name. */
function safeMiaoshouName(value, fallback) {
  const text = String(value || fallback || "产品素材包").replace(/[\\/:*?"<>|]/g, "_").trim();
  return (text || fallback || "产品素材包").slice(0, 80);
}

/** Clean a browser Cookie header before it is saved or sent upstream. */
function normalizeMiaoshouCookie(cookie) {
  return String(cookie || "").trim().replace(/\\_/g, "_").replace(/[\r\n]+/g, " ");
}

/** Read one named cookie value from a Cookie header string. */
function getMiaoshouCookieValue(cookie, name) {
  const parts = normalizeMiaoshouCookie(cookie).split(";");
  const prefix = String(name || "") + "=";
  for (let index = 0; index < parts.length; index += 1) {
    const item = parts[index].trim();
    if (item.indexOf(prefix) === 0) {
      return item.slice(prefix.length);
    }
  }
  return "";
}

/** Decode one base64url segment from a Miaoshou JWT cookie value. */
function decodeMiaoshouBase64Url(value) {
  const text = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padding = text.length % 4 ? "=".repeat(4 - (text.length % 4)) : "";
  return Buffer.from(text + padding, "base64").toString("utf8");
}

/** Parse the payload section from a Miaoshou autoLoginToken JWT. */
function decodeMiaoshouJwtPayload(token) {
  const parts = String(token || "").split(".");
  if (parts.length < 2) {
    return null;
  }
  try {
    return JSON.parse(decodeMiaoshouBase64Url(parts[1]));
  } catch (error) {
    return null;
  }
}

/** Return all positive second-based expiry claims from a Miaoshou JWT payload. */
function readMiaoshouExpiryClaimSeconds(payload) {
  const source = payload && typeof payload === "object" ? payload : {};
  const names = ["exp", "expireTime"];
  const values = [];
  for (let index = 0; index < names.length; index += 1) {
    const seconds = Number(source[names[index]] || 0);
    if (Number.isFinite(seconds) && seconds > 0) {
      values.push(seconds);
    }
  }
  if (!values.length) {
    return 0;
  }
  return Math.min.apply(null, values);
}

/** Read the best known expiry timestamp from the saved Miaoshou Cookie. */
function readMiaoshouCookieExpiresAt(cookie) {
  const token = getMiaoshouCookieValue(cookie, "autoLoginToken");
  const payload = decodeMiaoshouJwtPayload(token);
  const seconds = readMiaoshouExpiryClaimSeconds(payload);
  if (!seconds) {
    return "";
  }
  return new Date(seconds * 1000).toISOString();
}

/** Summarize whether one Miaoshou Cookie exists and is locally expired. */
function createMiaoshouCookieStatus(cookie) {
  const normalizedCookie = normalizeMiaoshouCookie(cookie);
  const expiresAt = readMiaoshouCookieExpiresAt(normalizedCookie);
  const expiresTime = expiresAt ? Date.parse(expiresAt) : 0;
  const expired = Boolean(expiresTime && Date.now() + MIAOSHOU_COOKIE_EXPIRY_SKEW_MS >= expiresTime);
  return {
    hasCookie: Boolean(normalizedCookie),
    expired: expired,
    expiresAt: expiresAt
  };
}

/** Convert one upstream JSON response into an Error with a readable message. */
function createMiaoshouError(message, statusCode, details) {
  const error = new Error(message);
  error.statusCode = statusCode || 502;
  error.details = details || null;
  return error;
}

/** Return true when Miaoshou's response looks like an expired or invalid login. */
function isMiaoshouLoginFailure(payload, statusCode) {
  if (statusCode === 401 || statusCode === 403) {
    return true;
  }
  const source = payload && typeof payload === "object" ? payload : {};
  const text = [
    source.result,
    source.code,
    source.reason,
    source.message,
    source.msg,
    source.error
  ].join(" ");
  return /登录|登陆|未登录|未登陆|授权|过期|cookie|token|login|auth/i.test(text);
}

/** Create the standard frontend-readable error for expired Miaoshou cookies. */
function createMiaoshouLoginError(details) {
  return createMiaoshouError("妙手 Cookie 已过期或无效，请重新复制 Cookie 后再试。", 401, details || null);
}

/** Decode the dynamic Miaoshou x-app-zebra signing rule using Node crypto. */
function decryptMiaoshouSignRule(encryptedRule) {
  const decipher = crypto.createDecipheriv("aes-128-cbc", Buffer.from(MIAOSHOU_APP_SIGN_AES_KEY), Buffer.alloc(16));
  return Buffer.concat([
    decipher.update(Buffer.from(String(encryptedRule || ""), "base64")),
    decipher.final()
  ]).toString("utf8");
}

/** Convert a full Miaoshou API path into the apiName string used by the signer. */
function normalizeMiaoshouApiName(pathname) {
  const pathText = String(pathname || "");
  if (pathText.indexOf("/api/") === 0) {
    return pathText.slice(5);
  }
  if (pathText.indexOf("/") === 0) {
    return pathText.slice(1);
  }
  return pathText;
}

/** Build the signed browser-like headers required by Miaoshou backend APIs. */
async function createMiaoshouSignedHeaders(cookie, pathname, frontVersion) {
  const normalizedCookie = normalizeMiaoshouCookie(cookie);
  if (!normalizedCookie) {
    throw createMiaoshouError("请先输入妙手 Cookie。", 400, null);
  }
  const baseHeaders = {
    Accept: "application/json, text/plain, */*",
    Origin: MIAOSHOU_BASE_URL,
    Referer: MIAOSHOU_BASE_URL + "/common_collect_box/index?fetchType=importCopy",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36",
    Cookie: normalizedCookie
  };
  const initResponse = await fetch(MIAOSHOU_BASE_URL + MIAOSHOU_WEB_INIT_CONFIG_PATH, {
    headers: baseHeaders,
    signal: AbortSignal.timeout(30000)
  });
  const initText = await initResponse.text();
  let initPayload = null;
  try {
    initPayload = JSON.parse(initText);
  } catch (error) {
    if (isMiaoshouLoginFailure(null, initResponse.status)) {
      throw createMiaoshouLoginError({ status: initResponse.status });
    }
    throw createMiaoshouError("妙手签名配置返回不是 JSON。", 502, { status: initResponse.status });
  }
  if (isMiaoshouLoginFailure(initPayload, initResponse.status)) {
    throw createMiaoshouLoginError({ status: initResponse.status });
  }
  if (!initResponse.ok) {
    throw createMiaoshouError("妙手签名配置获取失败，HTTP " + initResponse.status + "。", 502, { status: initResponse.status });
  }
  const data = initPayload && initPayload.data && initPayload.data.timestamp && initPayload.data.rule ? initPayload.data : initPayload;
  if (!data || !data.timestamp || !data.rule) {
    throw createMiaoshouError("妙手签名配置缺少 timestamp 或 rule。", 502, { status: initResponse.status });
  }
  let rule = null;
  try {
    rule = JSON.parse(decryptMiaoshouSignRule(data.rule));
  } catch (error) {
    throw createMiaoshouError("妙手签名规则解析失败，请刷新 Cookie 后重试。", 502, { status: initResponse.status });
  }
  const timestamp = String(Number(data.timestamp || Math.floor(Date.now() / 1000)));
  const signTemplate = String(rule.rule || "").replace(/key/g, MIAOSHOU_APP_SIGN_REPLACE_KEY);
  const signText = signTemplate
    .replace(/apiName/g, normalizeMiaoshouApiName(pathname))
    .replace(/timestamp/g, timestamp);
  const headers = Object.assign({}, baseHeaders, {
    "Content-Type": "application/x-www-form-urlencoded",
    "x-timestamp": timestamp,
    "x-front-version": String(frontVersion || "")
  });
  headers[rule.key] = crypto.createHash("md5").update(signText).digest("hex");
  return headers;
}

/** Extract the STS config object from the Miaoshou response envelope. */
function readMiaoshouStsConfig(payload) {
  const source = payload && typeof payload === "object" ? payload : {};
  const stsConfig = source.stsConfig && typeof source.stsConfig === "object" ? source.stsConfig : null;
  if (source.result !== "success" || !stsConfig) {
    if (isMiaoshouLoginFailure(source, 200)) {
      throw createMiaoshouLoginError(source);
    }
    throw createMiaoshouError("妙手 OSS 凭证获取失败：" + String(source.reason || source.message || "未知错误。"), 502, null);
  }
  return stsConfig;
}

/** Generate the object path expected by Miaoshou collect-box import ZIP uploads. */
function generateMiaoshouOssPath(cookie) {
  const accountId = getMiaoshouCookieValue(cookie, "accountId");
  if (!accountId) {
    throw createMiaoshouError("妙手 Cookie 缺少 accountId。", 400, null);
  }
  return "temp_dir/d1/collect_import_zip/" + accountId + "/mserpZip_" + Date.now() + "_" + crypto.randomUUID() + ".zip";
}

/** Resolve the public OSS upload URL from STS config and object path. */
function buildMiaoshouOssUrl(stsConfig, ossPath) {
  return "https://" + String(stsConfig.bucket || "earth-pvt") + "." + String(stsConfig.region || "oss-cn-beijing") + ".aliyuncs.com/" + String(ossPath || "").replace(/^[/\\]+/, "");
}

/** Build a browser-compatible Alibaba OSS V1 PUT signature for ZIP upload. */
function buildMiaoshouOssPutHeaders(ossUrl, stsConfig, body) {
  const parsed = new URL(ossUrl);
  const bucket = parsed.hostname.split(".")[0];
  const objectKey = parsed.pathname;
  const contentType = "application/zip";
  const ossDate = new Date().toUTCString();
  const ossUserAgent = "aliyun-sdk-js/6.23.0 AutoBuild";
  const canonicalizedHeaders = "x-oss-date:" + ossDate + "\n"
    + "x-oss-security-token:" + String(stsConfig.securityToken || "") + "\n"
    + "x-oss-user-agent:" + ossUserAgent + "\n";
  const stringToSign = "PUT\n\n" + contentType + "\n" + ossDate + "\n"
    + canonicalizedHeaders
    + "/" + bucket + objectKey;
  const signature = crypto.createHmac("sha1", String(stsConfig.accessKeySecret || ""))
    .update(stringToSign)
    .digest("base64");
  return {
    Accept: "*/*",
    "Content-Type": contentType,
    "Content-Length": String(body.length),
    Host: parsed.hostname,
    Origin: MIAOSHOU_BASE_URL,
    Referer: MIAOSHOU_BASE_URL + "/",
    Date: ossDate,
    "x-oss-date": ossDate,
    "x-oss-security-token": String(stsConfig.securityToken || ""),
    "x-oss-user-agent": ossUserAgent,
    Authorization: "OSS " + String(stsConfig.accessKeyId || "") + ":" + signature
  };
}

/** Build all server-side files required by the 妙手 product import package. */
class MiaoshouExportService {
  /** Store the cache, ViewModel and image-cache dependencies. */
  constructor(options) {
    const settings = options || {};
    this.repository = settings.repository;
    this.viewModels = settings.viewModels;
    this.images = settings.images;
    this.cacheDirectory = path.resolve(__dirname, "..", settings.cacheDirectory || (this.repository && this.repository.cacheDirectory) || "D:/自动组货/cache");
    this.cookieFilePath = path.resolve(__dirname, "..", "cookie.json");
  }

  /** Persist the latest Miaoshou Cookie in server/cookie.json for reuse and inspection. */
  saveMiaoshouCookie(cookie) {
    const normalizedCookie = normalizeMiaoshouCookie(cookie);
    if (!normalizedCookie) {
      throw createMiaoshouError("请先输入妙手 Cookie。", 400, null);
    }
    const status = createMiaoshouCookieStatus(normalizedCookie);
    if (status.expired) {
      throw createMiaoshouLoginError({ expires_at: status.expiresAt });
    }
    fs.mkdirSync(path.dirname(this.cookieFilePath), { recursive: true });
    fs.writeFileSync(this.cookieFilePath, JSON.stringify({
      updated_at: new Date().toISOString(),
      cookie: normalizedCookie
    }, null, 2), "utf8");
    return normalizedCookie;
  }

  /** Read the saved Miaoshou Cookie from server/cookie.json when it exists. */
  readSavedMiaoshouCookie() {
    if (!fs.existsSync(this.cookieFilePath)) {
      return "";
    }
    let payload = null;
    try {
      payload = JSON.parse(fs.readFileSync(this.cookieFilePath, "utf8"));
    } catch (error) {
      throw createMiaoshouError("server/cookie.json 不是有效 JSON，请重新粘贴 Cookie。", 400, null);
    }
    return normalizeMiaoshouCookie(payload && payload.cookie);
  }

  /** Return frontend-safe metadata for the saved Miaoshou Cookie. */
  getSavedMiaoshouCookieStatus() {
    const cookie = this.readSavedMiaoshouCookie();
    const status = createMiaoshouCookieStatus(cookie);
    return {
      hasCookie: status.hasCookie,
      expired: status.expired,
      expiresAt: status.expiresAt,
      path: this.cookieFilePath
    };
  }

  /** Prefer a newly pasted Cookie, otherwise reuse the valid saved Cookie. */
  resolveMiaoshouCookie(cookie) {
    const normalizedCookie = normalizeMiaoshouCookie(cookie);
    if (normalizedCookie) {
      return this.saveMiaoshouCookie(normalizedCookie);
    }
    const savedCookie = this.readSavedMiaoshouCookie();
    if (!savedCookie) {
      throw createMiaoshouError("server/cookie.json 中没有可用 Cookie，请先粘贴一次妙手 Cookie。", 400, null);
    }
    const status = createMiaoshouCookieStatus(savedCookie);
    if (status.expired) {
      throw createMiaoshouLoginError({ expires_at: status.expiresAt });
    }
    return savedCookie;
  }

  /** Build one 妙手-compatible workbook from a Temu ViewModel record. */
  buildWorkbook(record) {
    const item = record || {};
    const headers = ["* 产品标题", "货币类型", "货源链接", "货源平台", "产品主编号", "详情描述", "货源类目", "属性", "SKU规格1", "SKU规格2", "平台SKU", "* SKU售价", "SKU库存", "SKU重量(KG)", "SKU尺寸(CM)"];
    const note = "注意事项：同一个商品多个SKU时，SPU级信息只填写第一行；图片通过素材包目录上传。";
    const rows = [[note], headers];
    const sourceRows = asArray(item.sku);
    const skuRows = sourceRows.length ? sourceRows : [{ sku_id: item.product_id || item.main_id, sku_price: "", sku_stock: 0, sku_weight: 0 }];
    const description = buildMiaoshouDescription(item.attributes_json);
    const productId = String(item.product_id || item.main_id || "");
    for (let index = 0; index < skuRows.length; index += 1) {
      const sku = skuRows[index] || {};
      const firstSpec = parseSpecValue(sku.SubSku1 || sku.subSku1, "SubSku1");
      const secondSpec = parseSpecValue(sku.SubSku2 || sku.subSku2, "SubSku2");
      const platformSku = String(sku.sku_id || sku.skuId || (productId ? productId + "-" + (index + 1) : String(item.main_id || "") + "-" + (index + 1)));
      const productFields = index === 0
        ? [String(item.product_name || ""), "CNY", String(item.page_url || ""), "Temu", productId, description, String(item.product_category || ""), ""]
        : ["", "", "", "", "", "", "", ""];
      rows.push(productFields.concat([
        firstSpec.value,
        secondSpec.value,
        platformSku,
        parseMiaoshouPrice(sku.sku_price),
        parseMiaoshouNumber(sku.sku_stock, 0),
        parseMiaoshouNumber(sku.sku_weight, 0),
        formatMiaoshouDimensions(sku)
      ]));
    }
    const sheet = XLSX.utils.aoa_to_sheet(rows);
    const columns = [];
    for (let index = 0; index < headers.length; index += 1) {
      columns.push({ wch: 18 });
    }
    sheet["!cols"] = columns;
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, "Worksheet");
    return XLSX.write(workbook, { bookType: "xlsx", type: "buffer" });
  }

  /** Read one Temu source image through the server-side cache. */
  async readExportImage(source, kind) {
    const value = String(source || "").trim();
    if (!isTemuImage(value)) {
      return null;
    }
    let localUrl = value;
    if (!this.images.isLocalImageUrl(value)) {
      localUrl = await this.images.cacheImage(value, "temu", kind, false);
    }
    const image = this.images.readLocalImage(localUrl);
    if (!image) {
      throw new Error("图片未找到：" + value);
    }
    return image;
  }

  /** Create a standard ZIP stream and pipe output directly to the download response. */
  createArchive(output) {
    const archive = archiver("zip", { store: true });
    const completion = new Promise(function createArchivePromise(resolve, reject) {
      /** Resolve after the standard ZIP stream writes its end record. */
      function handleArchiveEnd() {
        resolve();
      }
      /** Reject when the ZIP stream reports a generation error. */
      function handleArchiveError(error) {
        reject(error);
      }
      archive.on("end", handleArchiveEnd);
      archive.on("error", handleArchiveError);
    });
    if (output && typeof archive.pipe === "function") {
      archive.pipe(output);
    }
    return { archive: archive, completion: completion };
  }

  /** Add one empty folder entry to preserve the 妙手 material directory layout. */
  addFolder(archive, name) {
    archive.append(Buffer.alloc(0), { name: name + "/", mode: "0755" });
  }

  /** Add one image to a standard ZIP stream and retain failures without aborting export. */
  async addImage(archive, name, source, kind, failures) {
    const value = String(source || "").trim();
    if (!value) {
      return;
    }
    try {
      const image = await this.readExportImage(value, kind);
      if (image) {
        archive.append(image.buffer, { name: name + image.extension, mode: "0644" });
      }
    } catch (error) {
      failures.push(value);
    }
  }

  /** Generate one complete Temu-only 妙手 ZIP from the server cache. */
  async createTemuZip(output, onStart) {
    const payload = this.repository.read();
    const view = this.viewModels.createWorkbench(payload);
    const records = [];
    for (let index = 0; index < view.records.length; index += 1) {
      if (String(view.records[index].platform || "").toLowerCase() === "temu") {
        records.push(view.records[index]);
      }
    }
    if (!records.length) {
      const error = new Error("当前没有可导出的 Temu 商品。");
      error.statusCode = 400;
      throw error;
    }

    const failures = [];
    const packageName = safeMiaoshouName("Temu-妙手导入包-" + Date.now(), "Temu-妙手导入包");
    const fileName = packageName + ".zip";
    if (typeof onStart === "function") {
      onStart({ fileName: fileName, productCount: records.length });
    }
    const archiveState = this.createArchive(output);
    const archive = archiveState.archive;
    this.addFolder(archive, packageName);
    for (let productIndex = 0; productIndex < records.length; productIndex += 1) {
      const record = records[productIndex] || {};
      const productName = safeMiaoshouName(record.product_name, "Temu商品");
      const productCode = safeMiaoshouName(record.product_id || record.main_id, String(productIndex + 1));
      const productRoot = packageName + "/" + productName + "_" + productCode;
      archive.append(this.buildWorkbook(record), { name: productRoot + "/导入产品模板.xlsx", mode: "0644" });
      this.addFolder(archive, productRoot);
      this.addFolder(archive, productRoot + "/产品主图");
      this.addFolder(archive, productRoot + "/SKU图");
      this.addFolder(archive, productRoot + "/详情图");
      this.addFolder(archive, productRoot + "/尺寸图表");
      this.addFolder(archive, productRoot + "/产品视频");
      this.addFolder(archive, productRoot + "/产品证书");

      const mainImages = collectImageUrls(record.main_image_url, record.gallery_image_urls);
      let detailImages = collectImageUrls("", record.detail_image_urls);
      if (!detailImages.length) {
        detailImages = collectImageUrls("", record.gallery_image_urls);
      }
      if (!detailImages.length) {
        detailImages = mainImages.slice();
      }
      for (let imageIndex = 0; imageIndex < mainImages.length; imageIndex += 1) {
        await this.addImage(archive, productRoot + "/产品主图/主图_" + (imageIndex + 1), mainImages[imageIndex], "main", failures);
      }
      for (let imageIndex = 0; imageIndex < detailImages.length; imageIndex += 1) {
        await this.addImage(archive, productRoot + "/详情图/详情图_" + (imageIndex + 1), detailImages[imageIndex], "detail", failures);
      }

      const exportedSkuKeys = [];
      const skuRows = asArray(record.sku);
      for (let skuIndex = 0; skuIndex < skuRows.length; skuIndex += 1) {
        const sku = skuRows[skuIndex] || {};
        const firstSpec = parseSpecValue(sku.SubSku1 || sku.subSku1, "SKU");
        const skuKey = firstSpec.value || String(sku.sku_id || sku.skuId || skuIndex + 1);
        if (exportedSkuKeys.indexOf(skuKey) >= 0) {
          continue;
        }
        const skuImages = collectImageUrls("", sku.sku_image_urls);
        if (!skuImages.length && sku.sku_image_url) {
          skuImages.push(String(sku.sku_image_url));
        }
        if (!skuImages.length) {
          continue;
        }
        exportedSkuKeys.push(skuKey);
        await this.addImage(archive, productRoot + "/SKU图/" + safeMiaoshouName(skuKey, "SKU") + "_" + exportedSkuKeys.length, skuImages[0], "sku", failures);
      }
    }

    archive.finalize();
    if (output && typeof output.addTrailers === "function") {
      output.addTrailers({ "X-Miaoshou-Image-Failures": String(failures.length) });
    }
    await archiveState.completion;
    return { fileName: fileName, productCount: records.length, failureCount: failures.length };
  }

  /** Generate the current Temu ZIP in memory for direct online import. */
  async createTemuZipBuffer() {
    const chunks = [];
    const output = new stream.PassThrough();
    output.on("data", function collectMiaoshouZipChunk(chunk) {
      chunks.push(Buffer.from(chunk));
    });
    const result = await this.createTemuZip(output, function ignoreMiaoshouZipStart() {});
    return { buffer: Buffer.concat(chunks), result: result };
  }

  /** Request fresh OSS upload credentials from Miaoshou. */
  async getMiaoshouSts(cookie) {
    const pathName = MIAOSHOU_GET_STS_PATH;
    const headers = await createMiaoshouSignedHeaders(cookie, pathName, "1787622471824");
    const response = await fetch(MIAOSHOU_BASE_URL + pathName + "?scene=collectImportTempFile", {
      headers: headers,
      signal: AbortSignal.timeout(30000)
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch (error) {
      if (isMiaoshouLoginFailure(null, response.status)) {
        throw createMiaoshouLoginError({ status: response.status });
      }
      throw createMiaoshouError("妙手 OSS 凭证返回不是 JSON。", 502, { status: response.status });
    }
    if (!response.ok && isMiaoshouLoginFailure(payload, response.status)) {
      throw createMiaoshouLoginError(payload);
    }
    if (!response.ok) {
      throw createMiaoshouError("妙手 OSS 凭证获取失败，HTTP " + response.status + "。", 502, { status: response.status });
    }
    return readMiaoshouStsConfig(payload);
  }

  /** Upload one ZIP buffer to the Miaoshou OSS bucket and return its object path. */
  async putMiaoshouOss(cookie, zipBuffer) {
    const stsConfig = await this.getMiaoshouSts(cookie);
    const ossPath = generateMiaoshouOssPath(cookie);
    const ossUrl = buildMiaoshouOssUrl(stsConfig, ossPath);
    const response = await fetch(ossUrl, {
      method: "PUT",
      headers: buildMiaoshouOssPutHeaders(ossUrl, stsConfig, zipBuffer),
      body: zipBuffer,
      signal: AbortSignal.timeout(120000)
    });
    if (!response.ok) {
      throw createMiaoshouError("妙手 OSS 上传失败，HTTP " + response.status + "。", 502, null);
    }
    return ossPath;
  }

  /** Call Miaoshou's import endpoint after the ZIP has been uploaded. */
  async processMiaoshouImport(cookie, ossPath, fileName, autoFetch) {
    const pathName = MIAOSHOU_PROCESS_PATH;
    const headers = await createMiaoshouSignedHeaders(cookie, pathName, "1787622471824");
    const body = new URLSearchParams({
      ossPath: String(ossPath || ""),
      fileName: String(fileName || "").replace(/\.zip$/i, ""),
      templateType: "mserpZip",
      isAutoFetch: autoFetch ? "1" : "0"
    });
    const response = await fetch(MIAOSHOU_BASE_URL + pathName, {
      method: "POST",
      headers: headers,
      body: body,
      signal: AbortSignal.timeout(30000)
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch (error) {
      if (isMiaoshouLoginFailure(null, response.status)) {
        throw createMiaoshouLoginError({ status: response.status });
      }
      throw createMiaoshouError("妙手导入接口返回不是 JSON。", 502, { status: response.status });
    }
    if (!response.ok || payload.result !== "success") {
      if (isMiaoshouLoginFailure(payload, response.status)) {
        throw createMiaoshouLoginError(payload);
      }
      throw createMiaoshouError("妙手导入失败：" + String(payload.reason || payload.message || "未知错误。"), 502, null);
    }
    return payload;
  }

  /** Save Cookie, upload the current cache ZIP, and create a Miaoshou import task. */
  async importTemuOnline(options) {
    const settings = options || {};
    const cookie = this.resolveMiaoshouCookie(settings.cookie);
    const zip = await this.createTemuZipBuffer();
    const ossPath = await this.putMiaoshouOss(cookie, zip.buffer);
    const importPayload = await this.processMiaoshouImport(cookie, ossPath, zip.result.fileName, settings.autoFetch !== false);
    return {
      fileName: zip.result.fileName,
      productCount: zip.result.productCount,
      failureCount: zip.result.failureCount,
      ossPath: ossPath,
      importResult: importPayload.result || "success",
      importTaskId: importPayload.commonCollectBoxImportTaskId || importPayload.importTaskId || ""
    };
  }
}

module.exports = { MiaoshouExportService: MiaoshouExportService };
