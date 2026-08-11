importScripts("collector-temu.js", "collector-1688.js");

var unifiedConfigPromise = null;
var extensionCacheStorageKey = "autoPackingExtensionCache";

/** Read extension API configuration once from the packaged config file. */
function getUnifiedExtensionConfig() {
  if (!unifiedConfigPromise) {
    unifiedConfigPromise = fetch(chrome.runtime.getURL("config.json")).then(function parseUnifiedExtensionConfig(response) {
      if (!response.ok) {
        throw new Error("扩展 config.json 读取失败。");
      }
      return response.json();
    });
  }
  return unifiedConfigPromise;
}

/** Resolve one versioned backend URL from extension configuration. */
function getUnifiedApiUrl(pathname) {
  return getUnifiedExtensionConfig().then(function buildUnifiedApiUrl(config) {
    return String(config.apiBaseUrl || "http://127.0.0.1:3000/api/v1").replace(/\/$/, "") + pathname;
  });
}

/** Handle collection requests from either platform page. */
chrome.runtime.onMessage.addListener(function handleUnifiedCollectionMessage(message, sender, sendResponse) {
  if (message && message.type === "getUnifiedBindingPanelData") {
    getUnifiedBindingPanelData().then(function handleBindingPanelData(payload) {
      sendResponse({ ok: true, payload: payload });
    }).catch(function handleBindingPanelError(error) {
      sendResponse({ ok: false, error: error.message || "读取 Temu 绑定列表失败。" });
    });
    return true;
  }
  if (message && message.type === "replaceUnifiedSku") {
    var replaceTabId = message.tabId || (sender.tab && sender.tab.id ? sender.tab.id : 0);
    if (!replaceTabId) {
      sendResponse({ ok: false, error: "没有找到当前 1688 商品页标签。" });
      return false;
    }
    if (!message.targetTemuMainId && !message.targetTemuPlatformId) {
      sendResponse({ ok: false, error: "请先在左侧选择 Temu 商品。" });
      return false;
    }
    notifyUnifiedCollectionStatus(replaceTabId, "collecting", "正在读取当前 1688 SKU", "replaceSku");
    collectUnifiedFromTab(replaceTabId, "1688").then(function handleUnifiedSkuCollection(data) {
      notifyUnifiedCollectionStatus(replaceTabId, "broadcasting", "正在替换 Temu SKU 并更新 cache", "replaceSku");
      return submitUnifiedSkuReplacement(data, String(message.targetTemuMainId || ""), String(message.targetTemuPlatformId || ""), Number(message.targetTemuVersion || 0));
    }).then(function handleUnifiedSkuReplacementResult(result) {
      var count = Number(result && result.data && result.data.replaced_sku_count || 0);
      notifyUnifiedCollectionStatus(replaceTabId, "completed", "已替换 Temu SKU " + count + " 条", "replaceSku");
      sendResponse(result);
    }).catch(function handleUnifiedSkuReplacementError(error) {
      notifyUnifiedCollectionStatus(replaceTabId, "failed", error.message || "SKU 替换失败", "replaceSku");
      sendResponse({ ok: false, error: error.message || "SKU 替换失败。" });
    });
    return true;
  }
  if (!message || message.type !== "collectUnifiedProduct") {
    return false;
  }
  var tabId = message.tabId || (sender.tab && sender.tab.id ? sender.tab.id : 0);
  if (!tabId) {
    sendResponse({ ok: false, error: "没有找到当前商品页标签。" });
    return false;
  }
  var platform = sender.tab && sender.tab.url
    ? getUnifiedPlatform(sender.tab.url)
    : message.platform || "";
  if (platform !== "temu" && platform !== "1688") {
    sendResponse({ ok: false, error: "无法识别当前平台。" });
    return false;
  }
  notifyUnifiedCollectionStatus(tabId, "collecting", "正在读取商品页面");
  collectUnifiedFromTab(tabId, platform).then(function handleUnifiedCollection(data) {
    notifyUnifiedCollectionStatus(tabId, "broadcasting", "正在写入服务器和扩展 cache");
    if (platform !== "1688") {
      return submitAndCacheUnifiedCollection(data, platform, "", "");
    }
    if (message.targetTemuMainId) {
      return submitAndCacheUnifiedCollection(data, "1688", String(message.targetTemuMainId), String(message.targetTemuPlatformId || ""));
    }
    return getUnifiedActiveWorkflow().then(function handleActiveWorkflow(activeWorkflow) {
      var workflowTemuMainId = activeWorkflow && activeWorkflow.active_temu_main_id
        ? String(activeWorkflow.active_temu_main_id)
        : "";
      if (workflowTemuMainId) {
        return submitAndCacheUnifiedCollection(data, "1688", workflowTemuMainId, "");
      }
      return submitAndCacheUnifiedCollection(data, platform, "", "");
    });
  }).then(function handleUnifiedCollectionResult(result) {
    notifyUnifiedCollectionStatus(tabId, "completed", result && result.replaced ? "已完成，重复商品已更新" : "采集完成");
    sendResponse(result);
  }).catch(function handleUnifiedCollectionError(error) {
    notifyUnifiedCollectionStatus(tabId, "failed", error.message || "采集失败");
    sendResponse({ ok: false, error: error.message || "采集失败。" });
  });
  return true;
});

