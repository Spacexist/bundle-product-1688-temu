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
    this.currency = settings.currency || null;
  }

  /** Start image caching after the collection payload has been committed. */
  scheduleImageCache(record, requestId) {
    const service = this;
    const platform = String(record && record.platform || "");
    const platformId = String(record && record.platform_id || "");
    const productId = String(record && record.product_id || "");
    /** Run the image cache job on the next event-loop turn. */
    setImmediate(function startDeferredImageCache() {
      service.cacheRecordImagesInBackground(platform, platformId, productId, requestId).catch(function handleBackgroundImageCacheError(error) {
        const ids = [platform, platformId];
        service.events.publish({
          resource: "product",
          action: "image_cache_failed",
          ids: ids,
          version: 0,
          error: error.message || "后台图片缓存失败。"
        }, requestId);
      });
    });
  }

  /** Cache one collected record without blocking the collection response. */
  async cacheRecordImagesInBackground(platform, platformId, productId, requestId) {
    const initialPayload = this.repository.read();
    const record = this.findExisting(initialPayload.records, platform, productId);
    if (!record || String(record.platform_id || "") !== String(platformId || "")) {
      return;
    }
    const expectedVersion = Number(record.version || 1);
    await this.images.cacheRecordImages(record);
    const latestPayload = this.repository.read();
    const latestRecord = this.findExisting(latestPayload.records, platform, productId);
    if (!latestRecord || String(latestRecord.platform_id || "") !== String(platformId || "")
      || Number(latestRecord.version || 1) !== expectedVersion) {
      return;
    }
    this.copyCachedImageFields(latestRecord, record);
    this.repository.write(latestPayload);
    this.events.publish({
      resource: "product",
      action: "images_cached",
      ids: [platform, platformId],
      version: Number(latestPayload.version || 1)
    }, requestId);
  }

  /** Copy only image-related fields from the completed background cache job. */
  copyCachedImageFields(target, source) {
    target.main_image_url = source.main_image_url;
    target.gallery_image_urls = source.gallery_image_urls;
    target.detail_image_urls = source.detail_image_urls;
    target.sku = source.sku;
    target.source_data = source.source_data;
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

  /** Return the stable server cache key for one canonical product record. */
  getRecordCacheKey(record, index) {
    const item = record || {};
    const platform = String(item.platform || "").toLowerCase();
    const productId = String(item.product_id || "");
    if (productId) {
      return "product:" + platform + ":" + productId;
    }
    const platformId = String(item.platform_id || "");
    if (platformId) {
      return "platform:" + platform + ":" + platformId;
    }
    return "record:" + platform + ":" + String(item.main_id || item.mainid || index);
  }

  /** Remove historical duplicate server cache rows while retaining the newest row. */
  dedupeRecords(records) {
    const source = Array.isArray(records) ? records : [];
    const result = [];
    const keyIndexes = {};
    for (let index = 0; index < source.length; index += 1) {
      const item = source[index] || {};
      const key = this.getRecordCacheKey(item, index);
      if (Object.prototype.hasOwnProperty.call(keyIndexes, key)) {
        result[keyIndexes[key]] = item;
        continue;
      }
      keyIndexes[key] = result.length;
      result.push(item);
    }
    return result;
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
    const priceInfo = this.currency ? await this.currency.normalizeSourcePrices(source, platform) : null;
    const payload = this.repository.read();
    payload.records = this.dedupeRecords(payload.records);
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
    if (this.currency && priceInfo) {
      const sourceRows = platform === "1688" ? source.skuRows : source.sku;
      if (Array.isArray(record.sku) && Array.isArray(sourceRows)) {
        this.currency.syncStoredSkuPrices(record.sku, sourceRows);
      }
      record.original_currency = priceInfo.original_currency;
      record.price_currency = priceInfo.price_currency;
      record.price_update_time = priceInfo.update_time;
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
    this.repository.write(payload);
    this.scheduleImageCache(record, requestId);
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
      bound_temu: temuRecord ? this.viewModels.normalizeRecord(temuRecord) : null,
      source_data: record.source_data
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
