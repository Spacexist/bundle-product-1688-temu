/** Read Temu product data from the page's main world. */
function collectTemuDataFromPage() {
  /** Read the serialized rawData object embedded in the page. */
  function readRawData() {
    if (window.rawData && window.rawData.store) {
      return window.rawData;
    }

    var scripts = document.getElementsByTagName("script");
    var marker = "window.rawData=";
    for (var index = 0; index < scripts.length; index += 1) {
      var scriptText = scripts[index].textContent || "";
      var startIndex = scriptText.indexOf(marker);
      if (startIndex < 0) {
        continue;
      }

      startIndex += marker.length;
      var endIndex = scriptText.indexOf(";document.dispatchEvent", startIndex);
      if (endIndex < 0) {
        endIndex = scriptText.lastIndexOf(";");
      }

      if (endIndex <= startIndex) {
        continue;
      }

      try {
        return JSON.parse(scriptText.slice(startIndex, endIndex));
      } catch (error) {
        return null;
      }
    }

    return null;
  }

  /** Read the last value for a query parameter. */
  function getQueryValue(query, key) {
    var value = query ? query[key] : undefined;
    if (Array.isArray(value)) {
      return value.length ? value[value.length - 1] : undefined;
    }
    return value;
  }

  /** Copy the product gallery into a serializable list. */
  function copyGalleryList(gallery) {
    var result = [];
    if (!Array.isArray(gallery)) {
      return result;
    }

    for (var index = 0; index < gallery.length; index += 1) {
      var item = gallery[index] || {};
      result.push({
        id: item.id,
        url: item.url,
        videoUrl: item.videoUrl,
        width: item.width,
        height: item.height,
        type: item.type
      });
    }
    return result;
  }

  /** Copy detail images from either supported page data location. */
  function copyDetailList(goods, productDetail) {
    var directList = copyGalleryList(goods ? goods.detailList : []);
    if (!directList.length && goods && Array.isArray(goods.detail)) {
      directList = copyGalleryList(goods.detail);
    }
    if (directList.length) {
      return directList;
    }

    var result = [];
    var floorList = productDetail && Array.isArray(productDetail.floorList)
      ? productDetail.floorList
      : [];
    for (var floorIndex = 0; floorIndex < floorList.length; floorIndex += 1) {
      var items = floorList[floorIndex].items || [];
      for (var itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
        var item = items[itemIndex] || {};
        result.push({
          url: item.url,
          width: item.width,
          height: item.height,
          index: item.index
        });
      }
    }
    if (result.length) {
      return result;
    }
    return copyDomDetailList();
  }

  /** Read one loaded or lazy-loaded image URL from a detail image node. */
  function readDomDetailImageUrl(image) {
    if (!image) {
      return "";
    }
    var attributes = ["src", "data-src", "data-original", "data-lazy-src", "data-image-url"];
    for (var index = 0; index < attributes.length; index += 1) {
      var value = image.getAttribute(attributes[index]);
      if (value && value.indexOf("data:") !== 0) {
        return value;
      }
    }
    return "";
  }

  /** Copy the product detail images already present in the Temu DOM. */
  function copyDomDetailList() {
    if (typeof document === "undefined") {
      return [];
    }
    var selectors = [
      '[data-testid*="detail"] img',
      '[data-testid*="description"] img',
      '[class*="product-detail"] img',
      '[class*="goods-detail"] img',
      '[class*="description"] img'
    ];
    var result = [];
    var seen = {};
    for (var selectorIndex = 0; selectorIndex < selectors.length; selectorIndex += 1) {
      var nodes = document.querySelectorAll(selectors[selectorIndex]);
      for (var nodeIndex = 0; nodeIndex < nodes.length; nodeIndex += 1) {
        var image = nodes[nodeIndex];
        var url = readDomDetailImageUrl(image);
        if (!url || seen[url]) {
          continue;
        }
        var rect = image.getBoundingClientRect();
        var width = Number(image.naturalWidth || rect.width || 0);
        var height = Number(image.naturalHeight || rect.height || 0);
        if (width < 180 && height < 180) {
          continue;
        }
        seen[url] = true;
        result.push({
          url: url,
          width: width,
          height: height,
          type: "dom_detail"
        });
      }
    }
    return result;
  }

  /** Copy the SKU list. */
  function copySkuList(skuList) {
    var result = [];
    if (!Array.isArray(skuList)) {
      return result;
    }

    for (var index = 0; index < skuList.length; index += 1) {
      var item = skuList[index] || {};
      result.push({
        skuId: item.skuId,
        goodsId: item.goodsId,
        normalPrice: item.normalPrice,
        normalPriceStr: item.normalPriceStr,
        salePrice: item.salePrice,
        limitQuantity: item.limitQuantity,
        stockQuantity: item.stockQuantity,
        isOnsale: item.isOnsale,
        specs: item.specs,
        thumbUrl: item.thumbUrl
      });
    }
    return result;
  }

  /** Copy the review list. */
  function copyReviewList(reviewData) {
    var result = [];
    var reviewList = reviewData && Array.isArray(reviewData.reviewInfoList)
      ? reviewData.reviewInfoList
      : [];
    for (var index = 0; index < reviewList.length; index += 1) {
      var item = reviewList[index] || {};
      result.push({
        reviewId: item.reviewId,
        name: item.name,
        score: item.score,
        comment: item.comment,
        time: item.time,
        concatTimeLang: item.concatTimeLang,
        goodsId: item.goodsId,
        skuId: item.skuId,
        specs: item.specs
      });
    }
    return result;
  }

  /** Copy the breadcrumb navigation shown above the product. */
  function copyBreadcrumbList(crumbOptList) {
    var result = [];
    if (!Array.isArray(crumbOptList)) {
      return result;
    }

    for (var index = 0; index < crumbOptList.length; index += 1) {
      var item = crumbOptList[index] || {};
      result.push({
        name: item.optName || item.title || item.name || item.text || "",
        url: item.seoLinkUrl || item.linkUrl || ""
      });
    }
    return result;
  }

  /** Copy the backend category ID chain returned by Temu. */
  function copyBackendCategoryIds(goods) {
    var result = [];
    var ids = [goods.catId1, goods.catId2, goods.catId3, goods.catId4];
    for (var index = 0; index < ids.length; index += 1) {
      if (ids[index] !== undefined && ids[index] !== null && ids[index] !== "") {
        result.push(ids[index]);
      }
    }
    return result;
  }

  /** Read the review score from supported page state locations. */
  function readReviewScore(store, reviewData) {
    if (reviewData && reviewData.reviewScore !== undefined) {
      return reviewData.reviewScore;
    }
    if (store.review && store.review.reviewScore !== undefined) {
      return store.review.reviewScore;
    }
    if (store.reviewStore && store.reviewStore.showScore !== undefined) {
      return store.reviewStore.showScore;
    }
    return undefined;
  }

  /** Build the recorded request parameters for the main product endpoint. */
  function createApiRequest(store) {
    var query = store.query || {};
    var goods = store.goods || {};
    var gallery = Array.isArray(goods.gallery) ? goods.gallery : [];
    var galleryUrl = getQueryValue(query, "top_gallery_url");
    if (!galleryUrl && gallery.length) {
      galleryUrl = gallery[0].url;
    }

    return {
      url: "https://www.temu.com/api/oak/integration/render",
      method: "POST",
      params: {
        goods_id: store.goodsId || goods.goodsId || getQueryValue(query, "goods_id"),
        _oak_gallery: galleryUrl,
        _oak_sku_id: getQueryValue(query, "sku_id"),
        _oak_spec_id: getQueryValue(query, "spec_id"),
        _oak_spec_gallery_id: getQueryValue(query, "spec_gallery_id"),
        _oak_spec_ids: getQueryValue(query, "spec_ids"),
        _oak_query_app_only: 1,
        _oak_query_used_wish: 1,
        _oak_show_leaf_category_low_price_tag: 1,
        _oak_show_sale_price_suffix: 1,
        _oak_show_what_rrp: 1,
        refer_page_sn: getQueryValue(query, "refer_page_sn"),
        _oak_stage: "goods_detail"
      }
    };
  }

  /** Normalize the page state into the extension's export structure. */
  function normalizeTemuData(rawData) {
    var store = rawData && rawData.store ? rawData.store : null;
    if (!store || !store.goods) {
      throw new Error("没有找到 Temu 商品详情数据，请等待页面加载完成后重试。");
    }

    var goods = store.goods || {};
    var query = store.query || {};
    var reviewData = store.review && store.review.reviewData
      ? store.review.reviewData
      : {};
    var mallData = store.mall && store.mall.mallData
      ? store.mall.mallData
      : {};
    var categoryIds = [goods.catId, goods.catId1, goods.catId2, goods.catId3, goods.catId4];
    var backendCategoryIds = copyBackendCategoryIds(goods);
    var pageUrl = location.href;

    return {
      source: "window.rawData.store",
      collectedAt: new Date().toISOString(),
      page: {
        url: pageUrl,
        goodsId: store.goodsId || goods.goodsId,
        pageSn: store.pageSn,
        locale: store.localInfo || {}
      },
      api: createApiRequest(store),
      goods: {
        goodsId: goods.goodsId,
        itemId: goods.itemId,
        goodsName: goods.goodsName,
        status: goods.status,
        minOnSalePrice: goods.minOnSalePrice,
        maxOnSalePrice: goods.maxOnSalePrice,
        minOnSalePriceStr: goods.minOnSalePriceStr,
        soldQuantity: goods.soldQuantity,
        mallId: goods.mallId,
        categoryIds: categoryIds,
        backendCategoryIds: backendCategoryIds,
        saleInfo: goods.saleInfo || {},
        goodsProperty: goods.goodsProperty || [],
        gallery: copyGalleryList(goods.gallery),
        detailList: copyDetailList(goods, store.productDetail)
      },
      sku: copySkuList(store.sku),
      mall: mallData,
      review: {
        reviewNum: reviewData.reviewNum,
        reviewScore: readReviewScore(store, reviewData),
        reviewInfoList: copyReviewList(reviewData)
      },
      breadcrumb: copyBreadcrumbList(store.crumbOptList),
      delivery: store.delivery || {},
      guarantee: store.guarantee || {},
      endpoints: [
        "https://www.temu.com/api/oak/integration/render",
        "https://www.temu.com/api/oak/sku/info",
        "https://www.temu.com/api/poppy/v1/goods_detail",
        "https://www.temu.com/api/bg/engels/reviews/goods/overview/list"
      ]
    };
  }

  /** Read the page data and return a serializable result. */
  try {
    var hostname = location.hostname;
    if (hostname !== "temu.com" && !hostname.endsWith(".temu.com")) {
      return { ok: false, error: "当前页面不是 Temu 页面。" };
    }

    var rawData = readRawData();
    if (!rawData) {
      return { ok: false, error: "没有找到页面内嵌商品数据，请等待页面加载完成。" };
    }
    return { ok: true, data: normalizeTemuData(rawData) };
  } catch (error) {
    return { ok: false, error: error.message || "读取 Temu 数据失败。" };
  }
}
