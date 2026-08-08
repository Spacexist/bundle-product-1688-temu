var collectButton = document.getElementById("collectButton");
var jsonExportButton = document.getElementById("jsonExportButton");
var batchExportButton = document.getElementById("batchExportButton");
var clearBatchButton = document.getElementById("clearBatchButton");
var batchCountElement = document.getElementById("batchCount");
var statusElement = document.getElementById("status");
var batchStorageKey = "unifiedBatchRecords";

document.addEventListener("DOMContentLoaded", initializePopup);

/** 初始化扩展弹窗。 */
function initializePopup() {
  collectButton.addEventListener("click", handleCollectClick);
  jsonExportButton.addEventListener("click", handleJsonExportClick);
  batchExportButton.addEventListener("click", handleBatchExportClick);
  clearBatchButton.addEventListener("click", handleClearBatchClick);
  refreshBatchCount();
}

/** 处理“采集并加入批次”按钮。 */
async function handleCollectClick() {
  collectButton.disabled = true;
  setStatus("正在读取当前商品页…", "");

  try {
    var response = await collectUnifiedCurrentPage();
    if (!response || !response.ok) {
      throw new Error(response && response.error ? response.error : "采集失败。");
    }
    await refreshBatchCount();
    setStatus("已加入批次，可继续切换商品页采集。", "success");
  } catch (error) {
    setStatus(error.message || "采集失败。", "error");
  } finally {
    collectButton.disabled = false;
  }
}

