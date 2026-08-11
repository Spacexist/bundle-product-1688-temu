/** Product application service that owns mutations, versions and undo behavior. */
class ProductService {
  /** Store repository, ViewModel and event dependencies. */
  constructor(options) {
    const settings = options || {};
    this.repository = settings.repository;
    this.viewModels = settings.viewModels;
    this.events = settings.events;
    this.images = settings.images;
  }

  /** Return the full workbench ViewModel. */
  getWorkbench() {
    return this.viewModels.createWorkbench(this.repository.read());
  }

  /** Clear every cached product through one backend-owned mutation. */
  clearAll(requestId) {
    const payload = this.repository.read();
    if (payload.records.length) {
      this.repository.createHistorySnapshot({ platform: "system", platform_id: "all", records: payload.records }, "clear_all");
    }
    payload.records = [];
    this.repository.write(payload);
    this.events.publish({ resource: "product", action: "cleared", ids: [], version: Number(payload.version || 1) }, requestId);
    return this.viewModels.createWorkbench(payload);
  }

  /** Delete one cached product using its stable platform identifier. */
  deleteOne(platform, platformId, requestId) {
    const payload = this.repository.read();
    const found = this.findRecord(payload.records, platform, platformId);
    if (!found) {
      const missingError = new Error("商品不存在或已被删除。");
      missingError.statusCode = 404;
      throw missingError;
    }
    this.repository.createHistorySnapshot(found.record, "delete");
    payload.records.splice(found.index, 1);
    this.repository.write(payload);
    this.events.publish({
      resource: "product",
      action: "deleted",
      ids: [String(platform), String(platformId)],
      version: Number(payload.version || 1)
    }, requestId);
    return this.viewModels.createWorkbench(payload);
  }

  /** Clear every cached product belonging to one platform. */
  clearPlatform(platform, requestId) {
    const payload = this.repository.read();
    const retainedRecords = [];
    const deletedRecords = [];
    for (let index = 0; index < payload.records.length; index += 1) {
      const record = payload.records[index];
      if (String(record.platform) === String(platform)) {
        deletedRecords.push(record);
      } else {
        retainedRecords.push(record);
      }
    }
    if (deletedRecords.length) {
      this.repository.createHistorySnapshot({ platform: platform, platform_id: "all", records: deletedRecords }, "clear_platform");
    }
    payload.records = retainedRecords;
    this.repository.write(payload);
    this.events.publish({
      resource: "product",
      action: "platform_cleared",
      ids: [String(platform)],
      version: Number(payload.version || 1)
    }, requestId);
    return this.viewModels.createWorkbench(payload);
  }

  /** Parse and persist an imported JSON document entirely on the backend. */
  async importJson(input, requestId) {
    let imported;
    try {
      imported = JSON.parse(String(input.json_text || ""));
    } catch (error) {
      const parseError = new Error("导入文件不是有效 JSON。");
      parseError.statusCode = 400;
      throw parseError;
    }
    const records = Array.isArray(imported)
      ? imported
      : imported && Array.isArray(imported.records) ? imported.records : [];
    if (!records.length) {
      const emptyError = new Error("JSON 中没有找到商品数组。");
      emptyError.statusCode = 400;
      throw emptyError;
    }
    const previous = this.repository.read();
    this.repository.createHistorySnapshot({ platform: "system", platform_id: "all", records: previous.records }, "import");
    const payload = imported && typeof imported === "object" && !Array.isArray(imported)
      ? imported
      : { records: records };
    payload.records = records;
    for (let recordIndex = 0; recordIndex < payload.records.length; recordIndex += 1) {
      await this.images.cacheRecordImages(payload.records[recordIndex]);
    }
    this.repository.write(payload);
    this.events.publish({ resource: "product", action: "imported", ids: [], version: Number(payload.version || 1) }, requestId);
    return this.viewModels.createWorkbench(payload);
  }

  /** Restore the original JSON format exported by the browser extension. */
  async restoreJson(input, requestId) {
    return this.importJson(input, requestId);
  }

