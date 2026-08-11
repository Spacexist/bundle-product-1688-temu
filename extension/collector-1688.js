/** Read safe diagnostics for the page-level 1688 JSON capture hook. */
function get1688CaptureDiagnostics() {
  /** Check whether a page-state object contains at least one SKU map. */
  function hasSkuInfoModel(model) {
    if (!model || typeof model !== "object") {
      return false;
    }
    var skuInfoMap = model.skuInfoMap;
    var originalSkuInfoMap = model.originalSkuInfoMap;
    return Boolean(
      skuInfoMap && typeof skuInfoMap === "object" && Object.keys(skuInfoMap).length
    ) || Boolean(
      originalSkuInfoMap && typeof originalSkuInfoMap === "object" && Object.keys(originalSkuInfoMap).length
    );
  }

  /** Read the SKU model from the known 1688 page-state locations. */
  function readSkuModelFromPageState(pageState) {
    var contextData = pageState && pageState.result && pageState.result.data;
    if (contextData && hasSkuInfoModel(contextData.skuModel)) {
      return contextData.skuModel;
    }
    if (contextData && contextData.skuSelectorBizModel && hasSkuInfoModel(contextData.skuSelectorBizModel)) {
      return contextData.skuSelectorBizModel.skuSelectorModel || contextData.skuSelectorBizModel;
    }
    var rootData = contextData && contextData.Root;
    var rootFields = rootData && rootData.fields;
    var dataJson = rootFields && rootFields.dataJson;
    if (dataJson && hasSkuInfoModel(dataJson.skuModel)) {
      return dataJson.skuModel;
    }
    if (dataJson && dataJson.skuSelectorBizModel && hasSkuInfoModel(dataJson.skuSelectorBizModel)) {
      return dataJson.skuSelectorBizModel.skuSelectorModel || dataJson.skuSelectorBizModel;
    }
    return null;
  }

  /** Parse a JSON object containing the numeric-key form used by some inline scripts. */
  function parseLooseEmbeddedJson(source) {
    try {
      return JSON.parse(source);
    } catch (error) {
      var normalized = source.replace(/([,{]\s*)(\d+)\s*:/g, '$1"$2":');
      try {
        return JSON.parse(normalized);
      } catch (nestedError) {
        return null;
      }
    }
  }

  /** Extract a balanced JSON object from an inline page script. */
  function parseEmbeddedJson(text, startIndex) {
    var source = String(text || "");
    var objectStart = source.indexOf("{", startIndex);
    if (objectStart < 0) {
      return null;
    }
    var depth = 0;
    var inString = false;
    var escaped = false;
    for (var index = objectStart; index < source.length; index += 1) {
      var character = source[index];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (character === "\\") {
          escaped = true;
        } else if (character === '"') {
          inString = false;
        }
        continue;
      }
      if (character === '"') {
        inString = true;
      } else if (character === "{") {
        depth += 1;
      } else if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          try {
            return parseLooseEmbeddedJson(source.slice(objectStart, index + 1));
          } catch (error) {
            return null;
          }
        }
      }
    }
    return null;
  }

  /** Read the embedded SKU model from the page global or inline scripts. */
  function readEmbeddedSkuModel() {
    var pageSkuModel = readSkuModelFromPageState(window.context);
    if (pageSkuModel) {
      return pageSkuModel;
    }
    var scriptNodes = document.querySelectorAll("script");
    for (var index = 0; index < scriptNodes.length; index += 1) {
      var scriptText = String(scriptNodes[index].textContent || "");
      var assignmentIndex = scriptText.indexOf("window.context=");
      if (assignmentIndex < 0) {
        continue;
      }
      var argumentIndex = scriptText.indexOf("window.contextPath,", assignmentIndex);
      var stateObject = parseEmbeddedJson(
        scriptText,
        argumentIndex >= 0 ? argumentIndex : assignmentIndex
      );
      var stateSkuModel = readSkuModelFromPageState(stateObject);
      if (stateSkuModel) {
        return stateSkuModel;
      }
    }
    return null;
  }

  var records = [];
  var state = window.__codex1688CaptureState || {};
  var embeddedSkuModel = readEmbeddedSkuModel();
  var hasEmbeddedSkuModel = hasSkuInfoModel(embeddedSkuModel);
  var endpointMap = {};
  var summaries = [];
  for (var index = 0; index < records.length; index += 1) {
    var record = records[index] || {};
    var url = String(record.url || "");
    var endpoint = url;
    try {
      endpoint = new URL(url, location.href).pathname;
    } catch (error) {
      endpoint = url;
    }
    endpointMap[endpoint] = true;
    summaries.push({
      url: url,
      method: record.method || "GET",
      bodyLength: String(record.requestBody || "").length,
      responseLength: String(record.responseBody || "").length,
      capturedAt: record.capturedAt || ""
    });
  }
  return {
    ok: true,
    data: {
      pageUrl: location.href,
      installed: Boolean(state.installed),
      installedAt: state.installedAt || "",
      capturedCount: Number(state.capturedCount || records.length),
      ignoredCount: Number(state.ignoredCount || 0),
      errorCount: Number(state.errorCount || 0),
      hasEmbeddedSkuModel: hasEmbeddedSkuModel,
      lastUrl: state.lastUrl || "",
      lastCapturedAt: state.lastCapturedAt || "",
      lastError: state.lastError || "",
      endpointNames: Object.keys(endpointMap),
      records: summaries
    }
  };
}