/** Notify the current product tab about one collection lifecycle state. */
function notifyUnifiedCollectionStatus(tabId, status, message, action) {
  if (!tabId) {
    return;
  }
  chrome.tabs.sendMessage(tabId, {
    type: "unifiedCollectionStatus",
    status: String(status || ""),
    message: String(message || ""),
    action: String(action || "")
  }, function handleUnifiedStatusMessage() {
    void chrome.runtime.lastError;
  });
}

/** Resolve the supported platform from a page URL. */
function getUnifiedPlatform(url) {
  var source = String(url || "").toLowerCase();
  if (source.indexOf("detail.1688.com/offer/") >= 0) {
    return "1688";
  }
  if (source.indexOf("temu.com/") >= 0) {
    return "temu";
  }
  throw new Error("当前页面不是 Temu 或 1688 商品详情页。 ");
}

/** Execute the selected platform collector in the page main world. */
function collectUnifiedFromTab(tabId, platform) {
  var collector = platform === "1688"
    ? collect1688DataFromPage
    : collectTemuDataFromPage;
  return chrome.scripting.executeScript({
    target: { tabId: tabId },
    world: "MAIN",
    func: collector
  }).then(function handleUnifiedExecution(results) {
    if (!results.length || !results[0].result) {
      throw new Error("没有读取到页面数据。 ");
    }
    var collectionResult = results[0].result;
    if (!collectionResult.ok) {
      throw new Error(collectionResult.error || "当前页面没有可用数据。 ");
    }
    return collectionResult.data;
  });
}

/** Get the stable product key used for de-duplication. */
function getUnifiedProductKey(data, platform) {
  var source = data || {};
  if (platform === "1688") {
    return "1688:" + String(source.offerId || source.pageUrl || "unknown");
  }
  var goods = source.goods || {};
  var page = source.page || {};
  return "temu:" + String(goods.itemId || goods.goodsId || page.goodsId || page.url || "unknown");
}

/** Return the stable cache key for one stored extension record. */
function getUnifiedCacheRecordKey(record) {
  var item = record || {};
  var platform = String(item.platform || "").toLowerCase();
  var source = item.source_data || {};
  if (platform === "1688" && (item.linked_temu_main_id || item.linked_temu_platform_id)) {
    return "binding:1688:" + String(item.linked_temu_main_id || item.linked_temu_platform_id);
  }
  var productKey = getUnifiedProductKey(source, platform);
  if (productKey && productKey.indexOf(":unknown") < 0) {
    return "product:" + productKey;
  }
  var platformId = getUnifiedRecordPlatformId(item);
  if (platformId) {
    return "platform:" + platform + ":" + platformId;
  }
  return "record:" + platform + ":" + String(item.main_id || item.mainid || "unknown");
}

