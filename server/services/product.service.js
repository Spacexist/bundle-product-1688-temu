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