  /** Locate a raw record using stable platform identifiers. */
  findRecord(records, platform, platformId) {
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index] || {};
      if (String(record.platform) === String(platform)
        && String(record.platform_id) === String(platformId)) {
        return { record: record, index: index };
      }
    }
    return null;
  }

  /** Locate one raw record by its global main identifier. */
  findRecordByMainId(records, platform, mainId) {
    const list = Array.isArray(records) ? records : [];
    for (let index = 0; index < list.length; index += 1) {
      const record = list[index] || {};
      if (String(record.platform) === String(platform)
        && String(record.main_id || record.mainid || "") === String(mainId || "")) {
        return { record: record, index: index };
      }
    }
    return null;
  }

  /** Save one product module with optimistic concurrency validation. */
  async saveModule(input, requestId) {
    const payload = this.repository.read();
    const found = this.findRecord(payload.records, input.platform, input.platform_id);
    if (!found) {
      const missingError = new Error("商品不存在或已被删除。");
      missingError.statusCode = 404;
      throw missingError;
    }
    const currentVersion = Number(found.record.version || 1);
    if (Number(input.version) !== currentVersion) {
      const conflictError = new Error("商品已被其他操作更新，请刷新后重试。");
      conflictError.statusCode = 409;
      conflictError.details = { current_version: currentVersion };
      throw conflictError;
    }
    const undoToken = this.repository.createHistorySnapshot(found.record, input.module);
    this.applyModule(found.record, input.module, input.data);
    if (input.module === "images" || input.module === "skus") {
      await this.images.cacheRecordImages(found.record);
    }
    found.record.version = currentVersion + 1;
    this.repository.write(payload);
    this.events.publish({
      resource: "product",
      action: "updated",
      ids: [String(input.platform), String(input.platform_id)],
      version: found.record.version
    }, requestId);
    return {
      product: this.viewModels.normalizeRecord(found.record),
      undo_token: undoToken
    };
  }

  /** Return the raw SKU rows retained by one cached product. */
  getStoredSkuRows(record, platform) {
    const target = record && typeof record === "object" ? record : {};
    if (Array.isArray(target.sku) && target.sku.length) {
      return target.sku;
    }
    const source = target.source_data && typeof target.source_data === "object" ? target.source_data : {};
    if (String(platform || "") === "1688" && Array.isArray(source.skuRows)) {
      return source.skuRows;
    }
    if (Array.isArray(source.sku)) {
      return source.sku;
    }
    return [];
  }

  /** Copy one SKU row while keeping image arrays independent from the source row. */
  copySkuRow(row) {
    const source = row && typeof row === "object" ? row : {};
    const result = {};
    for (const key in source) {
      if (Object.prototype.hasOwnProperty.call(source, key)) {
        result[key] = Array.isArray(source[key]) ? source[key].slice() : source[key];
      }
    }
    return result;
  }

  /** Read the first non-empty field from one collector SKU row. */
  readSkuField(row, names) {
    const source = row && typeof row === "object" ? row : {};
    const fields = Array.isArray(names) ? names : [];
    for (let index = 0; index < fields.length; index += 1) {
      const value = source[fields[index]];
      if (value !== undefined && value !== null && value !== "") {
        return value;
      }
    }
    return "";
  }

  /** Read one source SKU specification while preserving its property name. */
  readSkuSpecValue(row, index) {
    const source = row && typeof row === "object" ? row : {};
    const fieldName = index === 0 ? "SubSku1" : "SubSku2";
    const legacyFieldName = index === 0 ? "subSku1" : "subSku2";
    const direct = this.readSkuField(source, [fieldName, legacyFieldName]);
    if (direct) {
      return String(direct);
    }
    const specs = Array.isArray(source.specs) ? source.specs : Array.isArray(source.specAttrs) ? source.specAttrs : [];
    const item = specs[index] || {};
    if (typeof item === "string") {
      return item;
    }
    const name = this.readSkuField(item, ["specKey", "specName", "key"]);
    const value = this.readSkuField(item, ["specValue", "value", "name", "text", "propValue"]);
    return name && value ? String(name) + ":" + String(value) : String(value || "");
  }

  /** Read all image URLs retained by one collector SKU row. */
  readSkuImageUrls(row) {
    const source = row && typeof row === "object" ? row : {};
    const result = [];
    const images = Array.isArray(source.sku_image_urls) ? source.sku_image_urls : [];
    for (let index = 0; index < images.length; index += 1) {
      const item = images[index];
      const url = typeof item === "string" ? item : item && (item.url || item.imageUrl || item.thumbUrl);
      if (url) {
        result.push(String(url));
      }
    }
    const primary = this.readSkuField(source, ["sku_image_url", "imageUrl", "thumbUrl"]);
    if (!result.length && primary) {
      result.push(String(primary));
    }
    return result;
  }

  /** Find one SKU row by an explicit index or stable SKU identifier. */
  findSkuRow(rows, rowIndex, skuId, label) {
    const list = Array.isArray(rows) ? rows : [];
    if (rowIndex !== undefined && rowIndex !== null) {
      const numericIndex = Number(rowIndex);
      if (Number.isInteger(numericIndex) && numericIndex >= 0 && numericIndex < list.length) {
        return { row: list[numericIndex], index: numericIndex };
      }
    }
    const requestedId = String(skuId === undefined || skuId === null ? "" : skuId);
    if (requestedId) {
      for (let index = 0; index < list.length; index += 1) {
        const item = list[index] || {};
        const currentId = this.readSkuField(item, ["sku_id", "skuId", "id"]);
        if (String(currentId) === requestedId) {
          return { row: item, index: index };
        }
      }
    }
    const error = new Error((label || "SKU") + "不存在，请重新选择。 ");
    error.statusCode = 400;
    throw error;
  }

  /** Build a canonical Temu SKU row from the selected 1688 source SKU. */
  createReplacementSku(targetSku, sourceSku, sourceRecord, sourceIndex) {
    const target = this.copySkuRow(targetSku);
    const source = sourceSku && typeof sourceSku === "object" ? sourceSku : {};
    const sourceSkuId = this.readSkuField(source, ["sku_id", "skuId", "id"]);
    const sourcePrice = this.readSkuField(source, ["sku_price", "discountPrice", "promotionPrice", "salePrice", "normalPrice", "price"]);
    const sourceOriginalPrice = this.readSkuField(source, ["sku_original_price", "price", "normalPrice"]);
    const sourceStock = this.readSkuField(source, ["sku_stock", "stock", "stockQuantity", "canBookCount"]);
    const sourceWeight = this.readSkuField(source, ["sku_weight", "weight"]);
    const sourceImages = this.readSkuImageUrls(source);
    target.sku_id = this.readSkuField(target, ["sku_id", "skuId"]) || sourceSkuId || "";
    target.SubSku1 = this.readSkuSpecValue(source, 0) || this.readSkuSpecValue(target, 0);
    target.SubSku2 = this.readSkuSpecValue(source, 1) || this.readSkuSpecValue(target, 1);
    target.sku_price = sourcePrice !== "" ? sourcePrice : this.readSkuField(target, ["sku_price", "price"]);
    target.sku_original_price = sourceOriginalPrice !== "" ? sourceOriginalPrice : target.sku_original_price || "";
    target.sku_stock = sourceStock !== "" ? sourceStock : target.sku_stock || 0;
    target.sku_weight = sourceWeight !== "" ? sourceWeight : target.sku_weight || 0;
    if (sourceImages.length) {
      target.sku_image_urls = sourceImages;
      target.sku_image_url = sourceImages[0];
    }
    target.merged_ali_sku_keys = [];
    target.source_1688_sku_ids = sourceSkuId ? [String(sourceSkuId)] : [];
    target.replaced_from_1688 = {
      platform_id: String(sourceRecord && sourceRecord.platform_id || ""),
      main_id: String(sourceRecord && sourceRecord.main_id || ""),
      sku_index: Number(sourceIndex)
    };
    return target;
  }

  /** Replace selected Temu SKU rows with current 1688 SKU rows and publish the update. */
  async replaceSku(input, requestId) {
    const payload = this.repository.read();
    const target = input.target_temu_platform_id
      ? this.findRecord(payload.records, "temu", input.target_temu_platform_id)
      : this.findRecordByMainId(payload.records, "temu", input.target_temu_main_id);
    if (!target) {
      const targetError = new Error("找不到待替换的 Temu 商品。 ");
      targetError.statusCode = 404;
      throw targetError;
    }
    let source = input.source_1688_platform_id
      ? this.findRecord(payload.records, "1688", input.source_1688_platform_id)
      : this.findRecordByMainId(payload.records, "1688", input.source_1688_main_id);
    const sourceData = input.source_data && typeof input.source_data === "object" ? input.source_data : null;
    if (!source && sourceData) {
      source = {
        record: {
          platform: "1688",
          platform_id: String(input.source_1688_platform_id || ""),
          main_id: String(input.source_1688_main_id || ""),
          product_name: String(sourceData.productName || ""),
          source_data: sourceData,
          sku: Array.isArray(sourceData.skuRows) ? sourceData.skuRows : []
        },
        index: -1
      };
    }
    if (!source) {
      const sourceError = new Error("找不到当前 1688 商品，请先采集或刷新工作台。 ");
      sourceError.statusCode = 404;
      throw sourceError;
    }
    const targetRows = this.getStoredSkuRows(target.record, "temu");
    const sourceRows = this.getStoredSkuRows(source.record, "1688");
    const replaceAll = Boolean(input.replace_all_skus || sourceData);
    let targetSelection = null;
    let sourceSelection = null;
    if (!replaceAll) {
      targetSelection = this.findSkuRow(targetRows, input.target_sku_index, input.target_sku_id, "Temu SKU");
      sourceSelection = this.findSkuRow(sourceRows, input.source_sku_index, input.source_sku_id, "1688 SKU");
    }
    if (!Array.isArray(target.record.sku) || !target.record.sku.length) {
      target.record.sku = [];
      for (let rowIndex = 0; rowIndex < targetRows.length; rowIndex += 1) {
        target.record.sku.push(this.copySkuRow(targetRows[rowIndex]));
      }
    }
    const currentVersion = Number(target.record.version || 1);
    const undoToken = this.repository.createHistorySnapshot(target.record, "replace_sku");
    if (replaceAll) {
      if (!sourceRows.length) {
        const emptyError = new Error("当前 1688 商品没有可替换的 SKU。 ");
        emptyError.statusCode = 400;
        throw emptyError;
      }
      target.record.sku = [];
      for (let sourceIndex = 0; sourceIndex < sourceRows.length; sourceIndex += 1) {
        const baseTargetSku = targetRows[sourceIndex] || {};
        target.record.sku.push(this.createReplacementSku(baseTargetSku, sourceRows[sourceIndex], source.record, sourceIndex));
      }
    } else {
      const replacement = this.createReplacementSku(targetSelection.row, sourceSelection.row, source.record, sourceSelection.index);
      target.record.sku[targetSelection.index] = replacement;
    }
    await this.images.cacheRecordImages(target.record);
    target.record.version = currentVersion + 1;
    this.repository.write(payload);
    this.events.publish({
      resource: "product",
      action: "sku_replaced",
      ids: ["temu", String(target.record.platform_id), "1688", String(source.record.platform_id)],
      version: target.record.version
    }, requestId);
    return {
      product: this.viewModels.normalizeRecord(target.record),
      source_product: this.viewModels.normalizeRecord(source.record),
      target_sku_index: replaceAll ? null : targetSelection.index,
      source_sku_index: replaceAll ? null : sourceSelection.index,
      replaced_sku_count: replaceAll ? target.record.sku.length : 1,
      undo_token: undoToken
    };
  }

  /** Apply an allow-listed module payload to a raw product record. */
  applyModule(record, moduleName, data) {
    const source = data && typeof data === "object" ? data : {};
    const fields = {
      basic: ["product_name", "product_category", "category_ids", "attributes_json"],
      listing: ["product_name", "listing_json"],
      images: ["main_image_url", "gallery_image_urls", "detail_image_urls"],
      skus: ["sku"],
      binding: ["bound_1688_platform_id", "linked_temu_platform_id"]
    };
    const allowed = fields[moduleName];
    if (!allowed) {
      const moduleError = new Error("不支持的商品模块：" + moduleName);
      moduleError.statusCode = 400;
      throw moduleError;
    }
    for (let index = 0; index < allowed.length; index += 1) {
      const key = allowed[index];
      if (Object.prototype.hasOwnProperty.call(source, key)) {
        record[key] = source[key];
      }
    }
  }

  /** Restore one product snapshot using a durable undo token. */
  undo(input, requestId) {
    const snapshot = this.repository.consumeHistorySnapshot(input.token);
    if (!snapshot || !snapshot.record) {
      const undoError = new Error("返回记录不存在或已经使用。");
      undoError.statusCode = 404;
      throw undoError;
    }
    const payload = this.repository.read();
    const record = snapshot.record;
    const found = this.findRecord(payload.records, record.platform, record.platform_id);
    if (!found) {
      const missingError = new Error("原商品已经不存在，无法返回。");
      missingError.statusCode = 404;
      throw missingError;
    }
    record.version = Number(found.record.version || 1) + 1;
    payload.records[found.index] = record;
    this.repository.write(payload);
    this.events.publish({
      resource: "product",
      action: "restored",
      ids: [String(record.platform), String(record.platform_id)],
      version: record.version
    }, requestId);
    return { product: this.viewModels.normalizeRecord(record) };
  }
}

module.exports = { ProductService: ProductService };