/** Return the captured 1688 request and response JSON for local debugging. */
function get1688PageCaptureDump() {
  /** Check whether a page-state object contains at least one SKU map. */
  function hasSkuInfoModel(model) {
    if (!model || typeof model !== "object") {
      return false;
    }
    var skuInfoMap = model.skuInfoMap;
    var originalSkuInfoMap = model.originalSkuInfoMap;
    return Boolean(
      skuInfoMap && typeof skuInfoMap === "object" && Object.keys(skuInfoMap).length
    ) || Boolean(
      originalSkuInfoMap && typeof originalSkuInfoMap === "object" && Object.keys(originalSkuInfoMap).length
    );
  }

  /** Read the SKU model from the known 1688 page-state locations. */
  function readSkuModelFromPageState(pageState) {
    var contextData = pageState && pageState.result && pageState.result.data;
    if (contextData && hasSkuInfoModel(contextData.skuModel)) {
      return contextData.skuModel;
    }
    if (contextData && contextData.skuSelectorBizModel && hasSkuInfoModel(contextData.skuSelectorBizModel)) {
      return contextData.skuSelectorBizModel.skuSelectorModel || contextData.skuSelectorBizModel;
    }
    var rootData = contextData && contextData.Root;
    var rootFields = rootData && rootData.fields;
    var dataJson = rootFields && rootFields.dataJson;
    if (dataJson && hasSkuInfoModel(dataJson.skuModel)) {
      return dataJson.skuModel;
    }
    if (dataJson && dataJson.skuSelectorBizModel && hasSkuInfoModel(dataJson.skuSelectorBizModel)) {
      return dataJson.skuSelectorBizModel.skuSelectorModel || dataJson.skuSelectorBizModel;
    }
    return null;
  }

  /** Parse a JSON object containing the numeric-key form used by some inline scripts. */
  function parseLooseEmbeddedJson(source) {
    try {
      return JSON.parse(source);
    } catch (error) {
      var normalized = source.replace(/([,{]\s*)(\d+)\s*:/g, '$1"$2":');
      try {
        return JSON.parse(normalized);
      } catch (nestedError) {
        return null;
      }
    }
  }

  /** Extract a balanced JSON object from an inline page script. */
  function parseEmbeddedJson(text, startIndex) {
    var source = String(text || "");
    var objectStart = source.indexOf("{", startIndex);
    if (objectStart < 0) {
      return null;
    }
    var depth = 0;
    var inString = false;
    var escaped = false;
    for (var index = objectStart; index < source.length; index += 1) {
      var character = source[index];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (character === "\\") {
          escaped = true;
        } else if (character === '"') {
          inString = false;
        }
        continue;
      }
      if (character === '"') {
        inString = true;
      } else if (character === "{") {
        depth += 1;
      } else if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          try {
            return parseLooseEmbeddedJson(source.slice(objectStart, index + 1));
          } catch (error) {
            return null;
          }
        }
      }
    }
    return null;
  }

  /** Read the embedded SKU model from the page global or inline scripts. */
  function readEmbeddedSkuModel() {
    var pageSkuModel = readSkuModelFromPageState(window.context);
    if (pageSkuModel) {
      return pageSkuModel;
    }
    var scriptNodes = document.querySelectorAll("script");
    for (var index = 0; index < scriptNodes.length; index += 1) {
      var scriptText = String(scriptNodes[index].textContent || "");
      var assignmentIndex = scriptText.indexOf("window.context=");
      if (assignmentIndex < 0) {
        continue;
      }
      var argumentIndex = scriptText.indexOf("window.contextPath,", assignmentIndex);
      var stateObject = parseEmbeddedJson(
        scriptText,
        argumentIndex >= 0 ? argumentIndex : assignmentIndex
      );
      var stateSkuModel = readSkuModelFromPageState(stateObject);
      if (stateSkuModel) {
        return stateSkuModel;
      }
    }
    return null;
  }

  var records = Array.isArray(window.__codex1688ResponseCache)
    ? window.__codex1688ResponseCache
    : [];
  var embeddedSkuModel = readEmbeddedSkuModel();
  return {
    ok: true,
    data: {
      pageUrl: location.href,
      capturedAt: new Date().toISOString(),
      embeddedSkuModel: embeddedSkuModel,
      records: records
    }
  };
}

/** Collect a page-side diagnostic report equivalent to the required Console checks. */
function get1688PageProbe() {
  /** Check whether a page-state object contains at least one SKU map. */
  function hasSkuInfoModel(model) {
    if (!model || typeof model !== "object") {
      return false;
    }
    var skuInfoMap = model.skuInfoMap;
    var originalSkuInfoMap = model.originalSkuInfoMap;
    return Boolean(
      skuInfoMap && typeof skuInfoMap === "object" && Object.keys(skuInfoMap).length
    ) || Boolean(
      originalSkuInfoMap && typeof originalSkuInfoMap === "object" && Object.keys(originalSkuInfoMap).length
    );
  }

  /** Read the SKU model from the known 1688 page-state locations. */
  function readSkuModelFromPageState(pageState) {
    var contextData = pageState && pageState.result && pageState.result.data;
    if (contextData && hasSkuInfoModel(contextData.skuModel)) {
      return contextData.skuModel;
    }
    if (contextData && contextData.skuSelectorBizModel && hasSkuInfoModel(contextData.skuSelectorBizModel)) {
      return contextData.skuSelectorBizModel.skuSelectorModel || contextData.skuSelectorBizModel;
    }
    var rootData = contextData && contextData.Root;
    var rootFields = rootData && rootData.fields;
    var dataJson = rootFields && rootFields.dataJson;
    if (dataJson && hasSkuInfoModel(dataJson.skuModel)) {
      return dataJson.skuModel;
    }
    if (dataJson && dataJson.skuSelectorBizModel && hasSkuInfoModel(dataJson.skuSelectorBizModel)) {
      return dataJson.skuSelectorBizModel.skuSelectorModel || dataJson.skuSelectorBizModel;
    }
    return null;
  }

  var scripts = document.querySelectorAll("script");
  var matchingScripts = [];
  var htmlText = document.documentElement ? document.documentElement.innerHTML : "";
  var contextKeys = [];
  var contextResultKeys = [];
  if (window.context && typeof window.context === "object") {
    contextKeys = Object.keys(window.context).slice(0, 30);
    if (window.context.result && typeof window.context.result === "object") {
      contextResultKeys = Object.keys(window.context.result).slice(0, 30);
    }
  }
  for (var index = 0; index < scripts.length; index += 1) {
    var text = String(scripts[index].textContent || "");
    var skuModelIndex = text.indexOf("skuModel");
    var skuInfoMapIndex = text.indexOf("skuInfoMap");
    var contextIndex = text.indexOf("window.context");
    if (skuModelIndex >= 0 || skuInfoMapIndex >= 0 || contextIndex >= 0) {
      var snippetIndex = skuInfoMapIndex >= 0 ? skuInfoMapIndex : skuModelIndex;
      if (snippetIndex < 0) {
        snippetIndex = contextIndex;
      }
      var snippetStart = Math.max(0, snippetIndex - 300);
      matchingScripts.push({
        index: index,
        length: text.length,
        contextIndex: contextIndex,
        skuModelIndex: skuModelIndex,
        skuInfoMapIndex: skuInfoMapIndex,
        snippet: text.slice(snippetStart, snippetStart + 1200)
      });
    }
  }
  return {
    ok: true,
    data: {
      pageUrl: location.href,
      documentReadyState: document.readyState,
      contextType: typeof window.context,
      contextKeys: contextKeys,
      contextResultKeys: contextResultKeys,
      contextHasSkuModel: Boolean(readSkuModelFromPageState(window.context)),
      htmlHasContext: htmlText.indexOf("window.context") >= 0,
      htmlHasSkuModel: htmlText.indexOf("skuModel") >= 0,
      htmlHasSkuInfoMap: htmlText.indexOf("skuInfoMap") >= 0,
      scriptCount: scripts.length,
      matchingScripts: matchingScripts,
      responseCount: Array.isArray(window.__codex1688ResponseCache)
        ? window.__codex1688ResponseCache.length
        : 0
    }
  };
}

