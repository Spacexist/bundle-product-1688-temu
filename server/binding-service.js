const fs = require("fs");
const path = require("path");

/** Server-side service that persists one Temu-to-1688 binding in cache.json. */
class BindingService {
  /** Store the cache path and timestamp formatter used by binding writes. */
  constructor(options) {
    const settings = options || {};
    this.cacheFilePath = path.join(settings.cacheDirectory, "cache.json");
    this.formatTime = settings.formatTime;
  }

  /** Read the current shared cache payload from disk. */
  readCachePayload() {
    if (!fs.existsSync(this.cacheFilePath)) {
      return { version: "1.0", updated_at: "", records: [] };
    }
    const payload = JSON.parse(fs.readFileSync(this.cacheFilePath, "utf8"));
    if (!payload || typeof payload !== "object") {
      return { version: "1.0", updated_at: "", records: [] };
    }
    if (!Array.isArray(payload.records)) {
      payload.records = [];
    }
    return payload;
  }

  /** Read the next positive global or platform identifier from cached records. */
  getNextIdentifier(records, fieldName, platform) {
    let maximum = 0;
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index] || {};
      if (platform && record.platform !== platform) {
        continue;
      }
      const value = Number(record[fieldName] || (fieldName === "main_id" ? record.mainid : 0));
      if (Number.isFinite(value) && value > maximum) {
        maximum = value;
      }
    }
    return maximum + 1;
  }

  /** Normalize one 1688 category path by removing its leading home item. */
  get1688Category(source) {
    const statistics = source.statistics || {};
    let value = String(source.productCategory || statistics.categoryPath || statistics.category || "").replace(/\s+/g, " ").trim();
    if (value.indexOf("首页") !== 0) {
      return value;
    }
    value = value.slice(2).trim();
    if (value.charAt(0) === ">" || value.charAt(0) === "›" || value.charAt(0) === "〉" || value.charAt(0) === "/" || value.charAt(0) === "＞") {
      value = value.slice(1).trim();
    }
    return value;
  }

  /** Read the 1688 category identifier list from collected source data. */
  get1688CategoryIds(source) {
    const offerMeta = source.offerMeta || {};
    const categoryId = offerMeta.categoryId;
    if (Array.isArray(categoryId)) {
      return categoryId;
    }
    if (categoryId === undefined || categoryId === null || categoryId === "") {
      return [];
    }
    return [categoryId];
  }

  /** Ensure every record carries an explicit empty or populated platform binding field. */
  normalizeBindingFields(records) {
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index] || {};
      if (record.platform === "temu") {
        if (record.bound_1688_platform_id === undefined || record.bound_1688_platform_id === null) {
          record.bound_1688_platform_id = "";
        }
        record.bound_1688_main_id = "";
      }
      if (record.platform === "1688") {
        if (record.linked_temu_platform_id === undefined || record.linked_temu_platform_id === null) {
          record.linked_temu_platform_id = "";
        }
        record.linked_temu_main_id = "";
      }
    }
    for (let temuIndex = 0; temuIndex < records.length; temuIndex += 1) {
      const temuRecord = records[temuIndex] || {};
      if (temuRecord.platform !== "temu" || !temuRecord.bound_1688_platform_id) {
        continue;
      }
      let hasReverseBinding = false;
      for (let aliIndex = 0; aliIndex < records.length; aliIndex += 1) {
        const aliRecord = records[aliIndex] || {};
        if (aliRecord.platform === "1688"
          && String(aliRecord.platform_id || "") === String(temuRecord.bound_1688_platform_id)
          && String(aliRecord.linked_temu_platform_id || "") === String(temuRecord.platform_id || "")) {
          hasReverseBinding = true;
          break;
        }
      }
      if (!hasReverseBinding) {
        temuRecord.bound_1688_platform_id = "";
      }
    }
    for (let aliIndex = 0; aliIndex < records.length; aliIndex += 1) {
      const aliRecord = records[aliIndex] || {};
      if (aliRecord.platform !== "1688" || !aliRecord.linked_temu_platform_id) {
        continue;
      }
      let hasForwardBinding = false;
      for (let temuIndex = 0; temuIndex < records.length; temuIndex += 1) {
        const temuRecord = records[temuIndex] || {};
        if (temuRecord.platform === "temu"
          && String(temuRecord.platform_id || "") === String(aliRecord.linked_temu_platform_id)
          && String(temuRecord.bound_1688_platform_id || "") === String(aliRecord.platform_id || "")) {
          hasForwardBinding = true;
          break;
        }
      }
      if (!hasForwardBinding) {
        aliRecord.linked_temu_platform_id = "";
      }
    }
  }

  /** Create or replace the bound 1688 cache record from raw extension data. */
  collectAndBind1688(input) {
    const request = input && typeof input === "object" ? input : {};
    const temuMainId = String(request.temu_main_id || "").trim();
    const requestedTemuPlatformId = String(request.temu_platform_id || "").trim();
    const source = request.source_data && typeof request.source_data === "object" ? request.source_data : {};
    if (!temuMainId || (!source.offerId && !source.pageUrl)) {
      const error = new Error("绑定请求缺少 Temu 标识或 1688 采集数据。");
      error.statusCode = 400;
      throw error;
    }
    const payload = this.readCachePayload();
    let temuRecord = null;
    let replaceIndex = -1;
    for (let index = 0; index < payload.records.length; index += 1) {
      const record = payload.records[index] || {};
      const matchesTemuPlatform = requestedTemuPlatformId && String(record.platform_id || "") === requestedTemuPlatformId;
      const matchesTemuMain = !requestedTemuPlatformId && String(record.main_id || "") === temuMainId;
      if (record.platform === "temu" && (matchesTemuPlatform || matchesTemuMain)) {
        temuRecord = record;
      }
      const linkedByPlatform = requestedTemuPlatformId
        && String(record.linked_temu_platform_id || "") === requestedTemuPlatformId;
      const linkedByLegacyMain = !record.linked_temu_platform_id
        && String(record.linked_temu_main_id || "") === temuMainId;
      if (record.platform === "1688" && (linkedByPlatform || linkedByLegacyMain)) {
        replaceIndex = index;
      }
    }
    if (!temuRecord) {
      const error = new Error("服务器没有找到待绑定的 Temu 商品。");
      error.statusCode = 404;
      throw error;
    }
    const temuPlatformId = String(temuRecord.platform_id || "");
    const actualTemuMainId = String(temuRecord.main_id || temuRecord.mainid || temuMainId);
    if (!temuPlatformId) {
      const error = new Error("待绑定 Temu 商品没有 platform_id。");
      error.statusCode = 400;
      throw error;
    }
    replaceIndex = -1;
    for (let index = 0; index < payload.records.length; index += 1) {
      const record = payload.records[index] || {};
      const linkedByPlatform = String(record.linked_temu_platform_id || "") === temuPlatformId;
      const linkedByLegacyMain = !record.linked_temu_platform_id
        && String(record.linked_temu_main_id || "") === actualTemuMainId;
      if (record.platform === "1688" && (linkedByPlatform || linkedByLegacyMain)) {
        replaceIndex = index;
        break;
      }
    }
    this.normalizeBindingFields(payload.records);
    const oldRecord = replaceIndex >= 0 ? payload.records[replaceIndex] || {} : {};
    const mainId = replaceIndex >= 0
      ? Number(oldRecord.main_id || oldRecord.mainid)
      : this.getNextIdentifier(payload.records, "main_id", "");
    const platformId = replaceIndex >= 0
      ? Number(oldRecord.platform_id)
      : this.getNextIdentifier(payload.records, "platform_id", "1688");
    const record = {
      main_id: mainId,
      platform_id: platformId,
      mainid: mainId,
      platform: "1688",
      product_id: source.offerId || "",
      product_name: source.productName || "",
      product_category: this.get1688Category(source),
      category_ids: this.get1688CategoryIds(source),
      source_data: source,
      linked_temu_platform_id: temuPlatformId,
      linked_temu_main_id: ""
    };
    if (replaceIndex >= 0) {
      payload.records[replaceIndex] = record;
    } else {
      payload.records.push(record);
    }
    temuRecord.bound_1688_main_id = "";
    temuRecord.bound_1688_platform_id = String(platformId);
    payload.updated_at = this.formatTime(new Date());
    fs.writeFileSync(this.cacheFilePath, JSON.stringify(payload, null, 2), "utf8");
    return {
      record: record,
      binding: {
        temu_main_id: actualTemuMainId,
        temu_platform_id: temuPlatformId,
        ali_main_id: String(mainId),
        ali_platform_id: String(platformId)
      },
      cache: payload
    };
  }

  /** Bind one cached 1688 record to one Temu record and clear stale links. */
  bindTemuTo1688(input) {
    const source = input && typeof input === "object" ? input : {};
    const temuMainId = String(source.temu_main_id || "").trim();
    const requestedTemuPlatformId = String(source.temu_platform_id || "").trim();
    const aliMainId = String(source.ali_main_id || "").trim();
    const aliPlatformId = String(source.ali_platform_id || "").trim();
    if (!temuMainId || !aliMainId) {
      const error = new Error("绑定缺少 Temu 或 1688 商品标识。");
      error.statusCode = 400;
      throw error;
    }
    const payload = this.readCachePayload();
    let temuRecord = null;
    let aliRecord = null;
    for (let index = 0; index < payload.records.length; index += 1) {
      const record = payload.records[index] || {};
      const matchesTemuPlatform = requestedTemuPlatformId && String(record.platform_id || "") === requestedTemuPlatformId;
      const matchesTemuMain = !requestedTemuPlatformId && String(record.main_id || "") === temuMainId;
      if (record.platform === "temu" && (matchesTemuPlatform || matchesTemuMain)) {
        temuRecord = record;
      }
      const matchesAliPlatform = aliPlatformId && String(record.platform_id || "") === aliPlatformId;
      const matchesAliMain = !aliPlatformId && String(record.main_id || "") === aliMainId;
      if (record.platform === "1688" && (matchesAliPlatform || matchesAliMain)) {
        aliRecord = record;
      }
    }
    if (!temuRecord || !aliRecord) {
      const error = new Error(!temuRecord ? "服务器没有找到待绑定的 Temu 商品。" : "服务器没有找到刚采集的 1688 商品。");
      error.statusCode = 404;
      throw error;
    }
    const temuPlatformId = String(temuRecord.platform_id || "");
    const actualTemuMainId = String(temuRecord.main_id || temuRecord.mainid || temuMainId);
    const targetAliPlatformId = String(aliRecord.platform_id || aliPlatformId);
    this.normalizeBindingFields(payload.records);
    for (let index = 0; index < payload.records.length; index += 1) {
      const record = payload.records[index] || {};
      if (record.platform === "1688"
        && record !== aliRecord
        && String(record.linked_temu_platform_id || "") === temuPlatformId) {
        record.linked_temu_platform_id = "";
      }
      if (record.platform === "temu"
        && record !== temuRecord
        && String(record.bound_1688_platform_id || "") === targetAliPlatformId) {
        record.bound_1688_platform_id = "";
      }
    }
    temuRecord.bound_1688_main_id = "";
    temuRecord.bound_1688_platform_id = targetAliPlatformId;
    aliRecord.linked_temu_main_id = "";
    aliRecord.linked_temu_platform_id = temuPlatformId;
    payload.updated_at = this.formatTime(new Date());
    fs.writeFileSync(this.cacheFilePath, JSON.stringify(payload, null, 2), "utf8");
    return {
      temu_main_id: actualTemuMainId,
      temu_platform_id: temuPlatformId,
      ali_main_id: aliMainId,
      ali_platform_id: targetAliPlatformId
    };
  }
}

/** Create the server-side Temu and 1688 binding service. */
function createBindingService(options) {
  return new BindingService(options);
}

module.exports = {
  createBindingService: createBindingService
};
