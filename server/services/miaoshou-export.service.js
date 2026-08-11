const archiver = require("archiver");
const XLSX = require("xlsx");

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

/** Build all server-side files required by the 妙手 product import package. */
class MiaoshouExportService {
  /** Store the cache, ViewModel and image-cache dependencies. */
  constructor(options) {
    const settings = options || {};
    this.repository = settings.repository;
    this.viewModels = settings.viewModels;
    this.images = settings.images;
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
        ""
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

  /** Create a standard ZIP stream and collect its output in one server buffer. */
  createArchive() {
    const archive = archiver("zip", { store: true });
    const chunks = [];
    const completion = new Promise(function createArchivePromise(resolve, reject) {
      /** Collect each compressed output chunk. */
      function handleArchiveData(chunk) {
        chunks.push(chunk);
      }
      /** Resolve after the standard ZIP stream writes its end record. */
      function handleArchiveEnd() {
        resolve(Buffer.concat(chunks));
      }
      /** Reject when the ZIP stream reports a generation error. */
      function handleArchiveError(error) {
        reject(error);
      }
      archive.on("data", handleArchiveData);
      archive.on("end", handleArchiveEnd);
      archive.on("error", handleArchiveError);
    });
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
  async createTemuZip() {
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
    const archiveState = this.createArchive();
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
    const buffer = await archiveState.completion;
    return { buffer: buffer, fileName: packageName + ".zip", productCount: records.length, failureCount: failures.length };
  }
}

module.exports = { MiaoshouExportService: MiaoshouExportService };