/** Remove historical duplicate records while retaining the newest copy. */
function dedupeUnifiedBatch(batch) {
  var source = Array.isArray(batch) ? batch : [];
  var result = [];
  var keyIndexes = {};
  for (var index = 0; index < source.length; index += 1) {
    var item = source[index] || {};
    var key = getUnifiedCacheRecordKey(item);
    if (Object.prototype.hasOwnProperty.call(keyIndexes, key)) {
      result[keyIndexes[key]] = item;
      continue;
    }
    keyIndexes[key] = result.length;
    result.push(item);
  }
  return result;
}

/** Build the visible Temu breadcrumb category path without the home item. */
function getUnifiedTemuFrontCategory(data) {
  var source = data || {};
  var breadcrumb = Array.isArray(source.breadcrumb) ? source.breadcrumb : [];
  var names = [];
  for (var index = 0; index < breadcrumb.length; index += 1) {
    var item = breadcrumb[index] || {};
    if (item.name && String(item.name).trim() !== "首页") {
      names.push(String(item.name).trim());
    }
  }
  return names.join(" > ");
}

/** Remove a leading home breadcrumb from a category path. */
function removeUnifiedHomeCategoryPrefix(value) {
  var text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.indexOf("首页") !== 0) {
    return text;
  }
  var suffix = text.slice(2).trim();
  var first = suffix.charAt(0);
  if (first === ">" || first === "›" || first === "〉" || first === "/" || first === "＞") {
    return suffix.slice(1).trim();
  }
  return text;
}

/** Read the unified category ID list from either platform. */
function getUnifiedCategoryIds(data, platform) {
  var source = data || {};
  if (platform === "1688") {
    var offerMeta = source.offerMeta || {};
    var categoryId = offerMeta.categoryId;
    if (Array.isArray(categoryId)) {
      return categoryId;
    }
    return categoryId !== undefined && categoryId !== null && categoryId !== ""
      ? [categoryId]
      : [];
  }
  var goods = source.goods || {};
  if (Array.isArray(goods.backendCategoryIds)) {
    return goods.backendCategoryIds;
  }
  var result = [];
  var ids = [goods.catId1, goods.catId2, goods.catId3, goods.catId4];
  for (var index = 0; index < ids.length; index += 1) {
    if (ids[index] !== undefined && ids[index] !== null && ids[index] !== "") {
      result.push(ids[index]);
    }
  }
  return result;
}

/** Resolve a common product category path for either platform. */
function getUnifiedProductCategory(data, platform) {
  var source = data || {};
  if (platform === "1688") {
    var statistics = source.statistics || {};
    return removeUnifiedHomeCategoryPrefix(source.productCategory || statistics.categoryPath || statistics.category || "");
  }
  return getUnifiedTemuFrontCategory(source);
}

/** Build one unified JSON record with canonical global and platform identifiers. */
function createUnifiedRecord(data, platform, mainId, platformId, linkedTemuMainId) {
  var source = data || {};
  var goods = source.goods || {};
  var productId = platform === "1688"
    ? source.offerId || ""
    : goods.goodsId || source.page && source.page.goodsId || "";
  var productName = platform === "1688" ? source.productName : goods.goodsName;
  var record = {
    main_id: mainId,
    platform_id: platformId,
    mainid: mainId,
    platform: platform,
    product_id: productId,
    product_name: productName || "",
    product_category: getUnifiedProductCategory(source, platform),
    category_ids: getUnifiedCategoryIds(source, platform),
    source_data: source
  };
  if (platform === "1688" && linkedTemuMainId) {
    record.linked_temu_main_id = String(linkedTemuMainId);
  }
  return record;
}

