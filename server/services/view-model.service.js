/** Backend-only normalizer that produces the complete workbench ViewModel. */
class ViewModelService {
  /** Return an array or a safe empty list. */
  asArray(value) {
    return Array.isArray(value) ? value : [];
  }

  /** Read ordered URL values from collector image containers. */
  readImageUrls(value) {
    const result = [];
    const list = this.asArray(value);
    for (let index = 0; index < list.length; index += 1) {
      const item = list[index];
      const url = typeof item === "string" ? item : item && (item.url || item.imageUrl);
      if (url) {
        result.push(String(url));
      }
    }
    return result;
  }

  /** Read one collector specification value and preserve its property label. */
  readSpecValue(specs, index) {
    const list = this.asArray(specs);
    const item = list[index];
    if (!item) {
      return "";
    }
    if (typeof item === "string") {
      return item;
    }
    const name = item.specKey || item.specName || item.key || "";
    const value = item.specValue || item.value || item.name || item.text || item.propValue || "";
    return name && value ? String(name) + ":" + String(value) : String(value || "");
  }

  /** Normalize SKU rows once on the server for direct table rendering. */
  normalizeSkus(value) {
    const result = [];
    const rows = this.asArray(value);
    for (let index = 0; index < rows.length; index += 1) {
      const source = rows[index] || {};
      const images = this.readImageUrls(source.sku_image_urls);
      const primary = source.sku_image_url || source.imageUrl || source.thumbUrl || "";
      if (!images.length && primary) {
        images.push(String(primary));
      }
      result.push({
        sku_id: source.sku_id || source.skuId || "",
        SubSku1: source.SubSku1 || source.subSku1 || this.readSpecValue(source.specs || source.specAttrs, 0),
        SubSku2: source.SubSku2 || source.subSku2 || this.readSpecValue(source.specs || source.specAttrs, 1),
        sku_price: source.sku_price || source.discountPrice || source.promotionPrice || source.salePrice || source.normalPrice || source.price || "",
        sku_original_price: source.sku_original_price || source.price || source.normalPrice || "",
        sku_stock: source.sku_stock || source.stock || source.stockQuantity || source.canBookCount || "",
        sku_image_url: primary || images[0] || "",
        sku_image_urls: images,
        merged_ali_sku_keys: this.asArray(source.merged_ali_sku_keys)
      });
    }
    return result;
  }

  /** Normalize listing fields used directly by the workbench title area. */
  normalizeListing(value) {
    const source = value && typeof value === "object" ? value : {};
    return {
      title: String(source.title || ""),
      keywords: String(source.keywords || ""),
      attributes: this.asArray(source.attributes)
    };
  }

  /** Convert one raw cache record into a ready-to-render product ViewModel. */
  normalizeRecord(record) {
    const stored = record && typeof record === "object" ? record : {};
    const source = stored.source_data && typeof stored.source_data === "object" ? stored.source_data : {};
    const is1688 = String(stored.platform || "") === "1688";
    const goods = source.goods || {};
    const shop = source.shop || source.mall || {};
    const rawDetail = source.rawJson && source.rawJson.detailDescription ? source.rawJson.detailDescription : {};
    const gallerySource = is1688 ? source.galleryImageUrls : goods.gallery;
    const detailSource = is1688 ? source.detailImageUrls : goods.detailList;
    const gallery = stored.gallery_image_urls ? this.readImageUrls(stored.gallery_image_urls) : this.readImageUrls(gallerySource);
    let details = stored.detail_image_urls ? this.readImageUrls(stored.detail_image_urls) : this.readImageUrls(detailSource);
    if (!details.length && is1688) {
      details = this.readImageUrls(rawDetail.imageUrls);
    }
    const skuSource = stored.sku || (is1688 ? source.skuRows : source.sku);
    const listing = this.normalizeListing(stored.listing_json || source.listing);
    return {
      main_id: stored.main_id === undefined ? stored.mainid || "" : stored.main_id,
      platform_id: stored.platform_id === undefined ? "" : stored.platform_id,
      platform: stored.platform || "",
      version: Number(stored.version || 1),
      linked_temu_platform_id: stored.linked_temu_platform_id || "",
      bound_1688_platform_id: stored.bound_1688_platform_id || "",
      product_id: stored.product_id || (is1688 ? source.offerId : goods.goodsId) || "",
      product_name: listing.title || stored.product_name || (is1688 ? source.productName : goods.goodsName) || "未命名商品",
      product_category: stored.product_category || source.productCategory || "",
      category_ids: this.asArray(stored.category_ids || goods.backendCategoryIds),
      sku: this.normalizeSkus(skuSource),
      main_image_url: stored.main_image_url || source.mainImageUrl || gallery[0] || "",
      gallery_image_urls: gallery,
      detail_image_urls: details,
      detail_description_url: stored.detail_description_url || source.detailDescriptionUrl || rawDetail.detailUrl || "",
      shop_name: stored.shop_name || shop.name || shop.mallName || "",
      attributes_json: this.asArray(stored.attributes_json || source.attributes || goods.goodsProperty),
      listing_json: listing,
      page_url: stored.page_url || source.pageUrl || source.page && source.page.url || "",
      collected_at: stored.collected_at || source.collectedAt || ""
    };
  }

  /** Create the complete workbench ViewModel without frontend domain processing. */
  createWorkbench(payload) {
    const source = payload && typeof payload === "object" ? payload : {};
    const rawRecords = this.asArray(source.records);
    const records = [];
    for (let index = 0; index < rawRecords.length; index += 1) {
      records.push(this.normalizeRecord(rawRecords[index]));
    }
    return {
      version: Number(source.version || 1),
      updated_at: source.updated_at || "",
      records: records,
      mappings: this.asArray(source.mappings),
      update_instruction: source.update_instruction || null
    };
  }
}

module.exports = { ViewModelService: ViewModelService };
