/** Collection service that converts raw extension captures into canonical cache records. */
class CollectionService {
  /** Store persistence, ViewModel and realtime dependencies. */
  constructor(options) {
    const settings = options || {};
    this.repository = settings.repository;
    this.viewModels = settings.viewModels;
    this.events = settings.events;
    this.workflow = settings.workflow || null;
    this.images = settings.images;
  }

  /** Read the next positive identifier from one cache field. */
  getNextIdentifier(records, fieldName, platform) {
    let maximum = 0;
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index] || {};
      if (platform && String(record.platform) !== String(platform)) {
        continue;
      }
      const value = Number(record[fieldName] || 0);
      if (Number.isFinite(value) && value > maximum) {
        maximum = value;
      }
    }
    return maximum + 1;
  }

  /** Resolve the stable source product identifier from a raw collector payload. */
  getProductId(platform, source) {
    if (platform === "1688") {
      return String(source.offerId || source.pageUrl || "");
    }
    const goods = source.goods || {};
    const page = source.page || {};
    return String(goods.itemId || goods.goodsId || page.goodsId || page.url || "");
  }

  /** Resolve the source product name without frontend interpretation. */
  getProductName(platform, source) {
    if (platform === "1688") {
      return String(source.productName || "");
    }
    const goods = source.goods || {};
    return String(goods.goodsName || "");
  }

  /** Find an existing canonical record by platform and source product identity. */
  findExisting(records, platform, productId) {
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index] || {};
      if (String(record.platform) === String(platform)
        && String(record.product_id || "") === String(productId || "")) {
        return record;
      }
    }
    return null;
  }

  /** Find one record by its platform-local identifier. */
  findByPlatformId(records, platform, platformId) {
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index] || {};
      if (String(record.platform) === String(platform)
        && String(record.platform_id) === String(platformId)) {
        return record;
      }
    }
    return null;
  }

  /** Find one record by its global main identifier. */
  findByMainId(records, platform, mainId) {
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index] || {};
      if (String(record.platform) === String(platform)
        && String(record.main_id || record.mainid || "") === String(mainId || "")) {
        return record;
      }
    }
    return null;
  }

  /** Upsert one raw collection and optionally bind it to exactly one Temu product. */
  async collect(input, requestId) {
    const platform = String(input.platform || "").toLowerCase();
    const source = input.source_data && typeof input.source_data === "object" ? input.source_data : {};
    const payload = this.repository.read();
    const records = payload.records;
    const productId = this.getProductId(platform, source);
    let record = this.findExisting(records, platform, productId);
    if (!record) {
      record = {
        main_id: this.getNextIdentifier(records, "main_id", ""),
        platform_id: this.getNextIdentifier(records, "platform_id", platform),
        platform: platform,
        product_id: productId,
        product_name: this.getProductName(platform, source),
        version: 1,
        source_data: source,
        bound_1688_platform_id: "",
        linked_temu_platform_id: ""
      };
      records.push(record);
    } else {
      record.source_data = source;
      record.product_name = this.getProductName(platform, source) || record.product_name;
      record.version = Number(record.version || 1) + 1;
    }
    let temuRecord = null;
    if (platform === "1688" && (input.target_temu_platform_id || input.target_temu_main_id)) {
      const targetTemu = input.target_temu_platform_id
        ? this.findByPlatformId(records, "temu", input.target_temu_platform_id)
        : this.findByMainId(records, "temu", input.target_temu_main_id);
      if (!targetTemu) {
        const targetError = new Error("找不到待绑定的 Temu 商品。");
        targetError.statusCode = 404;
        throw targetError;
      }
      temuRecord = this.bindOneToOne(records, record, targetTemu.platform_id);
    }
    await this.images.cacheRecordImages(record);
    this.repository.write(payload);
    const ids = [platform, String(record.platform_id)];
    if (temuRecord) {
      ids.push("temu", String(temuRecord.platform_id));
      if (this.workflow) {
        this.workflow.complete({
          temu_main_id: String(temuRecord.main_id || ""),
          ali_main_id: String(record.main_id || ""),
          ali_platform_id: String(record.platform_id || "")
        }, requestId);
      }
    }
    this.events.publish({ resource: "product", action: temuRecord ? "bound" : "collected", ids: ids, version: Number(payload.version || 1) }, requestId);
    return {
      product: this.viewModels.normalizeRecord(record),
      bound_temu: temuRecord ? this.viewModels.normalizeRecord(temuRecord) : null
    };
  }

  /** Bind one 1688 record to one Temu platform_id and clear previous conflicting pairs. */
  bindOneToOne(records, aliRecord, temuPlatformId) {
    const temuRecord = this.findByPlatformId(records, "temu", temuPlatformId);
    if (!temuRecord) {
      const bindingError = new Error("找不到指定 platform_id 的 Temu 商品。");
      bindingError.statusCode = 404;
      throw bindingError;
    }
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index] || {};
      if (record.platform === "temu"
        && record !== temuRecord
        && String(record.bound_1688_platform_id || "") === String(aliRecord.platform_id)) {
        record.bound_1688_platform_id = "";
        record.version = Number(record.version || 1) + 1;
      }
      if (record.platform === "1688"
        && record !== aliRecord
        && String(record.linked_temu_platform_id || "") === String(temuPlatformId)) {
        record.linked_temu_platform_id = "";
        record.version = Number(record.version || 1) + 1;
      }
    }
    temuRecord.bound_1688_platform_id = String(aliRecord.platform_id);
    temuRecord.version = Number(temuRecord.version || 1) + 1;
    aliRecord.linked_temu_platform_id = String(temuRecord.platform_id);
    aliRecord.version = Number(aliRecord.version || 1) + 1;
    return temuRecord;
  }
}

module.exports = { CollectionService: CollectionService };