/** Read the canonical global identifier from a record with legacy fallback. */
function getUnifiedRecordMainId(record) {
  var source = record || {};
  var value = Number(source.main_id);
  if (!Number.isFinite(value) || value <= 0) {
    value = Number(source.mainid);
  }
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** Read the canonical platform identifier from a record. */
function getUnifiedRecordPlatformId(record) {
  var value = Number(record && record.platform_id);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** Calculate the next global main_id in the unified batch. */
function getNextUnifiedMainid(batch) {
  var maxMainid = 0;
  var list = Array.isArray(batch) ? batch : [];
  for (var index = 0; index < list.length; index += 1) {
    var value = getUnifiedRecordMainId(list[index]);
    if (Number.isFinite(value) && value > maxMainid) {
      maxMainid = value;
    }
  }
  return maxMainid + 1;
}

/** Calculate the next platform_id for one platform in the unified batch. */
function getNextUnifiedPlatformId(batch, platform) {
  var maxPlatformId = 0;
  var samePlatformCount = 0;
  var list = Array.isArray(batch) ? batch : [];
  for (var index = 0; index < list.length; index += 1) {
    var item = list[index] || {};
    if (item.platform !== platform) {
      continue;
    }
    samePlatformCount += 1;
    var value = getUnifiedRecordPlatformId(item);
    if (value > maxPlatformId) {
      maxPlatformId = value;
    }
  }
  return maxPlatformId > 0 ? maxPlatformId + 1 : samePlatformCount + 1;
}

/** Read the unified JSON batch from the single local cache service. */
function getUnifiedBatchData() {
  return getUnifiedApiUrl("/workbench").then(function requestUnifiedWorkbench(endpoint) {
    return fetch(endpoint, { cache: "no-store" });
  }).then(function handleCacheRead(response) {
    if (!response.ok) {
      throw new Error("无法读取本地 cache，请先运行 npm run dev。 ");
    }
    return response.json();
  }).then(function handleCachePayload(payload) {
    return payload && payload.data && Array.isArray(payload.data.records) ? payload.data.records : [];
  });
}

/** Read the single Temu task currently waiting for a 1688 confirmation. */
function getUnifiedActiveWorkflow() {
  return getUnifiedApiUrl("/workflow/active").then(function requestUnifiedActiveWorkflow(endpoint) {
    return fetch(endpoint, { cache: "no-store" });
  }).then(function handleActiveWorkflowResponse(response) {
    if (!response.ok) {
      throw new Error("无法读取当前智能组货任务。");
    }
    return response.json();
  }).then(function unwrapActiveWorkflowPayload(payload) {
    if (payload && payload.ok === false) {
      var errorMessage = payload.error && payload.error.message
        ? payload.error.message
        : payload.error || "无法读取当前智能组货任务。";
      throw new Error(errorMessage);
    }
    return payload && payload.data && typeof payload.data === "object" ? payload.data : payload;
  });
}

/** Resolve a local hash image against the configured backend origin. */
function resolveUnifiedBindingPanelImageUrl(source, apiBaseUrl) {
  var imageUrl = String(source || "");
  if (imageUrl.indexOf("/api/v1/cache/image/") !== 0) {
    return imageUrl;
  }
  return new URL(imageUrl, apiBaseUrl).href;
}

/** Read the original CDN main image retained in source data or the product URL. */
function getUnifiedBindingPanelCdnImageUrl(item, source, galleryUrl) {
  var directUrl = String(source.mainImageUrl || galleryUrl || "");
  if (/^https?:\/\//i.test(directUrl)) {
    return directUrl;
  }
  var pageUrl = String(item.page_url || source.pageUrl || "");
  if (!pageUrl) {
    return "";
  }
  try {
    var topGalleryUrl = new URL(pageUrl).searchParams.get("top_gallery_url") || "";
    return /^https?:\/\//i.test(topGalleryUrl) ? topGalleryUrl : "";
  } catch (error) {
    return "";
  }
}

/** Create a compact Temu summary for the floating panel on 1688 detail pages. */
function createUnifiedBindingPanelRecord(record, apiBaseUrl) {
  var item = record || {};
  var source = item.source_data || {};
  var goods = source.goods || {};
  var gallery = Array.isArray(goods.gallery) ? goods.gallery : [];
  var firstGallery = gallery.length ? gallery[0] : "";
  var galleryUrl = typeof firstGallery === "string"
    ? firstGallery
    : firstGallery && (firstGallery.url || firstGallery.imageUrl) || "";
  var cdnImageUrl = getUnifiedBindingPanelCdnImageUrl(item, source, galleryUrl);
  var cachedImageUrl = item.main_image_url || "";
  var sourceSkus = Array.isArray(item.sku)
    ? item.sku
    : Array.isArray(source.sku) ? source.sku : [];
  var skus = [];
  for (var index = 0; index < sourceSkus.length; index += 1) {
    var sourceSku = sourceSkus[index] || {};
    skus.push({
      SubSku1: sourceSku.SubSku1 || sourceSku.subSku1 || "",
      SubSku2: sourceSku.SubSku2 || sourceSku.subSku2 || "",
      specs: Array.isArray(sourceSku.specs) ? sourceSku.specs : [],
      sku_price: sourceSku.sku_price || sourceSku.discountPrice || sourceSku.price || ""
    });
  }
  var listing = item.listing_json && typeof item.listing_json === "object"
    ? item.listing_json
    : source.listing && typeof source.listing === "object" ? source.listing : {};
  return {
    main_id: item.main_id === undefined ? item.mainid || "" : item.main_id,
    platform_id: item.platform_id || "",
    version: Number(item.version || 1),
    product_name: item.product_name || goods.goodsName || "未命名 Temu 商品",
    main_image_url: resolveUnifiedBindingPanelImageUrl(cachedImageUrl || cdnImageUrl, apiBaseUrl),
    cdn_image_url: cdnImageUrl,
    listing_json: { title: String(listing.title || item.product_name || goods.goodsName || "") },
    sku: skus
  };
}

/** Build the Temu list displayed on 1688 detail pages with the active task marker. */
async function getUnifiedBindingPanelData() {
  var batch = await getUnifiedBatchData();
  var active = await getUnifiedActiveWorkflow();
  var apiBaseUrl = await getUnifiedApiUrl("");
  var temuRecords = [];
  for (var index = 0; index < batch.length; index += 1) {
    var item = batch[index] || {};
    if (item.platform === "temu") {
      temuRecords.push(createUnifiedBindingPanelRecord(item, apiBaseUrl));
    }
  }
  return {
    records: temuRecords,
    active_temu_main_id: String(active && active.active_temu_main_id || "")
  };
}

/** Submit raw collector output so all normalization and persistence stay on the backend. */
function submitUnifiedCollection(data, platform, temuMainId, temuPlatformId) {
  return getUnifiedApiUrl("/products/collect").then(function postUnifiedCollection(endpoint) {
    return fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      platform: String(platform || ""),
      target_temu_main_id: String(temuMainId || ""),
      target_temu_platform_id: String(temuPlatformId || ""),
      source_data: data && typeof data === "object" ? data : {}
    })
    });
  }).then(function handleWorkflowBindingResponse(response) {
    if (!response.ok) {
      return response.json().catch(function handleWorkflowBindingErrorBody() {
        return {};
      }).then(function throwWorkflowBindingError(payload) {
        var errorMessage = payload && payload.error && payload.error.message
          ? payload.error.message
          : payload && payload.error || "服务器绑定 1688 商品失败。";
        throw new Error(errorMessage);
      });
    }
    return response.json();
  });
}