/** Collect normalized 1688 data from JSON responses captured in the page. */
function collect1688DataFromPage() {
  /** Parse a JSON or JSONP response body. */
  function parseResponseBody(text) {
    var source = String(text || "").trim();
    if (!source) {
      return null;
    }
    try {
      return JSON.parse(source);
    } catch (error) {
      var startIndex = source.indexOf("{");
      var endIndex = source.lastIndexOf("}");
      if (startIndex < 0 || endIndex <= startIndex) {
        return null;
      }
      try {
        return JSON.parse(source.slice(startIndex, endIndex + 1));
      } catch (nestedError) {
        return null;
      }
    }
  }

  /** Parse the form-encoded request body used by MTop. */
  function parseRequestBody(text) {
    var source = String(text || "");
    var formData = new URLSearchParams(source);
    var dataText = formData.get("data");
    if (!dataText) {
      return {};
    }
    try {
      return JSON.parse(dataText);
    } catch (error) {
      return {};
    }
  }

  /** Read the service name used by the multiplexed offer detail endpoint. */
  function getServiceName(record) {
    var request = parseRequestBody(record ? record.requestBody : "");
    var mmgaRequest = request && request.mmgaRequest ? request.mmgaRequest : {};
    return mmgaRequest.serviceName || "";
  }

  /** Read the URL path from a sanitized captured request. */
  function getPath(record) {
    try {
      return new URL(record.url, location.href).pathname;
    } catch (error) {
      return String(record && record.url ? record.url : "");
    }
  }

  /** Read the product number from the current URL. */
  function getOfferId() {
    var match = location.pathname.match(/\/offer\/(\d+)\.html/i);
    return match ? match[1] : "";
  }

  /** Keep only numeric characters in an offer ID. */
  function getNumericOfferId(value) {
    var match = String(value || "").match(/\d+/);
    return match ? match[0] : "";
  }

  /** Read a nested data field from an MTop response. */
  function getResponseData(response) {
    return response && response.data ? response.data : {};
  }

  /** Extract one balanced JSON object from an inline page state script. */
  function parseEmbedded1688Json(text, startIndex) {
    var source = String(text || "");
    var objectStart = source.indexOf("{", startIndex);
    if (objectStart < 0) {
      return null;
    }
    var depth = 0;
    var inString = false;
    var escaped = false;
    for (var index = objectStart; index < source.length; index += 1) {
      var character = source[index];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (character === "\\") {
          escaped = true;
        } else if (character === '"') {
          inString = false;
        }
        continue;
      }
      if (character === '"') {
        inString = true;
      } else if (character === "{") {
        depth += 1;
      } else if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          try {
            var candidate = source.slice(objectStart, index + 1);
            try {
              return JSON.parse(candidate);
            } catch (error) {
              var normalized = candidate.replace(/([,{]\s*)(\d+)\s*:/g, '$1"$2":');
              return JSON.parse(normalized);
            }
          } catch (error) {
            return null;
          }
        }
      }
    }
    return null;
  }

  /** Check whether a SKU model contains usable SKU records in either map. */
  function has1688SkuInfoModel(model) {
    if (!model || typeof model !== "object") {
      return false;
    }
    var skuInfoMap = model.skuInfoMap;
    var originalSkuInfoMap = model.originalSkuInfoMap;
    return Boolean(
      skuInfoMap && typeof skuInfoMap === "object" && Object.keys(skuInfoMap).length
    ) || Boolean(
      originalSkuInfoMap && typeof originalSkuInfoMap === "object" && Object.keys(originalSkuInfoMap).length
    );
  }

  /** Convert one object node into a normalized SKU and selector model pair. */
  function get1688SkuDataFromObject(node, parent) {
    if (!node || typeof node !== "object") {
      return null;
    }
    var selectorBizModel = node.skuSelectorBizModel;
    if (selectorBizModel && typeof selectorBizModel === "object") {
      var selectorSkuModel = selectorBizModel.skuSelectorModel || selectorBizModel;
      if (has1688SkuInfoModel(selectorSkuModel)) {
        return {
          skuBizModel: selectorSkuModel,
          selectorModel: selectorBizModel.skuSelectorModel || selectorBizModel
        };
      }
    }
    if (node.skuModel && has1688SkuInfoModel(node.skuModel)) {
      return {
        skuBizModel: node.skuModel,
        selectorModel: node
      };
    }
    if (has1688SkuInfoModel(node)) {
      return {
        skuBizModel: node,
        selectorModel: parent && typeof parent === "object" ? parent : node
      };
    }
    return null;
  }

  /** Search an arbitrary 1688 response or page state for SKU data. */
  function find1688SkuDataInObject(root) {
    if (!root || typeof root !== "object") {
      return null;
    }
    var queue = [{ value: root, parent: null, depth: 0 }];
    var seen = [];
    while (queue.length) {
      var current = queue.shift();
      var value = current.value;
      if (!value || typeof value !== "object" || seen.indexOf(value) >= 0 || current.depth > 20) {
        continue;
      }
      seen.push(value);
      var result = get1688SkuDataFromObject(value, current.parent);
      if (result) {
        return result;
      }
      var keys = Object.keys(value);
      for (var keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
        var child = value[keys[keyIndex]];
        if (child && typeof child === "object") {
          queue.push({ value: child, parent: value, depth: current.depth + 1 });
        }
      }
    }
    return null;
  }

  /** Count SKU records that expose a price-like field. */
  function get1688SkuPriceCoverage(model) {
    if (!model || typeof model !== "object") {
      return 0;
    }
    var maps = [model.skuInfoMap, model.originalSkuInfoMap];
    var seenSkuIds = {};
    var count = 0;
    for (var mapIndex = 0; mapIndex < maps.length; mapIndex += 1) {
      var map = maps[mapIndex];
      if (!map || typeof map !== "object") {
        continue;
      }
      var keys = Object.keys(map);
      for (var keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
        var item = map[keys[keyIndex]] || {};
        var identity = String(item.skuId || keys[keyIndex]);
        if (seenSkuIds[identity]) {
          continue;
        }
        if (item.price || item.skuPrice || item.multiPrice || item.salePrice
          || item.discountPrice || item.promotionPrice) {
          seenSkuIds[identity] = true;
          count += 1;
        }
      }
    }
    return count;
  }

  /** Merge non-empty price fallback fields without replacing valid network records. */
  function merge1688SkuFallback(currentModel, fallbackModel) {
    if (!currentModel) {
      return fallbackModel;
    }
    if (!fallbackModel || typeof fallbackModel !== "object") {
      return currentModel;
    }
    if (!currentModel.originalSkuInfoMap && fallbackModel.originalSkuInfoMap) {
      currentModel.originalSkuInfoMap = fallbackModel.originalSkuInfoMap;
    }
    if (!currentModel.skuPriceScale && fallbackModel.skuPriceScale) {
      currentModel.skuPriceScale = fallbackModel.skuPriceScale;
    }
    if (!currentModel.skuProps && fallbackModel.skuProps) {
      currentModel.skuProps = fallbackModel.skuProps;
    }
    return currentModel;
  }

  /** Convert an executed 1688 page state into SKU and selector models. */
  function getEmbedded1688SkuDataFromState(pageState) {
    var contextData = pageState && pageState.result && pageState.result.data;
    if (contextData && has1688SkuInfoModel(contextData.skuModel)) {
      return {
        skuBizModel: contextData.skuModel,
        selectorModel: contextData
      };
    }
    if (contextData && contextData.skuSelectorBizModel) {
      var contextSelectorModel = contextData.skuSelectorBizModel.skuSelectorModel
        || contextData.skuSelectorBizModel;
      if (has1688SkuInfoModel(contextSelectorModel)) {
        return {
          skuBizModel: contextSelectorModel,
          selectorModel: contextData.skuSelectorBizModel.skuSelectorModel
            || contextData.skuSelectorBizModel
        };
      }
    }
    var rootData = contextData && contextData.Root;
    var rootFields = rootData && rootData.fields;
    var dataJson = rootFields && rootFields.dataJson;
    if (dataJson && has1688SkuInfoModel(dataJson.skuModel)) {
      return {
        skuBizModel: dataJson.skuModel,
        selectorModel: dataJson
      };
    }
    if (dataJson && dataJson.skuSelectorBizModel) {
      var dataJsonSelectorModel = dataJson.skuSelectorBizModel.skuSelectorModel
        || dataJson.skuSelectorBizModel;
      if (has1688SkuInfoModel(dataJsonSelectorModel)) {
        return {
          skuBizModel: dataJsonSelectorModel,
          selectorModel: dataJson.skuSelectorBizModel.skuSelectorModel
            || dataJson.skuSelectorBizModel
        };
      }
    }
    return null;
  }

  /** Search page state and inline scripts for the embedded 1688 SKU model. */
  function readEmbedded1688SkuData() {
    var pageStateSkuData = getEmbedded1688SkuDataFromState(window.context);
    if (pageStateSkuData) {
      return pageStateSkuData;
    }
    var scriptNodes = document.querySelectorAll("script");
    for (var scriptIndex = 0; scriptIndex < scriptNodes.length; scriptIndex += 1) {
      var scriptText = String(scriptNodes[scriptIndex].textContent || "");
      var assignmentIndex = scriptText.indexOf("window.context=");
      if (assignmentIndex < 0) {
        assignmentIndex = scriptText.indexOf("window.context =");
      }
      if (assignmentIndex < 0) {
        continue;
      }
      var argumentIndex = scriptText.indexOf("window.contextPath,", assignmentIndex);
      var stateObject = parseEmbedded1688Json(
        scriptText,
        argumentIndex >= 0 ? argumentIndex : assignmentIndex
      );
      var stateSkuData = getEmbedded1688SkuDataFromState(stateObject);
      if (stateSkuData) {
        return stateSkuData;
      }
    }
    var roots = [
      window.context,
      window.__INITIAL_STATE__,
      window.__INITIAL_DATA__,
      window.__NEXT_DATA__,
      window.__APOLLO_STATE__,
      window.__DATA__,
      window.__SSR_DATA__,
      window.__PAGE_DATA__,
      window.__OD_DATA__,
      window.__OD_STATE__
    ];
    var queue = [];
    var seen = [];
    for (var rootIndex = 0; rootIndex < roots.length; rootIndex += 1) {
      if (roots[rootIndex] && typeof roots[rootIndex] === "object") {
        queue.push({ value: roots[rootIndex], parent: null, depth: 0 });
      }
    }
    while (queue.length) {
      var current = queue.shift();
      var value = current.value;
      if (!value || typeof value !== "object" || seen.indexOf(value) >= 0 || current.depth > 12) {
        continue;
      }
      seen.push(value);
      var stateSkuData = get1688SkuDataFromObject(value, current.parent);
      if (stateSkuData) {
        return stateSkuData;
      }
      var keys = Object.keys(value);
      for (var keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
        var child = value[keys[keyIndex]];
        if (child && typeof child === "object") {
          queue.push({ value: child, parent: value, depth: current.depth + 1 });
        }
      }
    }
    return null;
  }

  /** Read the complete product state embedded in the 1688 page. */
  function readEmbedded1688PageContextData() {
    var directContext = window.context;
    if (directContext && directContext.result && directContext.result.data) {
      return directContext.result.data;
    }
    var scriptNodes = document.querySelectorAll("script");
    for (var scriptIndex = 0; scriptIndex < scriptNodes.length; scriptIndex += 1) {
      var scriptText = String(scriptNodes[scriptIndex].textContent || "");
      var assignmentIndex = scriptText.indexOf("window.context=");
      if (assignmentIndex < 0) {
        assignmentIndex = scriptText.indexOf("window.context =");
      }
      if (assignmentIndex < 0) {
        continue;
      }
      var argumentIndex = scriptText.indexOf("window.contextPath,", assignmentIndex);
      var stateObject = parseEmbedded1688Json(
        scriptText,
        argumentIndex >= 0 ? argumentIndex : assignmentIndex
      );
      if (stateObject && stateObject.result && stateObject.result.data) {
        return stateObject.result.data;
      }
    }
    return null;
  }

  /** Read detail HTML from the executed 1688 page memory and extract its image URLs. */
  function read1688DetailImageUrls() {
    var detailHtml = "";
    var offerDetails = window.offer_details;
    if (offerDetails && typeof offerDetails.content === "string") {
      detailHtml = offerDetails.content;
    }
    if (!detailHtml && typeof window.desc === "string") {
      detailHtml = window.desc;
    }
    if (!detailHtml || typeof DOMParser === "undefined") {
      return [];
    }
    var detailDocument = new DOMParser().parseFromString(detailHtml, "text/html");
    var imageNodes = detailDocument.querySelectorAll("img");
    var result = [];
    var seen = {};
    for (var index = 0; index < imageNodes.length; index += 1) {
      var imageNode = imageNodes[index];
      var rawUrl = imageNode.getAttribute("src")
        || imageNode.getAttribute("data-src")
        || imageNode.getAttribute("data-lazy-src")
        || "";
      var imageUrl = normalizeDomImageUrl(rawUrl);
      if (imageUrl && !seen[imageUrl]) {
        seen[imageUrl] = true;
        result.push(imageUrl);
      }
    }
    return result;
  }

  /** Read a nested result object from an offer-detail service response. */
  function getOfferDetailResult(response) {
    var data = getResponseData(response);
    if (data.result && typeof data.result === "object") {
      return data.result;
    }
    if (data.data && typeof data.data === "object") {
      if (data.data.result && typeof data.data.result === "object") {
        return data.data.result;
      }
      return data.data;
    }
    return data;
  }

  /** Convert a SKU property list into an image lookup by specification text. */
  function buildSkuImageMap(skuProps) {
    var result = {};
    var list = Array.isArray(skuProps) ? skuProps : [];
    for (var propIndex = 0; propIndex < list.length; propIndex += 1) {
      var values = Array.isArray(list[propIndex].value) ? list[propIndex].value : [];
      for (var valueIndex = 0; valueIndex < values.length; valueIndex += 1) {
        var value = values[valueIndex] || {};
        if (value.name) {
          result[value.name] = value.imageUrl || "";
        }
      }
    }
    return result;
  }

  /** Format one SKU dimension as property name and parameter value. */
  function formatSkuProperty(propertyName, propertyValue) {
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

  /** Split the combined 1688 specification text into two named dimensions. */
  function splitSkuSpec(specAttrs) {
    var source = String(specAttrs || "")
      .replace(/&gt;/gi, ">")
      .replace(/&#62;/gi, ">");
    var parts = source.split(/[>;；]/);
    var values = [];
    var names = [];
    for (var index = 0; index < parts.length && values.length < 2; index += 1) {
      var part = String(parts[index] || "").trim();
      var colonIndex = part.indexOf(":");
      if (colonIndex < 0) {
        colonIndex = part.indexOf("：");
      }
      if (colonIndex >= 0) {
        names.push(part.slice(0, colonIndex).trim());
        part = part.slice(colonIndex + 1).trim();
      } else {
        names.push("");
      }
      values.push(part);
    }
    return {
      first: values.length ? values[0] : "",
      second: values.length > 1 ? values[1] : "",
      firstName: names.length ? names[0] : "",
      secondName: names.length > 1 ? names[1] : ""
    };
  }

  /** Normalize a price-like value while removing a currency prefix. */
  function normalizeSkuPriceValue(value) {
    if (value === null || value === undefined) {
      return "";
    }
    var source = String(value).trim();
    if (!source) {
      return "";
    }
    var match = source.match(/(\d+(?:\.\d+)?(?:\s*[-~至]\s*\d+(?:\.\d+)?)?)/);
    return match ? match[1].replace(/\s+/g, "") : source;
  }

  /** Read one non-empty value from the current or original 1688 SKU row. */
  function read1688SkuValue(current, original, names) {
    var rows = [current || {}, original || {}];
    var fields = Array.isArray(names) ? names : [];
    for (var rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      var row = rows[rowIndex];
      for (var fieldIndex = 0; fieldIndex < fields.length; fieldIndex += 1) {
        var value = row[fields[fieldIndex]];
        if (value !== undefined && value !== null && value !== "") {
          return value;
        }
      }
    }
    return "";
  }

  /** Read one SKU measurement from direct or nested 1688 product fields. */
  function read1688SkuDimension(current, original, names) {
    var direct = read1688SkuValue(current, original, names);
    if (direct !== "") {
      return direct;
    }
    var rows = [current || {}, original || {}];
    var containers = ["dimensions", "skuDimensions", "packageDimensions"];
    for (var rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      var row = rows[rowIndex];
      for (var containerIndex = 0; containerIndex < containers.length; containerIndex += 1) {
        var container = row[containers[containerIndex]];
        if (!container || typeof container !== "object") {
          continue;
        }
        var nested = read1688SkuValue(container, null, names);
        if (nested !== "") {
          return nested;
        }
      }
    }
    return "";
  }

  /** Find the matching original SKU record by key or SKU ID. */
  function findOriginalSkuItem(originalMap, key, skuId) {
    if (!originalMap || typeof originalMap !== "object") {
      return {};
    }
    if (originalMap[key]) {
      return originalMap[key];
    }
    if (!skuId) {
      return {};
    }
    var keys = Object.keys(originalMap);
    for (var index = 0; index < keys.length; index += 1) {
      var item = originalMap[keys[index]] || {};
      if (String(item.skuId || "") === String(skuId)) {
        return item;
      }
    }
    return {};
  }

  /** Convert the SKU map object into flat CSV-ready rows. */
  function buildSkuRows(skuBizModel, propertyNames) {
    var result = [];
    var infoMap = skuBizModel && skuBizModel.skuInfoMap
      ? skuBizModel.skuInfoMap
      : {};
    var originalMap = skuBizModel && skuBizModel.originalSkuInfoMap
      ? skuBizModel.originalSkuInfoMap
      : {};
    if (!Object.keys(infoMap).length && Object.keys(originalMap).length) {
      infoMap = originalMap;
    }
    var priceScale = skuBizModel && skuBizModel.skuPriceScale
      ? skuBizModel.skuPriceScale
      : "";
    var imageMap = buildSkuImageMap(skuBizModel ? skuBizModel.skuProps : []);
    var names = Array.isArray(propertyNames) ? propertyNames : [];
    var keys = Object.keys(infoMap);
    for (var index = 0; index < keys.length; index += 1) {
      var item = infoMap[keys[index]] || {};
      var originalItem = findOriginalSkuItem(originalMap, keys[index], item.skuId);
      var price = normalizeSkuPriceValue(
        item.price
          || item.skuPrice
          || item.multiPrice
          || item.salePrice
          || originalItem.price
          || originalItem.skuPrice
          || originalItem.multiPrice
          || originalItem.salePrice
          || priceScale
      );
      var discountPrice = normalizeSkuPriceValue(
        item.discountPrice
          || item.promotionPrice
          || originalItem.discountPrice
          || originalItem.promotionPrice
          || price
      );
      var spec = splitSkuSpec(item.specAttrs);
      var weight = read1688SkuValue(item, originalItem, ["sku_weight", "skuWeight", "weight", "weightKg", "重量"]);
      var length = read1688SkuDimension(item, originalItem, ["sku_length", "skuLength", "length_cm", "lengthCm", "length", "dimensionLength", "packageLength", "长"]);
      var width = read1688SkuDimension(item, originalItem, ["sku_width", "skuWidth", "width_cm", "widthCm", "width", "dimensionWidth", "packageWidth", "宽"]);
      var height = read1688SkuDimension(item, originalItem, ["sku_height", "skuHeight", "height_cm", "heightCm", "height", "dimensionHeight", "packageHeight", "高"]);
      result.push({
        skuId: item.skuId,
        subSku1: formatSkuProperty(names[0] || spec.firstName, spec.first),
        subSku2: formatSkuProperty(names[1] || spec.secondName, spec.second),
        specAttrs: item.specAttrs,
        price: price,
        discountPrice: discountPrice,
        stock: item.canBookCount,
        sku_weight: weight,
        sku_length: length,
        sku_width: width,
        sku_height: height,
        saleCount: item.saleCount,
        specId: item.specId,
        imageUrl: imageMap[spec.first] || imageMap[item.specAttrs] || ""
      });
    }
    return result;
  }

  /** Normalize an image URL read from the rendered 1688 DOM. */
  function normalizeDomImageUrl(rawUrl) {
    var source = String(rawUrl || "").trim();
    if (!source || source === "undefined" || source === "null" || source.indexOf("data:") === 0) {
      return "";
    }
    source = source.replace(/&amp;/g, "&");
    if (source.indexOf("//") === 0) {
      source = location.protocol + source;
    }
    try {
      source = new URL(source, location.href).href;
    } catch (error) {
      return "";
    }
    if (!/^https?:\/\//i.test(source) || /\.(svg|ico)(\?|$)/i.test(source)) {
      return "";
    }
    return source;
  }

  /** Add one DOM image URL to a de-duplicated list. */
  function appendDomImageUrl(list, seen, rawUrl) {
    var imageUrl = normalizeDomImageUrl(rawUrl);
    if (!imageUrl || seen[imageUrl]) {
      return;
    }
    seen[imageUrl] = true;
    list.push(imageUrl);
  }

  /** Read the main and carousel images from the rendered product gallery. */
  function readDomImageUrls() {
    var result = [];
    var seen = {};
    var selectors = [
      '#gallery .od-gallery-preview .od-gallery-list > li img.preview-img',
      '[data-module="od_picture_gallery"] .od-gallery-preview .od-gallery-list > li img.preview-img',
      '#gallery .od-gallery-preview .od-gallery-list > li video[poster]',
      '[data-module="od_picture_gallery"] .od-gallery-preview .od-gallery-list > li video[poster]'
    ];
    for (var selectorIndex = 0; selectorIndex < selectors.length; selectorIndex += 1) {
      var nodes = document.querySelectorAll(selectors[selectorIndex]);
      for (var nodeIndex = 0; nodeIndex < nodes.length; nodeIndex += 1) {
        var node = nodes[nodeIndex];
        var rawUrl = node.poster
          || node.currentSrc
          || node.src
          || node.getAttribute("data-src")
          || node.getAttribute("data-original")
          || node.getAttribute("data-lazy-src")
          || "";
        appendDomImageUrl(
          result,
          seen,
          rawUrl
        );
        if (result.length >= 100) {
          return result;
        }
      }
    }
    return result;
  }

  /** Read a clean text value from the first matching DOM element. */
  function readDomText(selectors) {
    var selectorList = Array.isArray(selectors) ? selectors : [];
    for (var selectorIndex = 0; selectorIndex < selectorList.length; selectorIndex += 1) {
      var nodes = document.querySelectorAll(selectorList[selectorIndex]);
      for (var nodeIndex = 0; nodeIndex < nodes.length; nodeIndex += 1) {
        var text = String(nodes[nodeIndex].innerText || nodes[nodeIndex].textContent || "")
          .replace(/\s+/g, " ")
          .trim();
        if (text) {
          return text;
        }
      }
    }
    return "";
  }

  /** Read the product title from the rendered 1688 product title module. */
  function readDomProductName() {
    var productName = readDomText([
      '[data-module="od_title"] h1',
      '#title .module-od-title h1',
      '.module-od-title h1'
    ]);
    if (productName) {
      return productName;
    }
    var title = String(document.title || "").replace(/\s*-\s*阿里巴巴.*$/i, "");
    return title.replace(/\s+/g, " ").trim();
  }

  /** Read the visible shop name and shop URL from the rendered page. */
  function readDomShop() {
    var shopLink = document.querySelector("a.shop-company-name");
    var shopName = shopLink
      ? String(shopLink.innerText || shopLink.textContent || "").replace(/\s+/g, " ").trim()
      : "";
    return {
      shopName: shopName,
      shopUrl: shopLink ? shopLink.href || "" : ""
    };
  }

  /** Read the first visible product price from the rendered price module. */
  function readDomPrice() {
    var priceText = readDomText([
      "#mainPrice .price-info",
      "#mainPrice .price-comp",
      ".module-od-main-price .price-info"
    ]);
    var match = priceText.match(/[¥￥]\s*([0-9]+(?:\.[0-9]+)?)/);
    return match ? match[1] : "";
  }

  /** Read the SKU property labels visible in the rendered SKU module. */
  function readDomSkuPropName() {
    var nodes = document.querySelectorAll(
      '[data-module="od_sku_selection"] .feature-item-label h3, #skuSelection .feature-item-label h3'
    );
    var values = [];
    var seen = {};
    for (var index = 0; index < nodes.length; index += 1) {
      var value = String(nodes[index].innerText || nodes[index].textContent || "")
        .replace(/\s+/g, " ")
        .trim();
      if (value && !seen[value]) {
        seen[value] = true;
        values.push(value);
      }
    }
    return values.join(";");
  }

  /** Read clean text from an individual SKU option node. */
  function readDomSkuOptionText(node) {
    var labelNode = node.querySelector(
      ".item-label, .sku-item-label, .sku-name, .ant-radio-button-wrapper-content"
    );
    var value = labelNode
      ? String(labelNode.getAttribute("title") || labelNode.innerText || labelNode.textContent || "")
      : String(node.getAttribute("title") || node.getAttribute("aria-label") || node.innerText || node.textContent || "");
    return value.replace(/\s+/g, " ").trim();
  }

  /** Convert one visible SKU option node into a normalized option object. */
  function normalizeDomSkuOption(node) {
    var value = readDomSkuOptionText(node);
    var priceText = readDomTextFromNode(node, [".item-price-stock", ".item-price"]);
    var priceMatch = priceText.match(/[¥￥]\s*([0-9]+(?:\.[0-9]+)?)/);
    var stockMatch = String(node.innerText || node.textContent || "").match(/库存\s*([0-9]+)/);
    var imageNode = node.querySelector("img");
    return {
      value: value,
      price: priceMatch ? priceMatch[1] : "",
      stock: stockMatch ? stockMatch[1] : "",
      imageUrl: imageNode
        ? normalizeDomImageUrl(imageNode.currentSrc || imageNode.src || imageNode.getAttribute("data-src"))
        : ""
    };
  }

  /** Read SKU option groups and create at most a two-dimensional product matrix. */
  function readDomFeatureSkuRows() {
    var featureNodes = document.querySelectorAll(
      '[data-module="od_sku_selection"] .feature-item, #skuSelection .feature-item, .module-od-sku-selection .feature-item'
    );
    var groups = [];
    for (var featureIndex = 0; featureIndex < featureNodes.length && groups.length < 2; featureIndex += 1) {
      var featureNode = featureNodes[featureIndex];
      var propName = readDomTextFromNode(featureNode, [".feature-item-label h3"]);
      if (!propName) {
        continue;
      }
      var optionNodes = featureNode.querySelectorAll(".expand-view-item");
      if (!optionNodes.length) {
        optionNodes = featureNode.querySelectorAll(
          ".sku-item, .sku-item-label, .ant-radio-wrapper, .ant-radio-button-wrapper, [data-value], [data-sku-value]"
        );
      }
      var options = [];
      var seen = {};
      for (var optionIndex = 0; optionIndex < optionNodes.length; optionIndex += 1) {
        var option = normalizeDomSkuOption(optionNodes[optionIndex]);
        if (!option.value || option.value === propName || seen[option.value]) {
          continue;
        }
        seen[option.value] = true;
        options.push(option);
      }
      if (options.length) {
        groups.push({ name: propName, options: options });
      }
    }
    if (!groups.length) {
      return [];
    }

    var result = [];
    var firstGroup = groups[0];
    var secondGroup = groups.length > 1 ? groups[1] : null;
    for (var firstIndex = 0; firstIndex < firstGroup.options.length; firstIndex += 1) {
      var firstOption = firstGroup.options[firstIndex];
      if (!secondGroup) {
        result.push({
          skuId: "",
          subSku1: formatSkuProperty(firstGroup.name, splitSkuSpec(firstOption.value).first),
          subSku2: "",
          specAttrs: firstOption.value,
          price: firstOption.price || readDomPrice(),
          discountPrice: "",
          stock: firstOption.stock,
          saleCount: "",
          specId: "",
          imageUrl: firstOption.imageUrl
        });
        continue;
      }
      for (var secondIndex = 0; secondIndex < secondGroup.options.length; secondIndex += 1) {
        var secondOption = secondGroup.options[secondIndex];
        result.push({
          skuId: "",
          subSku1: formatSkuProperty(firstGroup.name, splitSkuSpec(firstOption.value).first),
          subSku2: formatSkuProperty(secondGroup.name, splitSkuSpec(secondOption.value).first),
          specAttrs: firstOption.value + ";" + secondOption.value,
          price: firstOption.price || secondOption.price || readDomPrice(),
          discountPrice: "",
          stock: firstOption.stock || secondOption.stock,
          saleCount: "",
          specId: "",
          imageUrl: firstOption.imageUrl || secondOption.imageUrl
        });
      }
    }
    return result;
  }

  /** Read visible SKU rows from the rendered 1688 SKU selection module. */
  function readDomSkuRows() {
    var featureRows = readDomFeatureSkuRows();
    if (featureRows.length) {
      return featureRows;
    }
    return [{
      skuId: "",
      subSku1: "",
      subSku2: "",
      specAttrs: "",
      price: readDomPrice(),
      discountPrice: "",
      stock: "",
      saleCount: "",
      specId: "",
      imageUrl: ""
    }];
  }

  /** Read the visible product breadcrumb path from the 1688 detail page. */
  function readDomCategoryPath() {
    var selectors = [
      '[class*="breadcrumb"]',
      '[class*="bread-crumb"]',
      '[class*="crumb"]',
      '[data-spm-anchor-id*="breadcrumb"]'
    ];
    for (var selectorIndex = 0; selectorIndex < selectors.length; selectorIndex += 1) {
      var nodes = document.querySelectorAll(selectors[selectorIndex]);
      for (var nodeIndex = 0; nodeIndex < nodes.length; nodeIndex += 1) {
        var text = String(nodes[nodeIndex].innerText || nodes[nodeIndex].textContent || "")
          .replace(/\s+/g, " ")
          .trim();
        if (text && text.length < 300 && /[>›〉]/.test(text)) {
          return text;
        }
      }
    }
    return "";
  }

  /** Read text from a DOM node using the first matching child selector. */
  function readDomTextFromNode(node, selectors) {
    var selectorList = Array.isArray(selectors) ? selectors : [];
    for (var selectorIndex = 0; selectorIndex < selectorList.length; selectorIndex += 1) {
      var child = node.querySelector(selectorList[selectorIndex]);
      if (child) {
        return String(child.innerText || child.textContent || "").replace(/\s+/g, " ").trim();
      }
    }
    return "";
  }

  /** Read the current product values needed by the DOM fallback. */
  function indexDomSnapshot() {
    return {
      domProductName: readDomProductName(),
      domImageUrls: readDomImageUrls(),
      domDetailImageUrls: readDomDetailImageUrls(),
      domPrice: readDomPrice(),
      domSkuPropName: readDomSkuPropName(),
      domSkuRows: readDomSkuRows(),
      domCategoryPath: readDomCategoryPath(),
      domShop: readDomShop()
    };
  }

  /** Append one non-empty SKU property name without creating duplicates. */
  function appendSkuPropertyName(list, value) {
    var name = String(value || "").replace(/\s+/g, " ").trim();
    if (name && list.length < 2 && list.indexOf(name) < 0) {
      list.push(name);
    }
  }

  /** Resolve the two SKU property names from the known 1688 skuProps array only. */
  function getSkuPropNames(skuBizModel, selectorModel) {
    var result = [];
    var models = [skuBizModel, selectorModel];
    for (var modelIndex = 0; modelIndex < models.length && result.length < 2; modelIndex += 1) {
      var model = models[modelIndex];
      var skuProps = model && Array.isArray(model.skuProps) ? model.skuProps : [];
      for (var propIndex = 0; propIndex < skuProps.length && result.length < 2; propIndex += 1) {
        var property = skuProps[propIndex] || {};
        appendSkuPropertyName(result, property.prop);
      }
    }
    return result;
  }

  /** Read product detail images already mounted in the rendered 1688 detail section. */
  function readDomDetailImageUrls() {
    var result = [];
    var seen = {};
    var selectors = [
      '#detail img',
      '#description img',
      '.module-od-detail img',
      '[data-module*="detail"] img',
      '[class*="offer-detail"] img',
      '[class*="product-detail"] img',
      '[class*="description"] img'
    ];
    for (var selectorIndex = 0; selectorIndex < selectors.length; selectorIndex += 1) {
      var nodes = document.querySelectorAll(selectors[selectorIndex]);
      for (var nodeIndex = 0; nodeIndex < nodes.length; nodeIndex += 1) {
        var image = nodes[nodeIndex];
        if (image.closest && image.closest('#gallery, [data-module*="gallery"], [data-module*="sku"], .od-gallery')) {
          continue;
        }
        var rawUrl = image.currentSrc
          || image.src
          || image.getAttribute("data-src")
          || image.getAttribute("data-original")
          || image.getAttribute("data-lazy-src")
          || image.getAttribute("data-ks-lazyload")
          || "";
        appendDomImageUrl(result, seen, rawUrl);
        if (result.length >= 100) {
          return result;
        }
      }
    }
    return result;
  }

  /** Read captured responses and assemble the relevant endpoint results. */
  function indexCapturedResponses(records) {
    var result = {
      skuBizModel: null,
      skuSource: "",
      embeddedSelectorModel: null,
      shopModel: null,
      statistics: null,
      currentOffer: null,
      logistics: null,
      attributes: null,
      reviews: null,
      reviewList: null
    };
    for (var index = 0; index < records.length; index += 1) {
      var record = records[index] || {};
      var response = parseResponseBody(record.responseBody);
      if (!response) {
        continue;
      }
      var path = getPath(record);
      var serviceName = getServiceName(record);
      var responseSkuData = find1688SkuDataInObject(response);
      if (responseSkuData && (!result.skuBizModel
        || get1688SkuPriceCoverage(responseSkuData.skuBizModel)
          > get1688SkuPriceCoverage(result.skuBizModel))) {
        result.skuBizModel = responseSkuData.skuBizModel;
        result.embeddedSelectorModel = responseSkuData.selectorModel;
        result.skuSource = "network_json";
      }
      if (path.indexOf("queryofferskuselectormodel") >= 0) {
        var selectorData = getResponseData(response);
        if (selectorData.skuSelectorBizModel && has1688SkuInfoModel(
          selectorData.skuSelectorBizModel.skuSelectorModel || selectorData.skuSelectorBizModel
        )) {
          result.skuBizModel = selectorData.skuSelectorBizModel.skuSelectorModel
            || selectorData.skuSelectorBizModel;
          result.embeddedSelectorModel = selectorData.skuSelectorBizModel.skuSelectorModel
            || selectorData.skuSelectorBizModel;
          result.skuSource = "network_json";
        }
      } else if (path.indexOf("moga.pc.shopcard") >= 0) {
        var shopData = getResponseData(response);
        result.shopModel = shopData.model || null;
      } else if (path.indexOf("pc.plugin.od.data.query") >= 0) {
        result.statistics = getResponseData(response);
      } else if (path.indexOf("queryitemratedlistv2") >= 0) {
        result.reviewList = getOfferDetailResult(response);
      } else if (serviceName === "pcOdRateCardInfoMergeService") {
        result.reviews = getOfferDetailResult(response);
      } else if (serviceName === "compareOfferSelectListService") {
        var compareResult = getOfferDetailResult(response);
        result.currentOffer = compareResult.currentOffer || null;
      } else if (serviceName === "offerLogisticsService") {
        result.logistics = getOfferDetailResult(response);
      } else if (serviceName === "decisionAttrService") {
        var attrResult = getOfferDetailResult(response);
        result.attributes = attrResult.offerDecisionAttrs || attrResult;
      }
    }
    return result;
  }

  /** Build the normalized product object used by the batch and CSV exporter. */
  function normalize1688Data(indexed, records, domSnapshot, pageContextData) {
    var skuBizModel = indexed.skuBizModel || {};
    var selectorModel = skuBizModel.skuSelectorModel || indexed.embeddedSelectorModel || {};
    var galleryFields = pageContextData && pageContextData.gallery
      && pageContextData.gallery.fields
      ? pageContextData.gallery.fields
      : {};
    var dataJson = pageContextData && pageContextData.Root
      && pageContextData.Root.fields
      && pageContextData.Root.fields.dataJson
      ? pageContextData.Root.fields.dataJson
      : {};
    var tempModel = dataJson.tempModel || {};
    var productTitleFields = pageContextData && pageContextData.productTitle
      && pageContextData.productTitle.fields
      ? pageContextData.productTitle.fields
      : {};
    var shopInfo = productTitleFields.shopInfo || {};
    var rateInfo = productTitleFields.rateInfo || {};
    var shippingFields = pageContextData && pageContextData.shippingServices
      && pageContextData.shippingServices.fields
      ? pageContextData.shippingServices.fields
      : {};
    var memoryShopModel = {
      shopName: shopInfo.companyName || tempModel.companyName || "",
      shopUrl: tempModel.winportUrl || "",
      starNum: rateInfo.goodsGrade || "",
      shopButton: {},
      mainCategoryName: ""
    };
    var memoryStatistics = {
      categoryName: "",
      categoryListName: "",
      totalSales: tempModel.saledCount || "",
      totalOrder: "",
      goodRates: rateInfo.goodRates
    };
    var memoryLogistics = shippingFields.deliveryLimitTimeModel || {};
    var memoryReviews = {
      rateAverageStarLevel: rateInfo.goodsGrade,
      commentTotalNum: rateInfo.commonTagNodeList
        && rateInfo.commonTagNodeList[0]
        ? rateInfo.commonTagNodeList[0].count
        : ""
    };
    var memoryAttributes = galleryFields.CpvEnhance
      && Array.isArray(galleryFields.CpvEnhance.decisionCpv)
      ? galleryFields.CpvEnhance.decisionCpv
      : [];
    var categoryPath = indexed.statistics && indexed.statistics.categoryListName
      ? indexed.statistics.categoryListName
      : domSnapshot && domSnapshot.domCategoryPath
        ? domSnapshot.domCategoryPath
        : "";
    var mainImageList = Array.isArray(galleryFields.mainImage)
      ? galleryFields.mainImage
      : [];
    if (!mainImageList.length && Array.isArray(selectorModel.mainImageList)) {
      mainImageList = selectorModel.mainImageList;
    }
    if (!mainImageList.length && Array.isArray(selectorModel.images)) {
      mainImageList = selectorModel.images;
    }
    var galleryUrls = [];
    for (var imageIndex = 0; imageIndex < mainImageList.length; imageIndex += 1) {
      var image = mainImageList[imageIndex] || {};
      var imageUrl = typeof image === "string"
        ? image
        : image.fullPathImageURI || image.imageURI || "";
      if (imageUrl) {
        galleryUrls.push(imageUrl);
      }
    }
    var detailImageUrls = read1688DetailImageUrls();
    if (!detailImageUrls.length && domSnapshot && Array.isArray(domSnapshot.domDetailImageUrls)) {
      detailImageUrls = domSnapshot.domDetailImageUrls.slice();
    }
    var descriptionFields = pageContextData && pageContextData.description
      && pageContextData.description.fields
      ? pageContextData.description.fields
      : {};
    var detailDescriptionUrl = descriptionFields.detailUrl || "";

    var currentOffer = indexed.currentOffer || {};
    var offerBaseInfo = dataJson.offerBaseInfo || selectorModel.offerBaseInfo || {};
    var offerId = getNumericOfferId(tempModel.offerId)
      || getNumericOfferId(selectorModel.offerId)
      || getNumericOfferId(offerBaseInfo.offerId)
      || getNumericOfferId(getOfferId());
    if (!galleryUrls.length && domSnapshot && Array.isArray(domSnapshot.domImageUrls)) {
      galleryUrls = domSnapshot.domImageUrls.slice();
    }
    var productName = tempModel.offerTitle
      || pageContextData && pageContextData.productTitle
      && pageContextData.productTitle.fields
      && pageContextData.productTitle.fields.title
      || domSnapshot && domSnapshot.domProductName
      || currentOffer.title
      || document.title.replace(/\s*-\s*阿里巴巴.*$/i, "").trim();
    var tradeModel = selectorModel.tradeModel || {};
    var shopModel = indexed.shopModel || memoryShopModel || domSnapshot && domSnapshot.domShop || {};
    var statistics = indexed.statistics || memoryStatistics;
    var logistics = indexed.logistics || memoryLogistics;
    var reviewResult = indexed.reviews || memoryReviews;
    var reviewListResult = indexed.reviewList || {};
    var reviewList = Array.isArray(reviewListResult.model) ? reviewListResult.model : [];
    var reviewModel = reviewResult.model
      || reviewResult.offerRateInfo && reviewResult.offerRateInfo.model
      || reviewResult.newOfferRateInfo && reviewResult.newOfferRateInfo.model
      || reviewResult
      || {};
    var skuPropNames = getSkuPropNames(skuBizModel, selectorModel);
    var skuRows = buildSkuRows(skuBizModel, skuPropNames);

    return {
      offerId: offerId,
      productName: productName,
      offerMeta: {
        sellerUserId: offerBaseInfo.sellerUserId || "",
        sellerLoginId: offerBaseInfo.sellerLoginId || "",
        sellerMemberId: offerBaseInfo.sellerMemberId || "",
        categoryId: offerBaseInfo.catId || "",
        tradeTemplateId: offerBaseInfo.tradeTemplateId || "",
        sellerWinportUrl: offerBaseInfo.sellerWinportUrl || ""
      },
      productCategory: categoryPath,
      mainImageUrl: galleryUrls.length ? galleryUrls[0] : currentOffer.imageUrl || "",
      galleryImageUrls: galleryUrls,
      detailDescriptionUrl: detailDescriptionUrl,
      detailImageUrls: detailImageUrls,
      skuPropName: skuPropNames.join(";"),
      skuPropNames: skuPropNames,
      skuRows: skuRows,
      skuCount: skuRows.length,
      shop: {
        name: shopModel.shopName || "",
        url: shopModel.shopUrl || "",
        star: shopModel.starNum,
        fans: shopModel.shopButton ? shopModel.shopButton.fuzzyFavCount : "",
        mainCategory: shopModel.mainCategoryName || ""
      },
      statistics: {
        category: statistics.categoryName || "",
        categoryPath: statistics.categoryListName || "",
        totalSales: statistics.totalSales || "",
        totalOrder: statistics.totalOrder || "",
        goodRates: statistics.goodRates
      },
      delivery: {
        expectTimeDesc: logistics.expectTimeDesc || "",
        limitTimeDay: logistics.limitTimeDay
      },
      reviews: {
        score: reviewModel.rateAverageStarLevel,
        count: reviewModel.commentTotalNum || String(reviewList.length || "")
      },
      attributes: Array.isArray(indexed.attributes) ? indexed.attributes : memoryAttributes,
      rawJson: {
        skuSelectorBizModel: {
          offerId: selectorModel.offerId,
          mainImageList: mainImageList,
          skuProps: skuBizModel.skuProps || [],
          skuInfoMap: skuBizModel.skuInfoMap || {},
          tradeModel: tradeModel
        },
        currentOffer: currentOffer,
        shopModel: shopModel,
        statistics: statistics,
        logistics: logistics,
        detailDescription: {
          detailUrl: detailDescriptionUrl,
          imageUrls: detailImageUrls
        },
        attributes: Array.isArray(indexed.attributes) ? indexed.attributes : memoryAttributes,
        reviews: reviewResult,
        reviewList: reviewList
      },
      pageUrl: location.href,
      capturedAt: new Date().toISOString(),
      capturedResponseCount: records.length,
      collectionMode: indexed.skuSource === "network_json"
        ? "network_json_dom"
        : indexed.skuSource === "embedded_json"
          ? "embedded_json_dom"
          : "dom_html"
    };
  }

  /** Read the executed page state before normalization. */
  var records = [];
  if (location.hostname !== "detail.1688.com") {
    return { ok: false, error: "当前页面不是 1688 商品详情页。" };
  }
  var domSnapshot = indexDomSnapshot();
  var indexed = {
    skuBizModel: null,
    skuSource: "",
    embeddedSelectorModel: null,
    shopModel: null,
    statistics: null,
    currentOffer: null,
    logistics: null,
    attributes: null,
    reviews: null,
    reviewList: null
  };
  var pageContextData = readEmbedded1688PageContextData();
  var embeddedSkuData = readEmbedded1688SkuData();
  if (embeddedSkuData) {
    indexed.skuBizModel = embeddedSkuData.skuBizModel;
    indexed.embeddedSelectorModel = embeddedSkuData.selectorModel;
    indexed.skuSource = "embedded_json";
  }
  if (!indexed.skuBizModel && !domSnapshot.domProductName && !domSnapshot.domImageUrls.length) {
    return { ok: false, error: "1688 商品 DOM 尚未加载完成，请等待页面加载后重试。" };
  }
  return { ok: true, data: normalize1688Data(indexed, records, domSnapshot, pageContextData) };
}
