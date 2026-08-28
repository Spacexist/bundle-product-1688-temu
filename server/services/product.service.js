const fs = require("fs");
const path = require("path");

/** Product application service that owns mutations, versions and undo behavior. */
class ProductService {
  /** Store repository, ViewModel and event dependencies. */
  constructor(options) {
    const settings = options || {};
    this.repository = settings.repository;
    this.viewModels = settings.viewModels;
    this.events = settings.events;
    this.images = settings.images;
    this.restoreUploadDirectory = path.join(this.repository.cacheDirectory, "runtime", "restore-upload");
  }

  /** Return the full workbench ViewModel. */
  getWorkbench() {
    return this.viewModels.createWorkbench(this.repository.read());
  }

  /** Clear every product, image, workflow and JSON entry from the cache directory. */
  async clearAll(requestId) {
    const emptyPayload = await this.repository.clearDirectory();
    if (this.images && typeof this.images.ensureDirectories === "function") {
      this.images.ensureDirectories();
    }
    this.events.publish({ resource: "product", action: "cache_directory_cleared", ids: [], version: 1 }, requestId);
    return this.viewModels.createWorkbench(emptyPayload);
  }

  /** Delete one cached product using its stable platform identifier. */
  async deleteOne(platform, platformId, requestId) {
    const service = this;
    const transaction = await this.repository.mutate(async function mutateOneProductDelete(payload) {
      const found = service.findRecord(payload.records, platform, platformId);
      if (!found) {
        const missingError = new Error("商品不存在或已被删除。");
        missingError.statusCode = 404;
        throw missingError;
      }
      service.repository.createHistorySnapshot(found.record, "delete");
      const deletedRecord = found.record;
      payload.records.splice(found.index, 1);
      return { deletedRecord: deletedRecord };
    });
    if (this.images && typeof this.images.deleteProductCache === "function") {
      this.images.deleteProductCache(transaction.result.deletedRecord);
    }
    if (this.images && typeof this.images.rebuildReferenceIndex === "function") {
      this.images.rebuildReferenceIndex(transaction.payload.records);
    }
    this.events.publish({
      resource: "product",
      action: "deleted",
      ids: [String(platform), String(platformId)],
      version: Number(transaction.payload.version || 1)
    }, requestId);
    return this.viewModels.createWorkbench(transaction.payload);
  }

