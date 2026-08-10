importScripts("collector-temu.js", "collector-1688.js");

var unifiedCacheEndpoint = "http://127.0.0.1:5173/api/cache";

/** Handle collection requests from either platform page. */
chrome.runtime.onMessage.addListener(function handleUnifiedCollectionMessage(message, sender, sendResponse) {
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
  collectUnifiedFromTab(tabId, platform).then(function handleUnifiedCollection(data) {
    return addUnifiedDataToBatch(data, platform);
  }).then(function handleUnifiedCollectionResult(result) {
    sendResponse(result);
  }).catch(function handleUnifiedCollectionError(error) {
    sendResponse({ ok: false, error: error.message || "采集失败。" });
  });
  return true;
});

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
function createUnifiedRecord(data, platform, mainId, platformId) {
  var source = data || {};
  var goods = source.goods || {};
  var productId = platform === "1688"
    ? source.offerId || ""
    : goods.goodsId || source.page && source.page.goodsId || "";
  var productName = platform === "1688" ? source.productName : goods.goodsName;
  return {
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
  return fetch(unifiedCacheEndpoint, { cache: "no-store" }).then(function handleCacheRead(response) {
    if (!response.ok) {
      throw new Error("无法读取本地 cache，请先运行 npm run dev。 ");
    }
    return response.json();
  }).then(function handleCachePayload(payload) {
    return payload && Array.isArray(payload.records) ? payload.records : [];
  });
}

/** Write the complete unified JSON batch to the single local cache service. */
function saveUnifiedBatchData(batch) {
  return fetch(unifiedCacheEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ records: Array.isArray(batch) ? batch : [] })
  }).then(function handleCacheResponse(response) {
    if (!response.ok) {
      throw new Error("写入本地 cache 失败，请确认 npm run dev 正在运行。 ");
    }
    return response.json();
  });
}

/** Add or replace one platform product while preserving both identifiers. */
async function addUnifiedDataToBatch(data, platform) {
  var batch = await getUnifiedBatchData();
  var productKey = getUnifiedProductKey(data, platform);
  var mainId = getNextUnifiedMainid(batch);
  var platformId = getNextUnifiedPlatformId(batch, platform);
  var replaced = false;
  for (var index = 0; index < batch.length; index += 1) {
    var item = batch[index] || {};
    if (getUnifiedProductKey(item.source_data, item.platform) === productKey) {
      mainId = getUnifiedRecordMainId(item) || mainId;
      platformId = getUnifiedRecordPlatformId(item) || platformId;
      batch[index] = createUnifiedRecord(data, platform, mainId, platformId);
      replaced = true;
      break;
    }
  }
  if (!replaced) {
    batch.push(createUnifiedRecord(data, platform, mainId, platformId));
  }
  await saveUnifiedBatchData(batch);
  return {
    ok: true,
    main_id: mainId,
    platform_id: platformId,
    mainid: mainId,
    batchCount: batch.length,
    replaced: replaced
  };
}