/** Collect the active Temu or 1688 tab through the unified background worker. */
async function collectUnifiedCurrentPage() {
  var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabs.length || !tabs[0].id) {
    throw new Error("没有找到当前标签页。");
  }
  var tab = tabs[0];
  var url = String(tab.url || "").toLowerCase();
  var platform = url.indexOf("detail.1688.com/offer/") >= 0 ? "1688" : "temu";
  return new Promise(function resolveUnifiedCollect(resolve, reject) {
    chrome.runtime.sendMessage({
      type: "collectUnifiedProduct",
      tabId: tab.id,
      platform: platform
    }, function handleUnifiedCollectResponse(response) {
      var lastError = chrome.runtime.lastError;
      if (lastError) {
        reject(new Error(lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

/** 读取当前活动标签页的 Temu 商品数据。 */
async function collectCurrentPageData() {
  var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabs.length || !tabs[0].id) {
    throw new Error("没有找到当前标签页。");
  }

  var executionResults = await chrome.scripting.executeScript({
    target: { tabId: tabs[0].id },
    world: "MAIN",
    func: collectTemuDataFromPage
  });
  if (!executionResults.length || !executionResults[0].result) {
    throw new Error("没有读取到页面数据。");
  }

  var collectionResult = executionResults[0].result;
  if (!collectionResult.ok) {
    throw new Error(collectionResult.error || "当前页面不是可采集的 Temu 商品页。");
  }
  return collectionResult.data;
}

/** 获取批次商品的去重键。 */
function getBatchProductKey(data) {
  var goods = data && data.goods ? data.goods : {};
  var page = data && data.page ? data.page : {};
  if (goods.itemId) {
    return "item:" + goods.itemId;
  }
  if (page.goodsId) {
    return "goods:" + page.goodsId;
  }
  return "page:" + (page.url || "unknown");
}

/** 把商品加入批次；同一商品再次采集时覆盖旧数据。 */
async function addDataToBatch(data) {
  var batch = await getBatchData();
  var productKey = getBatchProductKey(data);
  var nextMainId = getNextMainId(batch);
  var replaced = false;
  for (var index = 0; index < batch.length; index += 1) {
    if (getBatchProductKey(batch[index]) === productKey) {
      batch[index] = createStagedData(data, batch[index].mainid || nextMainId);
      replaced = true;
      break;
    }
  }
  if (!replaced) {
    batch.push(createStagedData(data, nextMainId));
  }
  await saveBatchData(batch);
  return batch;
}

/** 创建带有全局和平台编号的 JSON 暂存记录。 */
function createStagedData(data, mainId, platformId) {
  var record = {
    main_id: mainId,
    platform_id: platformId,
    mainid: mainId
  };
  var source = data || {};
  var keys = Object.keys(source);
  for (var index = 0; index < keys.length; index += 1) {
    var key = keys[index];
    if (key === "mainid" || key === "main_id" || key === "platform_id" || key === "temu_front_category") {
      continue;
    }
    if (key === "temu_backend_category_ids") {
      if (!Object.prototype.hasOwnProperty.call(source, "category_ids")) {
        record.category_ids = source[key];
      }
      continue;
    }
    if (key === "product_category") {
      record[key] = removeUnifiedHomeCategoryPrefix(source[key]);
      continue;
    }
    record[key] = source[key];
  }
  return record;
}

/** 计算当前 JSON 批次中的下一个全局 main_id。 */
function getNextMainId(batch) {
  var maxMainId = 0;
  var list = Array.isArray(batch) ? batch : [];
  for (var index = 0; index < list.length; index += 1) {
    var item = list[index] || {};
    var value = Number(item.main_id || item.mainid);
    if (Number.isFinite(value) && value > maxMainId) {
      maxMainId = value;
    }
  }
  return maxMainId + 1;
}

/** 读取记录中的平台编号，兼容没有编号的旧缓存。 */
function getStoredPlatformId(record) {
  var value = Number(record && record.platform_id);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** 计算某个平台的下一个 platform_id。 */
function getNextPlatformId(batch, platform) {
  var maxPlatformId = 0;
  var samePlatformCount = 0;
  var list = Array.isArray(batch) ? batch : [];
  for (var index = 0; index < list.length; index += 1) {
    var item = list[index] || {};
    if (item.platform !== platform) {
      continue;
    }
    samePlatformCount += 1;
    var value = getStoredPlatformId(item);
    if (value > maxPlatformId) {
      maxPlatformId = value;
    }
  }
  return maxPlatformId > 0 ? maxPlatformId + 1 : samePlatformCount + 1;
}

/** Remove the home breadcrumb from an exported category path. */
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

/** 从 chrome.storage.local 读取 JSON 批次。 */
function getBatchData() {
  return new Promise(function (resolve, reject) {
    var defaults = {};
    defaults[batchStorageKey] = [];
    chrome.storage.local.get(defaults, function (items) {
      var lastError = chrome.runtime && chrome.runtime.lastError;
      if (lastError) {
        reject(new Error(lastError.message));
        return;
      }
      var rawBatch = items && Array.isArray(items[batchStorageKey]) ? items[batchStorageKey] : [];
      var batch = [];
      var nextMainId = getNextMainId(rawBatch);
      var nextPlatformIds = {};
      var changed = false;
      for (var index = 0; index < rawBatch.length; index += 1) {
        var rawRecord = rawBatch[index] || {};
        var mainId = Number(rawRecord.main_id || rawRecord.mainid);
        if (!Number.isFinite(mainId) || mainId <= 0) {
          mainId = nextMainId;
          nextMainId += 1;
          changed = true;
        }
        var platform = rawRecord.platform || "";
        if (!Object.prototype.hasOwnProperty.call(nextPlatformIds, platform)) {
          nextPlatformIds[platform] = getNextPlatformId(rawBatch, platform);
        }
        var platformId = getStoredPlatformId(rawRecord);
        if (!platformId) {
          platformId = nextPlatformIds[platform];
          nextPlatformIds[platform] += 1;
          changed = true;
        } else if (platformId >= nextPlatformIds[platform]) {
          nextPlatformIds[platform] = platformId + 1;
        }
        if (Object.keys(rawRecord)[0] !== "main_id"
          || rawRecord.mainid !== mainId
          || rawRecord.platform_id !== platformId
          || Object.prototype.hasOwnProperty.call(rawRecord, "temu_front_category")
          || Object.prototype.hasOwnProperty.call(rawRecord, "temu_backend_category_ids")) {
          changed = true;
        }
        batch.push(createStagedData(rawRecord, mainId, platformId));
      }
      if (changed) {
        saveBatchData(batch).then(function () {
          resolve(batch);
        }).catch(reject);
        return;
      }
      resolve(batch);
    });
  });
}

/** 把 JSON 批次写入 chrome.storage.local。 */
function saveBatchData(batch) {
  return new Promise(function (resolve, reject) {
    var values = {};
    values[batchStorageKey] = batch;
    chrome.storage.local.set(values, function () {
      var lastError = chrome.runtime && chrome.runtime.lastError;
      if (lastError) {
        reject(new Error(lastError.message));
        return;
      }
      resolve();
    });
  });
}

/** 清空当前 JSON 批次。 */
function clearBatchData() {
  return new Promise(function (resolve, reject) {
    chrome.storage.local.remove(batchStorageKey, function () {
      var lastError = chrome.runtime && chrome.runtime.lastError;
      if (lastError) {
        reject(new Error(lastError.message));
        return;
      }
      resolve();
    });
  });
}

/** 刷新弹窗中的批次商品数量。 */
async function refreshBatchCount() {
  try {
    var batch = await getBatchData();
    batchCountElement.textContent = String(batch.length);
  } catch (error) {
    setStatus("读取批次失败：" + (error.message || "未知错误"), "error");
  }
}

/** 处理“导出当前批次”按钮。 */
async function handleBatchExportClick() {
  batchExportButton.disabled = true;
  setStatus("正在读取批次并生成 Excel…", "");
  try {
    var batch = await getBatchData();
    if (!batch.length) {
      throw new Error("当前批次为空，请先采集商品。");
    }
    var workbookBytes = createXlsxWorkbook(batch);
    var fileName = createBatchFileName(batch);
    startDownload(workbookBytes, fileName, function (errorMessage) {
      handleBatchDownloadFinished(errorMessage);
    });
  } catch (error) {
    batchExportButton.disabled = false;
    setStatus(error.message || "批量导出失败。", "error");
  }
}

/** Export the unified batch as a readable JSON file. */
async function handleJsonExportClick() {
  jsonExportButton.disabled = true;
  setStatus("正在生成统一 JSON…", "");
  try {
    var batch = await getBatchData();
    if (!batch.length) {
      throw new Error("当前批次为空，请先采集商品。");
    }
    var jsonText = JSON.stringify(buildUnifiedJsonExportBatch(batch), null, 2);
    var fileName = createJsonFileName(batch);
    startJsonDownload(jsonText, fileName, function handleJsonDownload(errorMessage) {
      if (errorMessage) {
        setStatus("JSON 下载失败：" + errorMessage, "error");
        return;
      }
      setStatus("统一 JSON 已下载。", "success");
    });
  } catch (error) {
    setStatus(error.message || "JSON 导出失败。", "error");
  } finally {
    jsonExportButton.disabled = false;
  }
}

/** 处理“清空批次”按钮。 */
async function handleClearBatchClick() {
  clearBatchButton.disabled = true;
  try {
    await clearBatchData();
    batchCountElement.textContent = "0";
    setStatus("批次已清空。", "success");
  } catch (error) {
    setStatus(error.message || "清空批次失败。", "error");
  } finally {
    clearBatchButton.disabled = false;
  }
}

/** 更新弹窗状态文字。 */
function setStatus(message, statusType) {
  statusElement.textContent = message;
  statusElement.className = "status";
  if (statusType) {
    statusElement.classList.add(statusType);
  }
}

/** 从当前页面读取 Temu 商品数据。此函数会被注入页面主世界执行。 */
function collectTemuDataFromPage() {
  /** 读取页面中序列化的 rawData。 */
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

  /** 读取查询参数中的最后一个值。 */
  function getQueryValue(query, key) {
    var value = query ? query[key] : undefined;
    if (Array.isArray(value)) {
      return value.length ? value[value.length - 1] : undefined;
    }
    return value;
  }

  /** 复制商品图片列表，避免把页面对象直接暴露到扩展上下文。 */
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

  /** 复制商品详情图，兼容商品对象和 productDetail 两种数据位置。 */
  function copyDetailList(goods, productDetail) {
    var directList = copyGalleryList(goods ? goods.detailList : []);
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
    return result;
  }

  /** 复制 SKU 列表。 */
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

  /** 复制评论列表。 */
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

  /** 复制商品页顶部的面包屑导航。 */
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

  /** 从不同版本的页面状态中读取评论评分。 */
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

  /** 生成主商品详情接口的请求参数记录。 */
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

  /** 把 Temu 页面状态转换成扩展导出的标准结构。 */
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

  /** 执行页面数据读取并返回可序列化的结果。 */
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

/** 生成批量下载文件名。 */
function createBatchFileName(batch) {
  var count = Array.isArray(batch) ? batch.length : 0;
  var timeText = new Date().toISOString().replace(/[:.]/g, "-");
  return "temu_1688_unified_" + count + "_" + timeText + ".xlsx";
}

/** Create a timestamped unified JSON download name. */
function createJsonFileName(batch) {
  var count = Array.isArray(batch) ? batch.length : 0;
  var timeText = new Date().toISOString().replace(/[:.]/g, "-");
  return "temu_1688_unified_" + count + "_" + timeText + ".json";
}

/** 创建 Excel 下载任务。 */
function startDownload(workbookBytes, fileName, callback) {
  var blob = new Blob([workbookBytes], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  });
  var objectUrl = URL.createObjectURL(blob);

  /** 处理 Chrome 下载 API 的回调。 */
  function handleDownloadCallback(downloadId) {
    var lastError = chrome.runtime.lastError;
    if (lastError) {
      URL.revokeObjectURL(objectUrl);
      callback(lastError.message, null);
      return;
    }

    setTimeout(revokeDownloadUrl, 60000, objectUrl);
    callback(null, downloadId);
  }

  chrome.downloads.download({
    url: objectUrl,
    filename: fileName,
    saveAs: true
  }, handleDownloadCallback);
}

/** Start a JSON download through the Chrome downloads API. */
function startJsonDownload(jsonText, fileName, callback) {
  var blob = new Blob([jsonText], { type: "application/json;charset=utf-8" });
  var objectUrl = URL.createObjectURL(blob);
  chrome.downloads.download({ url: objectUrl, filename: fileName, saveAs: true }, function handleJsonDownload(downloadId) {
    var lastError = chrome.runtime.lastError;
    window.setTimeout(revokeDownloadUrl, 60000, objectUrl);
    callback(lastError ? lastError.message : null, downloadId);
  });
}

/** 延迟释放下载对象 URL。 */
function revokeDownloadUrl(objectUrl) {
  URL.revokeObjectURL(objectUrl);
}

/** 处理批量下载结果，成功后清空 JSON 暂存批次。 */
async function handleBatchDownloadFinished(errorMessage) {
  batchExportButton.disabled = false;
  if (errorMessage) {
    setStatus("下载失败：" + errorMessage, "error");
    return;
  }

  try {
    await clearBatchData();
    batchCountElement.textContent = "0";
    setStatus("批次已下载，JSON 暂存已清空。", "success");
  } catch (error) {
    setStatus("文件已开始下载，但清空暂存失败：" + (error.message || "未知错误"), "error");
  }
}

/** 把值转换成工作表单元格文字。 */
function valueToText(value) {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}

/** 把 SKU 规格数组转换成单元格文字。 */
function specsToText(specs) {
  if (!Array.isArray(specs)) {
    return "";
  }
  var values = [];
  for (var index = 0; index < specs.length; index += 1) {
    var spec = specs[index] || {};
    values.push((spec.specKey || spec.spec_key || "") + ": " + (spec.specValue || spec.spec_value || ""));
  }
  return values.join("；");
}

/** 汇总批次中所有 SKU 规格维度名称。 */
function getSubSkuFieldNames(batch) {
  var names = [];
  var list = Array.isArray(batch) ? batch : [];
  for (var dataIndex = 0; dataIndex < list.length; dataIndex += 1) {
    var data = list[dataIndex] || {};
    var skuList = Array.isArray(data.sku) ? data.sku : [];
    for (var skuIndex = 0; skuIndex < skuList.length; skuIndex += 1) {
      var specs = Array.isArray(skuList[skuIndex].specs) ? skuList[skuIndex].specs : [];
      for (var specIndex = 0; specIndex < specs.length; specIndex += 1) {
        if (names.length >= 2) {
          return names;
        }
        var spec = specs[specIndex] || {};
        var fieldName = spec.specKey || spec.spec_key || "";
        if (!fieldName || names.indexOf(fieldName) >= 0) {
          continue;
        }
        names.push(fieldName);
      }
    }
  }
  return names;
}

/** 按规格维度名称提取 SKU 组合中的实际值。 */
function specsToSubSkuValues(specs, fieldNames) {
  var names = Array.isArray(fieldNames) ? fieldNames : [];
  var values = [];
  for (var nameIndex = 0; nameIndex < names.length; nameIndex += 1) {
    values.push("");
  }
  if (!Array.isArray(specs)) {
    return values;
  }

  for (var index = 0; index < specs.length; index += 1) {
    var spec = specs[index] || {};
    var fieldName = spec.specKey || spec.spec_key || "";
    var value = spec.specValue !== undefined ? spec.specValue : spec.spec_value;
    for (var fieldIndex = 0; fieldIndex < names.length; fieldIndex += 1) {
      if (names[fieldIndex] === fieldName) {
        values[fieldIndex] = value === undefined || value === null ? "" : value;
        break;
      }
    }
  }
  return values;
}

/** 创建商品信息工作表行。 */
function buildGoodsRows(data) {
  var goods = data.goods || {};
  var rows = [["字段", "值"]];
  rows.push(["商品 ID", goods.goodsId]);
  rows.push(["商品名称", goods.goodsName]);
  rows.push(["销售状态", goods.status]);
  rows.push(["最低售价", goods.minOnSalePriceStr]);
  rows.push(["最高售价", goods.maxOnSalePrice]);
  rows.push(["已售数量", goods.soldQuantity]);
  rows.push(["店铺 ID", goods.mallId]);
  rows.push(["分类 ID", goods.categoryIds]);
  rows.push(["店铺销售信息", goods.saleInfo]);
  rows.push(["商品属性", goods.goodsProperty]);
  rows.push(["面包屑路径", breadcrumbToText(data.breadcrumb)]);
  rows.push(["采集来源", data.source]);
  rows.push(["页面地址", data.page ? data.page.url : ""]);
  rows.push(["主接口", data.api ? data.api.url : ""]);
  rows.push(["主接口请求参数", data.api ? data.api.params : ""]);
  rows.push(["采集时间", data.collectedAt]);
  return rows;
}

/** 把面包屑对象数组转换成可读路径。 */
function breadcrumbToText(breadcrumb) {
  if (!Array.isArray(breadcrumb)) {
    return "";
  }
  var names = [];
  for (var index = 0; index < breadcrumb.length; index += 1) {
    var item = breadcrumb[index] || {};
    if (item.name) {
      names.push(item.name);
    }
  }
  return names.join(" > ");
}

/** 把图片列表中的同名字段按换行拼接。 */
function imageFieldToText(imageList, fieldName) {
  var values = [];
  if (!Array.isArray(imageList)) {
    return "";
  }

  for (var index = 0; index < imageList.length; index += 1) {
    var item = imageList[index] || {};
    if (item[fieldName] !== undefined && item[fieldName] !== null && item[fieldName] !== "") {
      values.push(valueToText(item[fieldName]));
    }
  }
  return values.join("\n");
}

/** 合并主图和详情图的字段，保留原图片工作表中的全部信息。 */
function mergedImageFieldToText(gallery, detailList, fieldName) {
  var galleryText = imageFieldToText(gallery, fieldName);
  var detailText = imageFieldToText(detailList, fieldName);
  if (!galleryText) {
    return detailText;
  }
  if (!detailText) {
    return galleryText;
  }
  return galleryText + "\n" + detailText;
}

/** 创建合并商品、SKU、店铺和图片字段的第一张工作表。 */
function buildCollectionRows(data, subSkuFieldNames) {
  var fieldNames = Array.isArray(subSkuFieldNames)
    ? subSkuFieldNames
    : getSubSkuFieldNames([data]);
  var header = [
    "mainid", "商品 ID", "产品名称", "已售数量", "分类 ID", "面包屑路径", "SKU ID"
  ];
  for (var fieldIndex = 0; fieldIndex < fieldNames.length; fieldIndex += 1) {
    header.push("Subsku_" + fieldNames[fieldIndex]);
  }
  header.push(
    "SKU价格", "SKU原价", "SKU库存", "SKU限购", "SKU在售", "SKU图片", "主图URL", "轮播图URL",
    "详情图URL", "图片视频URL", "图片 ID", "店铺 ID", "店铺名称", "店铺Logo", "店铺评分",
    "店铺评分文本", "店铺评论数", "店铺主页", "配送信息(JSON)", "商品属性(JSON)", "页面地址", "采集时间"
  );
  var rows = [header];
  var goods = data.goods || {};
  var mall = data.mall || {};
  var skuList = Array.isArray(data.sku) ? data.sku : [];
  var gallery = Array.isArray(goods.gallery) ? goods.gallery : [];
  var detailList = Array.isArray(goods.detailList) ? goods.detailList : [];
  var breadcrumbText = breadcrumbToText(data.breadcrumb);
  var mainImageUrl = gallery.length ? gallery[0].url : "";
  var carouselUrls = imageFieldToText(gallery, "url");
  var detailUrls = imageFieldToText(detailList, "url");
  var imageVideoUrls = mergedImageFieldToText(gallery, detailList, "videoUrl");
  var allImageIds = mergedImageFieldToText(gallery, detailList, "id");
  var goodsPropertyJson = valueToText(goods.goodsProperty);
  var deliveryJson = valueToText(data.delivery);
  var page = data.page || {};

  var rowCount = skuList.length ? skuList.length : 1;
  for (var skuIndex = 0; skuIndex < rowCount; skuIndex += 1) {
    var sku = skuList.length ? (skuList[skuIndex] || {}) : {};
    var skuPrice = sku.salePrice !== undefined ? sku.salePrice : sku.normalPriceStr;
    var subSkuValues = specsToSubSkuValues(sku.specs, fieldNames);
    var row = [
      data.mainid || "",
      goods.goodsId,
      goods.goodsName,
      goods.soldQuantity,
      goods.categoryIds,
      breadcrumbText,
      sku.skuId
    ];
    for (var subSkuIndex = 0; subSkuIndex < subSkuValues.length; subSkuIndex += 1) {
      row.push(subSkuValues[subSkuIndex]);
    }
    row.push(
      skuPrice,
      sku.normalPriceStr,
      sku.stockQuantity,
      sku.limitQuantity,
      sku.isOnsale,
      sku.thumbUrl,
      mainImageUrl,
      carouselUrls,
      detailUrls,
      imageVideoUrls,
      allImageIds,
      goods.mallId,
      mall.mallName,
      mall.mallLogo,
      mall.mallStar,
      mall.mallStarStr,
      mall.reviewNumStr,
      mall.seoUrl,
      deliveryJson,
      goodsPropertyJson,
      page.url,
      data.collectedAt
    );
    rows.push(row);
  }
  return rows;
}

/** 创建 SKU 工作表行。 */
function buildSkuRows(data) {
  var rows = [["SKU ID", "商品 ID", "规格", "原价", "售价", "库存", "限购", "在售", "图片"]];
  var skuList = Array.isArray(data.sku) ? data.sku : [];
  for (var index = 0; index < skuList.length; index += 1) {
    var item = skuList[index] || {};
    rows.push([
      item.skuId,
      item.goodsId,
      specsToText(item.specs),
      item.normalPriceStr,
      item.salePrice,
      item.stockQuantity,
      item.limitQuantity,
      item.isOnsale,
      item.thumbUrl
    ]);
  }
  return rows;
}

/** 创建店铺工作表行。 */
function buildMallRows(data) {
  var rows = [["字段", "值"]];
  var mall = data.mall || {};
  var keys = Object.keys(mall);
  for (var index = 0; index < keys.length; index += 1) {
    var key = keys[index];
    rows.push([key, mall[key]]);
  }
  return rows;
}

/** 创建评论工作表行，并用商品 ID 关联第一张工作表。 */
function buildReviewRows(data) {
  var rows = [["mainid", "商品 ID", "商品名称", "SKU ID", "评论 ID", "用户", "评分", "评论内容", "时间", "规格"]];
  var goods = data.goods || {};
  var reviewList = data.review && Array.isArray(data.review.reviewInfoList)
    ? data.review.reviewInfoList
    : [];
  for (var index = 0; index < reviewList.length; index += 1) {
    var item = reviewList[index] || {};
    rows.push([
      data.mainid || "",
      item.goodsId || goods.goodsId,
      goods.goodsName,
      item.skuId,
      item.reviewId,
      item.name,
      item.score,
      item.comment,
      item.concatTimeLang || item.time,
      specsToText(item.specs)
    ]);
  }
  return rows;
}

/** 创建图片工作表行。 */
function buildImageRows(data) {
  var rows = [["类型", "图片 ID", "图片地址", "视频地址", "宽度", "高度", "序号"]];
  var gallery = data.goods && Array.isArray(data.goods.gallery) ? data.goods.gallery : [];
  var detailList = data.goods && Array.isArray(data.goods.detailList) ? data.goods.detailList : [];

  for (var galleryIndex = 0; galleryIndex < gallery.length; galleryIndex += 1) {
    var galleryItem = gallery[galleryIndex] || {};
    rows.push(["主图", galleryItem.id, galleryItem.url, galleryItem.videoUrl, galleryItem.width, galleryItem.height, galleryIndex]);
  }
  for (var detailIndex = 0; detailIndex < detailList.length; detailIndex += 1) {
    var detailItem = detailList[detailIndex] || {};
    rows.push(["详情图", detailItem.id, detailItem.url, detailItem.videoUrl, detailItem.width, detailItem.height, detailItem.index || detailIndex]);
  }
  return rows;
}

/** 合并多个商品的第一张工作表行。 */
function buildBatchCollectionRows(batch) {
  var list = Array.isArray(batch) ? batch : [];
  if (!list.length) {
    return buildCollectionRows({}, []);
  }

  var fieldNames = getSubSkuFieldNames(list);
  var firstRows = buildCollectionRows(list[0], fieldNames);
  var rows = [firstRows[0]];
  for (var index = 0; index < list.length; index += 1) {
    var itemRows = buildCollectionRows(list[index], fieldNames);
    for (var rowIndex = 1; rowIndex < itemRows.length; rowIndex += 1) {
      rows.push(itemRows[rowIndex]);
    }
  }
  return rows;
}

/** 合并多个商品的评论工作表行。 */
function buildBatchReviewRows(batch) {
  var list = Array.isArray(batch) ? batch : [];
  if (!list.length) {
    return buildReviewRows({});
  }

  var firstRows = buildReviewRows(list[0]);
  var rows = [firstRows[0]];
  for (var index = 0; index < list.length; index += 1) {
    var itemRows = buildReviewRows(list[index]);
    for (var rowIndex = 1; rowIndex < itemRows.length; rowIndex += 1) {
      rows.push(itemRows[rowIndex]);
    }
  }
  return rows;
}

/** Return the normalized source payload from a unified record. */
function getUnifiedSourceData(record) {
  return record && record.source_data ? record.source_data : {};
}

/** Resolve the common product category text shown in the SKU worksheet. */
function getUnifiedProductCategoryText(record, source, platform) {
  if (record && record.product_category) {
    return removeUnifiedHomeCategoryPrefix(record.product_category);
  }
  if (platform === "1688") {
    var statistics = source.statistics || {};
    return removeUnifiedHomeCategoryPrefix(source.productCategory || statistics.categoryPath || statistics.category || "");
  }
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

/** Resolve the unified category ID list for the SKU worksheet. */
function getUnifiedCategoryIdsText(record, source, platform) {
  if (record && Array.isArray(record.category_ids)) {
    return record.category_ids;
  }
  if (record && record.category_ids !== undefined && record.category_ids !== null && record.category_ids !== "") {
    return [record.category_ids];
  }
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
  if (record && Array.isArray(record.temu_backend_category_ids)) {
    return record.temu_backend_category_ids;
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

/** Normalize an ISO collection time for JSON and Excel output. */
function formatUnifiedCollectedAt(value) {
  var text = String(value || "").trim();
  if (!text) {
    return "";
  }
  return text.replace("T", " ").replace(/Z$/, "");
}

/** Convert a newline-separated image field into a JSON URL array. */
function getUnifiedImageUrlArray(value) {
  var text = String(value || "").trim();
  var result = [];
  if (!text) {
    return result;
  }
  var values = text.split("\n");
  for (var index = 0; index < values.length; index += 1) {
    var url = values[index].trim();
    if (url) {
      result.push(url);
    }
  }
  return result;
}

/** Format one unified SKU dimension as property name and parameter value. */
function formatUnifiedSubSkuValue(propertyName, propertyValue) {
  var name = String(propertyName || "").trim();
  var value = String(propertyValue || "").trim();
  if (!value) {
    return "";
  }
  if (value.indexOf(":") >= 0 || value.indexOf("：") >= 0) {
    return value;
  }
  return name ? name + ":" + value : value;
}

/** Convert a platform SKU into the two shared SubSku columns. */
function getUnifiedSubSkuValues(item, platform, propertyNames) {
  var values = ["", ""];
  if (platform === "1688") {
    var names = Array.isArray(propertyNames) ? propertyNames : [];
    values[0] = formatUnifiedSubSkuValue(names[0], item.subSku1);
    values[1] = formatUnifiedSubSkuValue(names[1], item.subSku2);
    return values;
  }
  var specs = Array.isArray(item.specs) ? item.specs : [];
  var valueIndex = 0;
  for (var index = 0; index < specs.length && valueIndex < 2; index += 1) {
    var spec = specs[index] || {};
    var specName = spec.specKey !== undefined
      ? spec.specKey
      : spec.spec_key || "";
    var specValue = spec.specValue !== undefined
      ? spec.specValue
      : spec.spec_value || "";
    values[valueIndex] = formatUnifiedSubSkuValue(specName, specValue);
    valueIndex += 1;
  }
  return values;
}

/** Append one non-empty 1688 SKU property name without duplicates. */
function appendUnifiedSkuPropertyName(list, value) {
  var name = String(value || "").replace(/\s+/g, " ").trim();
  if (name && list.length < 2 && list.indexOf(name) < 0) {
    list.push(name);
  }
}

/** Read 1688 SKU property names from cached in-memory source data. */
function getUnified1688PropertyNames(source) {
  var result = [];
  var rawModel = source && source.rawJson && source.rawJson.skuSelectorBizModel
    ? source.rawJson.skuSelectorBizModel
    : {};
  var rawSkuProps = Array.isArray(rawModel.skuProps) ? rawModel.skuProps : [];
  for (var propIndex = 0; propIndex < rawSkuProps.length && result.length < 2; propIndex += 1) {
    appendUnifiedSkuPropertyName(result, rawSkuProps[propIndex] && rawSkuProps[propIndex].prop);
  }
  if (result.length >= 2) {
    return result;
  }
  var storedNames = Array.isArray(source && source.skuPropNames)
    ? source.skuPropNames
    : String(source && source.skuPropName || "").split(/[;；]/);
  for (var nameIndex = 0; nameIndex < storedNames.length && result.length < 2; nameIndex += 1) {
    appendUnifiedSkuPropertyName(result, storedNames[nameIndex]);
  }
  if (result.length >= 2) {
    return result;
  }
  var rows = source && Array.isArray(source.skuRows) ? source.skuRows : [];
  for (var rowIndex = 0; rowIndex < rows.length && result.length < 2; rowIndex += 1) {
    var parts = String(rows[rowIndex] && rows[rowIndex].specAttrs || "").split(/[>;；]/);
    for (var partIndex = 0; partIndex < parts.length && result.length < 2; partIndex += 1) {
      var part = String(parts[partIndex] || "").trim();
      var colonIndex = part.indexOf(":");
      if (colonIndex < 0) {
        colonIndex = part.indexOf("：");
      }
      if (colonIndex > 0) {
        appendUnifiedSkuPropertyName(result, part.slice(0, colonIndex));
      }
    }
  }
  return result;
}

/** Convert a platform source into the shared SKU row shape. */
function getUnifiedSkuRows(record) {
  var source = getUnifiedSourceData(record);
  var platform = record && record.platform ? record.platform : "";
  var result = [];
  if (platform === "1688") {
    var eightEightRows = Array.isArray(source.skuRows) ? source.skuRows : [];
    var propertyNames = getUnified1688PropertyNames(source);
    for (var eightIndex = 0; eightIndex < eightEightRows.length; eightIndex += 1) {
      var eightItem = eightEightRows[eightIndex] || {};
      result.push({
        skuId: eightItem.skuId,
        subSku: getUnifiedSubSkuValues(eightItem, platform, propertyNames),
        price: eightItem.discountPrice || eightItem.price || "",
        originalPrice: eightItem.price || "",
        stock: eightItem.stock,
        imageUrl: eightItem.imageUrl || ""
      });
    }
    return result;
  }
  var temuRows = Array.isArray(source.sku) ? source.sku : [];
  for (var temuIndex = 0; temuIndex < temuRows.length; temuIndex += 1) {
    var temuItem = temuRows[temuIndex] || {};
    result.push({
      skuId: temuItem.skuId,
      subSku: getUnifiedSubSkuValues(temuItem, platform),
      price: temuItem.salePrice !== undefined ? temuItem.salePrice : temuItem.normalPriceStr,
      originalPrice: temuItem.normalPriceStr || "",
      stock: temuItem.stockQuantity,
      imageUrl: temuItem.thumbUrl || ""
    });
  }
  return result;
}

/** Return a newline-separated URL field from a platform source. */
function getUnifiedImageUrls(record, detail) {
  var source = getUnifiedSourceData(record);
  var urls = [];
  if (record && record.platform === "1688") {
    urls = detail ? source.detailImageUrls : source.galleryImageUrls;
    return Array.isArray(urls) ? urls.join("\n") : "";
  }
  var goods = source.goods || {};
  var imageList = detail ? goods.detailList : goods.gallery;
  if (!Array.isArray(imageList)) {
    return "";
  }
  for (var index = 0; index < imageList.length; index += 1) {
    var item = imageList[index] || {};
    if (item.url) {
      urls.push(item.url);
    }
  }
  return urls.join("\n");
}

/** Build one unified SKU worksheet containing both platforms. */
function buildUnifiedCollectionRows(batch) {
  var header = [
    "main_id", "platform_id", "platform", "product_id", "product_name", "product_category",
    "category_ids", "sku_id", "SubSku1", "SubSku2",
    "sku_price", "sku_original_price", "sku_stock", "sku_image_url",
    "main_image_url", "gallery_image_urls", "detail_image_urls", "shop_name",
    "shop_rating", "review_count", "sales_count",
    "delivery_json", "attributes_json", "page_url", "collected_at"
  ];
  var rows = [header];
  var list = Array.isArray(batch) ? batch : [];
  for (var recordIndex = 0; recordIndex < list.length; recordIndex += 1) {
    var record = list[recordIndex] || {};
    var platform = record.platform || "";
    var skuRows = Array.isArray(record.sku) ? record.sku : [];
    var rowCount = skuRows.length ? skuRows.length : 1;
    for (var skuIndex = 0; skuIndex < rowCount; skuIndex += 1) {
      var sku = skuRows.length ? skuRows[skuIndex] || {} : {};
      var row = [
        record.main_id || "",
        record.platform_id || "",
        platform,
        record.product_id || "",
        record.product_name || "",
        record.product_category || "",
        record.category_ids || [],
        sku.sku_id || "",
        sku.SubSku1 || "",
        sku.SubSku2 || "",
        sku.sku_price === undefined ? "" : sku.sku_price,
        sku.sku_original_price === undefined ? "" : sku.sku_original_price,
        sku.sku_stock === undefined ? "" : sku.sku_stock,
        sku.sku_image_url || "",
        record.main_image_url || "",
        Array.isArray(record.gallery_image_urls) ? record.gallery_image_urls.join("\n") : "",
        Array.isArray(record.detail_image_urls) ? record.detail_image_urls.join("\n") : "",
        record.shop_name || "",
        record.shop_rating === undefined ? "" : record.shop_rating,
        record.review_count === undefined ? "" : record.review_count,
        record.sales_count === undefined ? "" : record.sales_count,
        record.delivery_json === undefined ? "" : record.delivery_json,
        record.attributes_json === undefined ? "" : record.attributes_json,
        record.page_url || "",
        record.collected_at || ""
      ];
      rows.push(row);
    }
  }
  return rows;
}

/** Build one unified review worksheet linked by the two canonical identifiers. */
function buildUnifiedReviewRows(batch) {
  var rows = [["main_id", "platform_id", "platform", "product_id", "product_name", "sku_id", "review_id", "user", "score", "comment", "time", "specs"]];
  var list = Array.isArray(batch) ? batch : [];
  for (var recordIndex = 0; recordIndex < list.length; recordIndex += 1) {
    var record = list[recordIndex] || {};
    var source = getUnifiedSourceData(record);
    var goods = source.goods || {};
    var reviewList = record.platform === "temu"
      && source.review && Array.isArray(source.review.reviewInfoList)
      ? source.review.reviewInfoList
      : source.rawJson && source.rawJson.reviewList && Array.isArray(source.rawJson.reviewList)
        ? source.rawJson.reviewList
        : [];
    for (var reviewIndex = 0; reviewIndex < reviewList.length; reviewIndex += 1) {
      var item = reviewList[reviewIndex] || {};
      rows.push([
        record.main_id || record.mainid,
        record.platform_id || "",
        record.platform,
        record.product_id,
        record.product_name || goods.goodsName,
        item.skuId,
        item.reviewId || item.id,
        item.name || item.userName,
        item.score || item.rate,
        item.comment || item.content,
        item.concatTimeLang || item.time || item.createTime,
        record.platform === "temu" ? specsToText(item.specs) : item.specAttrs
      ]);
    }
  }
  return rows;
}

/** Build the canonical JSON product records used by both exports. */
function buildUnifiedJsonExportBatch(batch) {
  var result = [];
  var list = Array.isArray(batch) ? batch : [];
  for (var index = 0; index < list.length; index += 1) {
    var record = list[index] || {};
    var source = getUnifiedSourceData(record);
    var platform = record.platform || "";
    var goods = source.goods || {};
    var shop = platform === "1688" ? source.shop || {} : source.mall || {};
    var statistics = source.statistics || {};
    var reviews = source.reviews || source.review || {};
    var skuRows = getUnifiedSkuRows(record);
    var skuList = [];
    for (var skuIndex = 0; skuIndex < skuRows.length; skuIndex += 1) {
      var sku = skuRows[skuIndex] || {};
      var subSku = Array.isArray(sku.subSku) ? sku.subSku : ["", ""];
      skuList.push({
        sku_id: sku.skuId || "",
        SubSku1: subSku[0] || "",
        SubSku2: subSku[1] || "",
        sku_price: sku.price === undefined ? "" : sku.price,
        sku_original_price: sku.originalPrice === undefined ? "" : sku.originalPrice,
        sku_stock: sku.stock === undefined ? "" : sku.stock,
        sku_image_url: sku.imageUrl || ""
      });
    }
    var galleryUrls = getUnifiedImageUrlArray(getUnifiedImageUrls(record, false));
    var detailUrls = getUnifiedImageUrlArray(getUnifiedImageUrls(record, true));
    var productId = record.product_id || (platform === "1688" ? source.offerId : goods.goodsId) || "";
    var productName = record.product_name || (platform === "1688" ? source.productName : goods.goodsName) || "";
    var productCategory = getUnifiedProductCategoryText(record, source, platform);
    var categoryIds = getUnifiedCategoryIdsText(record, source, platform);
    var pageUrl = platform === "1688" ? source.pageUrl : source.page && source.page.url;
    var collectedAt = formatUnifiedCollectedAt(
      platform === "1688" ? source.capturedAt : source.collectedAt
    );
    result.push({
      main_id: record.main_id || record.mainid || "",
      platform_id: record.platform_id || "",
      platform: platform,
      product_id: productId,
      product_name: productName,
      product_category: productCategory,
      category_ids: categoryIds,
      sku: skuList,
      main_image_url: galleryUrls.length ? galleryUrls[0] : "",
      gallery_image_urls: galleryUrls,
      detail_image_urls: detailUrls,
      shop_name: platform === "1688" ? shop.name || "" : shop.mallName || "",
      shop_rating: platform === "1688" ? shop.star : shop.mallStar,
      review_count: platform === "1688" ? reviews.count : shop.reviewNumStr,
      sales_count: platform === "1688" ? statistics.totalSales : goods.soldQuantity,
      delivery_json: source.delivery === undefined ? "" : source.delivery,
      attributes_json: platform === "1688" ? source.attributes : goods.goodsProperty,
      page_url: pageUrl || "",
      collected_at: collectedAt
    });
  }
  return result;
}

/** 创建批量 XLSX 文件的全部 XML 文件。 */
function createXlsxWorkbook(batch) {
  var batchList = Array.isArray(batch) ? batch : [batch || {}];
  var jsonBatch = buildUnifiedJsonExportBatch(batchList);
  var sheets = [
    { name: "商品SKU", rows: buildUnifiedCollectionRows(jsonBatch) },
    { name: "评论", rows: buildUnifiedReviewRows(batchList) }
  ];
  var files = [];
  files.push({ name: "[Content_Types].xml", content: createContentTypesXml(sheets.length) });
  files.push({ name: "_rels/.rels", content: createRootRelsXml() });
  files.push({ name: "xl/workbook.xml", content: createWorkbookXml(sheets) });
  files.push({ name: "xl/_rels/workbook.xml.rels", content: createWorkbookRelsXml(sheets.length) });
  files.push({ name: "xl/styles.xml", content: createStylesXml() });

  for (var index = 0; index < sheets.length; index += 1) {
    files.push({
      name: "xl/worksheets/sheet" + (index + 1) + ".xml",
      content: createSheetXml(sheets[index].rows)
    });
  }

  return createZip(files);
}

/** 创建工作簿 XML。 */
function createWorkbookXml(sheets) {
  var xml = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>";
  xml += "<workbook xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"><sheets>";
  for (var index = 0; index < sheets.length; index += 1) {
    xml += "<sheet name=\"" + escapeXml(sheets[index].name) + "\" sheetId=\"" + (index + 1) + "\" r:id=\"rId" + (index + 1) + "\"/>";
  }
  xml += "</sheets></workbook>";
  return xml;
}

/** 创建工作簿关系 XML。 */
function createWorkbookRelsXml(sheetCount) {
  var xml = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>";
  xml += "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">";
  for (var index = 0; index < sheetCount; index += 1) {
    xml += "<Relationship Id=\"rId" + (index + 1) + "\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet" + (index + 1) + ".xml\"/>";
  }
  xml += "<Relationship Id=\"rId" + (sheetCount + 1) + "\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles\" Target=\"styles.xml\"/></Relationships>";
  return xml;
}

/** 创建根关系 XML。 */
function createRootRelsXml() {
  return "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"xl/workbook.xml\"/></Relationships>";
}

/** 创建内容类型 XML。 */
function createContentTypesXml(sheetCount) {
  var xml = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>";
  xml += "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Override PartName=\"/xl/workbook.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml\"/><Override PartName=\"/xl/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml\"/>";
  for (var index = 0; index < sheetCount; index += 1) {
    xml += "<Override PartName=\"/xl/worksheets/sheet" + (index + 1) + ".xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/>";
  }
  xml += "</Types>";
  return xml;
}

/** 创建基础样式 XML。 */
function createStylesXml() {
  return "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><styleSheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><fonts count=\"2\"><font><sz val=\"11\"/><name val=\"Calibri\"/></font><font><b/><sz val=\"11\"/><name val=\"Calibri\"/></font></fonts><fills count=\"2\"><fill><patternFill patternType=\"none\"/></fill><fill><patternFill patternType=\"gray125\"/></fill></fills><borders count=\"1\"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count=\"1\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\"/></cellStyleXfs><cellXfs count=\"2\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\" xfId=\"0\"/><xf numFmtId=\"0\" fontId=\"1\" fillId=\"0\" borderId=\"0\" xfId=\"0\"/></cellXfs></styleSheet>";
}

/** 创建工作表 XML。 */
function createSheetXml(rows) {
  var xml = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>";
  xml += "<worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><sheetData>";
  for (var rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    var row = rows[rowIndex] || [];
    xml += "<row r=\"" + (rowIndex + 1) + "\">";
    for (var cellIndex = 0; cellIndex < row.length; cellIndex += 1) {
      var styleIndex = rowIndex === 0 ? 1 : 0;
      xml += createCellXml(row[cellIndex], getColumnName(cellIndex) + (rowIndex + 1), styleIndex);
    }
    xml += "</row>";
  }
  xml += "</sheetData></worksheet>";
  return xml;
}

/** 创建工作表单元格 XML。 */
function createCellXml(value, reference, styleIndex) {
  var text = valueToText(value);
  var style = styleIndex ? " s=\"" + styleIndex + "\"" : "";
  if (typeof value === "number" && Number.isFinite(value)) {
    return "<c r=\"" + reference + "\"" + style + "><v>" + value + "</v></c>";
  }
  return "<c r=\"" + reference + "\"" + style + " t=\"inlineStr\"><is><t xml:space=\"preserve\">" + escapeXml(text) + "</t></is></c>";
}

/** 根据列序号生成 Excel 列名。 */
function getColumnName(index) {
  var value = index + 1;
  var result = "";
  while (value > 0) {
    var remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

/** 转义 XML 特殊字符。 */
function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** 把字符串转换成 UTF-8 字节。 */
function toUtf8Bytes(text) {
  return new TextEncoder().encode(text);
}

/** 拼接多个 Uint8Array。 */
function concatByteArrays(parts) {
  var totalLength = 0;
  for (var index = 0; index < parts.length; index += 1) {
    totalLength += parts[index].length;
  }

  var result = new Uint8Array(totalLength);
  var offset = 0;
  for (var partIndex = 0; partIndex < parts.length; partIndex += 1) {
    result.set(parts[partIndex], offset);
    offset += parts[partIndex].length;
  }
  return result;
}

/** 创建小端序 16 位整数。 */
function uint16Bytes(value) {
  return new Uint8Array([value & 255, (value >>> 8) & 255]);
}

/** 创建小端序 32 位整数。 */
function uint32Bytes(value) {
  return new Uint8Array([
    value & 255,
    (value >>> 8) & 255,
    (value >>> 16) & 255,
    (value >>> 24) & 255
  ]);
}

/** 计算 ZIP 文件的 CRC32。 */
function calculateCrc32(bytes) {
  var table = [];
  for (var tableIndex = 0; tableIndex < 256; tableIndex += 1) {
    var tableValue = tableIndex;
    for (var bitIndex = 0; bitIndex < 8; bitIndex += 1) {
      tableValue = tableValue & 1 ? 0xedb88320 ^ (tableValue >>> 1) : tableValue >>> 1;
    }
    table.push(tableValue >>> 0);
  }

  var crc = 0xffffffff;
  for (var index = 0; index < bytes.length; index += 1) {
    crc = table[(crc ^ bytes[index]) & 255] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** 创建不压缩 ZIP 文件，供 XLSX 使用。 */
function createZip(files) {
  var localParts = [];
  var centralParts = [];
  var offset = 0;

  for (var index = 0; index < files.length; index += 1) {
    var file = files[index];
    var nameBytes = toUtf8Bytes(file.name);
    var dataBytes = toUtf8Bytes(file.content);
    var crc = calculateCrc32(dataBytes);
    var localHeader = concatByteArrays([
      uint32Bytes(0x04034b50),
      uint16Bytes(20),
      uint16Bytes(0),
      uint16Bytes(0),
      uint16Bytes(0),
      uint16Bytes(0),
      uint32Bytes(crc),
      uint32Bytes(dataBytes.length),
      uint32Bytes(dataBytes.length),
      uint16Bytes(nameBytes.length),
      uint16Bytes(0)
    ]);
    localParts.push(localHeader, nameBytes, dataBytes);

    var centralHeader = concatByteArrays([
      uint32Bytes(0x02014b50),
      uint16Bytes(20),
      uint16Bytes(20),
      uint16Bytes(0),
      uint16Bytes(0),
      uint16Bytes(0),
      uint16Bytes(0),
      uint32Bytes(crc),
      uint32Bytes(dataBytes.length),
      uint32Bytes(dataBytes.length),
      uint16Bytes(nameBytes.length),
      uint16Bytes(0),
      uint16Bytes(0),
      uint16Bytes(0),
      uint16Bytes(0),
      uint32Bytes(0),
      uint32Bytes(offset)
    ]);
    centralParts.push(centralHeader, nameBytes);
    offset += localHeader.length + nameBytes.length + dataBytes.length;
  }

  var localData = concatByteArrays(localParts);
  var centralData = concatByteArrays(centralParts);
  var endRecord = concatByteArrays([
    uint32Bytes(0x06054b50),
    uint16Bytes(0),
    uint16Bytes(0),
    uint16Bytes(files.length),
    uint16Bytes(files.length),
    uint32Bytes(centralData.length),
    uint32Bytes(localData.length),
    uint16Bytes(0)
  ]);
  return concatByteArrays([localData, centralData, endRecord]);
}