  /** Clear every cached product belonging to one platform. */
  async clearPlatform(platform, requestId) {
    const service = this;
    const transaction = await this.repository.mutate(async function mutatePlatformClear(payload) {
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
        service.repository.createHistorySnapshot({ platform: platform, platform_id: "all", records: deletedRecords }, "clear_platform");
      }
      payload.records = retainedRecords;
      return { deletedRecords: deletedRecords };
    });
    if (this.images && typeof this.images.deleteProductCache === "function") {
      const deletedRecords = transaction.result.deletedRecords || [];
      for (let index = 0; index < deletedRecords.length; index += 1) {
        this.images.deleteProductCache(deletedRecords[index]);
      }
    }
    if (this.images && typeof this.images.rebuildReferenceIndex === "function") {
      this.images.rebuildReferenceIndex(transaction.payload.records);
    }
    this.events.publish({
      resource: "product",
      action: "platform_cleared",
      ids: [String(platform)],
      version: Number(transaction.payload.version || 1)
    }, requestId);
    return this.viewModels.createWorkbench(transaction.payload);
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
    const importedPayload = imported && typeof imported === "object" && !Array.isArray(imported)
      ? imported
      : { records: records };
    const service = this;
    const transaction = await this.repository.mutate(async function mutateJsonImport(payload) {
      service.repository.createHistorySnapshot({ platform: "system", platform_id: "all", records: payload.records }, "import");
      payload.records = records;
      if (Object.prototype.hasOwnProperty.call(importedPayload, "mappings")) {
        payload.mappings = importedPayload.mappings;
      }
      if (Object.prototype.hasOwnProperty.call(importedPayload, "update_instruction")) {
        payload.update_instruction = importedPayload.update_instruction;
      }
      for (let recordIndex = 0; recordIndex < payload.records.length; recordIndex += 1) {
        await service.images.cacheRecordImages(payload.records[recordIndex]);
      }
      return null;
    });
    this.events.publish({ resource: "product", action: "imported", ids: [], version: Number(transaction.payload.version || 1) }, requestId);
    return this.viewModels.createWorkbench(transaction.payload);
  }

  /** Restore the original JSON format exported by the browser extension. */
  async restoreJson(input, requestId) {
    return this.importJson(input, requestId);
  }

  /** Normalize a browser-created restore upload id for filesystem use. */
  normalizeRestoreUploadId(uploadId) {
    return String(uploadId || "").replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 80);
  }

  /** Resolve the temporary files used by one chunked restore upload. */
  getRestoreUploadPaths(uploadId) {
    const safeUploadId = this.normalizeRestoreUploadId(uploadId);
    if (!safeUploadId) {
      const uploadError = new Error("恢复上传编号无效。");
      uploadError.statusCode = 400;
      throw uploadError;
    }
    fs.mkdirSync(this.restoreUploadDirectory, { recursive: true });
    return {
      uploadId: safeUploadId,
      payloadPath: path.join(this.restoreUploadDirectory, safeUploadId + ".json.part"),
      metaPath: path.join(this.restoreUploadDirectory, safeUploadId + ".meta.json"),
      dataPath: path.join(this.restoreUploadDirectory, safeUploadId + ".data.json"),
      recordsDirectory: path.join(this.restoreUploadDirectory, safeUploadId + "-records")
    };
  }

  /** Read the current chunked restore upload metadata. */
  readRestoreUploadMeta(metaPath) {
    if (!fs.existsSync(metaPath)) {
      return null;
    }
    try {
      const payload = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      return payload && typeof payload === "object" ? payload : null;
    } catch (error) {
      return null;
    }
  }

  /** Persist the current chunked restore upload metadata. */
  writeRestoreUploadMeta(metaPath, meta) {
    fs.writeFileSync(metaPath, JSON.stringify(meta || {}, null, 2), "utf8");
  }

  /** Remove temporary chunked restore files after success or restart. */
  cleanupRestoreUpload(paths) {
    const targets = paths && typeof paths === "object" ? [paths.payloadPath, paths.metaPath, paths.dataPath] : [];
    for (let index = 0; index < targets.length; index += 1) {
      if (targets[index] && fs.existsSync(targets[index])) {
        fs.unlinkSync(targets[index]);
      }
    }
    if (paths && paths.recordsDirectory && fs.existsSync(paths.recordsDirectory)) {
      fs.rmSync(paths.recordsDirectory, { recursive: true, force: true });
    }
  }

  /** Return the stable temporary filename for one prepared restore record. */
  getRestoreRecordPath(paths, recordIndex) {
    return path.join(paths.recordsDirectory, String(recordIndex).padStart(8, "0") + ".json");
  }

  /** Parse the uploaded JSON once and prepare per-record restore work files. */
  prepareRestoreUpload(paths, meta) {
    let imported;
    try {
      imported = JSON.parse(fs.readFileSync(paths.payloadPath, "utf8"));
    } catch (error) {
      this.cleanupRestoreUpload(paths);
      const parseError = new Error("导入文件不是有效 JSON。");
      parseError.statusCode = 400;
      throw parseError;
    }
    const records = Array.isArray(imported)
      ? imported
      : imported && Array.isArray(imported.records) ? imported.records : [];
    if (!records.length) {
      this.cleanupRestoreUpload(paths);
      const emptyError = new Error("JSON 中没有找到商品数组。");
      emptyError.statusCode = 400;
      throw emptyError;
    }
    if (fs.existsSync(paths.recordsDirectory)) {
      fs.rmSync(paths.recordsDirectory, { recursive: true, force: true });
    }
    fs.mkdirSync(paths.recordsDirectory, { recursive: true });
    for (let recordIndex = 0; recordIndex < records.length; recordIndex += 1) {
      fs.writeFileSync(this.getRestoreRecordPath(paths, recordIndex), JSON.stringify(records[recordIndex] || {}, null, 2), "utf8");
    }
    const importedPayload = imported && typeof imported === "object" && !Array.isArray(imported) ? imported : {};
    const restoreData = {};
    if (Object.prototype.hasOwnProperty.call(importedPayload, "mappings")) {
      restoreData.mappings = importedPayload.mappings;
    }
    if (Object.prototype.hasOwnProperty.call(importedPayload, "update_instruction")) {
      restoreData.update_instruction = importedPayload.update_instruction;
    }
    fs.writeFileSync(paths.dataPath, JSON.stringify(restoreData, null, 2), "utf8");
    fs.unlinkSync(paths.payloadPath);
    const preparedMeta = Object.assign({}, meta, {
      prepared: true,
      restore_started: false,
      total_records: records.length,
      next_record_index: 0,
      updated_at: new Date().toISOString()
    });
    this.writeRestoreUploadMeta(paths.metaPath, preparedMeta);
    return preparedMeta;
  }

  /** Read one prepared restore record from its temporary file. */
  readPreparedRestoreRecord(paths, recordIndex) {
    return JSON.parse(fs.readFileSync(this.getRestoreRecordPath(paths, recordIndex), "utf8"));
  }

  /** Read optional non-record fields retained from the original restore JSON. */
  readPreparedRestoreData(paths) {
    if (!fs.existsSync(paths.dataPath)) {
      return {};
    }
    try {
      const payload = JSON.parse(fs.readFileSync(paths.dataPath, "utf8"));
      return payload && typeof payload === "object" ? payload : {};
    } catch (error) {
      return {};
    }
  }

  /** Append one base64 restore chunk and prepare record batches after the final chunk. */
  async restoreJsonChunk(input, requestId) {
    const chunkIndex = Number(input && input.chunk_index);
    const totalChunks = Number(input && input.total_chunks);
    if (!Number.isInteger(chunkIndex) || !Number.isInteger(totalChunks) || totalChunks < 1 || chunkIndex < 0 || chunkIndex >= totalChunks) {
      const chunkError = new Error("恢复分片序号无效。");
      chunkError.statusCode = 400;
      throw chunkError;
    }
    const paths = this.getRestoreUploadPaths(input.upload_id);
    if (chunkIndex === 0) {
      this.cleanupRestoreUpload(paths);
    }
    const meta = this.readRestoreUploadMeta(paths.metaPath) || {
      upload_id: paths.uploadId,
      total_chunks: totalChunks,
      next_index: 0,
      file_name: String(input.file_name || ""),
      created_at: new Date().toISOString()
    };
    if (Number(meta.total_chunks) !== totalChunks || Number(meta.next_index) !== chunkIndex) {
      const orderError = new Error("恢复分片顺序不一致，请重新选择备份文件。");
      orderError.statusCode = 409;
      throw orderError;
    }
    const chunkBuffer = Buffer.from(String(input.chunk_base64 || ""), "base64");
    if (!chunkBuffer.length) {
      const emptyError = new Error("恢复分片内容为空。");
      emptyError.statusCode = 400;
      throw emptyError;
    }
    fs.appendFileSync(paths.payloadPath, chunkBuffer);
    meta.next_index = chunkIndex + 1;
    meta.updated_at = new Date().toISOString();
    this.writeRestoreUploadMeta(paths.metaPath, meta);
    if (meta.next_index < totalChunks) {
      return {
        done: false,
        prepared: false,
        received_chunks: meta.next_index,
        total_chunks: totalChunks
      };
    }
    const preparedMeta = this.prepareRestoreUpload(paths, meta);
    return {
      done: false,
      prepared: true,
      upload_id: paths.uploadId,
      received_chunks: preparedMeta.next_index,
      total_chunks: totalChunks,
      processed_records: 0,
      total_records: Number(preparedMeta.total_records || 0)
    };
  }

  /** Restore the next prepared record batch and return visible batch progress. */
  async restoreJsonBatch(input, requestId) {
    const paths = this.getRestoreUploadPaths(input && input.upload_id);
    const meta = this.readRestoreUploadMeta(paths.metaPath);
    if (!meta || !meta.prepared) {
      const missingError = new Error("恢复任务不存在或尚未准备完成。");
      missingError.statusCode = 404;
      throw missingError;
    }
    const totalRecords = Number(meta.total_records || 0);
    const startIndex = Number(meta.next_record_index || 0);
    const batchSize = Math.max(1, Math.min(50, Math.floor(Number(input && input.batch_size || 10))));
    const endIndex = Math.min(totalRecords, startIndex + batchSize);
    const batchRecords = [];
    for (let recordIndex = startIndex; recordIndex < endIndex; recordIndex += 1) {
      batchRecords.push(this.readPreparedRestoreRecord(paths, recordIndex));
    }
    const restoreData = this.readPreparedRestoreData(paths);
    const service = this;
    /** Apply one prepared record range to the cache payload. */
    const transaction = await this.repository.mutate(async function mutateRestoreBatch(payload) {
      if (!meta.restore_started) {
        service.repository.createHistorySnapshot({ platform: "system", platform_id: "all", records: payload.records }, "restore_chunked");
        payload.records = [];
        if (Object.prototype.hasOwnProperty.call(restoreData, "mappings")) {
          payload.mappings = restoreData.mappings;
        }
        if (Object.prototype.hasOwnProperty.call(restoreData, "update_instruction")) {
          payload.update_instruction = restoreData.update_instruction;
        }
      }
      for (let recordIndex = 0; recordIndex < batchRecords.length; recordIndex += 1) {
        await service.images.cacheRecordImages(batchRecords[recordIndex]);
        payload.records.push(batchRecords[recordIndex]);
      }
      return null;
    });
    meta.restore_started = true;
    meta.next_record_index = endIndex;
    meta.updated_at = new Date().toISOString();
    this.writeRestoreUploadMeta(paths.metaPath, meta);
    const done = endIndex >= totalRecords;
    if (done) {
      this.events.publish({ resource: "product", action: "imported", ids: [], version: Number(transaction.payload.version || 1) }, requestId);
      const workbench = this.viewModels.createWorkbench(transaction.payload);
      this.cleanupRestoreUpload(paths);
      return {
        done: true,
        processed_records: endIndex,
        total_records: totalRecords,
        workbench: workbench
      };
    }
    return {
      done: false,
      processed_records: endIndex,
      total_records: totalRecords
    };
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
    const service = this;
    const transaction = await this.repository.mutate(async function mutateProductModule(payload) {
      const found = service.findRecord(payload.records, input.platform, input.platform_id);
      if (!found) {
        const missingError = new Error("商品不存在或已被删除。");
        missingError.statusCode = 404;
        throw missingError;
      }
      const currentVersion = Number(found.record.version || 1);
      if (Number(input.version) !== currentVersion) {
        const conflictError = new Error("商品已被其他操作更新，请刷新后重试。");
        conflictError.statusCode = 409;
        conflictError.code = "PRODUCT_VERSION_CONFLICT";
        conflictError.details = {
          expected_version: Number(input.version),
          current_version: currentVersion,
          product: service.viewModels.normalizeRecord(found.record)
        };
        throw conflictError;
      }
      const undoToken = service.repository.createHistorySnapshot(found.record, input.module);
      service.applyModule(found.record, input.module, input.data);
      if (input.module === "images" || input.module === "skus") {
        await service.images.cacheEditableRecordImages(found.record);
      }
      found.record.version = currentVersion + 1;
      return {
        product: service.viewModels.normalizeRecord(found.record),
        undo_token: undoToken
      };
    });
    this.events.publish({
      resource: "product",
      action: "updated",
      ids: [String(input.platform), String(input.platform_id)],
      version: transaction.result.product.version
    }, requestId);
    return transaction.result;
  }

  /** Copy SKU1 price, stock or dimensions to every remaining SKU and persist once. */
  async copyFirstSkuAttribute(input, requestId) {
    const service = this;
    const transaction = await this.repository.mutate(async function mutateFirstSkuAttribute(payload) {
      const found = service.findRecord(payload.records, input.platform, input.platform_id);
      if (!found) {
        const missingError = new Error("商品不存在或已被删除。");
        missingError.statusCode = 404;
        throw missingError;
      }
      const currentVersion = Number(found.record.version || 1);
      if (Number(input.version) !== currentVersion) {
        const conflictError = new Error("商品已被其他操作更新，请刷新后重试。");
        conflictError.statusCode = 409;
        conflictError.code = "PRODUCT_VERSION_CONFLICT";
        conflictError.details = {
          expected_version: Number(input.version),
          current_version: currentVersion,
          product: service.viewModels.normalizeRecord(found.record)
        };
        throw conflictError;
      }
      const rows = service.getStoredSkuRows(found.record, input.platform);
      if (!rows.length) {
        const emptyError = new Error("当前商品没有可复制的 SKU1。");
        emptyError.statusCode = 400;
        throw emptyError;
      }
      if (!Array.isArray(found.record.sku) || !found.record.sku.length) {
        found.record.sku = [];
        for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
          found.record.sku.push(service.copySkuRow(rows[rowIndex]));
        }
      }
      const source = found.record.sku[0] || {};
      const undoToken = service.repository.createHistorySnapshot(found.record, "copy_first_sku_attribute");
      for (let index = 1; index < found.record.sku.length; index += 1) {
        const target = found.record.sku[index] || {};
        if (input.attribute === "price") {
          target.sku_price = source.sku_price;
        } else if (input.attribute === "stock") {
          target.sku_stock = source.sku_stock;
        } else {
          target.sku_length = source.sku_length;
          target.sku_width = source.sku_width;
          target.sku_height = source.sku_height;
        }
        found.record.sku[index] = target;
      }
      service.normalizeSavedSkuRows(found.record.sku);
      found.record.version = currentVersion + 1;
      return {
        product: service.viewModels.normalizeRecord(found.record),
        undo_token: undoToken
      };
    });
    this.events.publish({
      resource: "product",
      action: "first_sku_attribute_copied",
      ids: [String(input.platform), String(input.platform_id), String(input.attribute)],
      version: transaction.result.product.version
    }, requestId);
    return transaction.result;
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
    const sourceLength = this.readSkuField(source, ["sku_length", "skuLength", "length"]);
    const sourceWidth = this.readSkuField(source, ["sku_width", "skuWidth", "width"]);
    const sourceHeight = this.readSkuField(source, ["sku_height", "skuHeight", "height"]);
    const targetWeight = this.readSkuField(target, ["sku_weight", "skuWeight", "weight"]);
    const targetLength = this.readSkuField(target, ["sku_length", "skuLength", "length"]);
    const targetWidth = this.readSkuField(target, ["sku_width", "skuWidth", "width"]);
    const targetHeight = this.readSkuField(target, ["sku_height", "skuHeight", "height"]);
    const sourceImages = this.readSkuImageUrls(source);
    target.sku_id = this.readSkuField(target, ["sku_id", "skuId"]) || sourceSkuId || "";
    target.SubSku1 = this.readSkuSpecValue(source, 0) || this.readSkuSpecValue(target, 0);
    target.SubSku2 = this.readSkuSpecValue(source, 1) || this.readSkuSpecValue(target, 1);
    target.sku_price = sourcePrice !== "" ? sourcePrice : this.readSkuField(target, ["sku_price", "price"]);
    target.sku_original_price = sourceOriginalPrice !== "" ? sourceOriginalPrice : target.sku_original_price || "";
    target.sku_stock = sourceStock !== "" ? sourceStock : target.sku_stock || 0;
    target.sku_weight = sourceWeight !== "" ? sourceWeight : targetWeight || 0;
    target.sku_length = sourceLength !== "" ? sourceLength : targetLength;
    target.sku_width = sourceWidth !== "" ? sourceWidth : targetWidth;
    target.sku_height = sourceHeight !== "" ? sourceHeight : targetHeight;
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
    const service = this;
    const transaction = await this.repository.mutate(async function mutateSkuReplacement(payload) {
      const target = input.target_temu_platform_id
        ? service.findRecord(payload.records, "temu", input.target_temu_platform_id)
        : service.findRecordByMainId(payload.records, "temu", input.target_temu_main_id);
      if (!target) {
        const targetError = new Error("找不到待替换的 Temu 商品。 ");
        targetError.statusCode = 404;
        throw targetError;
      }
      let source = input.source_1688_platform_id
        ? service.findRecord(payload.records, "1688", input.source_1688_platform_id)
        : service.findRecordByMainId(payload.records, "1688", input.source_1688_main_id);
      const sourceData = input.source_data && typeof input.source_data === "object" ? input.source_data : null;
      if (!source && sourceData) {
        source = {
          record: {
            platform: "1688",
            platform_id: String(input.source_1688_platform_id || ""),
            main_id: String(input.source_1688_main_id || ""),
            product_name: String(sourceData.productName || ""),
            source_data: sourceData,
            sku: Array.isArray(sourceData.skuRows)
              ? sourceData.skuRows
              : Array.isArray(sourceData.sku) ? sourceData.sku : []
          },
          index: -1
        };
      }
      if (!source) {
        const sourceError = new Error("找不到当前 1688 商品，请先采集或刷新工作台。 ");
        sourceError.statusCode = 404;
        throw sourceError;
      }
      const currentVersion = Number(target.record.version || 1);
      if (Number(input.target_temu_version) !== currentVersion) {
        const conflictError = new Error("商品已被其他操作更新，请刷新后重试。");
        conflictError.statusCode = 409;
        conflictError.code = "PRODUCT_VERSION_CONFLICT";
        conflictError.details = {
          expected_version: Number(input.target_temu_version),
          current_version: currentVersion,
          product: service.viewModels.normalizeRecord(target.record)
        };
        throw conflictError;
      }
      const targetRows = service.getStoredSkuRows(target.record, "temu");
      const sourceRows = service.getStoredSkuRows(source.record, "1688");
      service.normalizeSavedSkuRows(targetRows);
      service.normalizeSavedSkuRows(sourceRows);
      const replaceAll = Boolean(input.replace_all_skus || sourceData);
      let targetSelection = null;
      let sourceSelection = null;
      if (!replaceAll) {
        targetSelection = service.findSkuRow(targetRows, input.target_sku_index, input.target_sku_id, "Temu SKU");
        sourceSelection = service.findSkuRow(sourceRows, input.source_sku_index, input.source_sku_id, "1688 SKU");
      }
      if (!Array.isArray(target.record.sku) || !target.record.sku.length) {
        target.record.sku = [];
        for (let rowIndex = 0; rowIndex < targetRows.length; rowIndex += 1) {
          target.record.sku.push(service.copySkuRow(targetRows[rowIndex]));
        }
      }
      const undoToken = service.repository.createHistorySnapshot(target.record, "replace_sku");
      if (replaceAll) {
        if (!sourceRows.length) {
          const emptyError = new Error("当前 1688 商品没有可替换的 SKU。 ");
          emptyError.statusCode = 400;
          throw emptyError;
        }
        target.record.sku = [];
        for (let sourceIndex = 0; sourceIndex < sourceRows.length; sourceIndex += 1) {
          const baseTargetSku = targetRows[sourceIndex] || {};
          target.record.sku.push(service.createReplacementSku(baseTargetSku, sourceRows[sourceIndex], source.record, sourceIndex));
        }
      } else {
        const replacement = service.createReplacementSku(targetSelection.row, sourceSelection.row, source.record, sourceSelection.index);
        target.record.sku[targetSelection.index] = replacement;
      }
      await service.images.cacheEditableRecordImages(target.record);
      target.record.version = currentVersion + 1;
      return {
        product: service.viewModels.normalizeRecord(target.record),
        source_product: service.viewModels.normalizeRecord(source.record),
        target_sku_index: replaceAll ? null : targetSelection.index,
        source_sku_index: replaceAll ? null : sourceSelection.index,
        replaced_sku_count: replaceAll ? target.record.sku.length : 1,
        undo_token: undoToken
      };
    });
    this.events.publish({
      resource: "product",
      action: "sku_replaced",
      ids: ["temu", String(transaction.result.product.platform_id), "1688", String(transaction.result.source_product.platform_id)],
      version: transaction.result.product.version
    }, requestId);
    return transaction.result;
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
    if (moduleName === "skus") {
      this.normalizeSavedSkuRows(record.sku);
    }
  }

  /** Apply selected carousel outputs to source positions or replace the complete main gallery. */
  async applyCarouselTask(task, selectedIndices, requestId, replaceAll) {
    const service = this;
    const transaction = await this.repository.mutate(async function mutateCarouselImages(payload) {
      const found = task.temu_platform_id
        ? service.findRecord(payload.records, "temu", task.temu_platform_id)
        : service.findRecordByMainId(payload.records, "temu", task.temu_main_id);
      if (!found) {
        const error = new Error("找不到轮播任务对应的 Temu 商品。");
        error.statusCode = 404;
        error.code = "CAROUSEL_PRODUCT_NOT_FOUND";
        throw error;
      }
      const generatedUrls = [];
      const selectedPages = {};
      for (let index = 0; index < selectedIndices.length; index += 1) {
        const selectedIndex = Number(selectedIndices[index]);
        if (selectedPages[selectedIndex]) {
          continue;
        }
        selectedPages[selectedIndex] = true;
        const page = task.pages[selectedIndex];
        if (page && page.status === "succeeded" && page.image_url) {
          generatedUrls.push(String(page.image_url));
        }
      }
      if (!generatedUrls.length) {
        const error = new Error("没有选择可替换的成功图片。");
        error.statusCode = 400;
        error.code = "CAROUSEL_OUTPUT_EMPTY";
        throw error;
      }
      const currentGallery = Array.isArray(found.record.gallery_image_urls) ? found.record.gallery_image_urls : [];
      const taskSourceIndices = Array.isArray(task.source_indices) ? task.source_indices : [];
      const resolvedSourceIndices = replaceAll ? [] : service.resolveCarouselReplacementIndices(currentGallery.length, taskSourceIndices);
      let gallery = generatedUrls.slice();
      if (!replaceAll) {
        gallery = currentGallery.slice();
        const sourceIndices = resolvedSourceIndices.slice();
        /** Order source positions so removal cannot shift a later target. */
        sourceIndices.sort(function sortCarouselSourceIndices(first, second) {
          return Number(first) - Number(second);
        });
        const insertIndex = Number(sourceIndices[0] || 0);
        for (let index = sourceIndices.length - 1; index >= 0; index -= 1) {
          if (sourceIndices[index] >= 0 && sourceIndices[index] < gallery.length) {
            gallery.splice(sourceIndices[index], 1);
          }
        }
        for (let index = 0; index < generatedUrls.length; index += 1) {
          gallery.splice(insertIndex + index, 0, generatedUrls[index]);
        }
      }
      const undoToken = service.repository.createHistorySnapshot(found.record, "carousel_images");
      found.record.gallery_image_urls = gallery;
      found.record.main_image_url = gallery[0] || "";
      await service.images.cacheEditableRecordImages(found.record);
      found.record.version = Number(found.record.version || 1) + 1;
      return { product: service.viewModels.normalizeRecord(found.record), undo_token: undoToken };
    });
    this.events.publish({
      resource: "product",
      action: "carousel_applied",
      ids: ["temu", String(transaction.result.product.platform_id)],
      version: transaction.result.product.version
    }, requestId);
    return transaction.result;
  }

  /** Resolve saved carousel slots to the nearest distinct positions in the live gallery. */
  resolveCarouselReplacementIndices(galleryLength, taskSourceIndices) {
    const length = Math.max(0, Math.floor(Number(galleryLength || 0)));
    const savedIndices = Array.isArray(taskSourceIndices) ? taskSourceIndices : [];
    const available = [];
    const resolved = [];
    for (let index = 0; index < length; index += 1) {
      available.push(index);
    }
    for (let sourceIndex = 0; sourceIndex < savedIndices.length && available.length; sourceIndex += 1) {
      const numericIndex = Number(savedIndices[sourceIndex]);
      const requestedIndex = Number.isFinite(numericIndex)
        ? Math.max(0, Math.min(length - 1, Math.round(numericIndex)))
        : 0;
      let nearestAvailableIndex = 0;
      for (let availableIndex = 1; availableIndex < available.length; availableIndex += 1) {
        const candidateDistance = Math.abs(available[availableIndex] - requestedIndex);
        const nearestDistance = Math.abs(available[nearestAvailableIndex] - requestedIndex);
        if (candidateDistance < nearestDistance
          || (candidateDistance === nearestDistance && available[availableIndex] < available[nearestAvailableIndex])) {
          nearestAvailableIndex = availableIndex;
        }
      }
      resolved.push(available.splice(nearestAvailableIndex, 1)[0]);
    }
    return resolved;
  }

  /** Persist canonical stock, weight and dimension keys for every saved SKU row. */
  normalizeSavedSkuRows(rows) {
    const target = Array.isArray(rows) ? rows : [];
    for (let index = 0; index < target.length; index += 1) {
      const row = target[index];
      if (!row || typeof row !== "object") {
        continue;
      }
      const stock = this.readSkuField(row, ["sku_stock", "stock", "stockQuantity", "canBookCount"]);
      const weight = this.readSkuField(row, ["sku_weight", "skuWeight", "weight"]);
      const length = this.readSkuField(row, ["sku_length", "skuLength", "length_cm", "lengthCm", "length"]);
      const width = this.readSkuField(row, ["sku_width", "skuWidth", "width_cm", "widthCm", "width"]);
      const height = this.readSkuField(row, ["sku_height", "skuHeight", "height_cm", "heightCm", "height"]);
      row.sku_stock = stock === "" ? 0 : stock;
      row.sku_weight = weight === "" ? 0 : weight;
      row.sku_length = length;
      row.sku_width = width;
      row.sku_height = height;
    }
  }

  /** Restore one product snapshot using a durable undo token. */
  async undo(input, requestId) {
    const service = this;
    const transaction = await this.repository.mutate(async function mutateProductUndo(payload) {
      const snapshot = service.repository.consumeHistorySnapshot(input.token);
      if (!snapshot || !snapshot.record) {
        const undoError = new Error("返回记录不存在或已经使用。");
        undoError.statusCode = 404;
        throw undoError;
      }
      const record = snapshot.record;
      const found = service.findRecord(payload.records, record.platform, record.platform_id);
      if (!found) {
        const missingError = new Error("原商品已经不存在，无法返回。");
        missingError.statusCode = 404;
        throw missingError;
      }
      record.version = Number(found.record.version || 1) + 1;
      payload.records[found.index] = record;
      return { product: service.viewModels.normalizeRecord(record) };
    });
    this.events.publish({
      resource: "product",
      action: "restored",
      ids: [String(transaction.result.product.platform), String(transaction.result.product.platform_id)],
      version: transaction.result.product.version
    }, requestId);
    return transaction.result;
  }
}

module.exports = { ProductService: ProductService };