/** Submit one collection to Server and preserve the raw record in extension cache. */
function submitAndCacheUnifiedCollection(data, platform, temuMainId, temuPlatformId) {
  return submitUnifiedCollection(data, platform, temuMainId, temuPlatformId).then(function cacheUnifiedCollectionResult(result) {
    var normalizedData = result && result.data && result.data.source_data && typeof result.data.source_data === "object"
      ? result.data.source_data
      : data;
    return addUnifiedDataToBatch(normalizedData, platform, temuMainId).then(function finishExtensionCacheWrite() {
      return result;
    });
  });
}

/** Replace every SKU in one selected Temu record with the current 1688 capture. */
function submitUnifiedSkuReplacement(data, temuMainId, temuPlatformId, temuVersion) {
  return getUnifiedApiUrl("/replaceSku").then(function postUnifiedSkuReplacement(endpoint) {
    var version = Number(temuVersion);
    if (!Number.isInteger(version) || version <= 0) {
      throw new Error("Temu 商品版本缺失，请刷新 1688 页面后重试。");
    }
    var requestBody = {
      target_temu_main_id: String(temuMainId || ""),
      target_temu_platform_id: String(temuPlatformId || ""),
      target_temu_version: version,
      source_data: data && typeof data === "object" ? data : {},
      replace_all_skus: true
    };
    return fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody)
    });
  }).then(function handleUnifiedSkuReplacementResponse(response) {
    return response.json().catch(function handleUnifiedSkuReplacementBodyError() {
      return {};
    }).then(function validateUnifiedSkuReplacementPayload(payload) {
      if (!response.ok || !payload || !payload.ok) {
        var errorMessage = payload && payload.error
          ? payload.error.message || payload.error
          : "服务器替换 Temu SKU 失败。";
        throw new Error(errorMessage);
      }
      return payload;
    });
  });
}

/** Read the independent extension cache records from chrome.storage.local. */
function getExtensionCacheBatch() {
  return new Promise(function readExtensionCache(resolve, reject) {
    chrome.storage.local.get([extensionCacheStorageKey], function handleExtensionCacheRead(payload) {
      var lastError = chrome.runtime.lastError;
      if (lastError) {
        reject(new Error(lastError.message));
        return;
      }
      var cache = payload && payload[extensionCacheStorageKey];
      resolve(cache && Array.isArray(cache.records) ? cache.records : []);
    });
  });
}

/** Write the independent extension cache records to chrome.storage.local. */
function saveExtensionCacheBatch(batch) {
  var payload = {};
  payload[extensionCacheStorageKey] = {
    version: 1,
    updated_at: new Date().toISOString(),
    records: Array.isArray(batch) ? batch : []
  };
  return new Promise(function writeExtensionCache(resolve, reject) {
    chrome.storage.local.set(payload, function handleExtensionCacheWrite() {
      var lastError = chrome.runtime.lastError;
      if (lastError) {
        reject(new Error(lastError.message));
        return;
      }
      resolve();
    });
  });
}

/** Add or replace one platform product while preserving both identifiers. */
async function addUnifiedDataToBatch(data, platform, linkedTemuMainId) {
  var batch = dedupeUnifiedBatch(await getExtensionCacheBatch());
  var productKey = getUnifiedProductKey(data, platform);
  var mainId = getNextUnifiedMainid(batch);
  var platformId = getNextUnifiedPlatformId(batch, platform);
  var replaced = false;
  for (var index = 0; index < batch.length; index += 1) {
    var item = batch[index] || {};
    var matchesLinkedTemu = platform === "1688"
      && linkedTemuMainId
      && item.platform === "1688"
      && String(item.linked_temu_main_id || "") === String(linkedTemuMainId);
    var matchesUnboundProduct = !linkedTemuMainId
      && getUnifiedProductKey(item.source_data, item.platform) === productKey;
    if (matchesLinkedTemu || matchesUnboundProduct) {
      mainId = getUnifiedRecordMainId(item) || mainId;
      platformId = getUnifiedRecordPlatformId(item) || platformId;
      batch[index] = createUnifiedRecord(data, platform, mainId, platformId, linkedTemuMainId);
      replaced = true;
      break;
    }
  }
  if (!replaced) {
    batch.push(createUnifiedRecord(data, platform, mainId, platformId, linkedTemuMainId));
  }
  batch = dedupeUnifiedBatch(batch);
  await saveExtensionCacheBatch(batch);
  return {
    ok: true,
    main_id: mainId,
    platform_id: platformId,
    mainid: mainId,
    batchCount: batch.length,
    replaced: replaced
  };
}
