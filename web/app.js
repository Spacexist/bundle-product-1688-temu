const { createApp } = Vue;

/** Resolve one versioned backend API path from public frontend configuration. */
function apiUrl(pathname) {
  const config = window.APP_CONFIG || {};
  return String(config.apiBaseUrl || "http://127.0.0.1:3000/api/v1").replace(/\/$/, "") + pathname;
}

/** Convert any value into a readable display string. */
function displayValue(value) {
  if (value === null || value === undefined || value === "") {
    return "—";
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}

/** Return a safe array for a JSON field. */
function asArray(value) {
  return Array.isArray(value) ? value : [];
}

/** Return one readable message from the shared API error envelope. */
function getApiErrorMessage(payload, fallbackMessage) {
  const error = payload && payload.error;
  if (typeof error === "string") {
    return error;
  }
  if (error && typeof error === "object" && error.message) {
    return String(error.message);
  }
  return String(fallbackMessage || "请求失败。");
}

/** Return one stable error code from a failed workflow request. */
function getWorkflowErrorCode(error) {
  return String(error && (error.code || error.statusCode) || "REQUEST_FAILED");
}

/** Unwrap one shared API response while retaining compatibility with raw data payloads. */
function readApiData(payload) {
  if (payload && Object.prototype.hasOwnProperty.call(payload, "data")) {
    return payload.data;
  }
  return payload;
}

/** Read URL values from a collector image array without altering their order. */
function readStoredImageUrls(value) {
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

/** Split one normalized SKU specification into its property name and value. */
function parseSkuSpecValue(rawValue, fallbackName) {
  const raw = String(rawValue || "").trim();
  if (!raw) {
    return { name: fallbackName, value: "" };
  }
  const separatorIndex = raw.indexOf(":");
  if (separatorIndex > 0) {
    return {
      name: raw.slice(0, separatorIndex).trim() || fallbackName,
      value: raw.slice(separatorIndex + 1).trim()
    };
  }
  return { name: fallbackName, value: raw };
}

/** Collect at most two distinct SKU specification groups from one product. */
function collectSkuSpecGroups(record) {
  const result = [];
  const rows = asArray(record && record.sku);
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex] || {};
    for (let specIndex = 0; specIndex < 2; specIndex += 1) {
      const rawValue = specIndex === 0 ? row.SubSku1 : row.SubSku2;
      const parsed = parseSkuSpecValue(rawValue, "SubSku" + (specIndex + 1));
      if (!parsed.value) {
        continue;
      }
      let group = null;
      for (let groupIndex = 0; groupIndex < result.length; groupIndex += 1) {
        if (result[groupIndex].name === parsed.name) {
          group = result[groupIndex];
          break;
        }
      }
      if (!group) {
        if (result.length >= 2) {
          continue;
        }
        group = { name: parsed.name, values: [] };
        result.push(group);
      }
      if (group.values.indexOf(parsed.value) < 0) {
        group.values.push(parsed.value);
      }
    }
  }
  return result;
}

/** Build a stable key for one SKU row while preserving the source identifiers. */
function buildSkuKey(record, sku, index) {
  const product = record || {};
  const item = sku || {};
  return [product.main_id, product.platform_id, item.sku_id || "", index].join("|");
}

/** Create the identifier-only endpoint saved in the mapping JSON. */
function getSkuReference(record, sku, index) {
  const product = record || {};
  const item = sku || {};
  return {
    main_id: product.main_id,
    platform_id: product.platform_id,
    product_id: product.product_id,
    sku_id: item.sku_id || "",
    sku_index: index
  };
}

/** Parse a price-like value into a number while preserving empty values. */
function parseSkuPrice(value) {
  const text = String(value === undefined || value === null ? "" : value).trim();
  if (!text) {
    return null;
  }
  const normalized = text.replace(/[^0-9.-]/g, "");
  if (!normalized || normalized === "-" || normalized === ".") {
    return null;
  }
  const amount = Number(normalized);
  return Number.isFinite(amount) ? amount : null;
}

/** Build one compact RMB price reference for intelligent-packing recommendations. */
function getWorkflowPriceReference(record) {
  const source = record || {};
  const rows = Array.isArray(source.sku) ? source.sku : [];
  const values = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index] || {};
    const value = parseSkuPrice(row.sku_price !== undefined ? row.sku_price : row.price);
    if (value !== null && value >= 0) {
      values.push(value);
    }
  }
  if (!values.length) {
    return { available: false, currency: "CNY", min: null, max: null, typical: null, sample_count: 0 };
  }
  for (let start = 0; start < values.length - 1; start += 1) {
    let smallest = start;
    for (let index = start + 1; index < values.length; index += 1) {
      if (values[index] < values[smallest]) {
        smallest = index;
      }
    }
    if (smallest !== start) {
      const temporary = values[start];
      values[start] = values[smallest];
      values[smallest] = temporary;
    }
  }
  const middle = Math.floor(values.length / 2);
  const typical = values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
  return {
    available: true,
    currency: "CNY",
    min: Number(values[0].toFixed(2)),
    max: Number(values[values.length - 1].toFixed(2)),
    typical: Number(typical.toFixed(2)),
    sample_count: values.length
  };
}

/** Add one 1688 price to a Temu price without losing non-numeric text. */
function addSkuPriceValues(currentValue, addedValue) {
  const currentText = String(currentValue === undefined || currentValue === null ? "" : currentValue).trim();
  const addedText = String(addedValue === undefined || addedValue === null ? "" : addedValue).trim();
  if (!addedText) {
    return currentValue === undefined ? "" : currentValue;
  }
  if (!currentText) {
    return addedValue;
  }
  const currentPrice = parseSkuPrice(currentText);
  const addedPrice = parseSkuPrice(addedText);
  if (currentPrice !== null && addedPrice !== null) {
    return Number((currentPrice + addedPrice).toFixed(2));
  }
  return currentText + " + " + addedText;
}

/** Build a stable key for one dragged 1688 SKU source row. */
function getAliSkuSourceKey(sku) {
  const item = sku || {};
  const skuId = item.sku_id || item.skuId || "";
  if (skuId) {
    return String(skuId);
  }
  return [item.SubSku1 || item.subSku1 || "", item.SubSku2 || item.subSku2 || "", item.sku_price || item.price || ""].join("|");
}

/** Format the current time without ISO T/Z characters. */
function formatCollectedAt(date) {
  const value = new Date(date);
  /** Pad one date or time segment to two characters. */
  const pad = function padTimePart(number) {
    return String(number).padStart(2, "0");
  };
  return value.getFullYear() + "-"
    + pad(value.getMonth() + 1) + "-"
    + pad(value.getDate()) + " "
    + pad(value.getHours()) + ":"
    + pad(value.getMinutes()) + ":"
    + pad(value.getSeconds());
}

/** Resolve one intelligent-packing API URL from public frontend configuration. */
function workflowApiUrl(pathname) {
  const config = window.APP_CONFIG || {};
  return String(config.apiBaseUrl || "http://127.0.0.1:3000/api/v1").replace(/\/$/, "") + pathname;
}

/** Send one workflow JSON request and reject unsuccessful server responses. */
function requestWorkflowJson(url, options) {
  return fetch(url, options).then(function parseWorkflowResponse(response) {
    return response.json().then(function validateWorkflowPayload(payload) {
      if (!response.ok || !payload || payload.ok === false) {
        const apiError = payload && payload.error && typeof payload.error === "object" ? payload.error : {};
        const error = new Error(getApiErrorMessage(payload, "智能组货请求失败。"));
        error.code = String(apiError.code || "REQUEST_FAILED");
        error.statusCode = Number(response.status || 500);
        error.requestId = payload && payload.meta ? String(payload.meta.request_id || "") : "";
        throw error;
      }
      return readApiData(payload);
    });
  });
}

const VIEW_STATE_STORAGE_KEY = "pod-auto-build.view-state";
const CAROUSEL_UNDO_STORAGE_KEY = "pod-auto-build.carousel-undo";
const WORKFLOW_INDICATOR_ACK_STORAGE_KEY = "pod-auto-build.workflow-indicator-ack";

/** Read the last workbench selection without breaking startup when browser storage is unavailable. */
function readPersistedViewState() {
  try {
    const raw = window.localStorage.getItem(VIEW_STATE_STORAGE_KEY);
    const state = raw ? JSON.parse(raw) : {};
    return state && typeof state === "object" ? state : {};
  } catch (error) {
    return {};
  }
}

/** Read durable carousel undo tokens retained by this browser. */
function readCarouselUndoTokens() {
  try {
    const raw = window.localStorage.getItem(CAROUSEL_UNDO_STORAGE_KEY);
    const tokens = raw ? JSON.parse(raw) : {};
    return tokens && typeof tokens === "object" ? tokens : {};
  } catch (error) {
    return {};
  }
}

/** Read durable intelligent-packing indicator acknowledgements retained by this browser. */
function readWorkflowIndicatorAcknowledgements() {
  try {
    const raw = window.localStorage.getItem(WORKFLOW_INDICATOR_ACK_STORAGE_KEY);
    const acknowledgements = raw ? JSON.parse(raw) : {};
    return acknowledgements && typeof acknowledgements === "object" ? acknowledgements : {};
  } catch (error) {
    return {};
  }
}

/** Reusable running/completed task indicator shared by image and SKU workflows. */
const TaskStatusIndicator = {
  props: {
    tone: { type: String, default: "green" },
    pulse: { type: Boolean, default: false },
    complete: { type: Boolean, default: false },
    error: { type: Boolean, default: false },
    label: { type: String, default: "打开任务" }
  },
  emits: ["activate"],
  template: `<span class="task-status-indicator" :class="['is-' + tone, { 'is-pulse': pulse, 'is-complete': complete && !error, 'is-error': error }]" role="button" tabindex="0" :title="label" :aria-label="label" @click.stop="$emit('activate')" @keydown.enter.stop="$emit('activate')">{{ error ? '!' : pulse ? '' : complete ? '✓' : '' }}</span>`
};

const app = createApp({
  template: `
    <div class="shell">
      <header class="topbar" :class="{ 'is-collapsed': topbarCollapsed }">
        <div class="toolbar">
          <button class="mode-button glass-action-button" :class="{ active: workspaceMode === 'smart' }" type="button" @click="changeWorkspaceMode('smart')">组货模式</button>
          <button class="mode-button glass-action-button" :class="{ active: workspaceMode === 'realtime' }" type="button" @click="changeWorkspaceMode('realtime')">工作台</button>
          <button class="mode-button glass-action-button" type="button" :disabled="!temuRecords.length || miaoshouExportBusy" @click="exportMiaoshouZip">{{ miaoshouExportBusy ? '妙手导出中…' : '导出妙手 ZIP' }}</button>
          <label class="mode-button restore-button glass-action-button">
            备份恢复
            <input type="file" accept="application/json,.json" @change="handleRestoreFile">
          </label>
        </div>
      </header>

      <main class="content">
        <div v-if="!records.length" class="panel empty">{{ renderMode === 'realtime' ? '等待扩展采集商品并写入本地 cache。' : '请先导入统一 JSON 文件。' }}</div>
        <div v-else class="render-layout">
          <aside class="panel listing-rail">
            <div class="listing-rail-heading"><div class="listing-cache-actions"><button class="glass-action-button" type="button" @click="clearEntireCache">清空</button></div></div>
            <button
              v-for="record in temuRecords"
              :key="record.main_id"
              class="listing-card"
              :class="{ active: selectedTemuRecord && String(record.main_id) === String(selectedTemuRecord.main_id) }"
              type="button"
              @click="selectTemuRecord(record)"
            >
              <img v-if="record.main_image_url" :src="imageSource(record.main_image_url)" referrerpolicy="no-referrer" alt="Temu 主图">
              <span v-else class="listing-image-empty">—</span>
              <span class="listing-copy"><span>{{ record.product_name }}</span></span>
              <span class="listing-card-delete" role="button" tabindex="0" aria-label="删除此 Temu 商品" @click.stop="deleteSelectedTemuRecord(record)" @keydown.enter.stop="deleteSelectedTemuRecord(record)">×</span>
              <span v-if="hasWorkflowTask(record) || hasOpenableDirectImageTask(record) || hasOpenableCarouselTask(record) || hasSkuBlendTask(record) || hasCompletedSkuBlendTask(record) || hasSkuBlendError(record)" class="task-status-indicators listing-task-status-indicators"><task-status-indicator v-if="hasWorkflowTask(record)" tone="blue" :complete="isWorkflowTaskComplete(record)" :error="hasWorkflowTaskError(record)" :label="hasWorkflowTaskError(record) ? '打开失败的组货任务' : isWorkflowTaskComplete(record) ? '打开已完成的组货任务' : '打开进行中的组货任务'" @activate="openWorkflowTask(record)"></task-status-indicator><task-status-indicator v-if="hasOpenableDirectImageTask(record)" tone="green" :pulse="true" :complete="isDirectImageTaskComplete(record)" :error="hasDirectImageTaskError(record)" :label="hasDirectImageTaskError(record) ? '打开失败的单图 Edits 任务' : '打开单图 Edits 任务'" @activate="openRetainedDirectImageEditor(record)"></task-status-indicator><task-status-indicator v-if="hasOpenableCarouselTask(record)" tone="violet" :complete="isCarouselTaskComplete(record)" :error="hasCarouselTaskError(record)" :label="hasCarouselTaskError(record) ? '打开失败的 Fusion 任务' : '打开 Fusion 任务'" @activate="openRetainedCarouselEditor(record)"></task-status-indicator><task-status-indicator v-if="hasSkuBlendTask(record) || hasCompletedSkuBlendTask(record) || hasSkuBlendError(record)" tone="yellow" :complete="hasCompletedSkuBlendTask(record)" :error="hasSkuBlendError(record)" :label="hasSkuBlendError(record) ? '打开失败的 SKU 溶图任务' : '打开 SKU 溶图任务'" @activate="openSkuBlendTask(record)"></task-status-indicator></span>
            </button>
            <div v-if="!temuRecords.length" class="muted">暂无 Temu 商品。</div>
          </aside>

          <section v-if="selectedTemuRecord" class="panel platform-render temu-render">
            <div class="render-heading"><div><span class="platform-label temu-label">Temu</span><span v-if="hasWorkflowTask(selectedTemuRecord) || hasOpenableDirectImageTask(selectedTemuRecord) || hasOpenableCarouselTask(selectedTemuRecord) || hasSkuBlendTask(selectedTemuRecord) || hasCompletedSkuBlendTask(selectedTemuRecord) || hasSkuBlendError(selectedTemuRecord)" class="task-status-indicators heading-task-status-indicators"><task-status-indicator v-if="hasWorkflowTask(selectedTemuRecord)" tone="blue" :complete="isWorkflowTaskComplete(selectedTemuRecord)" :error="hasWorkflowTaskError(selectedTemuRecord)" :label="hasWorkflowTaskError(selectedTemuRecord) ? '打开失败的组货任务' : isWorkflowTaskComplete(selectedTemuRecord) ? '打开已完成的组货任务' : '打开进行中的组货任务'" @activate="openWorkflowTask(selectedTemuRecord)"></task-status-indicator><task-status-indicator v-if="hasOpenableDirectImageTask(selectedTemuRecord)" tone="green" :pulse="true" :complete="isDirectImageTaskComplete(selectedTemuRecord)" :error="hasDirectImageTaskError(selectedTemuRecord)" :label="hasDirectImageTaskError(selectedTemuRecord) ? '打开失败的单图 Edits 任务' : '打开单图 Edits 任务'" @activate="openRetainedDirectImageEditor(selectedTemuRecord)"></task-status-indicator><task-status-indicator v-if="hasOpenableCarouselTask(selectedTemuRecord)" tone="violet" :complete="isCarouselTaskComplete(selectedTemuRecord)" :error="hasCarouselTaskError(selectedTemuRecord)" :label="hasCarouselTaskError(selectedTemuRecord) ? '打开失败的 Fusion 任务' : '打开 Fusion 任务'" @activate="openRetainedCarouselEditor(selectedTemuRecord)"></task-status-indicator><task-status-indicator v-if="hasSkuBlendTask(selectedTemuRecord) || hasCompletedSkuBlendTask(selectedTemuRecord) || hasSkuBlendError(selectedTemuRecord)" tone="yellow" :complete="hasCompletedSkuBlendTask(selectedTemuRecord)" :error="hasSkuBlendError(selectedTemuRecord)" :label="hasSkuBlendError(selectedTemuRecord) ? '打开失败的 SKU 溶图任务' : '打开 SKU 溶图任务'" @activate="openSkuBlendTask(selectedTemuRecord)"></task-status-indicator></span><div class="render-title-row"><button v-if="workspaceMode === 'realtime'" class="listing-merge-button listing-title-merge-button glass-action-button" :class="{ 'is-busy': listingMergeBusy }" type="button" :disabled="listingMergeBusy || !selected1688Record" title="这是AI合并标题" aria-label="这是AI合并标题" @click="mergeSelectedListings"><span class="listing-merge-triangle" aria-hidden="true"></span></button><input class="render-title-input" type="text" v-model="selectedTemuRecord.product_name" @change="saveProductModule(selectedTemuRecord, 'basic')" aria-label="Temu 商品名称"><button v-if="hasListingUndo(selectedTemuRecord)" class="operation-undo-button" type="button" :disabled="listingUndoBusy" @click="undoSelectedListing">{{ listingUndoBusy ? '返回中…' : '返回' }}</button><button v-if="hasCarouselUndo(selectedTemuRecord)" class="operation-undo-button" type="button" @click="undoCarouselReplacement(selectedTemuRecord)">恢复轮播替换</button></div><input class="render-category-input" type="text" v-model="selectedTemuRecord.product_category" @change="saveProductModule(selectedTemuRecord, 'basic')" placeholder="未提供商品分类" aria-label="Temu 商品分类"></div></div>
            <div class="render-gallery">
               <div class="gallery-thumbs" :class="{ 'is-image-drop-target': isImageDropTarget('temu-gallery') }" @dragenter.prevent.stop="setImageInteractionTarget('temu-gallery')" @dragover.prevent.stop="setImageInteractionTarget('temu-gallery')" @drop.prevent.stop="dropAliImageToTemuGallery($event, selectedTemuRecord)">
                <div v-for="(image, imageIndex) in galleryImages(selectedTemuRecord)" :key="image" class="thumb-item" draggable="true" :class="{ 'is-image-reorder-target': isImageReorderTarget('temu-gallery', imageIndex), 'is-image-drop-target': isImageDropTarget('temu-gallery', imageIndex), 'is-ai-selected': isTemuGalleryEditSelected(selectedTemuRecord, imageIndex) }" @dragstart.stop="startImageReorder($event, selectedTemuRecord, 'gallery', imageIndex)" @dragend="endImageReorder" @dragenter.prevent.stop="setImageInteractionTarget('temu-gallery', imageIndex)" @dragover.prevent.stop="setImageInteractionTarget('temu-gallery', imageIndex)" @drop.prevent.stop="dropAliImageToTemuGallery($event, selectedTemuRecord, imageIndex)">
                  <button class="thumb" :class="{ active: selectedTemuGalleryIndex === imageIndex }" type="button" draggable="true" title="双击打开 Edits" @dragstart.stop="startImageReorder($event, selectedTemuRecord, 'gallery', imageIndex)" @dragend="endImageReorder" @click="handleTemuGallerySelection($event, selectedTemuRecord, imageIndex)" @dblclick.stop="openSingleGalleryImageEditor(selectedTemuRecord, imageIndex)"><img :src="imageSource(image)" referrerpolicy="no-referrer" alt="Temu 商品图片" draggable="false"><span v-if="isTemuGalleryEditSelected(selectedTemuRecord, imageIndex)" class="gallery-ai-check">✓</span></button>
                  <button class="image-delete-button" type="button" aria-label="删除图片" @click.stop="removeGalleryImage(selectedTemuRecord, imageIndex, 'temu')">×</button>
                </div>
                <button v-if="galleryEditSelection.length === 2" class="gallery-ai-edit-button" type="button" @click.stop="openGalleryImageEditor(selectedTemuRecord)">AI 编辑 2 张</button>
                <label class="image-upload-button" title="点击上传本地图片，悬停选择 SKU 图片" @mouseenter="openGallerySkuPicker($event, selectedTemuRecord)" @mouseleave="scheduleGallerySkuPickerClose">+ 上传<input type="file" accept="image/*" multiple @change="handleGalleryUpload($event, selectedTemuRecord, 'temu')"></label>
              </div>
               <div class="gallery-main" :class="{ 'is-image-reorder-target': isImageReorderTarget('temu-gallery', 0), 'is-image-drop-target': isImageDropTarget('temu-gallery', 0) }" @dragenter.prevent.stop="setImageInteractionTarget('temu-gallery', 0)" @dragover.prevent.stop="setImageInteractionTarget('temu-gallery', 0)" @drop.prevent.stop="dropAliImageToTemuGallery($event, selectedTemuRecord, 0)"><img v-if="currentImage(selectedTemuRecord, 'temu')" :key="currentImage(selectedTemuRecord, 'temu')" :src="imageSource(currentImage(selectedTemuRecord, 'temu'))" referrerpolicy="no-referrer" alt="Temu 主图" draggable="true" title="双击打开 Edits" @dragstart.stop="startImageReorder($event, selectedTemuRecord, 'gallery', selectedTemuGalleryIndex)" @dragend="endImageReorder" @dblclick.stop="openSingleGalleryImageEditor(selectedTemuRecord, selectedTemuGalleryIndex)"><span v-else class="muted">暂无图片</span><button v-if="currentImage(selectedTemuRecord, 'temu')" class="gallery-image-search-button" type="button" :disabled="imageSearchBusy" title="用当前图片搜索 1688" aria-label="用当前图片搜索 1688" @click.stop="searchTemuImageOn1688(selectedTemuRecord, currentImage(selectedTemuRecord, 'temu'))"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.2"></circle><path d="m16 16 5 5"></path></svg></button></div>
            </div>
             <div class="sku-panel sku-spec-panel" :class="{ 'is-drop-mode': dragSkuReference }" @change="saveProductModule(selectedTemuRecord, 'skus')" @dragover.prevent @drop.prevent="ignoreNativeDrop">
                <div class="sku-spec-groups">
                  <div v-for="(group, groupIndex) in skuSpecGroups(selectedTemuRecord)" :key="groupIndex" class="sku-spec-group">
                    <div class="sku-spec-group-head" :class="{ 'is-drop-target': isAliDropTarget('group', group.name) }" @dragenter.prevent.stop="setAliDropTarget('group', group.name)" @dragover.prevent.stop="setAliDropTarget('group', group.name)" @drop.prevent.stop="dropAliSkuToTemuGroup($event, selectedTemuRecord, group.name)"><span>规格{{ groupIndex + 1 }}:</span><input class="sku-spec-name-input" type="text" :value="group.name" @input="updateSkuSpecName(selectedTemuRecord, group.name, $event.target.value)" aria-label="规格名称"><span class="sku-spec-count">{{ group.values.length }} 个选项</span><span class="sku-drop-badge">拖到此规格</span><button class="sku-spec-delete-button" type="button" @click.stop="removeTemuSpecGroup(selectedTemuRecord, group.name)">删除规格</button></div>
                    <div class="sku-spec-options"><div v-for="(value, optionIndex) in group.values" :key="optionIndex" class="sku-spec-option-wrap" :class="{ 'is-drop-target': isAliDropTarget('option', group.name, value) }" @dragenter.prevent.stop="setAliDropTarget('option', group.name, value)" @dragover.prevent.stop="setAliDropTarget('option', group.name, value)" @drop.prevent.stop="dropAliSkuToTemuOption($event, selectedTemuRecord, group.name, value)"><input class="sku-spec-option-input" type="text" :value="value" @input="updateSkuSpecOption(selectedTemuRecord, group.name, value, $event.target.value)" :aria-label="group.name + '选项'"><button class="sku-spec-option-delete" type="button" @click.stop="removeTemuSpecOption(selectedTemuRecord, group.name, value)" aria-label="删除规格选项">×</button></div></div>
                    <div class="sku-spec-group-actions sku-spec-add-control"><input class="sku-spec-add-input" type="text" :value="specOptionDraft(selectedTemuRecord, group.name)" @input="setSpecOptionDraft(selectedTemuRecord, group.name, $event.target.value)" @keyup.enter="addTemuSpecOption(selectedTemuRecord, group.name)" placeholder="输入新选项"><button class="sku-spec-add-button" type="button" @click="addTemuSpecOption(selectedTemuRecord, group.name)">+ 添加</button></div>
                  </div>
                  <div v-if="skuSpecGroups(selectedTemuRecord).length < 2" class="sku-spec-add-bar sku-spec-add-control"><input class="sku-spec-add-input" type="text" v-model="newSpecGroupName" @keyup.enter="addTemuSpecGroup(selectedTemuRecord)" placeholder="输入新规格名称"><button class="sku-spec-add-button" type="button" @click="addTemuSpecGroup(selectedTemuRecord)">+ 添加规格</button></div>
                  <div v-if="!skuSpecGroups(selectedTemuRecord).length" class="detail-empty">未识别到规格属性，可直接添加规格。</div>
                </div>
               <div class="sku-price-conversion"><strong>{{ selectedTemuRecord.price_conversion_label }}</strong><span>SKU 价格统一按人民币显示</span></div>
               <div class="sku-list-title sku-list-title-with-tools"><span>SKU列表（{{ selectedTemuRecord.sku.length }}个）</span><label class="sku-fusion-prompt-field"><span>溶图提示词</span><input type="text" v-model="imageEditorFusionPrompt" placeholder="请输入溶图提示词" aria-label="溶图提示词"></label></div>
                 <table class="sku-table sku-spec-table"><thead><tr><th>#</th><th>预览图</th><th v-for="group in skuSpecGroups(selectedTemuRecord)" :key="group.name" :class="{ 'is-drop-target': isAliDropTarget('group', group.name) }" @dragenter.prevent.stop="setAliDropTarget('group', group.name)" @dragover.prevent.stop="setAliDropTarget('group', group.name)" @drop.prevent.stop="dropAliSkuToTemuGroup($event, selectedTemuRecord, group.name)">{{ group.name }}</th><th><span class="sku-copy-first-heading">价格<button class="sku-copy-first-button" type="button" title="用 SKU1 的价格覆盖全部 SKU" aria-label="用 SKU1 的价格覆盖全部 SKU" :disabled="isCopyFirstSkuAttributeBusy(selectedTemuRecord, 'price')" @click.stop="copyFirstSkuAttribute(selectedTemuRecord, 'price')"></button></span></th><th><span class="sku-copy-first-heading">库存<button class="sku-copy-first-button" type="button" title="用 SKU1 的库存覆盖全部 SKU" aria-label="用 SKU1 的库存覆盖全部 SKU" :disabled="isCopyFirstSkuAttributeBusy(selectedTemuRecord, 'stock')" @click.stop="copyFirstSkuAttribute(selectedTemuRecord, 'stock')"></button></span></th><th class="sku-dimensions-column"><span class="sku-copy-first-heading">长宽高<button class="sku-copy-first-button" type="button" title="用 SKU1 的长宽高覆盖全部 SKU" aria-label="用 SKU1 的长宽高覆盖全部 SKU" :disabled="isCopyFirstSkuAttributeBusy(selectedTemuRecord, 'dimensions')" @click.stop="copyFirstSkuAttribute(selectedTemuRecord, 'dimensions')"></button></span></th></tr></thead><tbody>
                 <tr v-for="(sku, skuIndex) in selectedTemuRecord.sku" :key="getSkuKey(selectedTemuRecord, sku, skuIndex)">
                   <td>{{ skuIndex + 1 }}</td>
                  <td class="sku-image-cell" :class="{ 'is-image-drop-target': isImageDropTarget('temu-sku', skuIndex) }" @dragenter.prevent.stop="setImageDropTarget('temu-sku', skuIndex)" @dragover.prevent.stop="setImageDropTarget('temu-sku', skuIndex)" @drop.prevent.stop="dropAliImageToTemuSku($event, selectedTemuRecord, sku, skuIndex)"><div class="sku-images-editor"><div v-for="(image, imageIndex) in skuImageUrls(sku)" :key="imageIndex" class="sku-image-item"><img :src="imageSource(image)" referrerpolicy="no-referrer" alt="SKU 图片" draggable="true" title="拖到上方主图列表" @dragstart.stop="startSkuImageDrag($event, selectedTemuRecord, image, skuIndex, imageIndex)" @dragend="endAliImageDrag" @click.stop="openImagePreview(image)"><button class="image-delete-button" type="button" aria-label="删除 SKU 图片" @click="removeSkuImageAt(selectedTemuRecord, sku, imageIndex)">×</button></div><label v-if="!skuImageUrls(sku).length" class="sku-image-empty-upload" title="点击上传本地图片，悬停选择主图" @mouseenter="openSkuImagePicker($event, selectedTemuRecord, sku, skuIndex)" @mouseleave="scheduleSkuImagePickerClose">+<input type="file" accept="image/*" @change.stop="handleSkuImageUpload($event, selectedTemuRecord, sku)"></label><div v-if="skuImageUrls(sku).length === 2 || hasSkuFusionUndo(selectedTemuRecord, sku, skuIndex)" class="sku-image-actions"><button v-if="skuImageUrls(sku).length === 2" class="sku-blend-button" type="button" :disabled="isSkuBlendBusy(selectedTemuRecord, sku, skuIndex)" title="将当前 SKU 的两张图片发送到 BeeAPI 并替换为返回图片" @click.stop="blendSkuImages(selectedTemuRecord, sku, skuIndex)">{{ isSkuBlendBusy(selectedTemuRecord, sku, skuIndex) ? '生成中…' : '溶图' }}</button><button v-if="hasSkuFusionUndo(selectedTemuRecord, sku, skuIndex)" class="sku-fusion-undo-button" type="button" :disabled="isSkuFusionUndoBusy(selectedTemuRecord, sku, skuIndex)" @click.stop="undoSkuImageFusion(selectedTemuRecord, sku, skuIndex)">{{ isSkuFusionUndoBusy(selectedTemuRecord, sku, skuIndex) ? '恢复中…' : '恢复原图' }}</button></div></div></td>
                    <td v-for="(group, groupIndex) in skuSpecGroups(selectedTemuRecord)" :key="group.name" class="sku-spec-cell" :class="{ 'is-drop-target': isTemuSkuCellDropTarget(skuIndex, group.name) }" @dragenter.prevent.stop="setTemuSkuCellDropTarget(skuIndex, group.name)" @dragover.prevent.stop="setTemuSkuCellDropTarget(skuIndex, group.name)" @drop.prevent.stop="dropAliSkuToTemuSkuCell($event, selectedTemuRecord, sku, skuIndex, group.name)"><input class="sku-edit-input" type="text" :value="skuSpecValue(sku, groupIndex)" @input="updateSkuSpecValue(sku, groupIndex, $event.target.value)" :aria-label="group.name"></td>
                    <td><input class="sku-edit-input" type="text" inputmode="decimal" v-model="sku.sku_price" aria-label="SKU 价格"></td><td><input class="sku-edit-input" type="text" inputmode="numeric" v-model="sku.sku_stock" aria-label="SKU 库存"></td><td class="sku-dimensions-cell"><div class="sku-dimension-bubbles" aria-label="SKU 尺寸"><input class="sku-edit-input sku-dimension-input" type="text" inputmode="decimal" v-model="sku.sku_length" aria-label="SKU 长度"><span class="sku-dimension-separator">:</span><input class="sku-edit-input sku-dimension-input" type="text" inputmode="decimal" v-model="sku.sku_width" aria-label="SKU 宽度"><span class="sku-dimension-separator">:</span><input class="sku-edit-input sku-dimension-input" type="text" inputmode="decimal" v-model="sku.sku_height" aria-label="SKU 高度"></div></td>
                 </tr>
                  <tr v-if="!selectedTemuRecord.sku.length"><td :colspan="skuSpecGroups(selectedTemuRecord).length + 5" class="empty">暂无 SKU 数据</td></tr>
               </tbody></table>
             </div>
               <div class="detail-section" @dragenter.prevent.stop="setImageInteractionTarget('temu-detail')" @dragover.prevent.stop="setImageInteractionTarget('temu-detail')" @drop.prevent.stop="dropAliImageToTemuDetail($event, selectedTemuRecord)"><div class="detail-section-heading"><h3>商品详情</h3><button class="glass-action-button" type="button" :disabled="!galleryImages(selectedTemuRecord).length" @click.stop="replaceDetailsWithGallery(selectedTemuRecord)">使用主图一键覆盖</button></div><div v-if="selectedTemuRecord.detail_image_urls.length" class="detail-images"><div v-for="(image, detailIndex) in selectedTemuRecord.detail_image_urls" :key="image" class="detail-image-editor" draggable="true" title="双击打开 Edits" :class="{ 'is-image-reorder-target': isImageReorderTarget('temu-detail', detailIndex) }" @dragstart.stop="startImageReorder($event, selectedTemuRecord, 'detail', detailIndex)" @dragend="endImageReorder" @dragenter.prevent.stop="setImageInteractionTarget('temu-detail', detailIndex)" @dragover.prevent.stop="setImageInteractionTarget('temu-detail', detailIndex)" @drop.prevent.stop="dropAliImageToTemuDetail($event, selectedTemuRecord, detailIndex)" @dblclick.stop="openDetailImageEditor(selectedTemuRecord, image, detailIndex)"><img :src="imageSource(image)" referrerpolicy="no-referrer" alt="Temu 商品详情图" draggable="false"><button class="image-delete-button" type="button" aria-label="删除详情图" @click="removeDetailImage(selectedTemuRecord, detailIndex)">×</button></div></div><div v-else class="detail-empty-upload"><label class="detail-empty-upload-button" title="上传详情图">+<input type="file" accept="image/*" multiple @change="handleDetailUpload($event, selectedTemuRecord)"></label><span>暂无详情图，请上传图片。</span></div></div>
          </section>
          <section v-else class="panel platform-render empty">请选择 Temu 商品。</section>

          <section v-if="workspaceMode === 'smart'" class="panel platform-render smart-workflow-render">
            <div class="smart-workflow-heading">
              <div><span class="platform-label ali-label">智能组货</span></div>
              <button class="workflow-direction-button smart-workflow-direction-button" :class="{ 'is-analyzing': workflowPromptBusy, 'is-generating': workflowGenerateBusy, 'is-ready': workflowPrompts.length && !workflowPromptBusy && !workflowGenerateBusy }" type="button" :disabled="workflowPromptBusy || workflowGenerateBusy || !workflowSelectedImageUrl" @click="generateWorkflowPrompts">
                <span v-if="workflowPromptBusy || workflowGenerateBusy" class="workflow-direction-spinner" aria-hidden="true"></span>
                <span>{{ workflowPromptBusy ? '分析中' : workflowGenerateBusy ? '生图中' : workflowPrompts.length ? '重新组货' : '生成组货方向' }}</span>
              </button>
            </div>
            <section v-if="workflowPrompts.length" class="smart-workflow-step">
              <header><span>01</span><div><strong>组货建议</strong><small>四个候选方向会自动生成图片，生成完成后可直接搜图。</small></div></header>
              <div class="smart-result-grid">
                <article v-for="(item, index) in workflowPrompts" :key="'smart-result-' + index" class="smart-result-card" :class="{ selected: workflowSelectedResultIndex === index }">
                  <div class="smart-result-image-wrap"><button class="smart-result-image" type="button" :disabled="!item.image_url" @click="selectWorkflowResult(index)"><img v-if="item.image_url" :src="imageSource(item.image_url)" alt="AI 组货候选图"><span v-else>{{ item.status === 'generating' || item.status === 'queued' ? '后台生成中…' : item.status === 'error' ? workflowPromptErrorText(item) : item.error || '等待生成' }}</span><i v-if="workflowSelectedResultIndex === index">已选择</i></button><button v-if="item.image_url" class="smart-result-search-button" :class="{ 'is-busy': workflowSearchBusyKeys[index] }" type="button" :disabled="workflowSearchBusyKeys[index] || item.status === 'generating' || item.status === 'queued'" title="用这张生成图搜索 1688" :aria-label="workflowSearchBusyKeys[index] ? '1688 搜图中' : '用这张生成图搜索 1688'" @click.stop="searchWorkflow1688(index)"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.2"></circle><path d="m16 16 5 5"></path></svg></button></div>
                  <div class="smart-result-copy"><strong>{{ item.relation }}</strong><span>{{ item.product_intro }}</span></div>
                </article>
              </div>
              <div v-if="selectedWorkflowTask && selectedWorkflowTask.search_url" class="smart-search-ready"><span>搜款页已生成，进入满意商品详情后选择 Temu，并点击扩展确认绑定。</span><a :href="selectedWorkflowTask.search_url" target="_blank">重新打开搜款页</a></div>
            </section>
            <div v-if="!selectedTemuRecord" class="smart-workflow-empty">请先从左侧选择 Temu 商品。</div>
          </section>

          <section v-if="workspaceMode === 'realtime' && selected1688Record" class="panel platform-render ali-render">
            <div class="render-heading"><div><span class="platform-label ali-label">1688</span><input class="render-title-input" type="text" v-model="selected1688Record.product_name" @change="saveProductModule(selected1688Record, 'basic')" aria-label="1688 商品名称"><input class="render-category-input" type="text" v-model="selected1688Record.product_category" @change="saveProductModule(selected1688Record, 'basic')" placeholder="未提供商品分类" aria-label="1688 商品分类"></div></div>
             <div class="render-gallery"><div class="gallery-thumbs"><div v-for="(image, imageIndex) in galleryImages(selected1688Record)" :key="image" class="thumb-item"><button class="thumb" :class="{ active: selected1688GalleryIndex === imageIndex }" type="button" draggable="true" @dragstart.stop="startAliImageDrag($event, selected1688Record, image, 'gallery', imageIndex)" @dragend="endAliImageDrag" @click="selectGallery(imageIndex, '1688')"><img :src="imageSource(image)" referrerpolicy="no-referrer" alt="1688 商品图片" draggable="false"></button></div></div><div class="gallery-main"><img v-if="currentImage(selected1688Record, '1688')" :key="currentImage(selected1688Record, '1688')" :src="imageSource(currentImage(selected1688Record, '1688'))" referrerpolicy="no-referrer" alt="1688 主图" draggable="true" @dragstart.stop="startAliImageDrag($event, selected1688Record, currentImage(selected1688Record, '1688'), 'gallery', selected1688GalleryIndex)" @dragend="endAliImageDrag"><span v-else class="muted">暂无图片</span></div></div>
             <div class="sku-panel sku-spec-panel" @change="saveProductModule(selected1688Record, 'skus')" @dragover.prevent @drop.prevent="ignoreNativeDrop">
               <div class="ali-sku-toolbar">
                 <div class="ali-sku-toolbar-heading"><div class="sku-list-title">SKU列表 <span class="ali-sku-count">{{ selected1688Record.sku.length }}</span></div><div class="sku-price-conversion"><strong>{{ selected1688Record.price_conversion_label }}</strong><span>价格统一按人民币显示</span></div></div>
               </div>
               <table class="sku-table sku-spec-table"><thead><tr><th>#</th><th>预览图</th><th>{{ aliSubSkuHeader(selected1688Record, 0) }}</th><th>{{ aliSubSkuHeader(selected1688Record, 1) }}</th><th>价格</th><th>库存</th></tr></thead><tbody>
                 <tr v-for="(sku, skuIndex) in selected1688Record.sku" :key="getSkuKey(selected1688Record, sku, skuIndex)" class="sku-source-row" :class="{ 'is-dragging-source': dragSkuReference && String(dragSkuReference.main_id) === String(selected1688Record.main_id) && String(dragSkuReference.sku_index) === String(skuIndex) }">
                   <td>{{ skuIndex + 1 }}</td>
                      <td><div class="sku-images-editor"><div v-for="(image, imageIndex) in skuImageUrls(sku)" :key="imageIndex" class="sku-image-item"><img :src="imageSource(image)" referrerpolicy="no-referrer" alt="SKU 图片" draggable="true" @dragstart.stop="startAliImageDrag($event, selected1688Record, image, 'sku', skuIndex)" @dragend="endAliImageDrag" @click.stop="openImagePreview(image)"><button class="image-delete-button" type="button" aria-label="删除 SKU 图片" @click="removeSkuImageAt(selected1688Record, sku, imageIndex)">×</button></div><label v-if="!skuImageUrls(sku).length" class="sku-image-empty-upload" title="点击上传本地图片，悬停选择主图" @mouseenter="openSkuImagePicker($event, selected1688Record, sku, skuIndex)" @mouseleave="scheduleSkuImagePickerClose">+<input type="file" accept="image/*" @change.stop="handleSkuImageUpload($event, selected1688Record, sku)"></label></div></td>
                   <td><div class="subsku-editor"><input class="sku-edit-input subsku-value-input" type="text" draggable="true" :class="{ 'is-dragging-subsku': dragSkuReference && String(dragSkuReference.main_id) === String(selected1688Record.main_id) && String(dragSkuReference.sku_index) === String(skuIndex) && dragSkuReference.subsku_index === 0 }" :value="aliSubSkuValue(sku, 0)" :title="'拖动 ' + aliSubSkuHeader(selected1688Record, 0)" :aria-label="'1688 ' + aliSubSkuHeader(selected1688Record, 0)" @dragstart.stop="startAliSubSkuDrag($event, sku, skuIndex, 0)" @dragend="endAliDrag" @input="updateAliSubSkuValue(sku, 0, $event.target.value)"></div></td><td><div class="subsku-editor"><input class="sku-edit-input subsku-value-input" type="text" draggable="true" :disabled="!sku.SubSku2" :class="{ 'is-dragging-subsku': dragSkuReference && String(dragSkuReference.main_id) === String(selected1688Record.main_id) && String(dragSkuReference.sku_index) === String(skuIndex) && dragSkuReference.subsku_index === 1 }" :value="aliSubSkuValue(sku, 1)" :title="'拖动 ' + aliSubSkuHeader(selected1688Record, 1)" :aria-label="'1688 ' + aliSubSkuHeader(selected1688Record, 1)" @dragstart.stop="startAliSubSkuDrag($event, sku, skuIndex, 1)" @dragend="endAliDrag" @input="updateAliSubSkuValue(sku, 1, $event.target.value)"></div></td><td><input class="sku-edit-input" type="text" inputmode="decimal" v-model="sku.sku_price" aria-label="SKU 价格"></td><td><input class="sku-edit-input" type="text" inputmode="numeric" v-model="sku.sku_stock" aria-label="SKU 库存"></td>
                 </tr>
                 <tr v-if="!selected1688Record.sku.length"><td colspan="6" class="empty">暂无 SKU 数据</td></tr>
               </tbody></table>
             </div>
               <div class="detail-section"><h3>商品详情</h3><div v-if="selected1688Record.detail_image_urls.length" class="detail-images"><div v-for="(image, detailIndex) in selected1688Record.detail_image_urls" :key="image" class="detail-image-editor" draggable="true" @dragstart.stop="startAliImageDrag($event, selected1688Record, image, 'detail', detailIndex)" @dragend="endAliImageDrag"><img :src="imageSource(image)" referrerpolicy="no-referrer" alt="1688 商品详情图"></div></div><div v-else class="detail-empty-upload"><span>暂无详情图。</span></div></div>
          </section>
          <section v-else-if="workspaceMode === 'realtime'" class="panel platform-render empty">请选择 1688 商品。</section>
        </div>
        <aside v-if="skuImagePickerOpen" class="subsku-editor sku-image-picker-bubble" :style="skuImagePickerStyle()" aria-label="选择 SKU 主图" @mouseenter="cancelSkuImagePickerClose" @mouseleave="scheduleSkuImagePickerClose">
          <div class="sku-image-picker-heading"><strong>选择主图</strong><span>点击图片填入当前 SKU</span></div>
          <div v-if="skuImagePickerImages().length" class="sku-image-picker-grid"><button v-for="(image, imageIndex) in skuImagePickerImages()" :key="imageIndex" type="button" :title="'使用主图 ' + (imageIndex + 1)" @click="selectSkuImageFromGallery(image)"><img :src="imageSource(image)" referrerpolicy="no-referrer" :alt="'主图 ' + (imageIndex + 1)"></button></div>
          <div v-else class="sku-image-picker-empty">当前商品暂无主图。</div>
        </aside>
        <aside v-if="gallerySkuPickerOpen" class="subsku-editor sku-image-picker-bubble gallery-sku-picker-bubble" :style="gallerySkuPickerStyle()" aria-label="选择 SKU 图片加入主图" @mouseenter="cancelGallerySkuPickerClose" @mouseleave="scheduleGallerySkuPickerClose">
          <div class="sku-image-picker-heading"><strong>选择 SKU 图片</strong><span>点击加入 Temu 主图</span></div>
          <section v-if="gallerySkuPickerImages('temu').length" class="gallery-sku-picker-group"><strong>Temu SKU</strong><div class="sku-image-picker-grid"><button v-for="(image, imageIndex) in gallerySkuPickerImages('temu')" :key="'temu-' + imageIndex" type="button" :title="'加入 Temu SKU 图片 ' + (imageIndex + 1)" @click="selectGalleryImageFromSku(image)"><img :src="imageSource(image)" referrerpolicy="no-referrer" :alt="'Temu SKU 图片 ' + (imageIndex + 1)"></button></div></section>
          <section v-if="gallerySkuPickerImages('1688').length" class="gallery-sku-picker-group"><strong>1688 SKU</strong><div class="sku-image-picker-grid"><button v-for="(image, imageIndex) in gallerySkuPickerImages('1688')" :key="'1688-' + imageIndex" type="button" :title="'加入 1688 SKU 图片 ' + (imageIndex + 1)" @click="selectGalleryImageFromSku(image)"><img :src="imageSource(image)" referrerpolicy="no-referrer" :alt="'1688 SKU 图片 ' + (imageIndex + 1)"></button></div></section>
          <div v-if="!gallerySkuPickerImages('temu').length && !gallerySkuPickerImages('1688').length" class="sku-image-picker-empty">当前 Temu 和 1688 商品暂无 SKU 图片。</div>
        </aside>
        <div v-if="workflowPromptDialogOpen" class="image-editor-modal">
          <section class="image-editor-dialog workflow-prompt-dialog" role="dialog" aria-modal="true" aria-label="自定义组货方向提示词">
            <header class="image-editor-header"><div><strong>自定义组货方向</strong><span>Kimi 将按照本次要求推荐 4 个商品</span></div><button type="button" aria-label="关闭组货提示词" @click="closeWorkflowPromptDialog">×</button></header>
            <label class="image-editor-prompt"><span>组货提示词</span><textarea v-model="workflowCustomPromptDraft" rows="7" placeholder="请输入本次组货方向要求" aria-label="自定义组货方向提示词"></textarea></label>
            <div v-if="workflowPromptDialogError" class="image-editor-error">{{ workflowPromptDialogError }}</div>
            <footer class="image-editor-actions"><button class="image-editor-cancel" type="button" @click="closeWorkflowPromptDialog">取消</button><button class="image-editor-confirm" type="button" :disabled="workflowPromptBusy" @click="submitWorkflowPrompts">{{ workflowPromptBusy ? '分析中…' : '开始分析' }}</button></footer>
          </section>
        </div>
        <div v-if="imageEditorOpen" class="image-editor-modal" @pointerdown.self="beginImageEditorBackdropPress" @pointerup="finishImageEditorBackdropPress" @pointercancel="cancelImageEditorBackdropPress">
          <section class="image-editor-dialog" role="dialog" aria-modal="true" aria-label="AI 图片编辑">
            <header class="image-editor-header"><div><strong>{{ galleryEditSelection.length === 2 && imageCarouselCount > 1 ? '轮播修改模式' : galleryEditSelection.length === 2 ? '双图溶图' : '单图编辑' }}</strong><span>{{ galleryEditSelection.length === 2 && imageCarouselCount > 1 ? 'Kimi + Fusion API' : galleryEditSelection.length === 2 ? 'Fusion API' : 'Edits API' }}</span></div><span v-if="imageCarouselSourceMismatch" class="image-editor-header-status">当前显示旧任务 · 所选图片已变化</span><button type="button" aria-label="关闭 AI 图片编辑" @click="closeGalleryImageEditor">×</button></header>
            <div class="image-editor-stage" :class="{ 'has-two-sources': galleryImageEditorSources(selectedTemuRecord).length === 2, 'has-result': imageEditorGeneratedUrl || imageCarouselTask }">
              <span class="image-editor-stage-label">{{ imageCarouselTask && imageCarouselTask.status === 'planning' ? '轮播规划中' : imageEditorBusy ? '处理中' : imageCarouselTask ? '轮播预览' : imageEditorGeneratedUrl ? '生成结果' : galleryImageEditorSources(selectedTemuRecord).length === 2 ? '待溶图片' : '待编辑图片' }}</span>
              <div v-if="imageEditorBusy || (imageCarouselTask && imageCarouselTask.status === 'planning')" class="image-editor-loading"><span></span><strong>{{ imageCarouselCount > 1 ? imageCarouselReasoningEnabled ? 'Kimi 推理规划中…' : 'Kimi 快速规划中…' : '图片生成中…' }}</strong><small v-if="imageCarouselCount > 1">已输出约 {{ imageCarouselEstimatedTokens }} tokens，页面没有卡住。</small><small v-else>完成后可确认替换当前图片。</small></div>
              <div v-else-if="imageCarouselTask && imageCarouselTask.pages && imageCarouselTask.pages.length" class="carousel-slide-viewer">
                <button class="carousel-slide-arrow previous" type="button" :disabled="imageCarouselPageIndex <= 0" aria-label="上一张轮播图" @click="changeCarouselPage(-1)">‹</button>
                <article class="carousel-result-card">
                  <img v-if="currentCarouselPage().image_url" :src="imageSource(currentCarouselPage().image_url)" :alt="'轮播图 ' + (imageCarouselPageIndex + 1)">
                  <div v-else class="carousel-result-placeholder"><span>{{ currentCarouselPage().status === 'generating' ? '生成中…' : currentCarouselPage().status === 'failed' ? '[' + currentCarouselPage().error_code + '] ' + currentCarouselPage().error : '等待生成' }}</span><button v-if="currentCarouselPage().status === 'failed'" type="button" :disabled="isCarouselPageBusy(imageCarouselPageIndex)" @click="retryCarouselPage(imageCarouselPageIndex)">{{ isCarouselPageBusy(imageCarouselPageIndex) ? '重试中…' : '重试' }}</button></div>
                </article>
                <button class="carousel-slide-arrow next" type="button" :disabled="imageCarouselPageIndex >= imageCarouselTask.pages.length - 1" aria-label="下一张轮播图" @click="changeCarouselPage(1)">›</button>
                <div class="carousel-slide-meta"><span class="carousel-slide-counter">{{ imageCarouselPageIndex + 1 }} / {{ imageCarouselTask.pages.length }}</span><label v-if="currentCarouselPage().status === 'succeeded'" class="carousel-result-select"><input type="checkbox" v-model="currentCarouselPage().selected">选用当前图</label></div>
              </div>
              <img v-else-if="imageEditorGeneratedUrl" class="image-editor-generated-image" :src="imageSource(imageEditorGeneratedUrl)" alt="AI 生成结果">
              <div v-else class="image-editor-source-canvas"><img v-for="(image, sourceIndex) in galleryImageEditorSources(selectedTemuRecord)" :key="sourceIndex" :src="imageSource(image)" alt="待编辑图片"></div>
            </div>
            <div v-if="galleryImageEditorSources(selectedTemuRecord).length === 2 && !imageCarouselTask" class="carousel-controls">
              <label class="image-editor-prompt"><span>生成数量</span><input type="number" min="1" max="10" :value="imageCarouselCount" @input="handleCarouselCountInput($event)"></label>
              <label class="image-editor-prompt"><span>市场语言</span><input type="text" v-model="imageCarouselMarketLanguage" placeholder="美国 / English"></label>
              <button class="carousel-mode-note" :class="{ 'is-reasoning': imageCarouselReasoningEnabled }" type="button" :title="imageCarouselReasoningEnabled ? '推理模式，temperature 1；点击切换' : '不推理模式，temperature 0.6；点击切换'" :aria-label="imageCarouselReasoningEnabled ? '当前为推理模式，点击切换为不推理模式' : '当前为不推理模式，点击切换为推理模式'" @click="toggleCarouselReasoningMode"><i></i><span>{{ imageCarouselReasoningEnabled ? '推理模式' : '不推理模式' }}</span></button>
            </div>
            <label v-if="!imageCarouselTask" class="image-editor-prompt"><span>提示词</span><textarea v-model="imageEditorPrompt" rows="4" aria-label="图片编辑提示词"></textarea></label>
            <div v-if="imageCarouselTask && imageCarouselTask.pages && imageCarouselTask.pages.length" class="carousel-page-editor">
              <label class="image-editor-prompt"><span>分镜 {{ imageCarouselPageIndex + 1 }} / {{ imageCarouselTask.pages.length }}</span><input type="text" v-model="currentCarouselPage().purpose" :readonly="currentCarouselPage().status === 'generating' || isCarouselPageBusy(imageCarouselPageIndex)" placeholder="页面用途（中文）"></label>
              <label class="image-editor-prompt"><span>提示词</span><textarea v-model="currentCarouselPage().prompt" :readonly="currentCarouselPage().status === 'generating' || isCarouselPageBusy(imageCarouselPageIndex)" rows="4" placeholder="完整生图提示词（中文）"></textarea></label>
              <div v-if="imageCarouselTask.status === 'awaiting_review'" class="carousel-page-actions"><button type="button" @click="removeCarouselPage(imageCarouselPageIndex)">删除当前分镜</button><button v-if="imageCarouselTask.pages.length < 10" type="button" @click="addCarouselPage">+ 添加分镜</button></div>
            </div>
            <div v-if="imageEditorError" class="image-editor-error">{{ imageEditorError }}</div>
            <footer class="image-editor-actions"><button v-if="imageCarouselSourceMismatch" class="image-editor-cancel" type="button" @click="replaceExistingCarouselTask">放弃旧任务并使用当前图片</button><button v-else-if="imageCarouselTask" class="image-editor-cancel" type="button" @click="abandonCarouselTask">放弃轮播任务</button><button class="image-editor-cancel" type="button" @click="closeGalleryImageEditor">关闭</button><button v-if="!imageCarouselTask || imageCarouselTask.status === 'awaiting_review' || imageCarouselTask.status === 'failed' || imageCarouselTask.status === 'interrupted'" class="image-editor-generate" type="button" :disabled="imageEditorBusy || (imageCarouselTask && imageCarouselGenerationBusy) || !imageEditorPrompt.trim()" @click="submitGalleryImageEdit">{{ imageEditorBusy ? '规划中…' : imageCarouselTask && (imageCarouselTask.status === 'failed' || imageCarouselTask.status === 'interrupted') ? '重新开始' : imageCarouselTask ? '确认分镜并生成' : '开始生成' }}</button><button v-if="imageCarouselTask && imageCarouselTask.pages && imageCarouselTask.pages.length && imageCarouselTask.status !== 'planning' && imageCarouselTask.status !== 'awaiting_review' && imageCarouselTask.status !== 'failed' && imageCarouselTask.status !== 'interrupted'" class="image-editor-generate" type="button" :disabled="imageCarouselGenerationBusy" @click="regenerateAllCarouselPages">{{ imageCarouselGenerationBusy ? '全部生成中…' : '全部重生' }}</button><button v-if="imageCarouselTask && imageCarouselTask.pages && imageCarouselTask.pages.length && imageCarouselTask.status !== 'planning' && imageCarouselTask.status !== 'awaiting_review' && imageCarouselTask.status !== 'failed' && imageCarouselTask.status !== 'interrupted'" class="image-editor-generate" type="button" :disabled="isCarouselPageBusy(imageCarouselPageIndex) || currentCarouselPage().status === 'generating' || !String(currentCarouselPage().prompt || '').trim()" @click="regenerateCurrentCarouselPage">{{ isCarouselPageBusy(imageCarouselPageIndex) ? '单张生成中…' : '单独重生' }}</button><button v-if="imageCarouselTask && imageCarouselTask.status === 'generated' && successfulCarouselPageCount(true) > 0" class="image-editor-main-apply" type="button" :disabled="imageCarouselGenerationBusy" title="跳过失败分镜，使用全部成功图片替换所有主图" @click="confirmCarouselReplacement(true)">替换所有主图</button><button class="image-editor-confirm" type="button" :disabled="imageEditorBusy || (imageCarouselTask && imageCarouselGenerationBusy) || (imageCarouselTask ? successfulCarouselPageCount() < 1 : !imageEditorGeneratedUrl)" @click="confirmGalleryImageEdit">确认替换</button></footer>
          </section>
        </div>
        <div v-if="imagePreviewUrl" class="image-preview-modal" @click="closeImagePreview">
          <button class="image-preview-close" type="button" @click.stop="closeImagePreview" aria-label="关闭图片预览">×</button>
          <img :src="imageSource(imagePreviewUrl)" alt="放大图片" @click.stop>
        </div>
        <div v-if="apiSettingsOpen" class="image-editor-modal" @click.self="closeApiSettings">
          <section class="image-editor-dialog" role="dialog" aria-modal="true" aria-label="API 设置">
            <header class="image-editor-header"><div><strong>API 设置</strong><span>密钥只保存到后端</span></div><button type="button" aria-label="关闭 API 设置" @click="closeApiSettings">×</button></header>
            <label class="image-editor-prompt"><span>BeeAPI Key（{{ imageApiKeyMasked || '未配置' }}）</span><input type="password" v-model="imageApiKeyDraft" autocomplete="off" placeholder="留空则不修改"></label>
            <label class="image-editor-prompt"><span>Kimi API Key（{{ kimiApiKeyMasked || '未配置' }}）</span><input type="password" v-model="kimiApiKeyDraft" autocomplete="off" placeholder="留空则不修改"></label>
            <footer class="image-editor-actions"><button class="image-editor-cancel" type="button" @click="closeApiSettings">取消</button><button class="image-editor-confirm" type="button" :disabled="apiSettingsBusy" @click="saveApiSettings">{{ apiSettingsBusy ? '保存中…' : '保存到后端' }}</button></footer>
          </section>
        </div>

      </main>
    </div>
  `,
  data: function createAppState() {
    const queryMode = new URLSearchParams(window.location.search).get("mode");
    const persistedViewState = readPersistedViewState();
    return {
      records: [],
      renderMode: queryMode === "export" ? "export" : "realtime",
      workspaceMode: persistedViewState.workspaceMode === "smart" ? "smart" : "realtime",
      realtimeConnected: false,
      realtimeSource: null,
      realtimeRefreshTimer: null,
      realtimeRefreshQueued: false,
      realtimeRefreshInFlight: false,
      realtimeLastEventId: 0,
      activePlatform: "temu",
      selectedMainId: "",
      selectedGalleryIndex: 0,
      selectedTemuGalleryIndex: 0,
      selected1688GalleryIndex: 0,
      selectedTemuMainId: String(persistedViewState.selectedTemuMainId || ""),
      selected1688MainId: String(persistedViewState.selected1688MainId || ""),
      mappingRows: [],
      cartesianBaseRows: {},
      sourceFileName: "",
      statusText: "请导入统一 JSON 文件。",
      statusType: "normal",
      dragSkuReference: null,
      dragDropTarget: null,
      dragImageReference: null,
      imageDropTarget: null,
      imageReorderReference: null,
      imageReorderTarget: null,
      imagePreviewUrl: "",
      skuImagePickerOpen: false,
      skuImagePickerTarget: null,
      skuImagePickerCloseTimer: null,
      gallerySkuPickerOpen: false,
      gallerySkuPickerTarget: null,
      gallerySkuPickerCloseTimer: null,
      galleryEditRecordKey: "",
      galleryEditSelection: [],
      imageEditorSourceType: "gallery",
      imageEditorSourceUrls: [],
      imageEditorDetailIndex: -1,
      imageEditorRecordKey: "",
      imageEditorOpen: false,
      imageEditorPrompt: "",
      imageEditorEditPrompt: "",
      imageEditorFusionPrompt: "",
      imageEditorCarouselPrompt: "",
      imageEditorGeneratedUrl: "",
      imageEditorBusy: false,
      imageEditorError: "",
      imageEditorRestoreMainId: String(persistedViewState.imageEditorMainId || ""),
      imageEditorRestoreInFlight: false,
      imageEditorRequestId: 0,
      imageEditorBackdropPressed: false,
      imageDirectTask: null,
      imageDirectTasksByMainId: {},
      imageDirectPollTimer: null,
      imageDirectIndicatorTimer: null,
      imageCarouselCount: 1,
      imageCarouselMarketLanguage: "美国 / English",
      imageCarouselReasoningEnabled: false,
      imageCarouselTask: null,
      imageCarouselTasksByMainId: {},
      imageCarouselPageBusyKeys: {},
      imageCarouselPageIndex: 0,
      imageCarouselGenerationBusy: false,
      imageCarouselEstimatedTokens: 0,
      imageCarouselSourceMismatch: false,
      imageCarouselPollTimer: null,
      imageCarouselIndicatorTimer: null,
      imageSearchBusy: false,
      specOptionDrafts: {},
      newSpecGroupName: "",
      detailImageRequests: {},
      imageEditSize: "1024x1024",
      imageEditPrices: {},
      imageEditModel: "",
      imageEditBusyKeys: {},
      imageEditErrorKeys: {},
      imageFusionUndoBusyKeys: {},
      imageFusionUndoTokens: {},
      skuBlendTasksByKey: {},
      skuBlendIndicatorTimer: null,
      listingMergeBusy: false,
      listingUndoBusy: false,
      listingUndoTokens: {},
      carouselUndoTokens: readCarouselUndoTokens(),
      apiSettingsOpen: false,
      apiSettingsBusy: false,
      imageApiKeyDraft: "",
      kimiApiKeyDraft: "",
      imageApiKeyMasked: "",
      kimiApiKeyMasked: "",
      workflow: { active_temu_main_id: "", tasks: {} },
      workflowTemporaryState: { updated_at: "", tasks: {} },
      workflowSelectedImageUrl: "",
      workflowSelectedResultIndex: -1,
      workflowPrompts: [],
      workflowPromptDrafts: {},
      workflowPromptDialogOpen: false,
      workflowCustomPromptDefault: "请结合当前 Temu 商品信息和图片，按照你认为最有销售价值的方向推荐 4 个可用于组货的商品。不要使用固定分类，候选方向由当前商品特征决定。",
      workflowCustomPromptDraft: "",
      workflowPromptDialogError: "",
      workflowPromptBusy: false,
      workflowPromptBusyKeys: {},
      workflowTaskErrorKeys: {},
      workflowIndicatorAcknowledgements: readWorkflowIndicatorAcknowledgements(),
      workflowGenerateBusy: false,
      workflowGenerateBusyKeys: {},
      workflowSearchBusyKeys: {},
      workflowStatusText: "等待选择 Temu 商品。",
      workflowStatusType: "normal",
      pendingCacheEvents: {},
      productSaveStates: {},
      copyFirstSkuAttributeBusyKeys: {},
      topbarCollapsed: false,
      topbarLastScrollY: 0,
      miaoshouExportBusy: false
    };
  },
  /** Start cache subscription after the Vue view is mounted. */
  mounted: function mountedApp() {
    window.addEventListener("dragend", this.clearImageDragState, true);
    window.addEventListener("drop", this.clearImageDragState);
    window.addEventListener("blur", this.clearImageDragState);
    window.addEventListener("scroll", this.handleWindowScroll, { passive: true });
    this.topbarLastScrollY = Math.max(0, Number(window.scrollY) || 0);
    this.loadImageEditConfig();
    this.loadWorkflowPayload();
    this.refreshDirectImageTaskIndicators();
    this.refreshSkuBlendTaskIndicators();
    if (this.renderMode === "realtime") {
      this.startRealtimeCache();
    }
  },
  /** Close the cache subscription before the Vue view is destroyed. */
  beforeUnmount: function cleanupRealtimeCache() {
    window.removeEventListener("dragend", this.clearImageDragState, true);
    window.removeEventListener("drop", this.clearImageDragState);
    window.removeEventListener("blur", this.clearImageDragState);
    window.removeEventListener("scroll", this.handleWindowScroll);
    this.cancelSkuImagePickerClose();
    if (this.imageDirectPollTimer) {
      window.clearTimeout(this.imageDirectPollTimer);
      this.imageDirectPollTimer = null;
    }
    if (this.imageDirectIndicatorTimer) {
      window.clearTimeout(this.imageDirectIndicatorTimer);
      this.imageDirectIndicatorTimer = null;
    }
    if (this.imageCarouselIndicatorTimer) {
      window.clearTimeout(this.imageCarouselIndicatorTimer);
      this.imageCarouselIndicatorTimer = null;
    }
    if (this.skuBlendIndicatorTimer) {
      window.clearTimeout(this.skuBlendIndicatorTimer);
      this.skuBlendIndicatorTimer = null;
    }
    this.stopRealtimeCache();
  },
  computed: {
    /** Return products for the currently active platform. */
    activeRecords: function getActiveRecords() {
      const result = [];
      for (let index = 0; index < this.records.length; index += 1) {
        if (this.records[index].platform === this.activePlatform) {
          result.push(this.records[index]);
        }
      }
      return result;
    },

    /** Return the currently selected product for the active platform. */
    activeRecord: function getActiveRecord() {
      const list = this.activeRecords;
      for (let index = 0; index < list.length; index += 1) {
        if (String(list[index].main_id) === String(this.selectedMainId)) {
          return list[index];
        }
      }
      return list[0] || null;
    },

    /** Return all Temu products for the mapping panel. */
    temuRecords: function getTemuRecords() {
      const result = [];
      for (let index = 0; index < this.records.length; index += 1) {
        if (this.records[index].platform === "temu") {
          result.push(this.records[index]);
        }
      }
      return result;
    },

    /** Return all 1688 products for the mapping panel. */
    aliRecords: function get1688Records() {
      const result = [];
      for (let index = 0; index < this.records.length; index += 1) {
        if (this.records[index].platform === "1688") {
          result.push(this.records[index]);
        }
      }
      return result;
    },

    /** Return the product selected on the Temu side of the mapping panel. */
    selectedTemuRecord: function getSelectedTemuRecord() {
      const list = this.temuRecords;
      for (let index = 0; index < list.length; index += 1) {
        if (String(list[index].main_id) === String(this.selectedTemuMainId)) {
          return list[index];
        }
      }
      return list[0] || null;
    },

    /** Return the product selected on the 1688 side of the mapping panel. */
    selected1688Record: function getSelected1688Record() {
      const list = this.aliRecords;
      for (let index = 0; index < list.length; index += 1) {
        if (String(list[index].main_id) === String(this.selected1688MainId)) {
          return list[index];
        }
      }
      return null;
    },

    /** Return all SKU references already attached to one Temu SKU. */
    mappedKeys: function getMappedKeys() {
      const result = {};
      for (let rowIndex = 0; rowIndex < this.mappingRows.length; rowIndex += 1) {
        const row = this.mappingRows[rowIndex] || {};
        result[row.temu_key] = true;
      }
      return result;
    },

    /** Return the persisted intelligent-packing task for the selected Temu product. */
    selectedWorkflowTask: function getSelectedWorkflowTask() {
      const tasks = this.workflow && this.workflow.tasks ? this.workflow.tasks : {};
      return tasks[String(this.selectedTemuMainId)] || null;
    },

    /** Return the available source images for the selected Temu product. */
    workflowSourceImages: function getWorkflowSourceImages() {
      const record = this.selectedTemuRecord || {};
      if (Array.isArray(record.gallery_image_urls) && record.gallery_image_urls.length) {
        return record.gallery_image_urls;
      }
      return record.main_image_url ? [record.main_image_url] : [];
    },

    /** Check whether at least one intelligent-packing candidate image is ready. */
    workflowHasGeneratedImages: function hasWorkflowGeneratedImages() {
      for (let index = 0; index < this.workflowPrompts.length; index += 1) {
        if (this.workflowPrompts[index].image_url) {
          return true;
        }
      }
      return false;
    },

    /** Check whether any candidate image search is currently running. */
    workflowHasSearchBusy: function hasWorkflowSearchBusy() {
      const busyKeys = this.workflowSearchBusyKeys || {};
      for (const key in busyKeys) {
        if (busyKeys[key]) {
          return true;
        }
      }
      return false;
    }
  },
  methods: {
    /** Collapse the wide navigation away from the page top and restore it only near the top. */
    handleWindowScroll: function handleWindowScroll() {
      const currentScrollY = Math.max(0, Number(window.scrollY) || 0);
      if (currentScrollY <= 96) {
        this.topbarCollapsed = false;
      } else if (currentScrollY >= 128) {
        this.topbarCollapsed = true;
      }
      this.topbarLastScrollY = currentScrollY;
    },

    /** Persist the current workspace and product selection for the next browser refresh. */
    persistViewState: function persistViewState() {
      try {
        window.localStorage.setItem(VIEW_STATE_STORAGE_KEY, JSON.stringify({
          workspaceMode: this.workspaceMode,
          selectedTemuMainId: this.selectedTemuMainId,
          selected1688MainId: this.selected1688MainId,
          imageEditorMainId: this.imageEditorRestoreMainId
        }));
      } catch (error) {
        return;
      }
    },

    /** Set a visible status message for the current operation. */
    setStatus: function setStatus(message, type) {
      this.statusText = message;
      this.statusType = type || "normal";
    },

    /** Open the server-only provider credential editor. */
    openApiSettings: function openApiSettings() {
      this.apiSettingsOpen = true;
      const view = this;
      fetch(apiUrl("/config"), { cache: "no-store" }).then(function handleSettingsConfigResponse(response) {
        return response.json();
      }).then(function applyMaskedSettings(payload) {
        const config = payload && payload.data ? payload.data : {};
        view.imageApiKeyMasked = String(config.image && config.image.apikey_masked || "");
        view.kimiApiKeyMasked = String(config.kimi && config.kimi.apikey_masked || "");
      }).catch(function handleSettingsConfigError(error) {
        view.setStatus(error.message || "API 设置读取失败。", "error");
      });
    },

    /** Close the credential editor and discard plaintext drafts. */
    closeApiSettings: function closeApiSettings() {
      this.apiSettingsOpen = false;
      this.imageApiKeyDraft = "";
      this.kimiApiKeyDraft = "";
    },

    /** Build the stable Server cache event key for one product record. */
    productCacheEventKey: function productCacheEventKey(record) {
      const item = record || {};
      const platform = String(item.platform || "");
      const platformId = String(item.platform_id || "");
      return platform && platformId ? platform + "|" + platformId : "";
    },

    /** Mark one locally submitted cache update so its own SSE refresh can be skipped. */
    markPendingCacheEvent: function markPendingCacheEvent(record) {
      const key = this.productCacheEventKey(record);
      if (!key) {
        return "";
      }
      this.pendingCacheEvents[key] = Number(this.pendingCacheEvents[key] || 0) + 1;
      const view = this;
      /** Remove one stale local event marker after the server has had time to respond. */
      function expirePendingCacheEvent() {
        view.clearPendingCacheEvent(key);
      }
      window.setTimeout(expirePendingCacheEvent, 5000);
      return key;
    },

    /** Remove one pending local cache event marker. */
    clearPendingCacheEvent: function clearPendingCacheEvent(key) {
      const eventKey = String(key || "");
      const pending = Number(this.pendingCacheEvents[eventKey] || 0);
      if (pending <= 1) {
        delete this.pendingCacheEvents[eventKey];
        return;
      }
      this.pendingCacheEvents[eventKey] = pending - 1;
    },

    /** Consume an SSE update produced by this page without refetching the whole workbench. */
    consumePendingCacheEvent: function consumePendingCacheEvent(message) {
      if (!message || message.action !== "updated" || !Array.isArray(message.ids) || message.ids.length < 2) {
        return false;
      }
      const eventKey = [String(message.ids[0] || ""), String(message.ids[1] || "")].join("|");
      if (!Number(this.pendingCacheEvents[eventKey] || 0)) {
        return false;
      }
      this.clearPendingCacheEvent(eventKey);
      return true;
    },

    /** Submit plaintext credentials once and keep only masked values in the browser. */
    saveApiSettings: function saveApiSettings() {
      if (this.apiSettingsBusy) {
        return;
      }
      this.apiSettingsBusy = true;
      const view = this;
      fetch(apiUrl("/config/secrets"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image_apikey: this.imageApiKeyDraft, kimi_apikey: this.kimiApiKeyDraft })
      }).then(function handleSecretSaveResponse(response) {
        return response.json().then(function validateSecretSavePayload(payload) {
          if (!response.ok || !payload.ok) {
            throw new Error(getApiErrorMessage(payload, "API 设置保存失败。"));
          }
          return payload.data;
        });
      }).then(function applySavedSecrets(config) {
        view.imageApiKeyMasked = String(config.image && config.image.apikey_masked || "");
        view.kimiApiKeyMasked = String(config.kimi && config.kimi.apikey_masked || "");
        view.closeApiSettings();
        view.setStatus("API 密钥已安全保存到后端。", "success");
      }).catch(function handleSecretSaveError(error) {
        view.setStatus(error.message || "API 设置保存失败。", "error");
      }).finally(function finishSecretSave() {
        view.apiSettingsBusy = false;
      });
    },

    /** Clone one JSON-compatible product module snapshot before a request starts. */
    cloneProductSaveData: function cloneProductSaveData(data) {
      if (!data || typeof data !== "object") {
        return {};
      }
      return JSON.parse(JSON.stringify(data));
    },

    /** Find one currently rendered record by its stable cache key. */
    findProductByCacheKey: function findProductByCacheKey(cacheKey) {
      const key = String(cacheKey || "");
      for (let index = 0; index < this.records.length; index += 1) {
        if (this.productCacheEventKey(this.records[index]) === key) {
          return this.records[index];
        }
      }
      return null;
    },

    /** Return or create the single save state shared by every module of one product. */
    getProductSaveState: function getProductSaveState(record) {
      const key = this.productCacheEventKey(record);
      if (!key) {
        return null;
      }
      if (!this.productSaveStates[key]) {
        this.productSaveStates[key] = {
          pendingModules: {},
          inFlight: null,
          generation: 0,
          conflict: false,
          remoteProduct: null,
          timer: null
        };
      }
      return this.productSaveStates[key];
    },

    /** Build the allow-listed module snapshot sent to the backend. */
    createProductModuleData: function createProductModuleData(record, moduleName) {
      const data = {};
      if (moduleName === "basic") {
        data.product_name = record.product_name;
        data.product_category = record.product_category;
        data.category_ids = record.category_ids;
        data.attributes_json = record.attributes_json;
      } else if (moduleName === "images") {
        data.main_image_url = record.main_image_url;
        data.gallery_image_urls = record.gallery_image_urls;
        data.detail_image_urls = record.detail_image_urls;
      } else if (moduleName === "skus") {
        data.sku = record.sku;
      } else if (moduleName === "listing") {
        data.product_name = record.product_name;
        data.listing_json = record.listing_json;
      }
      return data;
    },

    /** Queue the next module snapshot for one product without allowing parallel writes. */
    saveProductModule: function saveProductModule(record, moduleName) {
      if (!record) {
        return;
      }
      const key = this.productCacheEventKey(record);
      const state = this.getProductSaveState(record);
      if (!key || !state) {
        return;
      }
      state.pendingModules[moduleName] = this.cloneProductSaveData(this.createProductModuleData(record, moduleName));
      state.generation += 1;
      if (state.conflict) {
        state.conflict = false;
        state.remoteProduct = null;
      }
      if (state.timer) {
        window.clearTimeout(state.timer);
      }
      const view = this;
      /** Start one coalesced product save after the input burst settles. */
      function startCoalescedProductSave() {
        state.timer = null;
        view.flushProductSave(key);
      }
      state.timer = window.setTimeout(startCoalescedProductSave, 260);
    },

    /** Flush one queued module snapshot while keeping every product save serialized. */
    flushProductSave: function flushProductSave(cacheKey) {
      const key = String(cacheKey || "");
      const state = this.productSaveStates[key];
      if (!state || state.inFlight || state.conflict) {
        return;
      }
      let moduleName = "";
      for (const pendingModuleName in state.pendingModules) {
        if (Object.prototype.hasOwnProperty.call(state.pendingModules, pendingModuleName)) {
          moduleName = pendingModuleName;
          break;
        }
      }
      if (!moduleName) {
        return;
      }
      const record = this.findProductByCacheKey(key);
      if (!record) {
        delete state.pendingModules[moduleName];
        return;
      }
      const data = state.pendingModules[moduleName];
      delete state.pendingModules[moduleName];
      const generation = state.generation;
      const version = Number(record.version || 1);
      state.inFlight = { moduleName: moduleName, generation: generation, data: data, version: version };
      this.markPendingCacheEvent(record);
      const view = this;
      const endpoint = "/products/" + encodeURIComponent(record.platform) + "/" + encodeURIComponent(record.platform_id) + "/modules/" + encodeURIComponent(moduleName);
      fetch(apiUrl(endpoint), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: version, data: data })
      }).then(function handleModuleSaveResponse(response) {
        return response.json().then(function validateModuleSavePayload(payload) {
          if (!response.ok || !payload.ok) {
            const saveError = new Error(getApiErrorMessage(payload, "保存失败。"));
            saveError.status = response.status;
            saveError.payload = payload;
            throw saveError;
          }
          return payload.data;
        });
      }).then(function applySavedModule(result) {
        view.finishProductSave(key, result);
      }).catch(function handleModuleSaveError(error) {
        view.failProductSave(key, error);
      });
    },

    /** Apply only the saved version and keep the live record so unblurred edits cannot roll back. */
    finishProductSave: function finishProductSave(cacheKey, result) {
      const state = this.productSaveStates[String(cacheKey || "")];
      if (!state || !state.inFlight) {
        return;
      }
      state.inFlight = null;
      const product = result && result.product ? result.product : null;
      const record = this.findProductByCacheKey(cacheKey);
      if (record && product) {
        record.version = Number(product.version || record.version || 1);
      }
      if (this.hasPendingProductModules(state)) {
        this.flushProductSave(cacheKey);
        return;
      }
      this.setStatus("cache 已更新。", "success");
    },

    /** Check whether one product has module snapshots waiting behind its current request. */
    hasPendingProductModules: function hasPendingProductModules(state) {
      const pending = state && state.pendingModules ? state.pendingModules : {};
      for (const moduleName in pending) {
        if (Object.prototype.hasOwnProperty.call(pending, moduleName)) {
          return true;
        }
      }
      return false;
    },

    /** Retain a failed module snapshot and expose a recoverable conflict state. */
    failProductSave: function failProductSave(cacheKey, error) {
      const key = String(cacheKey || "");
      const state = this.productSaveStates[key];
      if (!state || !state.inFlight) {
        return;
      }
      const request = state.inFlight;
      state.inFlight = null;
      this.clearPendingCacheEvent(key);
      if (!state.pendingModules[request.moduleName]) {
        state.pendingModules[request.moduleName] = request.data;
      }
      const payload = error && error.payload ? error.payload : null;
      const errorBody = payload && payload.error && typeof payload.error === "object" ? payload.error : {};
      const details = errorBody.details && typeof errorBody.details === "object" ? errorBody.details : {};
      if (error && Number(error.status) === 409) {
        const record = this.findProductByCacheKey(key);
        state.conflict = true;
        state.remoteProduct = details.product || null;
        if (record && details.current_version) {
          record.version = Number(details.current_version);
        }
        this.setStatus("商品已被其他页面更新，当前修改已暂存；继续编辑将保留本页修改重试。", "error");
        return;
      }
      this.setStatus(error && error.message ? error.message : "cache 更新失败。", "error");
    },

    /** Replace one rendered product with the fresh server ViewModel. */
    replaceProductViewModel: function replaceProductViewModel(product) {
      for (let index = 0; index < this.records.length; index += 1) {
        if (String(this.records[index].platform) === String(product.platform)
          && String(this.records[index].platform_id) === String(product.platform_id)) {
          this.records.splice(index, 1, product);
          return;
        }
      }
    },

    /** Build the compact product information sent to Kimi without image payloads. */
    createListingSource: function createListingSource(record) {
      const item = record || {};
      const listing = item.listing_json && typeof item.listing_json === "object" ? item.listing_json : {};
      return {
        title: String(listing.title || item.product_name || ""),
        category: String(item.product_category || ""),
        attributes: Array.isArray(item.attributes_json) ? item.attributes_json : []
      };
    },

    /** Apply one returned Listing title while preserving the other editable Temu fields. */
    applyListingToRecord: function applyListingToRecord(record, rawListing) {
      if (!record) {
        return null;
      }
      const listing = record.listing_json && typeof record.listing_json === "object"
        ? record.listing_json
        : { title: "", keywords: "", attributes: [] };
      const returnedListing = rawListing && typeof rawListing === "object" ? rawListing : {};
      const returnedTitle = String(returnedListing.title || "").trim();
      if (returnedTitle) {
        listing.title = returnedTitle;
      }
      record.listing = listing;
      record.listing_json = listing;
      if (returnedTitle) {
        record.product_name = returnedTitle;
      }
      return listing;
    },

    /** Build the browser lookup key for one Listing undo token returned by the API. */
    getListingUndoKey: function getListingUndoKey(record) {
      const item = record || {};
      return String(item.platform || "temu") + ":" + String(item.main_id || "");
    },

    /** Check whether the selected Listing has a server-side undo token. */
    hasListingUndo: function hasListingUndo(record) {
      const key = this.getListingUndoKey(record);
      return Boolean(this.listingUndoTokens[key]);
    },

    /** Merge the currently selected Temu and 1688 Listing sources through Kimi. */
    mergeSelectedListings: function mergeSelectedListings() {
      const temuRecord = this.selectedTemuRecord;
      const aliRecord = this.selected1688Record;
      if (!temuRecord || !aliRecord || this.listingMergeBusy) {
        this.setStatus("请先选择 Temu 和 1688 商品。", "error");
        return;
      }
      this.listingMergeBusy = true;
      this.setStatus("Kimi 正在合并两个 Listing…", "normal");
      const view = this;
      fetch(apiUrl("/listing/merge"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          temu_listing: this.createListingSource(temuRecord),
          ali_listing: this.createListingSource(aliRecord)
        })
      }).then(function handleListingMergeResponse(response) {
        return response.json().then(function handleListingMergePayload(payload) {
          if (!response.ok || !payload || !payload.ok) {
            const apiError = payload && payload.error && typeof payload.error === "object" ? payload.error : {};
            const error = new Error(getApiErrorMessage(payload, "Kimi 合并 Listing 失败。"));
            error.code = String(apiError.code || response.status || "REQUEST_FAILED");
            error.statusCode = Number(response.status || 500);
            throw error;
          }
          return readApiData(payload);
        });
      }).then(function handleListingMergeSuccess(payload) {
        const undoKey = view.getListingUndoKey(temuRecord);
        view.applyListingToRecord(temuRecord, payload.listing);
        view.listingUndoTokens[undoKey] = String(payload.undo_token || "");
        view.setStatus("Kimi 返回内容已更新到当前页面，暂未自动保存。", "success");
      }).catch(function handleListingMergeError(error) {
        view.setStatus("Listing 合并失败 [" + getWorkflowErrorCode(error) + "]：" + (error.message || "请求失败。"), "error");
      }).finally(function handleListingMergeFinished() {
        view.listingMergeBusy = false;
      });
    },

    /** Restore the selected Listing by consuming its server-side undo token. */
    undoSelectedListing: function undoSelectedListing() {
      const temuRecord = this.selectedTemuRecord;
      if (!temuRecord || this.listingUndoBusy) {
        return;
      }
      const undoKey = this.getListingUndoKey(temuRecord);
      const undoToken = String(this.listingUndoTokens[undoKey] || "");
      if (!undoToken) {
        this.setStatus("没有可返回的 Listing。", "normal");
        return;
      }
      this.listingUndoBusy = true;
      this.setStatus("正在通过 Server API 恢复原 Listing…", "normal");
      const view = this;
      fetch(apiUrl("/listing/undo"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ undo_token: undoToken })
      }).then(function handleListingUndoResponse(response) {
        return response.json().then(function handleListingUndoPayload(payload) {
          if (!response.ok || !payload || !payload.ok) {
            throw new Error(getApiErrorMessage(payload, "Listing 返回失败。"));
          }
          return readApiData(payload);
        });
      }).then(function handleListingUndoSuccess(payload) {
        view.applyListingToRecord(temuRecord, payload.listing);
        delete view.listingUndoTokens[undoKey];
        view.setStatus("已在当前页面恢复原 Listing，暂未自动保存。", "success");
      }).catch(function handleListingUndoError(error) {
        view.setStatus("Listing 返回失败：" + (error.message || "请求失败。"), "error");
      }).finally(function handleListingUndoFinished() {
        view.listingUndoBusy = false;
      });
    },

    /** Apply a normalized record list and keep both platform selections valid. */
    applyRecords: function applyRecords(records, sourceFileName, payload) {
      const previousMainId = String(this.selectedMainId || "");
      const previousTemuMainId = String(this.selectedTemuMainId || "");
      const previousAliMainId = String(this.selected1688MainId || "");
      const previousTemuGalleryIndex = Number(this.selectedTemuGalleryIndex);
      const previousAliGalleryIndex = Number(this.selected1688GalleryIndex);
      const previousRecords = this.records;
      const mergedRecords = [];
      const retainedKeys = {};
      const incomingRecords = Array.isArray(records) ? records : [];
      for (let recordIndex = 0; recordIndex < incomingRecords.length; recordIndex += 1) {
        const incomingRecord = incomingRecords[recordIndex];
        const key = this.productCacheEventKey(incomingRecord);
        const state = key ? this.productSaveStates[key] : null;
        let localRecord = null;
        for (let localIndex = 0; localIndex < previousRecords.length; localIndex += 1) {
          if (this.productCacheEventKey(previousRecords[localIndex]) === key) {
            localRecord = previousRecords[localIndex];
            break;
          }
        }
        const hasLocalChanges = state && (state.inFlight || this.hasPendingProductModules(state) || state.conflict);
        if (hasLocalChanges && localRecord) {
          if (Number(incomingRecord.version || 0) > Number(localRecord.version || 0)) {
            state.remoteProduct = incomingRecord;
          }
          mergedRecords.push(localRecord);
          retainedKeys[key] = true;
        } else {
          mergedRecords.push(incomingRecord);
        }
      }
      for (let localIndex = 0; localIndex < previousRecords.length; localIndex += 1) {
        const localRecord = previousRecords[localIndex];
        const key = this.productCacheEventKey(localRecord);
        const state = key ? this.productSaveStates[key] : null;
        const hasLocalChanges = state && (state.inFlight || this.hasPendingProductModules(state) || state.conflict);
        if (hasLocalChanges && !retainedKeys[key]) {
          mergedRecords.push(localRecord);
        }
      }
      this.records = mergedRecords;
      this.sourceFileName = sourceFileName || "";
      this.selectedMainId = records.length ? records[0].main_id : "";
      for (let recordIndex = 0; recordIndex < records.length; recordIndex += 1) {
        if (previousMainId && String(records[recordIndex].main_id) === previousMainId) {
          this.selectedMainId = records[recordIndex].main_id;
          break;
        }
      }
      const query = new URLSearchParams(window.location.search);
      const requestedTemuMainId = String(query.get("temu_main_id") || "");
      const requestedAliMainId = String(query.get("ali_main_id") || "");
      this.selectedTemuMainId = this.temuRecords.length ? this.temuRecords[0].main_id : "";
      let hasTemuSelection = false;
      for (let temuIndex = 0; temuIndex < this.temuRecords.length; temuIndex += 1) {
        const candidate = String(this.temuRecords[temuIndex].main_id);
        if ((requestedTemuMainId && candidate === requestedTemuMainId)
          || (!requestedTemuMainId && previousTemuMainId && candidate === previousTemuMainId)) {
          this.selectedTemuMainId = this.temuRecords[temuIndex].main_id;
          hasTemuSelection = true;
          break;
        }
      }
      this.selected1688MainId = "";
      let hasAliSelection = false;
      for (let aliIndex = 0; aliIndex < this.aliRecords.length; aliIndex += 1) {
        const candidate = String(this.aliRecords[aliIndex].main_id);
        if ((requestedAliMainId && candidate === requestedAliMainId)
          || (!requestedAliMainId && previousAliMainId && candidate === previousAliMainId)) {
          this.selected1688MainId = this.aliRecords[aliIndex].main_id;
          hasAliSelection = true;
          break;
        }
      }
      if (!hasTemuSelection && this.temuRecords.length) {
        this.selectedTemuMainId = this.temuRecords[0].main_id;
      }
      if (!hasAliSelection) {
        this.selectBound1688ForTemu(this.selectedTemuRecord);
      }
      this.updateGallerySelection(this.selectedTemuRecord, "temu", previousTemuGalleryIndex);
      this.updateGallerySelection(this.selected1688Record, "1688", previousAliGalleryIndex);
      const retainImageEditor = Boolean(this.imageEditorBusy || this.imageEditorGeneratedUrl || this.imageDirectTask || this.imageCarouselTask);
      if (!retainImageEditor) {
        this.galleryEditRecordKey = "";
        this.galleryEditSelection = [];
        this.imageEditorSourceType = "gallery";
        this.imageEditorSourceUrls = [];
        this.imageEditorDetailIndex = -1;
        this.imageEditorRecordKey = "";
        this.imageEditorOpen = false;
      }
      this.syncWorkflowSelection();
      if (payload && Array.isArray(payload.mappings)) {
        this.loadMapping(payload);
      }
      this.syncWorkflowSelection();
      this.persistViewState();
    },

    /** Apply the long-lived local cache payload received from the server. */
    applyCachePayload: function applyCachePayload(payload) {
      const instruction = payload && payload.update_instruction && typeof payload.update_instruction === "object"
        ? payload.update_instruction
        : {};
      const records = payload && Array.isArray(payload.records) ? payload.records : [];
      this.applyRecords(records, "cache.json", payload);
      this.refreshImageTaskIndicatorsAndRestore();
      if (instruction.type === "binding_completed") {
        const temuMainId = String(instruction.temu_main_id || "");
        const aliMainId = String(instruction.ali_main_id || "");
        for (let temuIndex = 0; temuIndex < this.temuRecords.length; temuIndex += 1) {
          if (String(this.temuRecords[temuIndex].main_id) === temuMainId) {
            this.selectedTemuMainId = this.temuRecords[temuIndex].main_id;
            break;
          }
        }
        for (let aliIndex = 0; aliIndex < this.aliRecords.length; aliIndex += 1) {
          if (String(this.aliRecords[aliIndex].main_id) === aliMainId) {
            this.selected1688MainId = this.aliRecords[aliIndex].main_id;
            break;
          }
        }
        this.selectedTemuGalleryIndex = 0;
        this.selected1688GalleryIndex = 0;
        this.persistViewState();
        this.setStatus("服务器已完成绑定并更新当前 Temu / 1688 商品。", "success");
        return;
      }
      if (records.length) {
        this.setStatus("实时 cache 已读取 " + records.length + " 个商品。", "success");
      } else {
        this.setStatus("等待扩展采集商品并写入 cache。", "normal");
      }
    },

    /** Open the local cache snapshot and SSE stream for real-time rendering. */
    startRealtimeCache: function startRealtimeCache() {
      this.stopRealtimeCache();
      const view = this;
      const source = new EventSource(String((window.APP_CONFIG || {}).eventUrl || apiUrl("/events")));
      /** Mark the real-time cache stream as connected. */
      source.onopen = function handleCacheOpen() {
        view.realtimeConnected = true;
      };
      /** Apply each cache update pushed by the local server. */
      source.onmessage = function handleCacheMessage(event) {
        let message = {};
        try {
          message = JSON.parse(String(event && event.data || "{}"));
        } catch (error) {
          message = {};
        }
        if (message.action === "connected") {
          return;
        }
        if (message.resource === "workbench" && message.action === "focus") {
          view.focusRealtimeWorkbench(message);
          return;
        }
        if (message.resource === "workflow" && (message.action === "candidate_updated" || message.action === "state_updated")) {
          view.realtimeLastEventId = Number(event && event.lastEventId) || view.realtimeLastEventId;
          view.loadWorkflowPayload();
          return;
        }
        if (view.consumePendingCacheEvent(message)) {
          return;
        }
        view.realtimeLastEventId = Number(event && event.lastEventId) || view.realtimeLastEventId;
        view.queueRealtimeCacheRefresh();
      };
      /** Mark the cache stream as disconnected without clearing loaded data. */
      source.onerror = function handleCacheError() {
        view.realtimeConnected = false;
      };
      this.realtimeSource = source;
      this.realtimeRefreshQueued = true;
      this.refreshRealtimeCache();
    },

    /** Switch to the requested Workbench product and reveal its Temu panel. */
    focusRealtimeWorkbench: function focusRealtimeWorkbench(instruction) {
      const temuMainId = String(instruction && instruction.temu_main_id || "");
      const temuPlatformId = String(instruction && instruction.temu_platform_id || "");
      this.changeWorkspaceMode("realtime");
      for (let index = 0; index < this.temuRecords.length; index += 1) {
        const record = this.temuRecords[index];
        if ((temuMainId && String(record.main_id) === temuMainId)
          || (temuPlatformId && String(record.platform_id) === temuPlatformId)) {
          this.selectTemuRecord(record);
          break;
        }
      }
      /** Reveal the selected Temu panel after Vue applies the new Workbench state. */
      function revealFocusedWorkbenchProduct() {
        const panel = document.querySelector(".temu-render");
        if (panel) {
          panel.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      }
      this.$nextTick(revealFocusedWorkbenchProduct);
      this.setStatus("已返回工作台并定位到刚绑定的商品。", "success");
    },

    /** Queue several close-together product events into one cache refresh. */
    queueRealtimeCacheRefresh: function queueRealtimeCacheRefresh() {
      this.realtimeRefreshQueued = true;
      if (this.realtimeRefreshTimer || this.realtimeRefreshInFlight) {
        return;
      }
      const view = this;
      /** Start one coalesced cache refresh after the current event burst. */
      function startQueuedRealtimeCacheRefresh() {
        view.realtimeRefreshTimer = null;
        view.refreshRealtimeCache();
      }
      this.realtimeRefreshTimer = setTimeout(startQueuedRealtimeCacheRefresh, 120);
    },

    /** Read one cache snapshot and apply it after coalesced SSE invalidations. */
    refreshRealtimeCache: function refreshRealtimeCache() {
      if (this.realtimeRefreshInFlight || !this.realtimeRefreshQueued) {
        return;
      }
      this.realtimeRefreshQueued = false;
      this.realtimeRefreshInFlight = true;
      const view = this;
      fetch(apiUrl("/workbench"), { cache: "no-store" }).then(function handleCacheResponse(response) {
        if (!response.ok) {
          throw new Error("本地 cache 服务未启动。 ");
        }
        return response.json();
      }).then(function handleCachePayload(payload) {
        view.applyCachePayload(payload.data || {});
      }).catch(function handleCacheRefreshError(error) {
        if (error && error.message === "本地 cache 服务未启动。 ") {
          view.setStatus("未连接到本地 cache，请先运行 npm run dev。", "normal");
          return;
        }
        view.setStatus("实时数据刷新失败。", "error");
      }).finally(function handleCacheRefreshFinished() {
        view.realtimeRefreshInFlight = false;
        if (view.realtimeRefreshQueued) {
          view.queueRealtimeCacheRefresh();
        }
      });
    },

    /** Close the current real-time cache stream. */
    stopRealtimeCache: function stopRealtimeCache() {
      if (this.realtimeSource) {
        this.realtimeSource.close();
        this.realtimeSource = null;
      }
      if (this.realtimeRefreshTimer) {
        clearTimeout(this.realtimeRefreshTimer);
        this.realtimeRefreshTimer = null;
      }
      this.realtimeRefreshQueued = false;
      this.realtimeConnected = false;
    },

    /** Switch between local JSON export mode and live cache rendering mode. */
    changeRenderMode: function changeRenderMode(mode) {
      this.renderMode = mode === "export" ? "export" : "realtime";
      if (this.renderMode === "realtime") {
        this.startRealtimeCache();
        return;
      }
      this.stopRealtimeCache();
      this.setStatus("导出模式：请导入统一 JSON 文件。", "normal");
    },

    /** Switch only the right-hand workspace while preserving the Temu listing rail. */
    changeWorkspaceMode: function changeWorkspaceMode(mode) {
      this.workspaceMode = mode === "smart" ? "smart" : "realtime";
      this.persistViewState();
      if (this.workspaceMode === "smart" && this.selectedTemuRecord) {
        this.syncWorkflowSelection();
      }
    },

    /** Set the visible status message for the inline intelligent-packing workflow. */
    setWorkflowStatus: function setWorkflowStatus(message, type) {
      this.workflowStatusText = String(message || "");
      this.workflowStatusType = type || "normal";
    },

    /** Apply one workflow state snapshot and refresh the selected task. */
    applyWorkflowPayload: function applyWorkflowPayload(payload) {
      const state = payload && payload.workflow ? payload.workflow : payload;
      const temporaryState = payload && payload.state ? payload.state : { updated_at: "", tasks: {} };
      this.workflow = state && typeof state === "object" ? state : { active_temu_main_id: "", tasks: {} };
      this.workflowTemporaryState = temporaryState && typeof temporaryState === "object" ? temporaryState : { updated_at: "", tasks: {} };
      this.resumePendingWorkflowGenerations();
      const task = this.selectedWorkflowTask;
      if (task && Array.isArray(task.prompts) && !this.workflowPromptBusy) {
        this.syncWorkflowPrompts(task);
      }
      if (task && !this.workflowPromptBusy) {
        const statusType = task.status === "completed" || task.status === "images_ready"
          ? "success"
          : task.status === "generation_error" || task.status === "search_error" ? "error" : "normal";
        this.setWorkflowStatus(this.workflowTaskStatusText(this.selectedTemuMainId), statusType);
      }
    },

    /** Resume every persisted prompt task that has not yet entered image generation. */
    resumePendingWorkflowGenerations: function resumePendingWorkflowGenerations() {
      const tasks = this.workflow && this.workflow.tasks ? this.workflow.tasks : {};
      const taskIds = Object.keys(tasks);
      for (let index = 0; index < taskIds.length; index += 1) {
        const mainId = String(taskIds[index]);
        const task = tasks[mainId];
        if (task && task.status === "prompts_ready" && Array.isArray(task.prompts) && task.prompts.length === 4 && !this.workflowGenerateBusyKeys[mainId]) {
          this.generateWorkflowImages(undefined, mainId, task.prompts);
        }
      }
    },

    /** Load all persisted intelligent-packing tasks from the backend. */
    loadWorkflowPayload: function loadWorkflowPayload() {
      const view = this;
      return requestWorkflowJson(workflowApiUrl("/workflow"), { cache: "no-store" }).then(function handleWorkflowLoadSuccess(payload) {
        view.applyWorkflowPayload(payload);
        view.syncWorkflowSelection();
      }).catch(function handleWorkflowLoadError(error) {
        if (view.workspaceMode === "smart") {
          view.setWorkflowStatus("组货记录读取失败：" + error.message, "error");
        }
      });
    },

    /** Store one returned workflow task under its Temu product identifier. */
    storeWorkflowTask: function storeWorkflowTask(temuMainId, task) {
      if (!task || typeof task !== "object") {
        return;
      }
      if (!this.workflow || typeof this.workflow !== "object") {
        this.workflow = { active_temu_main_id: "", tasks: {} };
      }
      if (!this.workflow.tasks || typeof this.workflow.tasks !== "object") {
        this.workflow.tasks = {};
      }
      this.workflow.tasks[String(temuMainId || "")] = task;
    },

    /** Restore the inline workflow controls for the selected Temu record. */
    syncWorkflowSelection: function syncWorkflowSelection() {
      const record = this.selectedTemuRecord;
      const task = this.selectedWorkflowTask;
      const images = this.workflowSourceImages;
      this.workflowPromptDrafts = {};
      this.workflowSearchBusyKeys = {};
      const selectedMainId = String(record && record.main_id || "");
      const temporaryTasks = this.workflowTemporaryState && this.workflowTemporaryState.tasks ? this.workflowTemporaryState.tasks : {};
      const temporaryTask = temporaryTasks[selectedMainId] || {};
      this.workflowPromptBusy = Boolean(this.workflowPromptBusyKeys[selectedMainId]) || temporaryTask.status === "analyzing";
      this.workflowGenerateBusy = Boolean(this.workflowGenerateBusyKeys[selectedMainId]) || temporaryTask.status === "generating";
      this.workflowSelectedImageUrl = task && task.selected_image_url ? task.selected_image_url : record && record.main_image_url ? record.main_image_url : images[0] || "";
      this.workflowSelectedResultIndex = task && Number.isFinite(Number(task.selected_result_index)) ? Number(task.selected_result_index) : -1;
      this.syncWorkflowPrompts(task);
      this.setWorkflowStatus(this.workflowPromptBusy ? "Kimi 正在后台分析当前商品…" : task && task.status !== "idle" ? this.workflowTaskStatusText(this.selectedTemuMainId) : record ? "已选择 Temu 商品，请确认分析主图。" : "等待选择 Temu 商品。", "normal");
      if (task && task.status === "prompts_ready" && Array.isArray(task.prompts) && task.prompts.length === 4 && !this.workflowPromptBusy && !this.workflowGenerateBusy) {
        this.generateWorkflowImages(undefined, selectedMainId, task.prompts);
      }
    },

    /** Copy persisted workflow prompts into editable page-local objects. */
    syncWorkflowPrompts: function syncWorkflowPrompts(task) {
      const source = task && Array.isArray(task.prompts) ? task.prompts : [];
      const prompts = [];
      for (let index = 0; index < source.length; index += 1) {
        const promptKey = String(index);
        const hasDraft = Object.prototype.hasOwnProperty.call(this.workflowPromptDrafts, promptKey);
        prompts.push({
          relation: String(source[index].relation || ""),
          product_name: String(source[index].product_name || ""),
          product_intro: String(source[index].product_intro || source[index].product_name || ""),
          prompt: hasDraft ? this.workflowPromptDrafts[promptKey] : String(source[index].prompt || ""),
          image_url: String(source[index].image_url || ""),
          status: String(source[index].status || ""),
          error: String(source[index].error || ""),
          error_code: String(source[index].error_code || ""),
          error_status: Number(source[index].error_status || 0),
          search_url: String(source[index].search_url || ""),
          search_status: this.workflowSearchBusyKeys[promptKey] ? "searching" : String(source[index].search_status || ""),
          search_error: String(source[index].search_error || "")
        });
      }
      this.workflowPrompts = prompts;
      if (task && Number(task.selected_result_index) >= 0) {
        this.workflowSelectedResultIndex = Number(task.selected_result_index);
      }
    },

    /** Return a concise candidate error message with its backend error code. */
    workflowPromptErrorText: function workflowPromptErrorText(item) {
      const source = item || {};
      const code = String(source.error_code || (source.error_status ? "HTTP_" + source.error_status : "WORKFLOW_ERROR"));
      const rawMessage = String(source.error || "生图失败。").replace(/\s+/g, " ").trim();
      const message = rawMessage.indexOf("<!DOCTYPE") >= 0 || rawMessage.indexOf("<html") >= 0
        ? "上游服务返回网关错误。"
        : rawMessage.slice(0, 120);
      return "生成失败 [" + code + "] " + message;
    },

    /** Keep one user-edited prompt while workflow SSE snapshots are arriving. */
    markWorkflowPromptDraft: function markWorkflowPromptDraft(index, value) {
      this.workflowPromptDrafts[String(index)] = String(value || "");
    },

    /** Select the Temu image submitted to the prompt-generation service. */
    selectWorkflowSourceImage: function selectWorkflowSourceImage(image) {
      const source = String(image || "");
      this.workflowSelectedImageUrl = source;
      const images = this.galleryImages(this.selectedTemuRecord);
      const imageIndex = images.indexOf(source);
      if (imageIndex >= 0) {
        this.selectedTemuGalleryIndex = imageIndex;
        this.selectedGalleryIndex = imageIndex;
      }
    },

    /** Open the custom direction prompt stored for the selected Temu product. */
    generateWorkflowPrompts: function generateWorkflowPrompts() {
      if (!this.selectedTemuRecord || !this.workflowSelectedImageUrl || this.workflowPromptBusy) {
        return;
      }
      const task = this.selectedWorkflowTask;
      const savedPrompt = task ? String(task.custom_prompt || "").trim() : "";
      this.workflowCustomPromptDraft = savedPrompt || this.workflowCustomPromptDefault;
      this.workflowPromptDialogError = "";
      this.workflowPromptDialogOpen = true;
    },

    /** Close the custom direction prompt without starting a Kimi request. */
    closeWorkflowPromptDialog: function closeWorkflowPromptDialog() {
      this.workflowPromptDialogOpen = false;
      this.workflowPromptDialogError = "";
    },

    /** Request four custom intelligent-packing directions for the selected Temu product. */
    submitWorkflowPrompts: function submitWorkflowPrompts() {
      if (!this.selectedTemuRecord || !this.workflowSelectedImageUrl || this.workflowPromptBusy) {
        return;
      }
      const customPrompt = String(this.workflowCustomPromptDraft || "").trim();
      if (!customPrompt) {
        this.workflowPromptDialogError = "请输入组货提示词。";
        return;
      }
      this.workflowPromptBusy = true;
      const requestedTemuMainId = String(this.selectedTemuRecord.main_id);
      this.workflowPromptBusyKeys[requestedTemuMainId] = true;
      delete this.workflowTaskErrorKeys[requestedTemuMainId];
      this.workflowPromptDialogOpen = false;
      this.workflowPromptDialogError = "";
      this.workflowPromptDrafts = {};
      this.setWorkflowStatus("Kimi 正在分析商品并生成四个组货方向…", "normal");
      const view = this;
      requestWorkflowJson(workflowApiUrl("/workflow/prompts"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          temu_main_id: this.selectedTemuRecord.main_id,
          image_url: this.workflowSelectedImageUrl,
          custom_prompt: customPrompt,
          product: {
            title: this.selectedTemuRecord.product_name,
            category: this.selectedTemuRecord.product_category,
            attributes: this.selectedTemuRecord.attributes_json,
            price_reference: getWorkflowPriceReference(this.selectedTemuRecord)
          }
        })
      }).then(function handleWorkflowPromptSuccess(payload) {
        view.storeWorkflowTask(requestedTemuMainId, payload.task);
        delete view.workflowTaskErrorKeys[requestedTemuMainId];
        if (String(view.selectedTemuMainId) === requestedTemuMainId) {
          view.syncWorkflowPrompts(payload.task);
          view.workflowSelectedResultIndex = -1;
          view.setWorkflowStatus("四个组货方向已生成，正在自动生成四张图片…", "normal");
        }
        view.generateWorkflowImages(undefined, requestedTemuMainId, payload.task && payload.task.prompts);
      }).catch(function handleWorkflowPromptError(error) {
        view.workflowTaskErrorKeys[requestedTemuMainId] = true;
        if (String(view.selectedTemuMainId) !== requestedTemuMainId) {
          return;
        }
        view.workflowPromptDialogError = "Kimi 提词失败：" + error.message;
        view.setWorkflowStatus("Kimi 提词失败：" + error.message, "error");
      }).finally(function finishWorkflowPromptRequest() {
        delete view.workflowPromptBusyKeys[requestedTemuMainId];
        if (String(view.selectedTemuMainId) === requestedTemuMainId) {
          view.workflowPromptBusy = false;
        }
      });
    },

    /** Apply one terminal workflow generation snapshot returned or recovered from the backend. */
    applyWorkflowGenerationResult: function applyWorkflowGenerationResult(temuMainId, task, index) {
      const requestedTemuMainId = String(temuMainId || "");
      this.storeWorkflowTask(requestedTemuMainId, task);
      const generationFailed = this.workflowTaskHasGenerationError(task) || !this.workflowTaskHasGeneratedAllImages(task);
      if (generationFailed) {
        this.workflowTaskErrorKeys[requestedTemuMainId] = true;
      } else {
        delete this.workflowTaskErrorKeys[requestedTemuMainId];
      }
      if (String(this.selectedTemuMainId) !== requestedTemuMainId) {
        return;
      }
      this.syncWorkflowPrompts(task);
      if (index === undefined) {
        this.workflowPromptDrafts = {};
      } else {
        delete this.workflowPromptDrafts[String(Number(index))];
      }
      this.setWorkflowStatus(generationFailed ? "生图已结束，存在生成失败的图片。" : index === undefined ? "四张白底图已生成，请选择一张。" : "图片已重新生成。", generationFailed ? "error" : "success");
    },

    /** Poll the persisted workflow state when the long generation response is interrupted. */
    recoverWorkflowGenerationResult: async function recoverWorkflowGenerationResult(temuMainId) {
      const requestedTemuMainId = String(temuMainId || "");
      let lastError = null;
      for (let attempt = 0; attempt < 310; attempt += 1) {
        try {
          const payload = await requestWorkflowJson(workflowApiUrl("/workflow"), { cache: "no-store" });
          const state = payload && payload.workflow ? payload.workflow : payload;
          const tasks = state && state.tasks && typeof state.tasks === "object" ? state.tasks : {};
          const task = tasks[requestedTemuMainId];
          if (task) {
            this.storeWorkflowTask(requestedTemuMainId, task);
            if (String(this.selectedTemuMainId) === requestedTemuMainId) {
              this.syncWorkflowPrompts(task);
            }
            let running = task.status === "generating";
            const prompts = Array.isArray(task.prompts) ? task.prompts : [];
            for (let promptIndex = 0; promptIndex < prompts.length; promptIndex += 1) {
              if (prompts[promptIndex].status === "queued" || prompts[promptIndex].status === "generating") {
                running = true;
                break;
              }
            }
            if (!running) {
              return task;
            }
          }
        } catch (error) {
          lastError = error;
        }
        /** Pause before reading the durable workflow state again. */
        function waitForWorkflowRecoveryTick(resolve) {
          window.setTimeout(resolve, 1000);
        }
        await new Promise(waitForWorkflowRecoveryTick);
      }
      throw lastError || new Error("后台生图结果读取超时。");
    },

    /** Generate the four candidate images immediately after Kimi returns directions. */
    generateWorkflowImages: function generateWorkflowImages(index, requestedMainId, requestedPrompts) {
      const temuMainId = String(requestedMainId || this.selectedTemuRecord && this.selectedTemuRecord.main_id || "");
      const promptSource = Array.isArray(requestedPrompts) ? requestedPrompts : this.workflowPrompts;
      if (!temuMainId || promptSource.length !== 4 || this.workflowGenerateBusyKeys[temuMainId]) {
        return;
      }
      this.workflowGenerateBusyKeys[temuMainId] = true;
      if (String(this.selectedTemuMainId) === temuMainId) {
        this.workflowGenerateBusy = true;
        this.setWorkflowStatus(index === undefined ? "BeeAPI 正在依次生成四张白底图…" : "BeeAPI 正在重新生成第 " + (Number(index) + 1) + " 张图…", "normal");
      }
      const prompts = [];
      for (let promptIndex = 0; promptIndex < promptSource.length; promptIndex += 1) {
        const promptItem = promptSource[promptIndex] || {};
        prompts.push(String(promptItem.prompt || ""));
      }
      const body = { temu_main_id: temuMainId, prompts: prompts };
      if (index !== undefined) {
        body.index = Number(index);
      }
      const view = this;
      const requestedTemuMainId = temuMainId;
      delete this.workflowTaskErrorKeys[requestedTemuMainId];
      requestWorkflowJson(workflowApiUrl("/workflow/generate"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      }).then(function handleWorkflowGenerationSuccess(payload) {
        view.applyWorkflowGenerationResult(requestedTemuMainId, payload.task, index);
      }).catch(function handleWorkflowGenerationError(error) {
        const requestError = error;
        return view.recoverWorkflowGenerationResult(requestedTemuMainId).then(function applyRecoveredWorkflowGeneration(task) {
          view.applyWorkflowGenerationResult(requestedTemuMainId, task, index);
        }).catch(function handleWorkflowRecoveryError() {
          view.workflowTaskErrorKeys[requestedTemuMainId] = true;
          if (String(view.selectedTemuMainId) !== requestedTemuMainId) {
            return;
          }
          view.setWorkflowStatus("BeeAPI 生图失败 [" + getWorkflowErrorCode(requestError) + "]：" + requestError.message, "error");
        });
      }).finally(function finishWorkflowGenerationRequest() {
        delete view.workflowGenerateBusyKeys[requestedTemuMainId];
        if (String(view.selectedTemuMainId) === requestedTemuMainId) {
          view.workflowGenerateBusy = false;
        }
      });
    },

    /** Select one generated image for the 1688 image-search step. */
    selectWorkflowResult: function selectWorkflowResult(index) {
      if (this.workflowPrompts[index] && this.workflowPrompts[index].image_url) {
        this.acknowledgeWorkflowTaskIndicator(this.selectedTemuRecord);
        this.workflowSelectedResultIndex = Number(index);
      }
    },

    /** Send one selected generated image to the 1688 image-search service. */
    searchWorkflow1688: function searchWorkflow1688(index) {
      const resultIndex = index === undefined ? this.workflowSelectedResultIndex : Number(index);
      const resultKey = String(resultIndex);
      const result = this.workflowPrompts[resultIndex];
      const requestedTemuMainId = String(this.selectedTemuRecord && this.selectedTemuRecord.main_id || "");
      if (this.workflowSearchBusyKeys[resultKey] || resultIndex < 0 || !this.selectedTemuRecord || !result || !result.image_url) {
        return;
      }
      this.workflowSelectedResultIndex = resultIndex;
      delete this.workflowTaskErrorKeys[requestedTemuMainId];
      this.workflowSearchBusyKeys[resultKey] = true;
      result.search_status = "searching";
      result.search_error = "";
      this.setWorkflowStatus("正在提交第 " + (resultIndex + 1) + " 张图片到 search-1688…", "normal");
      const view = this;
      this.request1688ImageSearch(result.image_url, requestedTemuMainId).then(function handleWorkflowSearchSuccess(payload) {
        delete view.workflowTaskErrorKeys[requestedTemuMainId];
        if (String(view.selectedTemuMainId) !== requestedTemuMainId) {
          return;
        }
        const searchData = payload && typeof payload === "object" ? payload : {};
        const searchUrl = String(searchData.search_url || "");
        if (!searchUrl) {
          throw new Error("search-1688 未返回搜款地址。");
        }
        const currentResult = view.workflowPrompts[resultIndex];
        if (currentResult) {
          currentResult.search_url = searchUrl;
          currentResult.search_offers = Array.isArray(searchData.offers) ? searchData.offers : [];
          currentResult.search_status = "ready";
          currentResult.search_error = "";
        }
        const currentTask = view.selectedWorkflowTask;
        if (currentTask) {
          currentTask.status = "waiting_1688_confirmation";
          currentTask.selected_result_index = resultIndex;
          currentTask.search_url = searchUrl;
          currentTask.search_offers = Array.isArray(searchData.offers) ? searchData.offers : [];
        }
        const searchWindow = window.open(searchUrl, "_blank");
        if (!searchWindow) {
          view.setWorkflowStatus("搜图完成，但浏览器阻止了新窗口，请点击下方“重新打开搜款页”。", "normal");
          return;
        }
        view.setWorkflowStatus("第 " + (resultIndex + 1) + " 张图片已打开 1688 搜款页。", "success");
      }).catch(function handleWorkflowSearchError(error) {
        view.workflowTaskErrorKeys[requestedTemuMainId] = true;
        if (String(view.selectedTemuMainId) !== requestedTemuMainId) {
          return;
        }
        const currentResult = view.workflowPrompts[resultIndex];
        if (currentResult) {
          currentResult.search_status = "error";
          currentResult.search_error = error.message || "搜图失败。";
        }
        view.setWorkflowStatus("1688 搜图失败：" + error.message, "error");
      }).finally(function finishWorkflowSearchRequest() {
        if (String(view.selectedTemuMainId) === requestedTemuMainId) {
          view.workflowSearchBusyKeys[resultKey] = false;
        }
      });
    },

    /** Return readable workflow status text for one Temu product. */
    workflowTaskStatusText: function workflowTaskStatusText(temuMainId) {
      const tasks = this.workflow && this.workflow.tasks ? this.workflow.tasks : {};
      const task = tasks[String(temuMainId)];
      const statuses = {
        idle: "等待开始",
        prompts_ready: "提示词已就绪",
        generating: "图片生成中",
        images_ready: "图片已就绪",
        waiting_1688_confirmation: "等待确认 1688",
        completed: "1688 已绑定",
        generation_error: "生图失败",
        search_error: "搜图失败"
      };
      return task ? statuses[task.status] || task.status || "等待开始" : "等待开始";
    },

    /** Load the non-secret image-edit sizes and prices from the local server. */
    loadImageEditConfig: function loadImageEditConfig() {
      const view = this;
      fetch(apiUrl("/config"), { cache: "no-store" }).then(function handleImageEditConfigResponse(response) {
        if (!response.ok) {
          throw new Error("溶图配置读取失败。");
        }
        return response.json();
      }).then(function handleImageEditConfigPayload(payload) {
        const imageConfig = payload && payload.data && payload.data.image ? payload.data.image : {};
        view.imageEditModel = String(imageConfig.model || "");
        view.imageEditPrices = imageConfig.price && typeof imageConfig.price === "object" ? imageConfig.price : {};
        view.imageEditorEditPrompt = String(imageConfig.edit_prompt || "");
        view.imageEditorFusionPrompt = String(imageConfig.fusion_prompt || "");
        const kimiConfig = payload && payload.data && payload.data.kimi ? payload.data.kimi : {};
        view.workflowCustomPromptDefault = String(kimiConfig.workflow_prompt || view.workflowCustomPromptDefault);
        view.imageEditorCarouselPrompt = String(kimiConfig.carousel_default_requirement || "");
      }).catch(function handleImageEditConfigError() {
        view.imageEditPrices = {};
      });
    },

    /** Format one configured image-edit price for the compact size control. */
    imageEditPrice: function imageEditPrice(size) {
      const price = Number(this.imageEditPrices[String(size || "")]);
      return Number.isFinite(price) ? price.toFixed(2) : "—";
    },

    /** Select a Temu listing in the left rail and reset its gallery. */
    selectTemuRecord: function selectTemuRecord(record) {
      this.closeSkuImagePicker();
      this.selectedTemuMainId = record ? record.main_id : "";
      this.selectBound1688ForTemu(record);
      this.selectedTemuGalleryIndex = 0;
      this.selected1688GalleryIndex = 0;
      this.galleryEditRecordKey = "";
      this.galleryEditSelection = [];
      this.closeWorkflowPromptDialog();
      this.closeGalleryImageEditor();
      this.syncWorkflowSelection();
      this.persistViewState();
    },

    /** Delete the selected or explicitly targeted Temu product directly from the backend cache. */
    deleteSelectedTemuRecord: async function deleteSelectedTemuRecord(targetRecord) {
      const record = targetRecord || this.selectedTemuRecord;
      if (!record || !window.confirm("确认删除当前 Temu 缓存？")) {
        return;
      }
      try {
        const endpoint = "/products/temu/" + encodeURIComponent(String(record.platform_id));
        const response = await fetch(apiUrl(endpoint), { method: "DELETE" });
        const payload = await response.json();
        if (!response.ok || !payload || !payload.ok) {
          throw new Error(getApiErrorMessage(payload, "删除失败。"));
        }
        this.applyCachePayload(payload.data || {});
        this.setStatus("已删除当前 Temu 缓存。", "success");
      } catch (error) {
        this.setStatus("删除 Temu 缓存失败：" + error.message, "error");
      }
    },

    /** Clear all Temu, 1688, image, workflow and JSON data from the backend cache directory. */
    clearEntireCache: async function clearEntireCache() {
      if (!window.confirm("确认清空整个 cache 目录？Temu、1688、图片、工作流和 JSON 数据都会永久删除。")) {
        return;
      }
      try {
        const response = await fetch(apiUrl("/products"), { method: "DELETE" });
        const payload = await response.json();
        if (!response.ok || !payload || !payload.ok) {
          throw new Error(getApiErrorMessage(payload, "清空失败。"));
        }
        this.applyCachePayload(payload.data || {});
        this.carouselUndoTokens = {};
        this.persistCarouselUndoTokens();
        this.setStatus("cache 目录中的 Temu、1688、图片、工作流和 JSON 数据已清空。", "success");
      } catch (error) {
        this.setStatus("清空 cache 目录失败：" + error.message, "error");
      }
    },

    /** Clear every product from the Server cache without touching extension cache. */
    clearServerCache: async function clearServerCache() {
      if (!this.records.length || !window.confirm("确认清空 Server cache？扩展 cache 不会删除。")) {
        return;
      }
      try {
        const response = await fetch(apiUrl("/products"), { method: "DELETE" });
        const payload = await response.json();
        if (!response.ok || !payload || !payload.ok) {
          throw new Error(getApiErrorMessage(payload, "清空失败。"));
        }
        this.applyCachePayload(payload.data || {});
        this.carouselUndoTokens = {};
        this.persistCarouselUndoTokens();
        this.setStatus("Server cache 已清空，扩展 cache 已保留。", "success");
      } catch (error) {
        this.setStatus("清空 Server cache 失败：" + error.message, "error");
      }
    },

    /** Select only the 1688 record whose platform_id is bound to one Temu record. */
    selectBound1688ForTemu: function selectBound1688ForTemu(record) {
      const boundPlatformId = String(record && record.bound_1688_platform_id || "");
      this.selected1688MainId = "";
      if (!boundPlatformId) {
        return;
      }
      for (let index = 0; index < this.aliRecords.length; index += 1) {
        const aliRecord = this.aliRecords[index] || {};
        if (String(aliRecord.platform_id || "") === boundPlatformId
          && String(aliRecord.linked_temu_platform_id || "") === String(record.platform_id || "")) {
          this.selected1688MainId = aliRecord.main_id;
          return;
        }
      }
    },

    /** Resolve backend cache paths against the configured API server. */
    imageSource: function imageSource(url) {
      const source = String(url || "").trim();
      if (source.indexOf("/api/v1/cache/image/") === 0) {
        return new URL(apiUrl("")).origin + source;
      }
      return source;
    },

    /** Upload one image to 1688 and return the search identifier and result URL. */
    request1688ImageSearch: function request1688ImageSearch(imageUrl, temuMainId) {
      return requestWorkflowJson(apiUrl("/images/search-1688"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          image_url: String(imageUrl || ""),
          temu_main_id: String(temuMainId || "")
        })
      });
    },

    /** Send the selected Temu image to the server-side 1688 image-search API. */
    searchTemuImageOn1688: function searchTemuImageOn1688(record, image) {
      const source = String(image || "").trim();
      if (!record || !source || this.imageSearchBusy) {
        return;
      }
      this.imageSearchBusy = true;
      this.setStatus("正在用当前图片搜索 1688…", "normal");
      const view = this;
      this.request1688ImageSearch(source, record.main_id).then(function openImageSearchPage(result) {
        const searchUrl = String(result.search_url || "").trim();
        if (!searchUrl) {
          throw new Error("1688 搜图没有返回搜索页面。");
        }
        const searchWindow = window.open(searchUrl, "_blank");
        if (!searchWindow) {
          view.setStatus("1688 搜图完成，但浏览器阻止了新窗口，请允许弹窗后重试。", "normal");
          return;
        }
        view.setStatus("已打开 1688 搜图页面。", "success");
      }).catch(function handleImageSearchError(error) {
        view.setStatus("1688 搜图失败：" + (error.message || "请求失败。"), "error");
      }).finally(function finishImageSearchRequest() {
        view.imageSearchBusy = false;
      });
    },

    /** Return all image URLs currently attached to one SKU row. */
    skuImageUrls: function skuImageUrls(sku) {
      const item = sku || {};
      const stored = readStoredImageUrls(item.sku_image_urls);
      if (stored.length) {
        return stored;
      }
      return item.sku_image_url ? [String(item.sku_image_url)] : [];
    },

    /** Build the local busy-state key for one Temu SKU blend request. */
    getSkuBlendKey: function getSkuBlendKey(record, sku, index) {
      return buildSkuKey(record, sku, index);
    },

    /** Find the latest rendered SKU after a long-running image request has completed. */
    findCurrentSkuTarget: function findCurrentSkuTarget(cacheKey, skuId, rowIndex) {
      const record = this.findProductByCacheKey(cacheKey);
      const rows = record && Array.isArray(record.sku) ? record.sku : [];
      const targetSkuId = String(skuId || "");
      if (targetSkuId) {
        for (let index = 0; index < rows.length; index += 1) {
          if (String(rows[index] && rows[index].sku_id || "") === targetSkuId) {
            return { record: record, sku: rows[index], rowIndex: index };
          }
        }
      }
      const fallbackIndex = Number(rowIndex);
      if (Number.isInteger(fallbackIndex) && fallbackIndex >= 0 && fallbackIndex < rows.length) {
        return { record: record, sku: rows[fallbackIndex], rowIndex: fallbackIndex };
      }
      return null;
    },

    /** Open an upward main-image bubble anchored to one blank SKU image cell. */
    openSkuImagePicker: function openSkuImagePicker(event, record, sku, rowIndex) {
      if (!record || !sku) {
        return;
      }
      this.cancelSkuImagePickerClose();
      const anchor = event && event.currentTarget;
      const rectangle = anchor && typeof anchor.getBoundingClientRect === "function" ? anchor.getBoundingClientRect() : null;
      const bubbleWidth = 288;
      let anchorLeft = rectangle ? rectangle.left - 12 : 12;
      if (anchorLeft + bubbleWidth > window.innerWidth - 12) {
        anchorLeft = window.innerWidth - bubbleWidth - 12;
      }
      if (anchorLeft < 12) {
        anchorLeft = 12;
      }
      let pointerLeft = rectangle ? rectangle.left + rectangle.width / 2 - anchorLeft - 6 : 18;
      if (pointerLeft < 18) {
        pointerLeft = 18;
      }
      if (pointerLeft > bubbleWidth - 30) {
        pointerLeft = bubbleWidth - 30;
      }
      this.skuImagePickerTarget = {
        cacheKey: this.productCacheEventKey(record),
        skuId: String(sku.sku_id || ""),
        rowIndex: Number(rowIndex),
        anchorLeft: anchorLeft,
        anchorBottom: rectangle ? window.innerHeight - rectangle.top + 10 : 80,
        maxHeight: rectangle ? Math.max(120, rectangle.top - 24) : 260,
        pointerLeft: pointerLeft
      };
      this.skuImagePickerOpen = true;
    },

    /** Close the SKU main-image picker and discard its row reference. */
    closeSkuImagePicker: function closeSkuImagePicker() {
      this.cancelSkuImagePickerClose();
      this.skuImagePickerOpen = false;
      this.skuImagePickerTarget = null;
    },

    /** Schedule picker closing so the cursor can move from the plus button into the bubble. */
    scheduleSkuImagePickerClose: function scheduleSkuImagePickerClose() {
      this.cancelSkuImagePickerClose();
      const view = this;
      /** Close the picker after the short cursor-transfer grace period. */
      this.skuImagePickerCloseTimer = window.setTimeout(function closeSkuImagePickerAfterDelay() {
        view.skuImagePickerCloseTimer = null;
        view.closeSkuImagePicker();
      }, 220);
    },

    /** Cancel a pending hover-close timer for the SKU image bubble. */
    cancelSkuImagePickerClose: function cancelSkuImagePickerClose() {
      if (this.skuImagePickerCloseTimer !== null) {
        window.clearTimeout(this.skuImagePickerCloseTimer);
        this.skuImagePickerCloseTimer = null;
      }
    },

    /** Resolve the latest SKU row targeted by the open main-image picker. */
    currentSkuImagePickerTarget: function currentSkuImagePickerTarget() {
      const target = this.skuImagePickerTarget;
      if (!target) {
        return null;
      }
      return this.findCurrentSkuTarget(target.cacheKey, target.skuId, target.rowIndex);
    },

    /** Return every current main image available to the selected SKU row. */
    skuImagePickerImages: function skuImagePickerImages() {
      const target = this.currentSkuImagePickerTarget();
      return target ? this.galleryImages(target.record) : [];
    },

    /** Position the SKU image picker directly above its hovered plus button. */
    skuImagePickerStyle: function skuImagePickerStyle() {
      const target = this.skuImagePickerTarget || {};
      return {
        left: String(Number(target.anchorLeft) || 12) + "px",
        bottom: String(Number(target.anchorBottom) || 80) + "px",
        maxHeight: String(Number(target.maxHeight) || 260) + "px",
        "--sku-picker-max-height": String(Number(target.maxHeight) || 260) + "px",
        "--sku-picker-pointer-left": String(Number(target.pointerLeft) || 18) + "px"
      };
    },

    /** Assign one chosen Temu main image to the blank SKU row and save it. */
    selectSkuImageFromGallery: function selectSkuImageFromGallery(imageUrl) {
      const target = this.currentSkuImagePickerTarget();
      const source = String(imageUrl || "").trim();
      if (!target || !source) {
        this.closeSkuImagePicker();
        return;
      }
      target.sku.sku_image_urls = [source];
      target.sku.sku_image_url = source;
      this.saveProductModule(target.record, "skus");
      this.closeSkuImagePicker();
      this.setStatus("已使用主图填充 SKU 图片。", "success");
    },

    /** Open the unified Temu and 1688 SKU-image bubble above the gallery upload button. */
    openGallerySkuPicker: function openGallerySkuPicker(event, record) {
      if (!record) {
        return;
      }
      this.cancelGallerySkuPickerClose();
      const anchor = event && event.currentTarget;
      const rectangle = anchor && typeof anchor.getBoundingClientRect === "function" ? anchor.getBoundingClientRect() : null;
      const bubbleWidth = 288;
      let anchorLeft = rectangle ? rectangle.left - 12 : 12;
      if (anchorLeft + bubbleWidth > window.innerWidth - 12) {
        anchorLeft = window.innerWidth - bubbleWidth - 12;
      }
      if (anchorLeft < 12) {
        anchorLeft = 12;
      }
      let pointerLeft = rectangle ? rectangle.left + rectangle.width / 2 - anchorLeft - 6 : 18;
      if (pointerLeft < 18) {
        pointerLeft = 18;
      }
      if (pointerLeft > bubbleWidth - 30) {
        pointerLeft = bubbleWidth - 30;
      }
      this.gallerySkuPickerTarget = {
        cacheKey: this.productCacheEventKey(record),
        anchorLeft: anchorLeft,
        anchorBottom: rectangle ? window.innerHeight - rectangle.top + 10 : 80,
        maxHeight: rectangle ? Math.max(160, Math.min(420, rectangle.top - 24)) : 340,
        pointerLeft: pointerLeft
      };
      this.gallerySkuPickerOpen = true;
    },

    /** Close the unified gallery SKU-image picker. */
    closeGallerySkuPicker: function closeGallerySkuPicker() {
      this.cancelGallerySkuPickerClose();
      this.gallerySkuPickerOpen = false;
      this.gallerySkuPickerTarget = null;
    },

    /** Schedule closing after the cursor-transfer grace period. */
    scheduleGallerySkuPickerClose: function scheduleGallerySkuPickerClose() {
      this.cancelGallerySkuPickerClose();
      const view = this;
      /** Close the gallery picker after the pointer has left both controls. */
      this.gallerySkuPickerCloseTimer = window.setTimeout(function closeGallerySkuPickerAfterDelay() {
        view.gallerySkuPickerCloseTimer = null;
        view.closeGallerySkuPicker();
      }, 220);
    },

    /** Cancel the pending close timer for the unified SKU-image bubble. */
    cancelGallerySkuPickerClose: function cancelGallerySkuPickerClose() {
      if (this.gallerySkuPickerCloseTimer !== null) {
        window.clearTimeout(this.gallerySkuPickerCloseTimer);
        this.gallerySkuPickerCloseTimer = null;
      }
    },

    /** Return unique SKU images from the selected Temu or 1688 product. */
    gallerySkuPickerImages: function gallerySkuPickerImages(platform) {
      const record = platform === "1688" ? this.selected1688Record : this.selectedTemuRecord;
      const rows = record && Array.isArray(record.sku) ? record.sku : [];
      const images = [];
      for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
        const rowImages = this.skuImageUrls(rows[rowIndex]);
        for (let imageIndex = 0; imageIndex < rowImages.length; imageIndex += 1) {
          const source = String(rowImages[imageIndex] || "").trim();
          if (source && images.indexOf(source) < 0) {
            images.push(source);
          }
        }
      }
      return images;
    },

    /** Position the unified SKU-image bubble above the gallery upload button. */
    gallerySkuPickerStyle: function gallerySkuPickerStyle() {
      const target = this.gallerySkuPickerTarget || {};
      return {
        left: String(Number(target.anchorLeft) || 12) + "px",
        bottom: String(Number(target.anchorBottom) || 80) + "px",
        maxHeight: String(Number(target.maxHeight) || 340) + "px",
        "--sku-picker-max-height": String(Number(target.maxHeight) || 340) + "px",
        "--sku-picker-pointer-left": String(Number(target.pointerLeft) || 18) + "px"
      };
    },

    /** Add one chosen Temu or 1688 SKU image to the targeted Temu gallery. */
    selectGalleryImageFromSku: function selectGalleryImageFromSku(imageUrl) {
      const target = this.gallerySkuPickerTarget;
      const source = String(imageUrl || "").trim();
      const record = target ? this.findProductByCacheKey(target.cacheKey) : null;
      if (!record || !source) {
        this.closeGallerySkuPicker();
        return;
      }
      const added = this.appendTemuGalleryImage(record, source);
      const selectedIndex = record.gallery_image_urls.indexOf(source);
      this.updateGallerySelection(record, "temu", selectedIndex);
      this.saveProductModule(record, "images");
      this.closeGallerySkuPicker();
      this.setStatus(added ? "已将 SKU 图片加入 Temu 主图。" : "该 SKU 图片已在 Temu 主图中。", "success");
    },

    /** Check whether one SKU is currently waiting for an image-edit response. */
    isSkuBlendBusy: function isSkuBlendBusy(record, sku, index) {
      const key = this.getSkuBlendKey(record, sku, index);
      return Boolean(this.imageEditBusyKeys[key]);
    },

    /** Return whether any SKU under one Temu product is currently being fused. */
    hasSkuBlendTask: function hasSkuBlendTask(record) {
      const rows = record && Array.isArray(record.sku) ? record.sku : [];
      for (let index = 0; index < rows.length; index += 1) {
        if (this.isSkuBlendBusy(record, rows[index], index)) {
          return true;
        }
      }
      return false;
    },

    /** Return whether any SKU under one product has a retained image-service error. */
    hasSkuBlendError: function hasSkuBlendError(record) {
      const rows = record && Array.isArray(record.sku) ? record.sku : [];
      for (let index = 0; index < rows.length; index += 1) {
        const key = this.getSkuBlendKey(record, rows[index], index);
        if (this.imageEditErrorKeys[key]) {
          return true;
        }
      }
      return false;
    },

    /** Return whether completed SKU fusion results remain available for one Temu product. */
    hasCompletedSkuBlendTask: function hasCompletedSkuBlendTask(record) {
      if (this.hasSkuBlendTask(record)) {
        return false;
      }
      const rows = record && Array.isArray(record.sku) ? record.sku : [];
      for (let index = 0; index < rows.length; index += 1) {
        const key = this.getSkuBlendKey(record, rows[index], index);
        if (this.imageFusionUndoTokens[key]) {
          return true;
        }
      }
      return false;
    },

    /** Select the Temu product that owns a running SKU fusion and reveal its SKU area. */
    openSkuBlendTask: function openSkuBlendTask(record) {
      if (!record) {
        return;
      }
      this.selectedTemuMainId = record.main_id;
      this.selectBound1688ForTemu(record);
      this.persistViewState();
      /** Scroll the newly rendered Temu SKU panel into view after selection updates. */
      function revealSkuPanel() {
        const panel = document.querySelector(".temu-render .sku-panel");
        if (panel) {
          panel.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      }
      this.$nextTick(revealSkuPanel);
    },

    /** Check whether one SKU has an image-fusion undo token from the server. */
    hasSkuFusionUndo: function hasSkuFusionUndo(record, sku, index) {
      const key = this.getSkuBlendKey(record, sku, index);
      return Boolean(this.imageFusionUndoTokens[key]);
    },

    /** Check whether one SKU is waiting for its server-side fusion undo response. */
    isSkuFusionUndoBusy: function isSkuFusionUndoBusy(record, sku, index) {
      const key = this.getSkuBlendKey(record, sku, index);
      return Boolean(this.imageFusionUndoBusyKeys[key]);
    },

    /** Replace the two source SKU images with the single BeeAPI result. */
    replaceSkuImagesWithGenerated: function replaceSkuImagesWithGenerated(sku, imageUrl) {
      const item = sku || {};
      const url = String(imageUrl || "").trim();
      if (!url) {
        return;
      }
      item.sku_image_urls = [url];
      item.sku_image_url = url;
    },

    /** Find the current product and SKU row owned by one persisted SKU fusion task. */
    findSkuBlendTaskTarget: function findSkuBlendTaskTarget(task) {
      const source = task && typeof task === "object" ? task : {};
      let record = null;
      for (let index = 0; index < this.temuRecords.length; index += 1) {
        if (String(this.temuRecords[index].main_id || "") === String(source.temu_main_id || "")) {
          record = this.temuRecords[index];
          break;
        }
      }
      if (!record) {
        return null;
      }
      return this.findCurrentSkuTarget(this.productCacheEventKey(record), String(source.sku_id || ""), Number(source.sku_index));
    },

    /** Apply one persisted SKU fusion task to yellow indicators and the latest SKU row. */
    applySkuBlendTask: function applySkuBlendTask(task) {
      const target = this.findSkuBlendTaskTarget(task);
      if (!target) {
        return "";
      }
      const busyKey = this.getSkuBlendKey(target.record, target.sku, target.rowIndex);
      const status = String(task.status || "");
      this.skuBlendTasksByKey[busyKey] = task;
      this.imageEditBusyKeys[busyKey] = status === "queued" || status === "generating";
      if (status !== "succeeded") {
        delete this.imageFusionUndoTokens[busyKey];
      }
      if (status === "failed" || status === "interrupted") {
        this.imageEditErrorKeys[busyKey] = "[" + String(task.error_code || "SKU_BLEND_FAILED") + "] " + String(task.error || "溶图失败。");
        return busyKey;
      }
      delete this.imageEditErrorKeys[busyKey];
      if (status !== "succeeded") {
        return busyKey;
      }
      this.imageFusionUndoTokens[busyKey] = String(task.undo_token || "");
      const imageUrl = String(task.image_url || "").trim();
      const currentImages = this.skuImageUrls(target.sku);
      if (imageUrl && (currentImages.length !== 1 || currentImages[0] !== imageUrl)) {
        this.replaceSkuImagesWithGenerated(target.sku, imageUrl);
        this.saveProductModule(target.record, "skus");
      }
      return busyKey;
    },

    /** Refresh SKU fusion tasks from cache/runtime/sku-blend and continue polling active work. */
    async refreshSkuBlendTaskIndicators() {
      try {
        const response = await fetch(apiUrl("/images/sku-blend-tasks"), { cache: "no-store" });
        const payload = await response.json();
        if (!response.ok || !payload || !payload.ok) {
          return false;
        }
        const tasks = payload.data && Array.isArray(payload.data.tasks) ? payload.data.tasks : [];
        const previousLookup = this.skuBlendTasksByKey;
        this.skuBlendTasksByKey = {};
        let hasActiveTask = false;
        for (let index = 0; index < tasks.length; index += 1) {
          const task = tasks[index] || {};
          this.applySkuBlendTask(task);
          if (task.status === "queued" || task.status === "generating") {
            hasActiveTask = true;
          }
        }
        for (const key in previousLookup) {
          if (!this.skuBlendTasksByKey[key]) {
            delete this.imageEditBusyKeys[key];
            delete this.imageEditErrorKeys[key];
            delete this.imageFusionUndoTokens[key];
          }
        }
        if (hasActiveTask && !this.skuBlendIndicatorTimer) {
          const view = this;
          /** Refresh yellow indicators until every persisted SKU fusion task settles. */
          function refreshActiveSkuBlendIndicators() {
            view.skuBlendIndicatorTimer = null;
            view.refreshSkuBlendTaskIndicators();
          }
          this.skuBlendIndicatorTimer = window.setTimeout(refreshActiveSkuBlendIndicators, 1000);
        }
        return true;
      } catch (error) {
        return false;
      }
    },

    /** Remove one persisted SKU fusion task and all of its local indicator state. */
    async deleteSkuBlendTaskByKey(busyKey) {
      const key = String(busyKey || "");
      const task = this.skuBlendTasksByKey[key] || null;
      delete this.skuBlendTasksByKey[key];
      delete this.imageEditBusyKeys[key];
      delete this.imageEditErrorKeys[key];
      delete this.imageFusionUndoTokens[key];
      if (!task || !task.id) {
        return;
      }
      try {
        await fetch(apiUrl("/images/sku-blend-tasks/" + encodeURIComponent(String(task.id))), { method: "DELETE" });
      } catch (error) {
        return;
      }
    },

    /** Submit exactly two SKU images as one server-owned recoverable fusion task. */
    blendSkuImages: async function blendSkuImages(record, sku, rowIndex) {
      const images = this.skuImageUrls(sku);
      if (!record || !sku || images.length !== 2) {
        this.setStatus("溶图需要当前 SKU 正好有两张图片。", "normal");
        return;
      }
      const fusionPrompt = String(this.imageEditorFusionPrompt || "").trim();
      if (!fusionPrompt) {
        this.setStatus("请先填写溶图提示词。", "normal");
        return;
      }
      const busyKey = this.getSkuBlendKey(record, sku, rowIndex);
      if (this.imageEditBusyKeys[busyKey]) {
        return;
      }
      const taskId = "sku-blend-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
      const editSize = this.imageEditSize;
      const localTask = {
        id: taskId,
        temu_main_id: String(record.main_id || ""),
        temu_platform_id: String(record.platform_id || ""),
        sku_id: String(sku.sku_id || ""),
        sku_index: Number(rowIndex),
        source_image_urls: images.slice(),
        prompt: fusionPrompt,
        size: editSize,
        status: "queued",
        image_url: "",
        undo_token: "",
        error: "",
        error_code: ""
      };
      this.applySkuBlendTask(localTask);
      this.setStatus("SKU 溶图已提交到后台，刷新页面也会继续。", "normal");
      try {
        const response = await fetch(apiUrl("/images/sku-blend-tasks"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            client_task_id: taskId,
            temu_main_id: localTask.temu_main_id,
            temu_platform_id: localTask.temu_platform_id,
            sku_id: localTask.sku_id,
            sku_index: localTask.sku_index,
            image_urls: localTask.source_image_urls,
            prompt: localTask.prompt,
            size: localTask.size
          })
        });
        const payload = await response.json();
        if (!response.ok || !payload || !payload.ok) {
          throw new Error(getApiErrorMessage(payload, "溶图任务创建失败。"));
        }
        const task = payload.data && payload.data.task ? payload.data.task : localTask;
        this.applySkuBlendTask(task);
        await this.refreshSkuBlendTaskIndicators();
      } catch (error) {
        const errorMessage = "[" + getWorkflowErrorCode(error) + "] " + (error.message || "请求失败。");
        this.imageEditBusyKeys[busyKey] = false;
        this.imageEditErrorKeys[busyKey] = errorMessage;
        this.setStatus("溶图失败：" + errorMessage, "error");
      }
    },

    /** Restore one SKU's original two images through the server undo API. */
    undoSkuImageFusion: function undoSkuImageFusion(record, sku, rowIndex) {
      if (!record || !sku) {
        return;
      }
      const busyKey = this.getSkuBlendKey(record, sku, rowIndex);
      const undoToken = String(this.imageFusionUndoTokens[busyKey] || "");
      if (!undoToken || this.imageFusionUndoBusyKeys[busyKey]) {
        return;
      }
      const cacheKey = this.productCacheEventKey(record);
      const skuId = String(sku.sku_id || "");
      this.imageFusionUndoBusyKeys[busyKey] = true;
      this.setStatus("正在通过 Server API 恢复溶图前图片…", "normal");
      const view = this;
      fetch(apiUrl("/images/fusion/undo"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ undo_token: undoToken })
      }).then(function handleFusionUndoResponse(response) {
        return response.json().then(function handleFusionUndoPayload(payload) {
          if (!response.ok || !payload || !payload.ok) {
            throw new Error(getApiErrorMessage(payload, "溶图返回失败。"));
          }
          return readApiData(payload);
        });
      }).then(function handleFusionUndoSuccess(payload) {
        const imageUrls = Array.isArray(payload.image_urls) ? payload.image_urls.slice() : [];
        const currentTarget = view.findCurrentSkuTarget(cacheKey, skuId, rowIndex);
        if (!currentTarget) {
          throw new Error("当前 SKU 已发生变化，无法恢复原图。");
        }
        currentTarget.sku.sku_image_urls = imageUrls;
        currentTarget.sku.sku_image_url = imageUrls[0] || "";
        delete view.imageFusionUndoTokens[busyKey];
        view.deleteSkuBlendTaskByKey(busyKey);
        view.saveProductModule(currentTarget.record, "skus");
        view.setStatus("已通过 Server API 恢复 SKU 溶图前的两张图片。", "success");
      }).catch(function handleFusionUndoError(error) {
        view.setStatus("溶图返回失败：" + (error.message || "请求失败。"), "error");
      }).finally(function handleFusionUndoFinished() {
        view.imageFusionUndoBusyKeys[busyKey] = false;
      });
    },

    /** Return the actual values from both specification fields as one drag label. */
    skuSpecDisplayLabel: function skuSpecDisplayLabel(sku) {
      const item = sku || {};
      const values = [];
      const first = parseSkuSpecValue(item.SubSku1, "SubSku1");
      const second = parseSkuSpecValue(item.SubSku2, "SubSku2");
      if (first.value) {
        values.push(first.value);
      }
      if (second.value) {
        values.push(second.value);
      }
      return values.join(" ");
    },

    /** Read the dragged 1688 value that belongs to one target specification group. */
    skuSpecValueForGroup: function skuSpecValueForGroup(sku, groupName) {
      const item = sku || {};
      const targetName = String(groupName || "").trim();
      for (let specIndex = 0; specIndex < 2; specIndex += 1) {
        const fieldName = specIndex === 0 ? "SubSku1" : "SubSku2";
        const parsed = parseSkuSpecValue(item[fieldName], "SubSku" + (specIndex + 1));
        if (parsed.value && (!targetName || parsed.name === targetName)) {
          return parsed.value;
        }
      }
      return this.skuSpecDisplayLabel(item);
    },

    /** Check whether one Temu SKU belongs to a selected specification option. */
    skuMatchesSpecOption: function skuMatchesSpecOption(sku, record, groupName, optionValue) {
      const item = sku || {};
      const fieldName = this.skuFieldForGroup(item, groupName, record);
      const parsed = parseSkuSpecValue(item[fieldName], String(groupName || ""));
      const targetValue = String(optionValue || "").trim();
      if (!targetValue || !parsed.value) {
        return false;
      }
      const values = parsed.value.split(/\s*\+\s*/);
      for (let index = 0; index < values.length; index += 1) {
        if (String(values[index]).trim() === targetValue) {
          return true;
        }
      }
      return parsed.value === targetValue;
    },

    /** Track one 1688 source SKU so its price is added only once per Temu row. */
    markAliSkuPriceMerged: function markAliSkuPriceMerged(sku, sourceSku) {
      if (!sku || !sourceSku) {
        return false;
      }
      const sourceKey = getAliSkuSourceKey(sourceSku);
      if (!Array.isArray(sku.source_1688_sku_ids)) {
        Object.defineProperty(sku, "source_1688_sku_ids", {
          value: [],
          writable: true,
          configurable: true,
          enumerable: false
        });
      }
      if (sku.source_1688_sku_ids.indexOf(sourceKey) >= 0) {
        return false;
      }
      sku.source_1688_sku_ids.push(sourceKey);
      return true;
    },

    /** Merge one 1688 SKU into selected Temu rows and add its price. */
    mergeAliSkuIntoTemuRows: function mergeAliSkuIntoTemuRows(record, groupName, optionValue, sourceSku) {
      if (!record || !sourceSku) {
        return 0;
      }
      const rows = asArray(record.sku);
      const sourceValue = this.skuSpecValueForGroup(sourceSku, groupName);
      const sourceImages = this.skuImageUrls(sourceSku);
      const sourcePrice = sourceSku.sku_price === undefined ? sourceSku.price : sourceSku.sku_price;
      let mergedCount = 0;
      for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
        const targetSku = rows[rowIndex] || {};
        if (optionValue && !this.skuMatchesSpecOption(targetSku, record, groupName, optionValue)) {
          continue;
        }
        const fieldName = this.skuFieldForGroup(targetSku, groupName, record);
        const current = parseSkuSpecValue(targetSku[fieldName], String(groupName || ""));
        const currentValues = current.value ? current.value.split(/\s*\+\s*/) : [];
        if (sourceValue && currentValues.indexOf(sourceValue) < 0) {
          currentValues.push(sourceValue);
        }
        if (sourceValue) {
          const nextValue = currentValues.join(" + ");
          targetSku[fieldName] = current.name ? current.name + ":" + nextValue : nextValue;
        }
        for (let imageIndex = 0; imageIndex < sourceImages.length; imageIndex += 1) {
          this.appendSkuImage(targetSku, sourceImages[imageIndex]);
        }
        const priceAdded = this.markAliSkuPriceMerged(targetSku, sourceSku);
        if (priceAdded) {
          targetSku.sku_price = addSkuPriceValues(targetSku.sku_price, sourcePrice);
        }
        mergedCount += 1;
      }
      if (mergedCount) {
        const scopeText = optionValue ? (groupName + " / " + optionValue) : groupName;
        this.setStatus("已合并到 " + scopeText + "，匹配 " + mergedCount + " 个 Temu SKU，价格已相加。", "success");
      } else {
        this.setStatus("没有找到可合并的 Temu SKU。", "error");
      }
      return mergedCount;
    },

    /** Write one dragged 1688 SKU value into a specific Temu SKU cell. */
    mergeAliSkuIntoTemuSkuCell: function mergeAliSkuIntoTemuSkuCell(record, targetSku, rowIndex, groupName, sourceSku) {
      if (!record || !targetSku || !sourceSku) {
        return false;
      }
      this.clearSkuCartesianBase(record);
      const propertyName = String(groupName || "").trim();
      const sourceValue = this.skuSpecValueForGroup(sourceSku, propertyName);
      if (!propertyName || !sourceValue) {
        this.setStatus("拖入的 1688 SKU 没有可用规格值。", "error");
        return false;
      }
      const fieldName = this.skuFieldForGroup(targetSku, propertyName, record);
      const current = parseSkuSpecValue(targetSku[fieldName], propertyName);
      const currentValues = current.value ? current.value.split(/\s*\+\s*/) : [];
      let hasSourceValue = false;
      for (let valueIndex = 0; valueIndex < currentValues.length; valueIndex += 1) {
        if (String(currentValues[valueIndex]).trim() === sourceValue) {
          hasSourceValue = true;
          break;
        }
      }
      if (!hasSourceValue) {
        currentValues.push(sourceValue);
      }
      targetSku[fieldName] = (current.name || propertyName) + ":" + currentValues.join(" + ");
      const sourceImages = this.skuImageUrls(sourceSku);
      for (let imageIndex = 0; imageIndex < sourceImages.length; imageIndex += 1) {
        this.appendSkuImage(targetSku, sourceImages[imageIndex]);
      }
      const sourcePrice = sourceSku.sku_price === undefined ? sourceSku.price : sourceSku.sku_price;
      if (this.markAliSkuPriceMerged(targetSku, sourceSku)) {
        targetSku.sku_price = addSkuPriceValues(targetSku.sku_price, sourcePrice);
      }
      this.setStatus("已写入 Temu SKU #" + (Number(rowIndex) + 1) + " 的「" + propertyName + "」，价格已相加。", "success");
      return true;
    },

    /** Mark one Temu specification group or option as the active drop target. */
    setAliDropTarget: function setAliDropTarget(targetType, groupName, optionValue) {
      this.dragDropTarget = [targetType, groupName || "", optionValue || ""].join("|");
    },

    /** Test whether one Temu specification group or option is the active drop target. */
    isAliDropTarget: function isAliDropTarget(targetType, groupName, optionValue) {
      return this.dragDropTarget === [targetType, groupName || "", optionValue || ""].join("|");
    },

    /** Mark one Temu SKU specification cell as the active drop target. */
    setTemuSkuCellDropTarget: function setTemuSkuCellDropTarget(rowIndex, groupName) {
      this.dragDropTarget = ["cell", String(rowIndex), String(groupName || "")].join("|");
    },

    /** Test whether one Temu SKU specification cell is the active drop target. */
    isTemuSkuCellDropTarget: function isTemuSkuCellDropTarget(rowIndex, groupName) {
      return this.dragDropTarget === ["cell", String(rowIndex), String(groupName || "")].join("|");
    },

    /** Return the actual 1688 property name for one split SubSku column. */
    aliSubSkuHeader: function aliSubSkuHeader(record, index) {
      const groups = collectSkuSpecGroups(record);
      if (groups[index] && groups[index].name) {
        return groups[index].name;
      }
      return "SubSku" + (Number(index) + 1);
    },

    /** Return only the value portion shown inside one 1688 SubSku input. */
    aliSubSkuValue: function aliSubSkuValue(sku, index) {
      const item = sku || {};
      const fieldName = Number(index) === 0 ? "SubSku1" : "SubSku2";
      return parseSkuSpecValue(item[fieldName], "").value;
    },

    /** Preserve the hidden 1688 property name when editing one SubSku value. */
    updateAliSubSkuValue: function updateAliSubSkuValue(sku, index, value) {
      if (!sku) {
        return;
      }
      const fieldName = Number(index) === 0 ? "SubSku1" : "SubSku2";
      const current = parseSkuSpecValue(sku[fieldName], "");
      const nextValue = String(value || "").trim();
      sku[fieldName] = current.name && nextValue ? current.name + ":" + nextValue : nextValue;
    },

    /** Return both raw 1688 specification fields as one editable display value. */
    mergedAliSkuSpec: function mergedAliSkuSpec(sku) {
      const item = sku || {};
      const values = [];
      const first = String(item.SubSku1 || "").trim();
      const second = String(item.SubSku2 || "").trim();
      if (first) {
        values.push(first);
      }
      if (second) {
        values.push(second);
      }
      return values.join(" / ");
    },

    /** Split one edited 1688 specification value back into the two source fields. */
    updateAliMergedSkuSpec: function updateAliMergedSkuSpec(sku, value) {
      if (!sku) {
        return;
      }
      const parts = String(value || "").split(/\s*\/\s*/);
      const firstPart = String(parts.shift() || "").trim();
      const secondPart = parts.join(" / ").trim();
      const firstExisting = parseSkuSpecValue(sku.SubSku1, "SubSku1");
      const secondExisting = parseSkuSpecValue(sku.SubSku2, "SubSku2");
      const firstParsed = parseSkuSpecValue(firstPart, firstExisting.name);
      const secondParsed = parseSkuSpecValue(secondPart, secondExisting.name);
      sku.SubSku1 = firstParsed.value && firstPart !== firstExisting.name ? (firstPart.indexOf(":") < 0 && firstExisting.name ? firstExisting.name + ":" + firstPart : firstPart) : "";
      sku.SubSku2 = secondParsed.value && secondPart !== secondExisting.name ? (secondPart.indexOf(":") < 0 && secondExisting.name ? secondExisting.name + ":" + secondPart : secondPart) : "";
    },

    /** Find which shared SubSku field represents one rendered specification group. */
    skuFieldForGroup: function skuFieldForGroup(sku, groupName, record) {
      const item = sku || {};
      const targetName = String(groupName || "").trim();
      for (let specIndex = 0; specIndex < 2; specIndex += 1) {
        const fieldName = specIndex === 0 ? "SubSku1" : "SubSku2";
        const parsed = parseSkuSpecValue(item[fieldName], "SubSku" + (specIndex + 1));
        if (parsed.name === targetName) {
          return fieldName;
        }
      }
      const groups = collectSkuSpecGroups(record);
      for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
        if (groups[groupIndex].name === targetName) {
          return groupIndex === 0 ? "SubSku1" : "SubSku2";
        }
      }
      return "SubSku1";
    },

    /** Append one unique image URL to a SKU row while keeping its original main image. */
    appendSkuImage: function appendSkuImage(sku, imageUrl) {
      const item = sku || {};
      const url = String(imageUrl || "").trim();
      if (!url) {
        return;
      }
      if (!Array.isArray(item.sku_image_urls)) {
        item.sku_image_urls = item.sku_image_url ? [String(item.sku_image_url)] : [];
      }
      if (item.sku_image_urls.indexOf(url) < 0) {
        item.sku_image_urls.push(url);
      }
      if (!item.sku_image_url) {
        item.sku_image_url = item.sku_image_urls[0] || url;
      }
    },

    /** Merge one dragged 1688 SKU into every Temu SKU row under the selected spec group. */
    appendAliSkuToTemuField: function appendAliSkuToTemuField(record, groupName, sourceSku) {
      this.mergeAliSkuIntoTemuRows(record, groupName, "", sourceSku);
    },

    /** Drop a 1688 SKU on a Temu specification group and update every Temu row. */
    dropAliSkuToTemuGroup: function dropAliSkuToTemuGroup(event, record, groupName) {
      event.preventDefault();
      event.stopPropagation();
      const reference = this.dragSkuReference || this.readDraggedReference(event);
      if (!reference || !reference.source_sku) {
        this.dragSkuReference = null;
        this.dragDropTarget = null;
        return;
      }
      this.mergeAliSkuIntoTemuRows(record, groupName, "", reference.source_sku);
      this.saveProductModule(record, "skus");
      this.dragSkuReference = null;
      this.dragDropTarget = null;
    },

    /** Drop a 1688 SKU on one Temu specification option and update matching rows. */
    dropAliSkuToTemuOption: function dropAliSkuToTemuOption(event, record, groupName, optionValue) {
      event.preventDefault();
      event.stopPropagation();
      const reference = this.dragSkuReference || this.readDraggedReference(event);
      if (!reference || !reference.source_sku) {
        this.dragSkuReference = null;
        this.dragDropTarget = null;
        return;
      }
      this.mergeAliSkuIntoTemuRows(record, groupName, optionValue, reference.source_sku);
      this.saveProductModule(record, "skus");
      this.dragSkuReference = null;
      this.dragDropTarget = null;
    },

    /** Drop one 1688 SKU or SubSku directly into a Temu SKU specification cell. */
    dropAliSkuToTemuSkuCell: function dropAliSkuToTemuSkuCell(event, record, targetSku, rowIndex, groupName) {
      event.preventDefault();
      event.stopPropagation();
      const reference = this.dragSkuReference || this.readDraggedReference(event);
      if (!reference || !reference.source_sku) {
        this.endAliDrag();
        return;
      }
      this.mergeAliSkuIntoTemuSkuCell(record, targetSku, rowIndex, groupName, reference.source_sku);
      this.saveProductModule(record, "skus");
      this.endAliDrag();
    },

    /** Upload one local image through the backend cache and return its local API URL. */
    readImageFile: function readImageFile(file, callback, platform, kind) {
      const reader = new FileReader();
      /** Handle a successful local image read. */
      reader.onload = function handleImageFileLoad(event) {
        fetch(apiUrl("/cache/images"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            source: String(event.target.result || ""),
            platform: String(platform || "temu"),
            kind: String(kind || "main")
          })
        }).then(function handleImageCacheResponse(response) {
          return response.json().then(function validateImageCachePayload(payload) {
            if (!response.ok || !payload.ok) {
              throw new Error(getApiErrorMessage(payload, "图片缓存失败。"));
            }
            return payload.data;
          });
        }).then(function applyImageCacheResult(result) {
          callback(String(result && result.image_url || ""));
        }).catch(function handleImageCacheError() {
          callback("");
        });
      };
      /** Handle an unsuccessful local image read. */
      reader.onerror = function handleImageFileError() {
        callback("");
      };
      reader.readAsDataURL(file);
    },

    /** Preserve the SKU property name while changing its editable value. */
    updateSkuSpecValue: function updateSkuSpecValue(sku, groupName, index, value) {
      const item = sku || {};
      let propertyName = String(groupName || "").trim();
      let targetIndex = index;
      let propertyValue = value;
      if (value === undefined) {
        targetIndex = groupName;
        propertyValue = index;
        propertyName = "";
      }
      let fieldName = "";
      for (let specIndex = 0; specIndex < 2; specIndex += 1) {
        const candidateName = specIndex === 0 ? "SubSku1" : "SubSku2";
        const parsed = parseSkuSpecValue(item[candidateName], "SubSku" + (specIndex + 1));
        if (parsed.name === propertyName) {
          fieldName = candidateName;
          break;
        }
      }
      if (!fieldName) {
        fieldName = targetIndex === 0 ? "SubSku1" : "SubSku2";
      }
      const current = String(item[fieldName] || "");
      const currentParsed = parseSkuSpecValue(current, "");
      const outputName = propertyName || currentParsed.name;
      const nextValue = String(propertyValue || "").trim();
      item[fieldName] = outputName ? outputName + ":" + nextValue : nextValue;
    },

    /** Build the stable busy key for one SKU1-copy request. */
    copyFirstSkuAttributeBusyKey: function copyFirstSkuAttributeBusyKey(record, attribute) {
      return this.productCacheEventKey(record) + ":" + String(attribute || "");
    },

    /** Return whether one SKU1-copy request is currently running. */
    isCopyFirstSkuAttributeBusy: function isCopyFirstSkuAttributeBusy(record, attribute) {
      return Boolean(this.copyFirstSkuAttributeBusyKeys[this.copyFirstSkuAttributeBusyKey(record, attribute)]);
    },

    /** Flush and await pending product saves before a server-owned SKU mutation. */
    async waitForProductSaveIdle(record) {
      const cacheKey = this.productCacheEventKey(record);
      const state = this.productSaveStates[cacheKey];
      if (!state) {
        return;
      }
      if (state.timer) {
        window.clearTimeout(state.timer);
        state.timer = null;
      }
      if (!state.inFlight && this.hasPendingProductModules(state)) {
        this.flushProductSave(cacheKey);
      }
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (state.conflict) {
          throw new Error("商品已被其他页面更新，请刷新后重试。");
        }
        if (!state.inFlight && !this.hasPendingProductModules(state)) {
          return;
        }
        /** Pause briefly while the serialized product save finishes. */
        function waitForProductSaveTick(resolve) {
          window.setTimeout(resolve, 25);
        }
        await new Promise(waitForProductSaveTick);
      }
      throw new Error("正在保存 SKU1，请稍后重试。");
    },

    /** Ask the backend to copy one editable SKU1 attribute to every SKU row. */
    async copyFirstSkuAttribute(record, attribute) {
      const rows = record && Array.isArray(record.sku) ? record.sku : [];
      if (!record || !rows.length) {
        this.setStatus("当前商品没有可复制的 SKU1。", "normal");
        return;
      }
      let attributeLabel = "";
      if (attribute === "price") {
        attributeLabel = "价格";
      } else if (attribute === "stock") {
        attributeLabel = "库存";
      } else if (attribute === "dimensions") {
        attributeLabel = "长宽高";
      } else {
        return;
      }
      const busyKey = this.copyFirstSkuAttributeBusyKey(record, attribute);
      if (this.copyFirstSkuAttributeBusyKeys[busyKey]) {
        return;
      }
      this.copyFirstSkuAttributeBusyKeys[busyKey] = true;
      try {
        await this.waitForProductSaveIdle(record);
        const endpoint = "/products/" + encodeURIComponent(record.platform) + "/" + encodeURIComponent(record.platform_id) + "/skus/copy-first";
        const response = await fetch(apiUrl(endpoint), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ version: Number(record.version || 1), attribute: attribute })
        });
        const payload = await response.json();
        if (!response.ok || !payload || !payload.ok) {
          throw new Error(getApiErrorMessage(payload, "覆盖全部 SKU 失败。"));
        }
        this.replaceProductViewModel(payload.data.product);
        this.setStatus("已使用 SKU1 的" + attributeLabel + "覆盖全部 SKU。", "success");
      } catch (error) {
        this.setStatus(error && error.message ? error.message : "覆盖全部 SKU 失败。", "error");
      } finally {
        delete this.copyFirstSkuAttributeBusyKeys[busyKey];
      }
    },

    /** Update a product category ID list from a comma-separated input. */
    updateCategoryIds: function updateCategoryIds(record, value) {
      if (!record) {
        return;
      }
      let rawValue = String(value || "").trim();
      if (rawValue.charAt(0) === "[" && rawValue.charAt(rawValue.length - 1) === "]") {
        rawValue = rawValue.slice(1, -1);
      }
      const parts = rawValue.split(",");
      const categoryIds = [];
      for (let index = 0; index < parts.length; index += 1) {
        const item = parts[index].trim().replace(/^['\"]|['\"]$/g, "");
        if (item) {
          categoryIds.push(item);
        }
      }
      record.category_ids = categoryIds;
    },

    /** Rename one SKU specification property across every matching SKU row. */
    updateSkuSpecName: function updateSkuSpecName(record, oldName, value) {
      const item = record || {};
      const previousName = String(oldName || "").trim();
      const nextName = String(value || "").trim() || previousName;
      const rows = asArray(item.sku);
      if (!previousName || previousName === nextName) {
        return;
      }
      this.clearSkuCartesianBase(item);
      for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
        const row = rows[rowIndex] || {};
        for (let specIndex = 0; specIndex < 2; specIndex += 1) {
          const fieldName = specIndex === 0 ? "SubSku1" : "SubSku2";
          const rawValue = String(row[fieldName] || "").trim();
          const parsed = parseSkuSpecValue(rawValue, "SubSku" + (specIndex + 1));
          if (parsed.name !== previousName || !parsed.value) {
            continue;
          }
          row[fieldName] = nextName + ":" + parsed.value;
        }
      }
    },

    /** Replace one SKU specification value across every matching SKU row. */
    updateSkuSpecOption: function updateSkuSpecOption(record, groupName, oldValue, value) {
      const item = record || {};
      const propertyName = String(groupName || "").trim();
      const previousValue = String(oldValue || "").trim();
      const nextValue = String(value || "").trim();
      const rows = asArray(item.sku);
      if (!propertyName || !previousValue || previousValue === nextValue) {
        return;
      }
      this.clearSkuCartesianBase(item);
      for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
        const row = rows[rowIndex] || {};
        for (let specIndex = 0; specIndex < 2; specIndex += 1) {
          const fieldName = specIndex === 0 ? "SubSku1" : "SubSku2";
          const rawValue = String(row[fieldName] || "").trim();
          const parsed = parseSkuSpecValue(rawValue, "SubSku" + (specIndex + 1));
          if (parsed.name === propertyName && parsed.value === previousValue) {
            row[fieldName] = propertyName + ":" + nextValue;
          }
        }
      }
      this.deduplicateTemuSkuRows(item);
    },

    /** Clear the legacy Cartesian snapshot before editing one Temu specification. */
    clearSkuCartesianBase: function clearSkuCartesianBase(record) {
      const item = record || {};
      const recordKey = [item.main_id, item.platform_id].join("|");
      if (this.cartesianBaseRows && Object.prototype.hasOwnProperty.call(this.cartesianBaseRows, recordKey)) {
        delete this.cartesianBaseRows[recordKey];
      }
    },

    /** Build a stable draft key for one product specification option input. */
    specOptionDraftKey: function specOptionDraftKey(record, groupName) {
      const item = record || {};
      return [item.platform, item.main_id, item.platform_id, String(groupName || "")].join("|");
    },

    /** Read the pending new-option text for one product specification. */
    specOptionDraft: function specOptionDraft(record, groupName) {
      const key = this.specOptionDraftKey(record, groupName);
      return this.specOptionDrafts && this.specOptionDrafts[key] ? this.specOptionDrafts[key] : "";
    },

    /** Store the pending new-option text for one product specification. */
    setSpecOptionDraft: function setSpecOptionDraft(record, groupName, value) {
      if (!this.specOptionDrafts) {
        this.specOptionDrafts = {};
      }
      const key = this.specOptionDraftKey(record, groupName);
      this.specOptionDrafts[key] = String(value || "");
    },

    /** Create an empty SKU row for a newly added specification combination. */
    createEmptySkuRow: function createEmptySkuRow() {
      return {
        sku_id: "",
        SubSku1: "",
        SubSku2: "",
        sku_price: "",
        sku_original_price: "",
         sku_stock: 0,
         sku_weight: 0,
        sku_length: "",
        sku_width: "",
        sku_height: "",
        sku_image_url: "",
        sku_image_urls: []
      };
    },

    /** Remove duplicate SKU combinations after one specification group is edited or deleted. */
    deduplicateTemuSkuRows: function deduplicateTemuSkuRows(record) {
      const item = record || {};
      const rows = asArray(item.sku);
      const result = [];
      const seen = {};
      for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
        const row = rows[rowIndex] || {};
        const key = JSON.stringify([String(row.SubSku1 || ""), String(row.SubSku2 || "")]);
        if (seen[key]) {
          continue;
        }
        seen[key] = true;
        result.push(row);
      }
      item.sku = result;
      return rows.length - result.length;
    },

    /** Delete one Temu specification option and all SKU rows using it. */
    removeTemuSpecOption: function removeTemuSpecOption(record, groupName, optionValue) {
      const item = record || {};
      const propertyName = String(groupName || "").trim();
      const targetValue = String(optionValue || "").trim();
      if (!propertyName || !targetValue) {
        return;
      }
      this.clearSkuCartesianBase(item);
      const rows = asArray(item.sku);
      const keptRows = [];
      let removedCount = 0;
      for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
        const row = rows[rowIndex] || {};
        if (this.skuMatchesSpecOption(row, item, propertyName, targetValue)) {
          removedCount += 1;
        } else {
          keptRows.push(row);
        }
      }
      if (!removedCount) {
        this.setStatus("没有找到要删除的规格选项。", "error");
        return;
      }
      item.sku = keptRows;
      this.saveProductModule(item, "skus");
      this.setStatus("已删除「" + propertyName + " / " + targetValue + "」，同时删除 " + removedCount + " 个 SKU。", "success");
    },

    /** Delete one complete Temu specification group and collapse duplicate SKU combinations. */
    removeTemuSpecGroup: function removeTemuSpecGroup(record, groupName) {
      const item = record || {};
      const propertyName = String(groupName || "").trim();
      if (!propertyName) {
        return;
      }
      this.clearSkuCartesianBase(item);
      const rows = asArray(item.sku);
      let changed = false;
      for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
        const row = rows[rowIndex] || {};
        for (let specIndex = 0; specIndex < 2; specIndex += 1) {
          const fieldName = specIndex === 0 ? "SubSku1" : "SubSku2";
          const parsed = parseSkuSpecValue(row[fieldName], "SubSku" + (specIndex + 1));
          if (parsed.name === propertyName && parsed.value) {
            row[fieldName] = "";
            changed = true;
          }
        }
      }
      if (!changed) {
        this.setStatus("没有找到要删除的规格。", "error");
        return;
      }
      const collapsedCount = this.deduplicateTemuSkuRows(item);
      this.saveProductModule(item, "skus");
      this.setStatus("已删除规格「" + propertyName + "」。" + (collapsedCount ? " 已合并重复 SKU。" : ""), "success");
    },

    /** Add a new option to an existing specification and generate its SKU combinations. */
    addTemuSpecOption: function addTemuSpecOption(record, groupName) {
      const item = record || {};
      const propertyName = String(groupName || "").trim();
      const draftKey = this.specOptionDraftKey(item, propertyName);
      const targetValue = String(this.specOptionDrafts && this.specOptionDrafts[draftKey] || "").trim();
      if (!propertyName || !targetValue) {
        this.setStatus("请输入要添加的规格选项。", "error");
        return;
      }
      this.clearSkuCartesianBase(item);
      const groups = collectSkuSpecGroups(item);
      let targetGroup = null;
      for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
        if (groups[groupIndex].name === propertyName) {
          targetGroup = groups[groupIndex];
          break;
        }
      }
      if (!targetGroup) {
        this.setStatus("规格不存在，请先添加规格。", "error");
        return;
      }
      if (targetGroup.values.indexOf(targetValue) >= 0) {
        this.setStatus("该规格选项已经存在。", "error");
        return;
      }
      const rows = asArray(item.sku);
      const targetField = this.skuFieldForGroup(rows[0] || {}, propertyName, item);
      const otherGroups = [];
      for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
        if (groups[groupIndex].name !== propertyName) {
          otherGroups.push(groups[groupIndex]);
        }
      }
      let combinations = [[]];
      for (let groupIndex = 0; groupIndex < otherGroups.length; groupIndex += 1) {
        const expanded = [];
        const values = otherGroups[groupIndex].values;
        for (let combinationIndex = 0; combinationIndex < combinations.length; combinationIndex += 1) {
          for (let valueIndex = 0; valueIndex < values.length; valueIndex += 1) {
            const combination = combinations[combinationIndex].slice();
            combination.push(values[valueIndex]);
            expanded.push(combination);
          }
        }
        combinations = expanded;
      }
      let addedCount = 0;
      for (let combinationIndex = 0; combinationIndex < combinations.length; combinationIndex += 1) {
        let template = null;
        for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
          let matches = true;
          for (let groupIndex = 0; groupIndex < otherGroups.length; groupIndex += 1) {
            if (!this.skuMatchesSpecOption(rows[rowIndex], item, otherGroups[groupIndex].name, combinations[combinationIndex][groupIndex])) {
              matches = false;
              break;
            }
          }
          if (matches) {
            template = rows[rowIndex];
            break;
          }
        }
        let newRow = this.createEmptySkuRow();
        if (template) {
          const clonedRows = this.cloneSkuRows([template]);
          if (clonedRows.length) {
            newRow = clonedRows[0];
          }
        }
        newRow.sku_id = "";
        newRow.sku_price = "";
        newRow.sku_original_price = "";
        newRow.sku_stock = 0;
        newRow.sku_weight = 0;
        newRow.sku_length = "";
        newRow.sku_width = "";
        newRow.sku_height = "";
        newRow.sku_image_url = "";
        newRow.sku_image_urls = [];
        newRow[targetField] = propertyName + ":" + targetValue;
        for (let groupIndex = 0; groupIndex < otherGroups.length; groupIndex += 1) {
          const otherField = this.skuFieldForGroup(newRow, otherGroups[groupIndex].name, item);
          newRow[otherField] = otherGroups[groupIndex].name + ":" + combinations[combinationIndex][groupIndex];
        }
        rows.push(newRow);
        addedCount += 1;
      }
      item.sku = rows;
      delete this.specOptionDrafts[draftKey];
      this.saveProductModule(item, "skus");
      this.setStatus("已添加「" + propertyName + " / " + targetValue + "」，生成 " + addedCount + " 个 SKU。", "success");
    },

    /** Add a new Temu specification group with one editable default option. */
    addTemuSpecGroup: function addTemuSpecGroup(record) {
      const item = record || {};
      const propertyName = String(this.newSpecGroupName || "").trim();
      if (!propertyName) {
        this.setStatus("请输入要添加的规格名称。", "error");
        return;
      }
      this.clearSkuCartesianBase(item);
      const groups = collectSkuSpecGroups(item);
      if (groups.length >= 2) {
        this.setStatus("最多支持 2 个规格。", "error");
        return;
      }
      for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
        if (groups[groupIndex].name === propertyName) {
          this.setStatus("该规格名称已经存在。", "error");
          return;
        }
      }
      const rows = asArray(item.sku);
      if (!rows.length) {
        rows.push(this.createEmptySkuRow());
      }
      let hasSubSku1 = false;
      let hasSubSku2 = false;
      for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
        if (parseSkuSpecValue(rows[rowIndex].SubSku1, "SubSku1").value) {
          hasSubSku1 = true;
        }
        if (parseSkuSpecValue(rows[rowIndex].SubSku2, "SubSku2").value) {
          hasSubSku2 = true;
        }
      }
      let fieldName = "";
      if (!hasSubSku1) {
        fieldName = "SubSku1";
      } else if (!hasSubSku2) {
        fieldName = "SubSku2";
      }
      if (!fieldName) {
        this.setStatus("没有可用的规格字段。", "error");
        return;
      }
      for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
        rows[rowIndex][fieldName] = propertyName + ":新选项";
      }
      item.sku = rows;
      this.newSpecGroupName = "";
      this.saveProductModule(item, "skus");
      this.setStatus("已添加规格「" + propertyName + "」，默认选项为“新选项”。", "success");
    },

    /** Keep the selected gallery index valid after an image list change. */
    updateGallerySelection: function updateGallerySelection(record, platform, preferredIndex) {
      const images = this.galleryImages(record);
      let nextIndex = Number(preferredIndex);
      if (!images.length) {
        nextIndex = 0;
      } else if (!Number.isFinite(nextIndex) || nextIndex < 0) {
        nextIndex = 0;
      } else if (nextIndex >= images.length) {
        nextIndex = images.length - 1;
      }
      if (platform === "1688") {
        this.selected1688GalleryIndex = nextIndex;
        return;
      }
      this.selectedTemuGalleryIndex = nextIndex;
      this.selectedGalleryIndex = nextIndex;
    },

    /** Upload one or more local files into a product gallery preview. */
    handleGalleryUpload: function handleGalleryUpload(event, record, platform) {
      const input = event.target;
      const files = input && input.files ? input.files : [];
      if (!record || !files.length) {
        if (input) {
          input.value = "";
        }
        return;
      }
      if (!Array.isArray(record.gallery_image_urls)) {
        record.gallery_image_urls = [];
      }
      const view = this;
      let pending = 0;
      let added = 0;
      for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
        if (files[fileIndex].type && files[fileIndex].type.indexOf("image/") === 0) {
          pending += 1;
        }
      }
      if (!pending) {
        input.value = "";
        this.setStatus("请选择图片文件。", "error");
        return;
      }
      for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
        const file = files[fileIndex];
        if (!file.type || file.type.indexOf("image/") !== 0) {
          continue;
        }
        /** Append one successfully read image to the gallery. */
        this.readImageFile(file, function handleGalleryImageRead(imageUrl) {
          if (imageUrl) {
            record.gallery_image_urls.push(imageUrl);
            if (!record.main_image_url) {
              record.main_image_url = imageUrl;
            }
            added += 1;
          }
          pending -= 1;
          if (!pending) {
            view.updateGallerySelection(record, platform, record.gallery_image_urls.length - 1);
            view.saveProductModule(record, "images");
            view.setStatus("已添加 " + added + " 张商品图片并更新 cache。", "success");
          }
        }, record.platform, "main");
      }
      input.value = "";
    },

    /** Remove one product gallery image and update the main image fallback. */
    removeGalleryImage: function removeGalleryImage(record, index, platform) {
      if (!record) {
        return;
      }
      const list = Array.isArray(record.gallery_image_urls) ? record.gallery_image_urls : [];
      if (list.length) {
        list.splice(index, 1);
      } else if (index === 0) {
        record.main_image_url = "";
      }
      record.main_image_url = list.length ? list[0] : "";
      this.updateGallerySelection(record, platform, index);
      this.saveProductModule(record, "images");
      this.setStatus("已删除商品图片。", "success");
    },

    /** Upload a local file and append it to the SKU image list. */
    handleSkuImageUpload: function handleSkuImageUpload(event, record, sku) {
      const input = event.target;
      const file = input && input.files ? input.files[0] : null;
      if (!file || !record || !sku) {
        if (input) {
          input.value = "";
        }
        return;
      }
      if (!file.type || file.type.indexOf("image/") !== 0) {
        input.value = "";
        this.setStatus("请选择图片文件。", "error");
        return;
      }
      const view = this;
      /** Append the local file after it has been read. */
      this.readImageFile(file, function handleSkuImageRead(imageUrl) {
        if (imageUrl) {
          view.appendSkuImage(sku, imageUrl);
          view.saveProductModule(record, "skus");
          view.setStatus("SKU 图片已缓存到服务器。", "success");
        }
      }, record.platform, "sku");
      input.value = "";
    },

    /** Replace all Temu detail images with a copy of the current main-image gallery. */
    replaceDetailsWithGallery: function replaceDetailsWithGallery(record) {
      const images = this.galleryImages(record).slice();
      if (!record || !images.length) {
        this.setStatus("当前商品没有可用于覆盖详情的主图。", "error");
        return;
      }
      record.detail_image_urls = images;
      this.saveProductModule(record, "images");
      this.setStatus("已使用全部主图覆盖商品详情。", "success");
    },

    /** Remove one image from a SKU image list and keep the first image as the main preview. */
    removeSkuImageAt: function removeSkuImageAt(record, sku, index) {
      if (!record || !sku) {
        return;
      }
      const images = this.skuImageUrls(sku);
      if (index >= 0 && index < images.length) {
        images.splice(index, 1);
      }
      sku.sku_image_urls = images;
      sku.sku_image_url = images[0] || "";
      this.saveProductModule(record, "skus");
      this.setStatus("已删除 SKU 图片。", "success");
    },

    /** Remove every image attached to a SKU row. */
    removeSkuImage: function removeSkuImage(sku) {
      if (!sku) {
        return;
      }
      sku.sku_image_urls = [];
      sku.sku_image_url = "";
      this.setStatus("已删除 SKU 图片。", "success");
    },

    /** Upload one or more local files into a product detail image list. */
    handleDetailUpload: function handleDetailUpload(event, record) {
      const input = event.target;
      const files = input && input.files ? input.files : [];
      if (!record || !files.length) {
        if (input) {
          input.value = "";
        }
        return;
      }
      if (!Array.isArray(record.detail_image_urls)) {
        record.detail_image_urls = [];
      }
      const view = this;
      let pending = 0;
      let added = 0;
      for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
        if (files[fileIndex].type && files[fileIndex].type.indexOf("image/") === 0) {
          pending += 1;
        }
      }
      if (!pending) {
        input.value = "";
        this.setStatus("请选择图片文件。", "error");
        return;
      }
      for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
        const file = files[fileIndex];
        if (!file.type || file.type.indexOf("image/") !== 0) {
          continue;
        }
        /** Append one successfully read image to the detail list. */
        this.readImageFile(file, function handleDetailImageRead(imageUrl) {
          if (imageUrl) {
            record.detail_image_urls.push(imageUrl);
            added += 1;
          }
          pending -= 1;
          if (!pending) {
            view.saveProductModule(record, "images");
            view.setStatus("已添加 " + added + " 张详情图并更新 cache。", "success");
          }
        }, record.platform, "detail");
      }
      input.value = "";
    },

    /** Remove one product detail image from the current page. */
    removeDetailImage: function removeDetailImage(record, index) {
      if (!record || !Array.isArray(record.detail_image_urls)) {
        return;
      }
      record.detail_image_urls.splice(index, 1);
      this.saveProductModule(record, "images");
      this.setStatus("已删除详情图。", "success");
    },

    /** Load missing 1688 detail image URLs from the cached description address. */
    loadMissingDetailImages: function loadMissingDetailImages(records) {
      const list = Array.isArray(records) ? records : [];
      const view = this;
      for (let index = 0; index < list.length; index += 1) {
        const record = list[index] || {};
        if (record.detail_image_urls.length || !record.detail_description_url) {
          continue;
        }
        const requestKey = [record.platform, record.product_id, record.detail_description_url].join("|");
        if (this.detailImageRequests[requestKey]) {
          continue;
        }
        this.detailImageRequests[requestKey] = true;
        fetch(apiUrl("/images/details?url=" + encodeURIComponent(record.detail_description_url)), { cache: "no-store" })
          .then(function handleDetailResponse(response) {
            if (!response.ok) {
              throw new Error("详情图地址读取失败。");
            }
            return response.json();
          })
          .then(function handleDetailPayload(payload) {
            const detailData = readApiData(payload);
            const imageUrls = asArray(detailData && detailData.image_urls);
            if (!imageUrls.length) {
              return;
            }
            for (let recordIndex = 0; recordIndex < view.records.length; recordIndex += 1) {
              const target = view.records[recordIndex];
              if (String(target.platform) === String(record.platform)
                && String(target.main_id) === String(record.main_id)) {
                target.detail_image_urls = imageUrls;
                view.setStatus("已补充 " + imageUrls.length + " 张商品详情图。", "success");
                break;
              }
            }
          })
          .catch(function handleDetailError() {
            return null;
          });
      }
    },

    /** Read and normalize one local JSON file. */
    handleJsonFile: function handleJsonFile(event) {
      const input = event.target;
      const file = input && input.files ? input.files[0] : null;
      if (!file) {
        return;
      }
      const reader = new FileReader();
      const view = this;
      /** Submit raw file text to the backend without parsing it in the browser. */
      reader.onload = function handleJsonLoad(loadEvent) {
        fetch(apiUrl("/imports/json"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ json_text: String(loadEvent.target.result || "") })
        }).then(function handleJsonImportResponse(response) {
          return response.json().then(function validateJsonImportPayload(payload) {
            if (!response.ok || !payload.ok) {
              throw new Error(getApiErrorMessage(payload, "JSON 导入失败。"));
            }
            return payload.data;
          });
        }).then(function applyImportedViewModel(payload) {
          view.applyCachePayload(payload);
          view.setStatus("JSON 已由服务器导入。", "success");
        }).catch(function handleJsonImportError(error) {
          view.setStatus(error.message || "JSON 导入失败。", "error");
        });
      };
      reader.readAsText(file, "utf-8");
      input.value = "";
    },

    /** Submit one extension-exported JSON file to the backend restore API. */
    handleRestoreFile: function handleRestoreFile(event) {
      const input = event.target;
      const file = input && input.files ? input.files[0] : null;
      if (!file) {
        return;
      }
      const reader = new FileReader();
      const view = this;
      /** Send the untouched extension JSON text to the backend. */
      reader.onload = function handleRestoreJsonLoad(loadEvent) {
        fetch(apiUrl("/restore"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ json_text: String(loadEvent.target.result || "") })
        }).then(function handleRestoreResponse(response) {
          return response.json().then(function validateRestorePayload(payload) {
            if (!response.ok || !payload.ok) {
              throw new Error(getApiErrorMessage(payload, "恢复失败。"));
            }
            return payload.data;
          });
        }).then(function applyRestoreViewModel(payload) {
          view.applyCachePayload(payload);
          view.workspaceMode = "realtime";
          view.persistViewState();
          view.setStatus("扩展 JSON 已恢复到服务器。", "success");
        }).catch(function handleRestoreError(error) {
          view.setStatus(error.message || "恢复失败。", "error");
        });
      };
      reader.readAsText(file, "utf-8");
      input.value = "";
    },

    /** Load an existing mapping array when the imported JSON contains one. */
    loadMapping: function loadMapping(payload) {
      const source = payload && Array.isArray(payload.mappings) ? payload.mappings : [];
      this.mappingRows = [];
      for (let index = 0; index < source.length; index += 1) {
        const item = source[index] || {};
        const temu = item.temu || {};
        const ali = Array.isArray(item["1688"]) ? item["1688"] : [];
        this.mappingRows.push({
          temu: temu,
          temu_key: [temu.main_id, temu.sku_id, temu.sku_index].join("|"),
          ali: ali,
          ali_keys: []
        });
        const targetRow = this.mappingRows[this.mappingRows.length - 1];
        for (let aliIndex = 0; aliIndex < ali.length; aliIndex += 1) {
          targetRow.ali_keys.push([ali[aliIndex].main_id, ali[aliIndex].sku_id, ali[aliIndex].sku_index].join("|"));
        }
      }
    },

    /** Change the active platform page and reset its gallery selection. */
    switchPlatform: function switchPlatform(platform) {
      this.activePlatform = platform;
      const first = this.activeRecords[0];
      this.selectedMainId = first ? first.main_id : "";
      this.selectedGalleryIndex = 0;
    },

    /** Change the currently rendered product. */
    selectProduct: function selectProduct(record) {
      this.selectedMainId = record ? record.main_id : "";
      this.selectedGalleryIndex = 0;
    },

    /** Return the gallery list for one rendered product. */
    galleryImages: function galleryImages(record) {
      const item = record || {};
      if (item.gallery_image_urls && item.gallery_image_urls.length) {
        return item.gallery_image_urls;
      }
      return item.main_image_url ? [item.main_image_url] : [];
    },

    /** Move one platform gallery to a selected image. */
    selectGallery: function selectGallery(index, platform) {
      if (platform === "1688") {
        this.selected1688GalleryIndex = index;
        return;
      }
      this.selectedTemuGalleryIndex = index;
      this.selectedGalleryIndex = index;
    },

    /** Check whether one Temu gallery image is selected for AI editing. */
    isTemuGalleryEditSelected: function isTemuGalleryEditSelected(record, index) {
      if (this.galleryEditRecordKey !== this.imageRecordKey(record)) {
        return false;
      }
      return this.galleryEditSelection.indexOf(Number(index)) >= 0;
    },

    /** Select one image normally or add a second image while Shift is held. */
    handleTemuGallerySelection: function handleTemuGallerySelection(event, record, index) {
      const imageIndex = Number(index);
      if (this.workspaceMode === "smart" && !(event && event.shiftKey)) {
        const images = this.galleryImages(record);
        this.selectGallery(imageIndex, "temu");
        this.selectWorkflowSourceImage(images[imageIndex] || "");
        this.galleryEditRecordKey = "";
        this.galleryEditSelection = [];
        return;
      }
      const recordKey = this.imageRecordKey(record);
      const previousIndex = Number(this.selectedTemuGalleryIndex);
      if (this.galleryEditRecordKey !== recordKey) {
        this.galleryEditRecordKey = recordKey;
        this.galleryEditSelection = [];
      }
      if (event && event.shiftKey) {
        if (!this.galleryEditSelection.length && previousIndex !== imageIndex) {
          this.galleryEditSelection.push(previousIndex);
        }
        const selectedPosition = this.galleryEditSelection.indexOf(imageIndex);
        if (selectedPosition >= 0) {
          this.galleryEditSelection.splice(selectedPosition, 1);
        } else {
          if (this.galleryEditSelection.length >= 2) {
            this.galleryEditSelection.shift();
          }
          this.galleryEditSelection.push(imageIndex);
        }
      } else {
        this.galleryEditSelection = [imageIndex];
      }
      this.selectGallery(imageIndex, "temu");
      if (event && event.shiftKey && this.galleryEditSelection.length === 2) {
        this.openGalleryImageEditor(record);
      }
    },

    /** Open single-image Edits for one Temu gallery image on double click. */
    openSingleGalleryImageEditor: function openSingleGalleryImageEditor(record, index) {
      const imageIndex = Number(index);
      const images = this.galleryImages(record);
      if (!record || !images[imageIndex]) {
        return;
      }
      this.galleryEditRecordKey = this.imageRecordKey(record);
      this.galleryEditSelection = [imageIndex];
      this.imageEditorSourceType = "gallery";
      this.imageEditorSourceUrls = [];
      this.imageEditorDetailIndex = -1;
      this.imageEditorRecordKey = this.galleryEditRecordKey;
      this.selectGallery(imageIndex, "temu");
      this.openGalleryImageEditor(record);
    },

    /** Open single-image Edits for one Temu detail image on double click. */
    openDetailImageEditor: function openDetailImageEditor(record, image, index) {
      const source = String(image || "").trim();
      if (!record || !source) {
        return;
      }
      this.galleryEditRecordKey = this.imageRecordKey(record);
      this.galleryEditSelection = [];
      this.imageEditorSourceType = "detail";
      this.imageEditorSourceUrls = [source];
      this.imageEditorDetailIndex = Number(index);
      this.imageEditorRecordKey = this.galleryEditRecordKey;
      this.imageEditorPrompt = this.imageEditorEditPrompt;
      this.imageEditorGeneratedUrl = "";
      this.imageEditorError = "";
      this.imageEditorBusy = false;
      this.imageDirectTask = null;
      this.imageCarouselTask = null;
      this.imageCarouselGenerationBusy = false;
      this.imageCarouselPageIndex = 0;
      this.imageCarouselEstimatedTokens = 0;
      this.imageCarouselSourceMismatch = false;
      if (this.imageCarouselPollTimer) {
        window.clearTimeout(this.imageCarouselPollTimer);
        this.imageCarouselPollTimer = null;
      }
      this.imageEditorOpen = true;
      this.loadDirectImageTaskForProduct(record, [source]);
    },

    /** Return the selected Temu gallery image sources shown in the editor dialog. */
    galleryImageEditorSources: function galleryImageEditorSources(record) {
      if (this.imageEditorSourceType === "detail"
        && this.imageEditorRecordKey === this.imageRecordKey(record)) {
        return this.imageEditorSourceUrls.slice();
      }
      const images = this.galleryImages(record);
      const sources = [];
      for (let index = 0; index < this.galleryEditSelection.length; index += 1) {
        const image = images[this.galleryEditSelection[index]];
        if (image) {
          sources.push(image);
        }
      }
      return sources;
    },

    /** Retain one carousel task under its Temu product identifier for reopen controls. */
    rememberCarouselTask: function rememberCarouselTask(task) {
      const item = task && typeof task === "object" ? task : null;
      const key = item ? String(item.temu_main_id || "") : "";
      if (key) {
        this.imageCarouselTasksByMainId[key] = item;
      }
    },

    /** Store one direct-image task under its owning Temu product. */
    storeDirectImageTask: function storeDirectImageTask(task) {
      if (!task || !task.id) {
        return;
      }
      const mainId = String(task.temu_main_id || "");
      if (mainId) {
        this.imageDirectTasksByMainId[mainId] = task;
      }
    },

    /** Return whether one direct-image task belongs to the current source selection. */
    directImageTaskMatches: function directImageTaskMatches(task, record, sources) {
      if (!task || !record || String(task.temu_main_id || "") !== String(record.main_id || "")) {
        return false;
      }
      const taskSources = Array.isArray(task.source_image_urls) ? task.source_image_urls : [];
      const selectedSources = Array.isArray(sources) ? sources : [];
      if (taskSources.length !== selectedSources.length) {
        return false;
      }
      for (let index = 0; index < taskSources.length; index += 1) {
        if (String(taskSources[index]) !== String(selectedSources[index])) {
          return false;
        }
      }
      return true;
    },

    /** Apply one persisted direct-image task to the currently retained editor session. */
    applyDirectImageTask: function applyDirectImageTask(task) {
      if (!task || !task.id) {
        return;
      }
      this.imageCarouselTask = null;
      this.imageCarouselGenerationBusy = false;
      this.imageCarouselPageIndex = 0;
      this.imageCarouselEstimatedTokens = 0;
      this.imageCarouselSourceMismatch = false;
      if (this.imageCarouselPollTimer) {
        window.clearTimeout(this.imageCarouselPollTimer);
        this.imageCarouselPollTimer = null;
      }
      this.storeDirectImageTask(task);
      this.imageDirectTask = task;
      const status = String(task.status || "");
      if (status === "succeeded") {
        this.imageEditorBusy = false;
        this.imageEditorGeneratedUrl = String(task.image_url || "");
        this.imageEditorError = this.imageEditorGeneratedUrl ? "" : "[DIRECT_IMAGE_RESULT_MISSING] 图片任务没有返回生成结果。";
        return;
      }
      if (status === "failed" || status === "interrupted") {
        this.imageEditorBusy = false;
        this.imageEditorGeneratedUrl = "";
        this.imageEditorError = "[" + String(task.error_code || "DIRECT_IMAGE_GENERATION_FAILED") + "] " + String(task.error || "图片生成失败。");
        return;
      }
      this.imageEditorBusy = true;
      this.imageEditorGeneratedUrl = "";
      this.imageEditorError = "";
    },

    /** Poll one direct-image task until the backend persists a terminal result. */
    pollDirectImageTask: function pollDirectImageTask(taskId, remainingMisses) {
      const safeTaskId = String(taskId || "");
      if (!safeTaskId) {
        return;
      }
      if (this.imageDirectPollTimer) {
        window.clearTimeout(this.imageDirectPollTimer);
        this.imageDirectPollTimer = null;
      }
      const misses = remainingMisses === undefined ? 60 : Number(remainingMisses);
      const view = this;
      fetch(apiUrl("/images/direct-tasks/" + encodeURIComponent(safeTaskId)), { cache: "no-store" }).then(function handleDirectTaskResponse(response) {
        return response.json().then(function handleDirectTaskPayload(payload) {
          if (!response.ok || !payload || !payload.ok) {
            const error = new Error(getApiErrorMessage(payload, "单结果图片任务读取失败。"));
            error.statusCode = Number(response.status || 500);
            throw error;
          }
          return payload.data && payload.data.task ? payload.data.task : null;
        });
      }).then(function handleDirectTaskLoaded(task) {
        if (!task) {
          throw new Error("单结果图片任务不存在。");
        }
        view.storeDirectImageTask(task);
        if (!view.imageDirectTask || String(view.imageDirectTask.id) !== safeTaskId) {
          return;
        }
        view.applyDirectImageTask(task);
        if (task.status === "queued" || task.status === "generating") {
          /** Continue polling while the provider task remains active. */
          function continueDirectTaskPolling() {
            view.pollDirectImageTask(safeTaskId, 60);
          }
          view.imageDirectPollTimer = window.setTimeout(continueDirectTaskPolling, 900);
        }
      }).catch(function handleDirectTaskPollError(error) {
        if (!view.imageDirectTask || String(view.imageDirectTask.id) !== safeTaskId) {
          return;
        }
        if (misses > 0) {
          /** Retry task discovery when the POST response or one local request was interrupted. */
          function retryDirectTaskPolling() {
            view.pollDirectImageTask(safeTaskId, misses - 1);
          }
          view.imageDirectPollTimer = window.setTimeout(retryDirectTaskPolling, 1000);
          return;
        }
        view.imageEditorBusy = false;
        view.imageEditorError = "[DIRECT_IMAGE_TASK_UNREACHABLE] " + String(error && error.message || "单结果图片任务无法恢复。");
      });
    },

    /** Load the newest direct-image task when reopening the same source selection. */
    loadDirectImageTaskForProduct: function loadDirectImageTaskForProduct(record, sources) {
      if (!record) {
        return;
      }
      const retainedTask = this.imageDirectTasksByMainId[String(record.main_id || "")];
      if (this.directImageTaskMatches(retainedTask, record, sources)) {
        this.applyDirectImageTask(retainedTask);
        if (retainedTask.status === "queued" || retainedTask.status === "generating") {
          this.pollDirectImageTask(retainedTask.id);
        }
        return;
      }
      const view = this;
      fetch(apiUrl("/images/direct-tasks/product/" + encodeURIComponent(String(record.main_id || ""))), { cache: "no-store" }).then(function handleProductDirectTaskResponse(response) {
        if (!response.ok) {
          return null;
        }
        return response.json();
      }).then(function handleProductDirectTaskPayload(payload) {
        const task = payload && payload.ok && payload.data ? payload.data.task : null;
        if (!view.directImageTaskMatches(task, record, sources)) {
          return;
        }
        view.applyDirectImageTask(task);
        if (task.status === "queued" || task.status === "generating") {
          view.pollDirectImageTask(task.id);
        }
      }).catch(function ignoreProductDirectTaskReadFailure() {
        return;
      });
    },

    /** Remove one retained direct-image task after apply or explicit reset. */
    deleteDirectImageTask: function deleteDirectImageTask() {
      const task = this.imageDirectTask;
      if (!task || !task.id) {
        return;
      }
      const taskId = String(task.id);
      const mainId = String(task.temu_main_id || "");
      if (this.imageDirectPollTimer) {
        window.clearTimeout(this.imageDirectPollTimer);
        this.imageDirectPollTimer = null;
      }
      this.imageDirectTask = null;
      if (mainId) {
        delete this.imageDirectTasksByMainId[mainId];
      }
      fetch(apiUrl("/images/direct-tasks/" + encodeURIComponent(taskId)), { method: "DELETE" }).catch(function ignoreDirectTaskDeleteFailure() {
        return;
      });
    },

    /** Refresh every retained direct-image task used by homepage reopen controls. */
    async refreshDirectImageTaskIndicators() {
      try {
        const response = await fetch(apiUrl("/images/direct-tasks"), { cache: "no-store" });
        const payload = await response.json();
        if (!response.ok || !payload || !payload.ok) {
          return;
        }
        const tasks = payload.data && Array.isArray(payload.data.tasks) ? payload.data.tasks : [];
        const taskLookup = {};
        let hasActiveTask = false;
        for (let index = 0; index < tasks.length; index += 1) {
          const key = String(tasks[index] && tasks[index].temu_main_id || "");
          if (key) {
            taskLookup[key] = tasks[index];
          }
          if (tasks[index] && (tasks[index].status === "queued" || tasks[index].status === "generating")) {
            hasActiveTask = true;
          }
        }
        this.imageDirectTasksByMainId = taskLookup;
        if (hasActiveTask && !this.imageDirectIndicatorTimer) {
          const view = this;
          /** Refresh background indicators until every retained direct-image task settles. */
          function refreshActiveDirectImageIndicators() {
            view.imageDirectIndicatorTimer = null;
            view.refreshDirectImageTaskIndicators();
          }
          this.imageDirectIndicatorTimer = window.setTimeout(refreshActiveDirectImageIndicators, 1000);
        }
        return true;
      } catch (error) {
        return false;
      }
    },

    /** Refresh all retained carousel tasks used by the two homepage reopen controls. */
    async refreshCarouselTaskIndicators() {
      try {
        const response = await fetch(apiUrl("/workflow/carousel"), { cache: "no-store" });
        const payload = await response.json();
        if (!response.ok || !payload || !payload.ok) {
          return;
        }
        const tasks = payload.data && Array.isArray(payload.data.tasks) ? payload.data.tasks : [];
        const taskLookup = {};
        let hasActiveTask = false;
        for (let index = 0; index < tasks.length; index += 1) {
          const key = String(tasks[index] && tasks[index].temu_main_id || "");
          if (key) {
            taskLookup[key] = tasks[index];
          }
          if (tasks[index] && (tasks[index].status === "planning" || tasks[index].status === "generating")) {
            hasActiveTask = true;
          }
        }
        this.imageCarouselTasksByMainId = taskLookup;
        if (hasActiveTask && !this.imageCarouselIndicatorTimer) {
          const view = this;
          /** Refresh carousel indicators while any server-owned task is active. */
          function refreshActiveCarouselIndicators() {
            view.imageCarouselIndicatorTimer = null;
            view.refreshCarouselTaskIndicators();
          }
          this.imageCarouselIndicatorTimer = window.setTimeout(refreshActiveCarouselIndicators, 1000);
        }
        return true;
      } catch (error) {
        return false;
      }
    },

    /** Refresh all retained image task stores before attempting one F5 editor recovery. */
    async refreshImageTaskIndicatorsAndRestore() {
      await this.refreshSkuBlendTaskIndicators();
      const directLoaded = await this.refreshDirectImageTaskIndicators();
      const carouselLoaded = await this.refreshCarouselTaskIndicators();
      if (directLoaded && carouselLoaded) {
        await this.restoreImageEditorTaskAfterReload();
      }
    },

    /** Reopen the image editor and resume polling for the task that owned the pre-refresh dialog. */
    async restoreImageEditorTaskAfterReload() {
      const mainId = String(this.imageEditorRestoreMainId || "");
      if (!mainId || this.imageEditorRestoreInFlight || this.imageEditorOpen) {
        return;
      }
      let record = null;
      for (let index = 0; index < this.temuRecords.length; index += 1) {
        if (String(this.temuRecords[index].main_id || "") === mainId) {
          record = this.temuRecords[index];
          break;
        }
      }
      if (!record) {
        return;
      }
      this.imageEditorRestoreInFlight = true;
      try {
        const directTask = this.imageDirectTasksByMainId[mainId] || null;
        const carouselTask = this.imageCarouselTasksByMainId[mainId] || null;
        if (!directTask && !carouselTask) {
          this.imageEditorRestoreMainId = "";
          this.persistViewState();
          return;
        }
        if (directTask) {
          this.openRetainedDirectImageEditor(record);
        } else {
          this.openRetainedCarouselEditor(record);
        }
      } finally {
        this.imageEditorRestoreInFlight = false;
      }
    },

    /** Return whether one Temu product owns an active or retained intelligent-packing task. */
    hasWorkflowTask: function hasWorkflowTask(record) {
      if (!record) {
        return false;
      }
      const mainId = String(record.main_id || "");
      if (this.workflowPromptBusyKeys[mainId] || this.workflowGenerateBusyKeys[mainId]) {
        return true;
      }
      const tasks = this.workflow && this.workflow.tasks ? this.workflow.tasks : {};
      const task = tasks[mainId];
      if (!this.workflowTaskErrorKeys[mainId] && (!task || !Array.isArray(task.prompts) || !task.prompts.length)) {
        return false;
      }
      return !this.isWorkflowTaskIndicatorAcknowledged(record);
    },

    /** Build one stable signature for the current intelligent-packing result shown by an indicator. */
    workflowTaskIndicatorSignature: function workflowTaskIndicatorSignature(record) {
      if (!record) {
        return "";
      }
      const mainId = String(record.main_id || "");
      const tasks = this.workflow && this.workflow.tasks ? this.workflow.tasks : {};
      const task = tasks[mainId] || {};
      const signatureParts = [String(task.status || ""), String(task.selected_image_url || ""), String(task.custom_prompt || "")];
      const prompts = Array.isArray(task.prompts) ? task.prompts : [];
      for (let index = 0; index < prompts.length; index += 1) {
        signatureParts.push(String(prompts[index].status || ""));
        signatureParts.push(String(prompts[index].image_url || ""));
        signatureParts.push(String(prompts[index].error_code || ""));
      }
      if (this.workflowTaskErrorKeys[mainId]) {
        signatureParts.push("client-error");
      }
      return signatureParts.join("|");
    },

    /** Return whether the user already opened the current intelligent-packing result. */
    isWorkflowTaskIndicatorAcknowledged: function isWorkflowTaskIndicatorAcknowledged(record) {
      if (!record) {
        return false;
      }
      const mainId = String(record.main_id || "");
      const signature = this.workflowTaskIndicatorSignature(record);
      return Boolean(signature && this.workflowIndicatorAcknowledgements[mainId] === signature);
    },

    /** Record that the user opened the current intelligent-packing result. */
    acknowledgeWorkflowTaskIndicator: function acknowledgeWorkflowTaskIndicator(record) {
      if (!record) {
        return;
      }
      const mainId = String(record.main_id || "");
      if (this.workflowPromptBusyKeys[mainId] || this.workflowGenerateBusyKeys[mainId]) {
        return;
      }
      const signature = this.workflowTaskIndicatorSignature(record);
      if (!signature) {
        return;
      }
      this.workflowIndicatorAcknowledgements[mainId] = signature;
      try {
        window.localStorage.setItem(WORKFLOW_INDICATOR_ACK_STORAGE_KEY, JSON.stringify(this.workflowIndicatorAcknowledgements));
      } catch (error) {
        return;
      }
    },

    /** Return whether all four intelligent-packing images generated successfully. */
    workflowTaskHasGeneratedAllImages: function workflowTaskHasGeneratedAllImages(task) {
      const prompts = task && Array.isArray(task.prompts) ? task.prompts : [];
      if (prompts.length !== 4) {
        return false;
      }
      for (let index = 0; index < prompts.length; index += 1) {
        if (prompts[index].status !== "generated" || !prompts[index].image_url) {
          return false;
        }
      }
      return true;
    },

    /** Return whether one intelligent-packing task contains any image-generation failure. */
    workflowTaskHasGenerationError: function workflowTaskHasGenerationError(task) {
      if (!task) {
        return false;
      }
      if (task.status === "generation_error") {
        return true;
      }
      const prompts = Array.isArray(task.prompts) ? task.prompts : [];
      for (let index = 0; index < prompts.length; index += 1) {
        if (prompts[index].status === "error" || prompts[index].error_code) {
          return true;
        }
      }
      return false;
    },

    /** Return whether one intelligent-packing task has finished generating all four images. */
    isWorkflowTaskComplete: function isWorkflowTaskComplete(record) {
      if (!record) {
        return false;
      }
      const mainId = String(record.main_id || "");
      if (this.workflowPromptBusyKeys[mainId] || this.workflowGenerateBusyKeys[mainId]) {
        return false;
      }
      const tasks = this.workflow && this.workflow.tasks ? this.workflow.tasks : {};
      const task = tasks[mainId];
      return this.workflowTaskHasGeneratedAllImages(task);
    },

    /** Return whether one intelligent-packing task retained a generation or search failure. */
    hasWorkflowTaskError: function hasWorkflowTaskError(record) {
      if (!record) {
        return false;
      }
      const tasks = this.workflow && this.workflow.tasks ? this.workflow.tasks : {};
      const mainId = String(record.main_id || "");
      if (this.workflowPromptBusyKeys[mainId] || this.workflowGenerateBusyKeys[mainId]) {
        return false;
      }
      const task = tasks[mainId];
      return Boolean(this.workflowTaskErrorKeys[mainId] || this.workflowTaskHasGenerationError(task));
    },

    /** Select one Temu product and open its intelligent-packing workspace. */
    openWorkflowTask: function openWorkflowTask(record) {
      if (!record) {
        return;
      }
      this.acknowledgeWorkflowTaskIndicator(record);
      this.selectedTemuMainId = record.main_id;
      this.selectBound1688ForTemu(record);
      this.workspaceMode = "smart";
      this.syncWorkflowSelection();
      this.persistViewState();
    },

    /** Return whether one Temu product owns a retained single-image Edits task. */
    hasOpenableDirectImageTask: function hasOpenableDirectImageTask(record) {
      if (!record || this.imageEditorOpen) {
        return false;
      }
      const mainId = String(record.main_id || "");
      if (this.imageDirectTasksByMainId[mainId]) {
        return true;
      }
      const sameRecord = this.imageEditorRecordKey === this.imageRecordKey(record);
      return sameRecord && Boolean(this.imageDirectTask);
    },

    /** Return whether one Temu product owns a retained two-image Fusion task. */
    hasOpenableCarouselTask: function hasOpenableCarouselTask(record) {
      if (!record || this.imageEditorOpen) {
        return false;
      }
      const mainId = String(record.main_id || "");
      if (this.imageCarouselTasksByMainId[mainId]) {
        return true;
      }
      const sameRecord = this.imageEditorRecordKey === this.imageRecordKey(record);
      return sameRecord && Boolean(this.imageCarouselTask);
    },

    /** Return whether a retained single-image Edits task contains an error. */
    hasDirectImageTaskError: function hasDirectImageTaskError(record) {
      if (!record) {
        return false;
      }
      const mainId = String(record.main_id || "");
      const directTask = this.imageDirectTasksByMainId[mainId]
        || (this.imageDirectTask && String(this.imageDirectTask.temu_main_id || "") === mainId ? this.imageDirectTask : null);
      if (directTask && (directTask.status === "failed" || directTask.status === "interrupted" || directTask.error_code)) {
        return true;
      }
      const sameRecord = this.imageEditorRecordKey === this.imageRecordKey(record);
      return sameRecord && Boolean(this.imageDirectTask) && /^\[[^\]]+\]/.test(String(this.imageEditorError || ""));
    },

    /** Return whether a retained two-image Fusion task contains an error. */
    hasCarouselTaskError: function hasCarouselTaskError(record) {
      if (!record) {
        return false;
      }
      const mainId = String(record.main_id || "");
      const task = this.imageCarouselTasksByMainId[mainId]
        || (this.imageEditorRecordKey === this.imageRecordKey(record) ? this.imageCarouselTask : null);
      if (task) {
        if (task.status === "failed" || task.status === "error" || task.error_code) {
          return true;
        }
        const pages = Array.isArray(task.pages) ? task.pages : [];
        for (let index = 0; index < pages.length; index += 1) {
          if (pages[index].status === "failed" || pages[index].status === "error" || pages[index].error_code) {
            return true;
          }
        }
      }
      const sameRecord = this.imageEditorRecordKey === this.imageRecordKey(record);
      return sameRecord && Boolean(this.imageCarouselTask) && /^\[[^\]]+\]/.test(String(this.imageEditorError || ""));
    },

    /** Return whether one retained single-image Edits task generated successfully. */
    isDirectImageTaskComplete: function isDirectImageTaskComplete(record) {
      if (!record) {
        return false;
      }
      if (this.hasDirectImageTaskError(record)) {
        return false;
      }
      const mainId = String(record.main_id || "");
      const directTask = this.imageDirectTasksByMainId[mainId]
        || (this.imageDirectTask && String(this.imageDirectTask.temu_main_id || "") === mainId ? this.imageDirectTask : null);
      if (directTask) {
        return directTask.status === "succeeded" && Boolean(directTask.image_url);
      }
      return false;
    },

    /** Return whether every page in one retained Fusion task generated successfully. */
    isCarouselTaskComplete: function isCarouselTaskComplete(record) {
      if (!record || this.hasCarouselTaskError(record)) {
        return false;
      }
      const mainId = String(record.main_id || "");
      const task = this.imageCarouselTasksByMainId[mainId]
        || (this.imageEditorRecordKey === this.imageRecordKey(record) ? this.imageCarouselTask : null);
      if (task) {
        const pages = Array.isArray(task.pages) ? task.pages : [];
        if (!pages.length) {
          return false;
        }
        for (let index = 0; index < pages.length; index += 1) {
          if (pages[index].status !== "succeeded" || !pages[index].image_url) {
            return false;
          }
        }
        return true;
      }
      return false;
    },

    /** Reopen only the retained single-image Edits task for one Temu product. */
    openRetainedDirectImageEditor: function openRetainedDirectImageEditor(record) {
      this.openRetainedImageEditor(record, "direct");
    },

    /** Reopen only the retained two-image Fusion task for one Temu product. */
    openRetainedCarouselEditor: function openRetainedCarouselEditor(record) {
      this.openRetainedImageEditor(record, "carousel");
    },

    /** Select the owning Temu product and reopen one explicitly requested image task type. */
    openRetainedImageEditor: function openRetainedImageEditor(record, requestedType) {
      if (!record) {
        return;
      }
      const mainId = String(record.main_id || "");
      const directTask = requestedType === "direct" ? this.imageDirectTasksByMainId[mainId] || null : null;
      const task = requestedType === "carousel" ? this.imageCarouselTasksByMainId[mainId] || null : null;
      if (!directTask && !task) {
        return;
      }
      const sameSession = this.imageEditorRecordKey === this.imageRecordKey(record)
        && Boolean(directTask ? this.imageDirectTask : this.imageCarouselTask);
      this.selectedTemuMainId = record.main_id;
      this.imageEditorRestoreMainId = mainId;
      this.selectBound1688ForTemu(record);
      if (!sameSession && directTask) {
        this.galleryEditRecordKey = this.imageRecordKey(record);
        this.galleryEditSelection = directTask.source_type === "gallery" && Array.isArray(directTask.source_indices) ? directTask.source_indices.slice() : [];
        this.imageEditorSourceType = directTask.source_type === "detail" ? "detail" : "gallery";
        this.imageEditorSourceUrls = this.imageEditorSourceType === "detail" ? directTask.source_image_urls.slice() : [];
        this.imageEditorDetailIndex = Number(directTask.detail_index === undefined ? -1 : directTask.detail_index);
        this.imageEditorRecordKey = this.galleryEditRecordKey;
        this.imageEditorPrompt = String(directTask.prompt || "");
        this.imageCarouselCount = 1;
        this.imageCarouselTask = null;
        this.applyDirectImageTask(directTask);
      }
      if (!sameSession && task) {
        this.galleryEditRecordKey = this.imageRecordKey(record);
        this.galleryEditSelection = Array.isArray(task.source_indices) ? task.source_indices.slice() : [];
        this.imageEditorSourceType = "gallery";
        this.imageEditorSourceUrls = [];
        this.imageEditorDetailIndex = -1;
        this.imageEditorRecordKey = this.galleryEditRecordKey;
        this.imageEditorGeneratedUrl = "";
        this.imageEditorError = "";
        this.imageCarouselPageIndex = 0;
      }
      if (task) {
        this.imageCarouselTask = task;
        this.imageCarouselGenerationBusy = task.status === "planning" || task.status === "generating";
        this.imageCarouselCount = Number(task.count || 2);
        this.imageCarouselMarketLanguage = String(task.market_language || "美国 / English");
        this.imageCarouselReasoningEnabled = Boolean(task.reasoning_enabled);
        this.imageEditorPrompt = String(task.requirement || "");
        this.imageCarouselEstimatedTokens = Number(task.estimated_tokens || 0);
      }
      this.imageEditorOpen = true;
      this.persistViewState();
      if (task) {
        this.loadCarouselTaskForProduct(record, task.source_image_urls || []);
      }
      if (directTask && (directTask.status === "queued" || directTask.status === "generating")) {
        this.pollDirectImageTask(directTask.id);
      }
    },

    /** Open the AI image dialog for the selected one or two gallery images. */
    openGalleryImageEditor: function openGalleryImageEditor(record) {
      const sources = this.galleryImageEditorSources(record);
      if (!record || !sources.length || sources.length > 2) {
        this.setStatus("请选择一张图片，或按住 Shift 选择两张图片。", "normal");
        return;
      }
      this.imageEditorSourceType = "gallery";
      this.imageEditorSourceUrls = [];
      this.imageEditorDetailIndex = -1;
      this.imageEditorRecordKey = this.imageRecordKey(record);
      this.imageCarouselCount = 1;
      this.imageCarouselReasoningEnabled = false;
      this.imageEditorPrompt = sources.length === 2 ? this.imageEditorFusionPrompt : this.imageEditorEditPrompt;
      this.imageEditorGeneratedUrl = "";
      this.imageEditorError = "";
      this.imageEditorBusy = false;
      this.imageDirectTask = null;
      this.imageEditorBackdropPressed = false;
      this.imageCarouselTask = null;
      this.imageCarouselGenerationBusy = false;
      this.imageCarouselPageIndex = 0;
      this.imageCarouselEstimatedTokens = 0;
      this.imageCarouselSourceMismatch = false;
      if (this.imageCarouselPollTimer) {
        window.clearTimeout(this.imageCarouselPollTimer);
        this.imageCarouselPollTimer = null;
      }
      this.imageEditorOpen = true;
      if (sources.length === 1) {
        this.loadDirectImageTaskForProduct(record, sources);
      } else {
        this.loadCarouselTaskForProduct(record, sources);
      }
    },

    /** Switch the prompt default when the requested output count crosses one. */
    handleCarouselCountInput: function handleCarouselCountInput(event) {
      const previousCount = Number(this.imageCarouselCount || 1);
      const nextCount = Math.max(1, Math.min(10, Number(event && event.target ? event.target.value : 1) || 1));
      const currentPrompt = String(this.imageEditorPrompt || "");
      if (previousCount <= 1 && nextCount > 1
        && (!currentPrompt || currentPrompt === this.imageEditorFusionPrompt)) {
        this.imageEditorPrompt = this.imageEditorCarouselPrompt;
      } else if (previousCount > 1 && nextCount <= 1
        && (!currentPrompt || currentPrompt === this.imageEditorCarouselPrompt)) {
        this.imageEditorPrompt = this.imageEditorFusionPrompt;
      }
      this.imageCarouselCount = nextCount;
    },

    /** Toggle Kimi carousel planning between reasoning and non-reasoning modes. */
    toggleCarouselReasoningMode: function toggleCarouselReasoningMode() {
      this.imageCarouselReasoningEnabled = !this.imageCarouselReasoningEnabled;
    },

    /** Remember that a possible close gesture started on the empty backdrop. */
    beginImageEditorBackdropPress: function beginImageEditorBackdropPress() {
      this.imageEditorBackdropPressed = true;
    },

    /** Close only when the pointer both starts and ends on the empty backdrop. */
    finishImageEditorBackdropPress: function finishImageEditorBackdropPress(event) {
      const shouldClose = this.imageEditorBackdropPressed
        && event && event.target === event.currentTarget;
      this.imageEditorBackdropPressed = false;
      if (shouldClose) {
        this.closeGalleryImageEditor();
      }
    },

    /** Cancel one incomplete backdrop gesture without closing the dialog. */
    cancelImageEditorBackdropPress: function cancelImageEditorBackdropPress() {
      this.imageEditorBackdropPressed = false;
    },

    /** Route one image through Edits and every two-image Fusion count through one persisted workflow. */
    submitGalleryImageEdit: function submitGalleryImageEdit() {
      const sources = this.galleryImageEditorSources(this.selectedTemuRecord);
      if (sources.length === 2) {
        if (this.imageCarouselTask && this.imageCarouselTask.status === "awaiting_review") {
          this.saveAdvancedCarouselPlan();
          return;
        }
        if (this.imageCarouselTask && (this.imageCarouselTask.status === "failed" || this.imageCarouselTask.status === "interrupted")) {
          this.restartCarouselPlan();
          return;
        }
        if (this.imageCarouselTask && this.imageCarouselTask.pages && this.imageCarouselTask.pages.length) {
          this.generateCarouselPages();
          return;
        }
        this.startCarouselPlan();
        return;
      }
      this.submitDirectGalleryImageEdit();
    },

    /** Submit one selected image as one recoverable Edits task. */
    submitDirectGalleryImageEdit: function submitDirectGalleryImageEdit() {
      const record = this.selectedTemuRecord;
      const sources = this.galleryImageEditorSources(record);
      const prompt = String(this.imageEditorPrompt || "").trim();
      if (!record || !prompt || sources.length !== 1 || this.imageEditorBusy) {
        return;
      }
      const taskId = "direct-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
      const sourceType = this.imageEditorSourceType === "detail" ? "detail" : "gallery";
      const sourceIndices = sourceType === "gallery" ? this.galleryEditSelection.slice() : [];
      const directTask = {
        id: taskId,
        temu_main_id: String(record.main_id || ""),
        temu_platform_id: String(record.platform_id || ""),
        mode: "edit",
        source_image_urls: sources.slice(),
        source_type: sourceType,
        source_indices: sourceIndices,
        detail_index: Number(this.imageEditorDetailIndex),
        prompt: prompt,
        size: this.imageEditSize,
        status: "queued",
        image_url: "",
        error: "",
        error_code: ""
      };
      this.applyDirectImageTask(directTask);
      this.imageEditorRestoreMainId = directTask.temu_main_id;
      this.persistViewState();
      const view = this;
      fetch(apiUrl("/images/direct-tasks"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_task_id: taskId,
          temu_main_id: directTask.temu_main_id,
          temu_platform_id: directTask.temu_platform_id,
          mode: directTask.mode,
          image_urls: directTask.source_image_urls,
          source_type: directTask.source_type,
          source_indices: directTask.source_indices,
          detail_index: directTask.detail_index,
          prompt: directTask.prompt,
          size: directTask.size
        })
      }).then(function handleDirectImageCreateResponse(response) {
        return response.json().then(function handleDirectImageCreatePayload(payload) {
          if (!response.ok || !payload || !payload.ok) {
            const error = new Error(getApiErrorMessage(payload, "单结果图片任务创建失败。"));
            error.receivedResponse = true;
            error.code = String(payload && payload.error && payload.error.code || response.status || "DIRECT_IMAGE_TASK_CREATE_FAILED");
            throw error;
          }
          return payload.data && payload.data.task ? payload.data.task : null;
        });
      }).then(function handleDirectImageCreated(task) {
        if (!task || !view.imageDirectTask || String(view.imageDirectTask.id) !== taskId) {
          return;
        }
        view.applyDirectImageTask(task);
      }).catch(function keepPollingAfterDirectImageCreateFailure(error) {
        if (!error || !error.receivedResponse || !view.imageDirectTask || String(view.imageDirectTask.id) !== taskId) {
          return;
        }
        const failedTask = view.imageDirectTask;
        failedTask.status = "failed";
        failedTask.error = String(error.message || "单结果图片任务创建失败。");
        failedTask.error_code = String(error.code || "DIRECT_IMAGE_TASK_CREATE_FAILED");
        view.applyDirectImageTask(failedTask);
      });
      this.pollDirectImageTask(taskId);
    },

    /** Return whether two source arrays identify the same unordered image pair. */
    hasSameCarouselSources: function hasSameCarouselSources(firstSources, secondSources) {
      const first = Array.isArray(firstSources) ? firstSources.slice() : [];
      const second = Array.isArray(secondSources) ? secondSources.slice() : [];
      first.sort();
      second.sort();
      return first.length === 2 && first[0] === second[0] && first[1] === second[1];
    },

    /** Load and display the single retained carousel task for one Temu product. */
    async loadCarouselTaskForProduct(record, sources) {
      if (!record) {
        return;
      }
      try {
        const response = await fetch(apiUrl("/workflow/carousel/product/" + encodeURIComponent(String(record.main_id))), { cache: "no-store" });
        const payload = await response.json();
        if (!response.ok || !payload || !payload.ok) {
          throw new Error(getApiErrorMessage(payload, "轮播任务读取失败。"));
        }
        const task = payload.data && payload.data.task ? payload.data.task : null;
        if (!task) {
          return;
        }
        this.imageCarouselTask = task;
        this.rememberCarouselTask(task);
        this.imageCarouselGenerationBusy = task.status === "planning" || task.status === "generating";
        this.normalizeCarouselPageIndex();
        this.imageCarouselCount = Number(task.count || 1);
        this.imageCarouselMarketLanguage = String(task.market_language || "美国 / English");
        this.imageCarouselReasoningEnabled = Boolean(task.reasoning_enabled);
        this.imageEditorPrompt = String(task.requirement || this.imageEditorPrompt || "");
        this.imageCarouselEstimatedTokens = Number(task.estimated_tokens || 0);
        this.imageCarouselSourceMismatch = !this.hasSameCarouselSources(task.source_image_urls, sources);
        if (task.status === "planning" || task.status === "generating") {
          this.scheduleCarouselTaskPoll();
        } else if (task.status === "ready" && task.mode === "basic" && !this.imageCarouselSourceMismatch) {
          await this.generateCarouselPages();
        }
      } catch (error) {
        this.imageEditorError = error.message || "轮播任务读取失败。";
      }
    },

    /** Parse one frontend-facing SSE event block. */
    consumeCarouselEventBlock: function consumeCarouselEventBlock(block, state) {
      const lines = String(block || "").split(/\r?\n/);
      let eventName = "message";
      let dataText = "";
      for (let index = 0; index < lines.length; index += 1) {
        if (lines[index].indexOf("event:") === 0) {
          eventName = lines[index].slice(6).trim();
        } else if (lines[index].indexOf("data:") === 0) {
          dataText += lines[index].slice(5).trim();
        }
      }
      if (!dataText) {
        return;
      }
      const payload = JSON.parse(dataText);
      if (eventName === "progress" || eventName === "complete") {
        state.task = payload.task || null;
        this.imageCarouselTask = state.task;
        this.rememberCarouselTask(state.task);
        this.normalizeCarouselPageIndex();
        this.imageCarouselEstimatedTokens = Number(payload.estimated_tokens || 0);
      }
      if (eventName === "error") {
        const error = new Error(String(payload.message || "轮播规划失败。"));
        error.code = String(payload.code || "CAROUSEL_PLAN_FAILED");
        error.details = payload.details || null;
        state.error = error;
      }
    },

    /** Read a POST-based SSE planning response to completion. */
    async readCarouselPlanStream(response) {
      if (!response.body) {
        throw new Error("轮播规划接口没有返回数据流。");
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const state = { task: null, error: null };
      let pendingText = "";
      let finished = false;
      while (!finished) {
        const result = await reader.read();
        finished = result.done;
        pendingText += decoder.decode(result.value || new Uint8Array(), { stream: !finished });
        const blocks = pendingText.split(/\r?\n\r?\n/);
        pendingText = blocks.pop() || "";
        for (let index = 0; index < blocks.length; index += 1) {
          this.consumeCarouselEventBlock(blocks[index], state);
        }
      }
      if (pendingText) {
        this.consumeCarouselEventBlock(pendingText, state);
      }
      if (state.error) {
        throw state.error;
      }
      return state.task;
    },

    /** Submit one server-owned Fusion pipeline and use Kimi planning only for multiple outputs. */
    async startCarouselPlan() {
      const record = this.selectedTemuRecord;
      const sources = this.galleryImageEditorSources(record);
      const count = Math.max(1, Math.min(10, Number(this.imageCarouselCount || 1)));
      if (!record || sources.length !== 2 || this.imageEditorBusy) {
        return;
      }
      this.imageCarouselCount = count;
      this.imageEditorBusy = true;
      this.imageEditorRestoreMainId = String(record.main_id || "");
      this.persistViewState();
      this.imageEditorError = "";
      this.imageEditorBackdropPressed = false;
      this.imageCarouselEstimatedTokens = 0;
      try {
        const response = await fetch(apiUrl("/workflow/carousel/plan"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mode: "carousel",
            temu_main_id: record.main_id,
            temu_platform_id: record.platform_id,
            image_urls: sources,
            source_indices: this.galleryEditSelection.slice(),
            gallery_snapshot: this.galleryImages(record).slice(),
            count: count,
            market_language: String(this.imageCarouselMarketLanguage || "美国 / English"),
            prompt: String(this.imageEditorPrompt || ""),
            advanced: false,
            reasoning_enabled: Boolean(this.imageCarouselReasoningEnabled),
            size: this.imageEditSize
          })
        });
        const payload = await response.json();
        if (!response.ok || !payload || !payload.ok) {
          throw new Error(getApiErrorMessage(payload, "轮播后台任务提交失败。"));
        }
        const task = payload.data && payload.data.task ? payload.data.task : null;
        if (!task) {
          throw new Error("后台没有返回轮播任务。");
        }
        this.imageCarouselTask = task;
        this.rememberCarouselTask(task);
        this.imageCarouselGenerationBusy = task.status === "planning" || task.status === "generating";
        this.scheduleCarouselTaskPoll();
      } catch (error) {
        this.imageEditorError = "[" + getWorkflowErrorCode(error) + "] " + (error.message || "轮播后台任务提交失败。");
        if (!this.imageCarouselTask) {
          this.imageEditorRestoreMainId = "";
          this.persistViewState();
        }
      } finally {
        this.imageEditorBusy = false;
      }
    },

    /** Persist advanced-mode edits before concurrent page generation. */
    async saveAdvancedCarouselPlan() {
      const task = this.imageCarouselTask;
      if (!task || !task.pages || !task.pages.length) {
        return;
      }
      this.imageEditorBusy = true;
      this.imageEditorError = "";
      try {
        const pages = [];
        for (let index = 0; index < task.pages.length; index += 1) {
          pages.push({ purpose: String(task.pages[index].purpose || ""), prompt: String(task.pages[index].prompt || "") });
        }
        const response = await fetch(apiUrl("/workflow/carousel/" + encodeURIComponent(task.id)), {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pages: pages })
        });
        const payload = await response.json();
        if (!response.ok || !payload || !payload.ok) {
          throw new Error(getApiErrorMessage(payload, "分镜保存失败。"));
        }
        this.imageCarouselTask = payload.data.task;
        this.rememberCarouselTask(this.imageCarouselTask);
        this.imageEditorBusy = false;
        await this.generateCarouselPages();
      } catch (error) {
        this.imageEditorError = error.message || "分镜保存失败。";
      } finally {
        this.imageEditorBusy = false;
      }
    },

    /** Submit selected pages as one server-owned background Fusion batch. */
    async startCarouselGeneration(task, pageIndices) {
      if (!task || !task.id || !Array.isArray(pageIndices) || !pageIndices.length) {
        return;
      }
      const response = await fetch(apiUrl("/workflow/carousel/" + encodeURIComponent(task.id) + "/generate"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ page_indices: pageIndices })
      });
      const payload = await response.json();
      if (!response.ok || !payload || !payload.ok) {
        throw new Error(getApiErrorMessage(payload, "轮播后台任务提交失败。"));
      }
      const submittedTask = payload.data && payload.data.task ? payload.data.task : task;
      this.rememberCarouselTask(submittedTask);
      if (this.imageCarouselTask && String(this.imageCarouselTask.id || "") === String(submittedTask.id || "")) {
        this.imageCarouselTask = submittedTask;
        this.imageCarouselGenerationBusy = submittedTask.status === "generating";
        this.scheduleCarouselTaskPoll();
      }
    },

    /** Submit every carousel page once and let the backend execute them concurrently. */
    async generateCarouselPages() {
      const task = this.imageCarouselTask;
      if (!task || !Array.isArray(task.pages) || !task.pages.length || task.status === "generating") {
        return;
      }
      const pageIndices = [];
      for (let index = 0; index < task.pages.length; index += 1) {
        pageIndices.push(index);
      }
      this.imageCarouselGenerationBusy = true;
      this.imageEditorError = "";
      try {
        await this.startCarouselGeneration(task, pageIndices);
      } catch (error) {
        this.imageCarouselGenerationBusy = false;
        this.imageEditorError = error.message || "轮播后台任务提交失败。";
      }
    },

    /** Build one task-and-page key for an individual carousel request. */
    carouselPageBusyKey: function carouselPageBusyKey(pageIndex) {
      const taskId = this.imageCarouselTask ? this.imageCarouselTask.id : "";
      return String(taskId || "") + ":" + String(Number(pageIndex));
    },

    /** Return whether one carousel page has an active Fusion request. */
    isCarouselPageBusy: function isCarouselPageBusy(pageIndex) {
      const page = this.imageCarouselTask && this.imageCarouselTask.pages ? this.imageCarouselTask.pages[Number(pageIndex)] : null;
      return Boolean(page && page.status === "generating") || Boolean(this.imageCarouselPageBusyKeys[this.carouselPageBusyKey(pageIndex)]);
    },

    /** Persist the current carousel page text without changing other page states. */
    async saveCarouselPage(pageIndex) {
      const task = this.imageCarouselTask;
      const page = task && task.pages ? task.pages[Number(pageIndex)] : null;
      if (!task || !page || !String(page.prompt || "").trim()) {
        throw new Error("当前分镜提示词不能为空。");
      }
      const endpoint = "/workflow/carousel/" + encodeURIComponent(task.id) + "/pages/" + encodeURIComponent(String(Number(pageIndex)));
      const response = await fetch(apiUrl(endpoint), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ purpose: String(page.purpose || ""), prompt: String(page.prompt || "").trim() })
      });
      const payload = await response.json();
      if (!response.ok || !payload || !payload.ok) {
        throw new Error(getApiErrorMessage(payload, "分镜保存失败。"));
      }
      const savedTask = payload.data.task;
      const savedPage = savedTask && savedTask.pages ? savedTask.pages[Number(pageIndex)] : null;
      if (savedPage) {
        page.purpose = String(savedPage.purpose || "");
        page.prompt = String(savedPage.prompt || "");
      }
    },

    /** Save and submit exactly one carousel page to the background Fusion worker. */
    async generateCarouselPage(pageIndex) {
      const task = this.imageCarouselTask;
      const page = task && task.pages ? task.pages[Number(pageIndex)] : null;
      const busyKey = this.carouselPageBusyKey(pageIndex);
      if (!task || !page || this.imageCarouselPageBusyKeys[busyKey]) {
        return;
      }
      this.imageCarouselPageBusyKeys[busyKey] = true;
      try {
        await this.saveCarouselPage(pageIndex);
        await this.startCarouselGeneration(task, [Number(pageIndex)]);
      } catch (error) {
        this.imageEditorError = error.message || "轮播后台任务提交失败。";
      } finally {
        delete this.imageCarouselPageBusyKeys[busyKey];
      }
    },

    /** Retry one failed result without regenerating successful pages. */
    async retryCarouselPage(pageIndex) {
      if (this.isCarouselPageBusy(pageIndex)) {
        return;
      }
      await this.generateCarouselPage(pageIndex);
    },

    /** Regenerate only the currently visible carousel page. */
    async regenerateCurrentCarouselPage() {
      const pageIndex = Number(this.imageCarouselPageIndex);
      if (this.isCarouselPageBusy(pageIndex)) {
        return;
      }
      await this.generateCarouselPage(pageIndex);
    },

    /** Regenerate every carousel page concurrently through the batch path. */
    async regenerateAllCarouselPages() {
      await this.generateCarouselPages();
    },

    /** Refresh the current runtime task from disk-backed server state. */
    async refreshCarouselTask() {
      const record = this.selectedTemuRecord;
      if (!record) {
        return;
      }
      const response = await fetch(apiUrl("/workflow/carousel/product/" + encodeURIComponent(String(record.main_id))), { cache: "no-store" });
      const payload = await response.json();
      if (response.ok && payload && payload.ok) {
        this.imageCarouselTask = payload.data.task || null;
        this.rememberCarouselTask(this.imageCarouselTask);
        this.imageCarouselGenerationBusy = Boolean(this.imageCarouselTask
          && (this.imageCarouselTask.status === "planning" || this.imageCarouselTask.status === "generating"));
        this.normalizeCarouselPageIndex();
      }
    },

    /** Return the carousel page currently visible in the single-slide viewer. */
    currentCarouselPage: function currentCarouselPage() {
      const pages = this.imageCarouselTask && Array.isArray(this.imageCarouselTask.pages)
        ? this.imageCarouselTask.pages
        : [];
      return pages[this.imageCarouselPageIndex] || {};
    },

    /** Keep the visible carousel index inside the current page list. */
    normalizeCarouselPageIndex: function normalizeCarouselPageIndex() {
      const pages = this.imageCarouselTask && Array.isArray(this.imageCarouselTask.pages)
        ? this.imageCarouselTask.pages
        : [];
      if (!pages.length) {
        this.imageCarouselPageIndex = 0;
        return;
      }
      this.imageCarouselPageIndex = Math.max(0, Math.min(Number(this.imageCarouselPageIndex || 0), pages.length - 1));
    },

    /** Move the single-slide viewer one page left or right. */
    changeCarouselPage: function changeCarouselPage(offset) {
      this.imageCarouselPageIndex += Number(offset || 0);
      this.normalizeCarouselPageIndex();
    },

    /** Poll retained background work while its modal remains visible. */
    scheduleCarouselTaskPoll: function scheduleCarouselTaskPoll() {
      if (this.imageCarouselPollTimer) {
        window.clearTimeout(this.imageCarouselPollTimer);
      }
      const view = this;
      /** Refresh one retained task and continue only while it is active. */
      async function pollCarouselTask() {
        view.imageCarouselPollTimer = null;
        if (!view.imageEditorOpen) {
          return;
        }
        await view.refreshCarouselTask();
        const task = view.imageCarouselTask;
        if (task && (task.status === "planning" || task.status === "generating")) {
          view.scheduleCarouselTaskPoll();
        } else if (task && task.status === "ready" && task.mode === "basic" && !view.imageCarouselSourceMismatch) {
          await view.generateCarouselPages();
        }
      }
      this.imageCarouselPollTimer = window.setTimeout(pollCarouselTask, 2000);
    },

    /** Add one blank editable advanced-mode page. */
    addCarouselPage: function addCarouselPage() {
      if (this.imageCarouselTask && this.imageCarouselTask.pages.length < 10) {
        this.imageCarouselTask.pages.push({ purpose: "", prompt: "", status: "pending", image_url: "", selected: true });
        this.imageCarouselPageIndex = this.imageCarouselTask.pages.length - 1;
      }
    },

    /** Remove one editable advanced-mode page while retaining at least one. */
    removeCarouselPage: function removeCarouselPage(pageIndex) {
      if (this.imageCarouselTask && this.imageCarouselTask.pages.length > 1) {
        this.imageCarouselTask.pages.splice(Number(pageIndex), 1);
        this.normalizeCarouselPageIndex();
      }
    },

    /** Return the number of successful carousel outputs, optionally including unselected pages. */
    successfulCarouselPageCount: function successfulCarouselPageCount(includeUnselected) {
      const pages = this.imageCarouselTask && Array.isArray(this.imageCarouselTask.pages) ? this.imageCarouselTask.pages : [];
      let count = 0;
      for (let index = 0; index < pages.length; index += 1) {
        if (pages[index].status === "succeeded" && (includeUnselected || pages[index].selected !== false)) {
          count += 1;
        }
      }
      return count;
    },

    /** Delete the conflicting old task and immediately plan from the current pair. */
    async replaceExistingCarouselTask() {
      const task = this.imageCarouselTask;
      if (task) {
        await fetch(apiUrl("/workflow/carousel/" + encodeURIComponent(task.id)), { method: "DELETE" });
        delete this.imageCarouselTasksByMainId[String(task.temu_main_id || "")];
      }
      this.imageCarouselTask = null;
      this.imageCarouselPageBusyKeys = {};
      this.imageCarouselPageIndex = 0;
      this.imageCarouselSourceMismatch = false;
      this.imageEditorError = "";
      await this.startCarouselPlan();
    },

    /** Abandon the visible task and return the dialog to its original controls. */
    async abandonCarouselTask() {
      const task = this.imageCarouselTask;
      if (task) {
        await fetch(apiUrl("/workflow/carousel/" + encodeURIComponent(task.id)), { method: "DELETE" });
        delete this.imageCarouselTasksByMainId[String(task.temu_main_id || "")];
      }
      this.imageCarouselTask = null;
      this.imageCarouselPageIndex = 0;
      this.imageCarouselCount = 1;
      this.imageCarouselReasoningEnabled = false;
      this.imageCarouselEstimatedTokens = 0;
      this.imageCarouselSourceMismatch = false;
      this.imageEditorError = "";
      this.imageEditorRestoreMainId = "";
      this.persistViewState();
    },

    /** Delete one failed plan before submitting the same source pair again. */
    async restartCarouselPlan() {
      const task = this.imageCarouselTask;
      if (task) {
        await fetch(apiUrl("/workflow/carousel/" + encodeURIComponent(task.id)), { method: "DELETE" });
        delete this.imageCarouselTasksByMainId[String(task.temu_main_id || "")];
      }
      this.imageCarouselTask = null;
      this.imageCarouselPageIndex = 0;
      await this.startCarouselPlan();
    },

    /** Replace selected gallery positions only after the user confirms the result. */
    confirmGalleryImageEdit: function confirmGalleryImageEdit() {
      if (this.imageCarouselTask) {
        this.confirmCarouselReplacement();
        return;
      }
      const record = this.selectedTemuRecord;
      const generatedUrl = String(this.imageEditorGeneratedUrl || "").trim();
      if (!record || !generatedUrl || this.imageEditorBusy) {
        return;
      }
      if (this.imageEditorSourceType === "detail") {
        const detailList = this.imageListForType(record, "detail");
        const detailIndex = Number(this.imageEditorDetailIndex);
        if (detailIndex < 0 || detailIndex >= detailList.length) {
          return;
        }
        detailList.splice(detailIndex, 1, generatedUrl);
        this.saveProductModule(record, "images");
        this.setStatus("已确认编辑并替换详情图。", "success");
        this.deleteDirectImageTask();
        this.closeGalleryImageEditor(true);
        return;
      }
      const list = this.imageListForType(record, "gallery");
      const indices = this.galleryEditSelection.slice().sort(function sortImageIndices(first, second) {
        return first - second;
      });
      if (!indices.length) {
        return;
      }
      const insertIndex = indices[0];
      for (let index = indices.length - 1; index >= 0; index -= 1) {
        list.splice(indices[index], 1);
      }
      list.splice(insertIndex, 0, generatedUrl);
      record.main_image_url = list[0] || "";
      this.saveProductModule(record, "images");
      this.selectedTemuGalleryIndex = insertIndex;
      this.selectedGalleryIndex = insertIndex;
      this.setStatus(indices.length === 2 ? "已确认溶图并替换两张原图。" : "已确认编辑并替换原图。", "success");
      this.deleteDirectImageTask();
      this.closeGalleryImageEditor(true);
    },

    /** Apply selected outputs to source positions or replace the complete main-image gallery. */
    async confirmCarouselReplacement(replaceAll) {
      const task = this.imageCarouselTask;
      if (!task || this.imageCarouselGenerationBusy) {
        return;
      }
      const selectedIndices = [];
      for (let index = 0; index < task.pages.length; index += 1) {
        if (task.pages[index].status === "succeeded" && (replaceAll || task.pages[index].selected !== false)) {
          selectedIndices.push(index);
        }
      }
      if (!selectedIndices.length) {
        this.imageEditorError = "请至少选择一张生成成功的图片。";
        return;
      }
      this.imageCarouselGenerationBusy = true;
      try {
        const response = await fetch(apiUrl("/workflow/carousel/" + encodeURIComponent(task.id) + "/apply"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ selected_indices: selectedIndices, replace_all: Boolean(replaceAll) })
        });
        const payload = await response.json();
        if (!response.ok || !payload || !payload.ok) {
          throw new Error(getApiErrorMessage(payload, "轮播替换失败。"));
        }
        const result = payload.data || {};
        const product = result.product || {};
        this.carouselUndoTokens[this.productCacheEventKey(product)] = String(result.undo_token || "");
        this.persistCarouselUndoTokens();
        await this.reloadWorkbenchAfterCarousel();
        this.setStatus(replaceAll ? "全部主图已替换为本次轮播生成图。" : "轮播图片已按分镜顺序替换，可恢复整组原图。", "success");
        delete this.imageCarouselTasksByMainId[String(task.temu_main_id || "")];
        this.closeGalleryImageEditor(true);
      } catch (error) {
        this.imageEditorError = error.message || "轮播替换失败。";
      } finally {
        this.imageCarouselGenerationBusy = false;
      }
    },

    /** Reload the workbench after one server-owned carousel mutation. */
    async reloadWorkbenchAfterCarousel() {
      const response = await fetch(apiUrl("/workbench"), { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok || !payload || !payload.ok) {
        throw new Error(getApiErrorMessage(payload, "工作台刷新失败。"));
      }
      this.applyCachePayload(payload.data || {});
    },

    /** Return whether one product has a durable carousel undo token. */
    hasCarouselUndo: function hasCarouselUndo(record) {
      return Boolean(this.carouselUndoTokens[this.productCacheEventKey(record)]);
    },

    /** Persist durable carousel undo tokens for browser refresh recovery. */
    persistCarouselUndoTokens: function persistCarouselUndoTokens() {
      try {
        window.localStorage.setItem(CAROUSEL_UNDO_STORAGE_KEY, JSON.stringify(this.carouselUndoTokens));
      } catch (error) {
        return;
      }
    },

    /** Restore the complete pre-carousel product snapshot. */
    async undoCarouselReplacement(record) {
      const key = this.productCacheEventKey(record);
      const token = String(this.carouselUndoTokens[key] || "");
      if (!token) {
        return;
      }
      try {
        const response = await fetch(apiUrl("/products/undo"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: token })
        });
        const payload = await response.json();
        if (!response.ok || !payload || !payload.ok) {
          throw new Error(getApiErrorMessage(payload, "轮播恢复失败。"));
        }
        delete this.carouselUndoTokens[key];
        this.persistCarouselUndoTokens();
        await this.reloadWorkbenchAfterCarousel();
        this.setStatus("已恢复轮播替换前的整组图片。", "success");
      } catch (error) {
        this.setStatus(error.message || "轮播恢复失败。", "error");
      }
    },

    /** Close the image editor while retaining unfinished or unconfirmed image work for reopening. */
    closeGalleryImageEditor: function closeGalleryImageEditor(forceReset) {
      const shouldForceReset = forceReset === true;
      this.imageEditorOpen = false;
      this.imageEditorRestoreMainId = "";
      this.persistViewState();
      if (shouldForceReset && this.imageDirectTask) {
        this.deleteDirectImageTask();
      }
      if (!shouldForceReset && (this.imageEditorBusy || this.imageCarouselGenerationBusy || this.imageEditorGeneratedUrl || this.imageCarouselTask)) {
        if (this.imageCarouselPollTimer) {
          window.clearTimeout(this.imageCarouselPollTimer);
          this.imageCarouselPollTimer = null;
        }
        return;
      }
      this.imageEditorRequestId += 1;
      this.imageEditorBusy = false;
      this.imageEditorGeneratedUrl = "";
      this.imageEditorError = "";
      this.imageDirectTask = null;
      this.imageCarouselTask = null;
      this.imageCarouselPageIndex = 0;
      this.imageCarouselGenerationBusy = false;
      this.imageCarouselEstimatedTokens = 0;
      this.imageCarouselSourceMismatch = false;
      if (this.imageCarouselPollTimer) {
        window.clearTimeout(this.imageCarouselPollTimer);
        this.imageCarouselPollTimer = null;
      }
      this.galleryEditRecordKey = "";
      this.galleryEditSelection = [];
      this.imageEditorSourceType = "gallery";
      this.imageEditorSourceUrls = [];
      this.imageEditorDetailIndex = -1;
      this.imageEditorRecordKey = "";
    },

    /** Return the image currently shown for one platform render column. */
    currentImage: function currentImage(record, platform) {
      const images = this.galleryImages(record);
      const index = platform === "1688" ? this.selected1688GalleryIndex : this.selectedTemuGalleryIndex;
      return images[index] || images[0] || "";
    },

    /** Start dragging one 1688 image to its matching Temu image target. */
    startAliImageDrag: function startAliImageDrag(event, record, image, sourceType, index) {
      const imageUrl = String(image || "").trim();
      if (!imageUrl) {
        return;
      }
      const item = record || {};
      this.dragImageReference = {
        main_id: item.main_id,
        platform_id: item.platform_id,
        source_type: sourceType || "gallery",
        source_index: index,
        image_url: imageUrl
      };
      if (sourceType === "gallery" || sourceType === "detail") {
        this.imageReorderReference = {
          record_key: this.imageRecordKey(record),
          image_type: sourceType,
          source_index: Number(index)
        };
      } else {
        this.imageReorderReference = null;
      }
      this.dragSkuReference = null;
      this.dragDropTarget = null;
      this.imageDropTarget = null;
      this.imageReorderTarget = null;
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = "copy";
        event.dataTransfer.setData("application/x-temu-1688-image", JSON.stringify(this.dragImageReference));
        event.dataTransfer.setData("text/plain", imageUrl);
      }
    },

    /** Clear the active 1688 image drag state after a completed or cancelled drag. */
    endAliImageDrag: function endAliImageDrag() {
      this.dragImageReference = null;
      this.imageDropTarget = null;
      this.imageReorderReference = null;
      this.imageReorderTarget = null;
    },

    /** Mark one Temu image area as the active image drop target. */
    setImageDropTarget: function setImageDropTarget(targetType, targetIndex) {
      if (String(targetType || "") === "temu-sku"
        && (!this.dragImageReference || String(this.dragImageReference.source_type || "") !== "sku")) {
        this.imageDropTarget = null;
        return;
      }
      this.imageDropTarget = [targetType || "", targetIndex === undefined ? "" : String(targetIndex)].join("|");
    },

    /** Start dragging one Temu or 1688 SKU image toward the Temu main gallery. */
    startSkuImageDrag: function startSkuImageDrag(event, record, image, skuIndex, imageIndex) {
      this.startAliImageDrag(event, record, image, "sku", skuIndex);
      if (this.dragImageReference) {
        this.dragImageReference.source_image_index = Number(imageIndex);
      }
    },

    /** Test whether one Temu image area is the active image drop target. */
    isImageDropTarget: function isImageDropTarget(targetType, targetIndex) {
      return this.imageDropTarget === [targetType || "", targetIndex === undefined ? "" : String(targetIndex)].join("|");
    },

    /** Clear stale image drop highlights after a browser drag ends or leaves the page. */
    clearImageDragState: function clearImageDragState(event) {
      this.imageDropTarget = null;
      this.imageReorderTarget = null;
      if (!event || event.type === "dragend" || event.type === "blur") {
        this.dragImageReference = null;
        this.imageReorderReference = null;
        this.dragSkuReference = null;
        this.dragDropTarget = null;
      }
    },

    /** Build a stable key for one product image list while a drag is active. */
    imageRecordKey: function imageRecordKey(record) {
      const item = record || {};
      return [item.platform, item.main_id, item.platform_id, item.product_id].join("|");
    },

    /** Return the mutable image array for one product image type. */
    imageListForType: function imageListForType(record, imageType) {
      if (!record) {
        return [];
      }
      const fieldName = imageType === "detail" ? "detail_image_urls" : "gallery_image_urls";
      if (!Array.isArray(record[fieldName])) {
        record[fieldName] = [];
      }
      return record[fieldName];
    },

    /** Move one array item before the requested target position. */
    moveImageInList: function moveImageInList(list, sourceIndex, targetIndex) {
      if (!Array.isArray(list)) {
        return -1;
      }
      const source = Number(sourceIndex);
      if (!Number.isInteger(source) || source < 0 || source >= list.length) {
        return -1;
      }
      const movedItem = list.splice(source, 1)[0];
      const appendToEnd = targetIndex === undefined;
      let target = appendToEnd ? list.length : Number(targetIndex);
      if (!Number.isInteger(target)) {
        target = list.length;
      }
      if (target < 0) {
        target = 0;
      }
      if (target > list.length) {
        target = list.length;
      }
      list.splice(target, 0, movedItem);
      return target;
    },

    /** Start reordering one Temu or 1688 gallery/detail image list. */
    startImageReorder: function startImageReorder(event, record, imageType, index) {
      const list = this.imageListForType(record, imageType);
      const sourceIndex = Number(index);
      if (!record || !Number.isInteger(sourceIndex) || sourceIndex < 0 || sourceIndex >= list.length) {
        return;
      }
      this.imageReorderReference = {
        record_key: this.imageRecordKey(record),
        image_type: imageType,
        source_index: sourceIndex
      };
      this.dragImageReference = null;
      this.dragSkuReference = null;
      this.dragDropTarget = null;
      this.imageDropTarget = null;
      this.imageReorderTarget = null;
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("application/x-temu-image-reorder", JSON.stringify(this.imageReorderReference));
        event.dataTransfer.setData("text/plain", String(list[sourceIndex] || ""));
      }
    },

    /** End a same-list image reorder drag without clearing another image drag source. */
    endImageReorder: function endImageReorder() {
      this.imageReorderReference = null;
      this.imageReorderTarget = null;
      this.imageDropTarget = null;
    },

    /** Mark one image list position as the current reorder target. */
    setImageReorderTarget: function setImageReorderTarget(targetType, targetIndex) {
      this.imageReorderTarget = [targetType || "", targetIndex === undefined ? "" : String(targetIndex)].join("|");
    },

    /** Mark one position for same-list image reordering and ignore cross-list image drops. */
    setImageInteractionTarget: function setImageInteractionTarget(targetType, targetIndex) {
      const targetName = String(targetType || "");
      const targetRecord = targetName.indexOf("temu-") === 0 ? this.selectedTemuRecord : this.selected1688Record;
      const targetImageType = targetName.indexOf("detail") >= 0 ? "detail" : "gallery";
      const reorder = this.imageReorderReference;
      const sameList = reorder
        && targetRecord
        && reorder.record_key === this.imageRecordKey(targetRecord)
        && reorder.image_type === targetImageType;
      if (sameList) {
        this.setImageReorderTarget(targetType, targetIndex);
        this.imageDropTarget = null;
        return;
      }
      const reference = this.dragImageReference;
      if (targetName === "temu-gallery" && reference
        && (String(reference.source_type || "") === "gallery" || String(reference.source_type || "") === "sku")) {
        this.setImageDropTarget(targetType, targetIndex);
        this.imageReorderTarget = null;
        return;
      }
      this.imageDropTarget = null;
      this.imageReorderTarget = null;
    },

    /** Test whether one image list position is the current reorder target. */
    isImageReorderTarget: function isImageReorderTarget(targetType, targetIndex) {
      return this.imageReorderTarget === [targetType || "", targetIndex === undefined ? "" : String(targetIndex)].join("|");
    },

    /** Reorder one image list and keep the gallery main image aligned with its first item. */
    dropImageReorder: function dropImageReorder(event, record, imageType, targetIndex) {
      event.preventDefault();
      event.stopPropagation();
      const reference = this.imageReorderReference;
      if (!reference
        || reference.record_key !== this.imageRecordKey(record)
        || reference.image_type !== imageType) {
        this.endAliImageDrag();
        return;
      }
      const list = this.imageListForType(record, imageType);
      const movedIndex = this.moveImageInList(list, reference.source_index, targetIndex);
      if (movedIndex < 0) {
        this.endAliImageDrag();
        return;
      }
      if (imageType === "gallery") {
        record.main_image_url = list.length ? String(list[0] || "") : "";
        const platform = String(record.platform) === "1688" ? "1688" : "temu";
        this.updateGallerySelection(record, platform, movedIndex);
      }
      this.endAliImageDrag();
      this.setStatus(imageType === "gallery" ? "已调整主图顺序。" : "已调整详情图顺序。", "success");
      this.saveProductModule(record, "images");
    },

    /** Append one unique image to a Temu product gallery. */
    appendTemuGalleryImage: function appendTemuGalleryImage(record, imageUrl, targetIndex) {
      if (!record || !imageUrl) {
        return false;
      }
      const list = this.imageListForType(record, "gallery");
      if (!list.length && record.main_image_url) {
        list.push(String(record.main_image_url));
      }
      const existingIndex = list.indexOf(imageUrl);
      if (existingIndex >= 0) {
        if (targetIndex !== undefined) {
          this.moveImageInList(list, existingIndex, targetIndex);
          record.main_image_url = list.length ? String(list[0] || "") : "";
        }
        return false;
      }
      let insertIndex = targetIndex === undefined ? list.length : Number(targetIndex);
      if (!Number.isInteger(insertIndex) || insertIndex < 0) {
        insertIndex = list.length;
      }
      if (insertIndex > list.length) {
        insertIndex = list.length;
      }
      list.splice(insertIndex, 0, imageUrl);
      if (targetIndex === undefined && !record.main_image_url) {
        record.main_image_url = imageUrl;
      } else if (targetIndex !== undefined) {
        record.main_image_url = list.length ? String(list[0] || "") : "";
      }
      return true;
    },

    /** Append one unique image to a Temu detail image list. */
    appendTemuDetailImage: function appendTemuDetailImage(record, imageUrl, targetIndex) {
      if (!record || !imageUrl) {
        return false;
      }
      const list = this.imageListForType(record, "detail");
      const existingIndex = list.indexOf(imageUrl);
      if (existingIndex >= 0) {
        if (targetIndex !== undefined) {
          this.moveImageInList(list, existingIndex, targetIndex);
        }
        return false;
      }
      let insertIndex = targetIndex === undefined ? list.length : Number(targetIndex);
      if (!Number.isInteger(insertIndex) || insertIndex < 0) {
        insertIndex = list.length;
      }
      if (insertIndex > list.length) {
        insertIndex = list.length;
      }
      list.splice(insertIndex, 0, imageUrl);
      return true;
    },

    /** Add a 1688 gallery image to Temu or reorder the Temu gallery. */
    dropAliImageToTemuGallery: function dropAliImageToTemuGallery(event, record, targetIndex) {
      event.preventDefault();
      event.stopPropagation();
      const reorder = this.imageReorderReference;
      if (reorder && reorder.record_key === this.imageRecordKey(record) && reorder.image_type === "gallery") {
        this.dropImageReorder(event, record, "gallery", targetIndex);
        return;
      }
      const reference = this.dragImageReference || this.readDraggedImageReference(event);
      const sourceType = reference ? String(reference.source_type || "") : "";
      const canAddToGallery = sourceType === "gallery" || sourceType === "sku";
      const imageUrl = canAddToGallery ? String(reference.image_url || "") : "";
      if (record && imageUrl) {
        const added = this.appendTemuGalleryImage(record, imageUrl, targetIndex);
        if (targetIndex === undefined) {
          record.main_image_url = imageUrl;
        }
        this.updateGallerySelection(record, "temu", record.gallery_image_urls.indexOf(imageUrl));
        this.setStatus(targetIndex === undefined
          ? (added ? "已将图片添加到 Temu 主图。" : "已将已有图片设为 Temu 主图。")
          : (added ? "已将图片插入 Temu 主图列表。" : "已调整 Temu 主图顺序。"), "success");
        this.saveProductModule(record, "images");
      }
      this.endAliImageDrag();
    },

    /** Add a 1688 detail image to Temu or reorder the Temu detail list. */
    dropAliImageToTemuDetail: function dropAliImageToTemuDetail(event, record, targetIndex) {
      event.preventDefault();
      event.stopPropagation();
      const reorder = this.imageReorderReference;
      if (reorder && reorder.record_key === this.imageRecordKey(record) && reorder.image_type === "detail") {
        this.dropImageReorder(event, record, "detail", targetIndex);
        return;
      }
      const reference = this.dragImageReference || this.readDraggedImageReference(event);
      const imageUrl = reference && String(reference.source_type || "") === "detail" ? String(reference.image_url || "") : "";
      if (record && imageUrl) {
        const added = this.appendTemuDetailImage(record, imageUrl, targetIndex);
        this.setStatus(targetIndex === undefined
          ? "已将 1688 详情图添加到 Temu 商品详情。"
          : (added ? "已将 1688 详情图插入 Temu 详情图列表。" : "已调整 Temu 详情图顺序。"), "success");
        this.saveProductModule(record, "images");
      }
      this.endAliImageDrag();
    },

    /** Replace one Temu SKU image with a dragged 1688 main or SKU image. */
    dropAliImageToTemuSku: function dropAliImageToTemuSku(event, record, targetSku, rowIndex) {
      event.preventDefault();
      event.stopPropagation();
      const reference = this.dragImageReference || this.readDraggedImageReference(event);
      const sourceType = reference ? String(reference.source_type || "") : "";
      const canReplaceSkuImage = sourceType === "gallery" || sourceType === "sku";
      const imageUrl = canReplaceSkuImage && reference.image_url ? String(reference.image_url) : "";
      if (targetSku && imageUrl) {
        targetSku.sku_image_urls = [imageUrl];
        targetSku.sku_image_url = imageUrl;
        this.setStatus("已用 1688 图片替换 Temu SKU #" + (Number(rowIndex) + 1) + " 的图片。", "success");
        this.saveProductModule(record, "skus");
      }
      this.endAliImageDrag();
    },

    /** Open one SKU image in the large preview overlay. */
    openImagePreview: function openImagePreview(image) {
      this.imagePreviewUrl = String(image || "").trim();
    },

    /** Close the large image preview overlay. */
    closeImagePreview: function closeImagePreview() {
      this.imagePreviewUrl = "";
    },

    /** Start dragging one 1688 SKU reference onto a Temu SKU. */
    startAliDrag: function startAliDrag(event, sku, index) {
      this.dragSkuReference = getSkuReference(this.selected1688Record, sku, index);
      this.dragImageReference = null;
      this.imageDropTarget = null;
      this.dragDropTarget = null;
      this.dragSkuReference.source_sku = {
        sku_id: sku && sku.sku_id ? sku.sku_id : "",
        SubSku1: sku && sku.SubSku1 ? sku.SubSku1 : "",
        SubSku2: sku && sku.SubSku2 ? sku.SubSku2 : "",
        sku_price: sku && sku.sku_price !== undefined ? sku.sku_price : "",
        sku_image_url: sku && sku.sku_image_url ? sku.sku_image_url : "",
        sku_image_urls: this.skuImageUrls(sku)
      };
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = "copy";
        event.dataTransfer.setData("application/x-temu-1688-sku", JSON.stringify(this.dragSkuReference));
        event.dataTransfer.setData("text/plain", "1688 SKU " + (index + 1));
      }
    },

    /** Start dragging one individual 1688 SubSku value onto a Temu target. */
    startAliSubSkuDrag: function startAliSubSkuDrag(event, sku, index, subSkuIndex) {
      const item = sku || {};
      const fieldName = subSkuIndex === 0 ? "SubSku1" : "SubSku2";
      const value = String(item[fieldName] || "").trim();
      if (!value) {
        return;
      }
      this.dragSkuReference = getSkuReference(this.selected1688Record, item, index);
      this.dragImageReference = null;
      this.imageDropTarget = null;
      this.dragSkuReference.drag_kind = "subsku";
      this.dragSkuReference.subsku_index = subSkuIndex;
      this.dragSkuReference.source_sku = {
        sku_id: item.sku_id || "",
        SubSku1: subSkuIndex === 0 ? value : "",
        SubSku2: subSkuIndex === 1 ? value : "",
        sku_price: item.sku_price === undefined ? "" : item.sku_price,
        sku_image_url: item.sku_image_url || "",
        sku_image_urls: this.skuImageUrls(item)
      };
      this.dragDropTarget = null;
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = "copy";
        event.dataTransfer.setData("application/x-temu-1688-sku", JSON.stringify(this.dragSkuReference));
        event.dataTransfer.setData("text/plain", value);
      }
    },

    /** Clear the active 1688 drag state after a completed or cancelled drag. */
    endAliDrag: function endAliDrag() {
      this.dragSkuReference = null;
      this.dragDropTarget = null;
      this.dragImageReference = null;
      this.imageDropTarget = null;
    },

    /** Block native text or JSON drops outside the dedicated SKU drop zone. */
    ignoreNativeDrop: function ignoreNativeDrop(event) {
      if (event) {
        event.preventDefault();
        event.stopPropagation();
      }
      this.dragSkuReference = null;
      this.dragDropTarget = null;
      this.dragImageReference = null;
      this.imageDropTarget = null;
    },

    /** Drop one 1688 SKU on a Temu specification group and merge it into all Temu rows. */
    dropAliSkuToTemuField: function dropAliSkuToTemuField(event, record, groupName) {
      event.preventDefault();
      const reference = this.dragSkuReference || this.readDraggedReference(event);
      if (!reference) {
        return;
      }
      const sourceSku = reference.source_sku || {};
      if (!sourceSku.sku_id && reference.platform_id === undefined) {
        this.dragSkuReference = null;
        return;
      }
      this.appendAliSkuToTemuField(record, groupName, sourceSku);
      this.saveProductModule(record, "skus");
      this.dragSkuReference = null;
      this.dragDropTarget = null;
    },

    /** Clone SKU rows for a runtime-only Cartesian product base without changing the source product. */
    cloneSkuRows: function cloneSkuRows(rows) {
      const sourceRows = asArray(rows);
      const result = [];
      for (let rowIndex = 0; rowIndex < sourceRows.length; rowIndex += 1) {
        const sourceRow = sourceRows[rowIndex] || {};
        const targetRow = {};
        for (const key in sourceRow) {
          if (Object.prototype.hasOwnProperty.call(sourceRow, key)) {
            targetRow[key] = Array.isArray(sourceRow[key]) ? sourceRow[key].slice() : sourceRow[key];
          }
        }
        if (!Array.isArray(targetRow.sku_image_urls)) {
          targetRow.sku_image_urls = this.skuImageUrls(sourceRow);
        }
        result.push(targetRow);
      }
      return result;
    },

    /** Build every Temu SKU and 1688 SKU pair as one combined SKU row. */
    buildCartesianSkuRows: function buildCartesianSkuRows(temuRows, aliRows) {
      const targetRows = asArray(temuRows);
      const sourceRows = asArray(aliRows);
      const result = [];
      for (let targetIndex = 0; targetIndex < targetRows.length; targetIndex += 1) {
        const targetSku = targetRows[targetIndex] || {};
        const targetSpec = parseSkuSpecValue(targetSku.SubSku1, "SubSku1");
        const targetImages = this.skuImageUrls(targetSku);
        for (let sourceIndex = 0; sourceIndex < sourceRows.length; sourceIndex += 1) {
          const sourceSku = sourceRows[sourceIndex] || {};
          const mergedSku = this.cloneSkuRows([targetSku])[0] || {};
          const sourceLabel = this.skuSpecDisplayLabel(sourceSku);
          let combinedValue = targetSpec.value;
          if (sourceLabel) {
            combinedValue = combinedValue ? combinedValue + " + " + sourceLabel : sourceLabel;
          }
          mergedSku.SubSku1 = targetSpec.name ? targetSpec.name + ":" + combinedValue : combinedValue;
          mergedSku.SubSku2 = targetSku.SubSku2 || "";
          mergedSku.sku_image_urls = targetImages.slice();
          for (let imageIndex = 0; imageIndex < this.skuImageUrls(sourceSku).length; imageIndex += 1) {
            this.appendSkuImage(mergedSku, this.skuImageUrls(sourceSku)[imageIndex]);
          }
          mergedSku.sku_image_url = mergedSku.sku_image_urls[0] || "";
          const sourcePrice = sourceSku.sku_price === undefined ? sourceSku.price : sourceSku.sku_price;
          const priceAdded = this.markAliSkuPriceMerged(mergedSku, sourceSku);
          if (priceAdded) {
            mergedSku.sku_price = addSkuPriceValues(targetSku.sku_price, sourcePrice);
          }
          result.push(mergedSku);
        }
      }
      return result;
    },

    /** Drop a 1688 SKU row on the Temu SKU panel and generate the full Cartesian product. */
    dropAliSkuCartesian: function dropAliSkuCartesian(event, record) {
      event.preventDefault();
      event.stopPropagation();
      const reference = this.dragSkuReference || this.readDraggedReference(event);
      const sourceRecord = this.selected1688Record;
      const sameSource = reference
        && sourceRecord
        && String(reference.main_id) === String(sourceRecord.main_id)
        && String(reference.platform_id) === String(sourceRecord.platform_id)
        && reference.source_sku;
      if (!sameSource || !record) {
        this.dragSkuReference = null;
        return;
      }
      const recordKey = [record.main_id, record.platform_id].join("|");
      if (!this.cartesianBaseRows[recordKey]) {
        this.cartesianBaseRows[recordKey] = this.cloneSkuRows(record.sku);
      }
      const baseRows = this.cartesianBaseRows[recordKey];
      const sourceRows = asArray(this.selected1688Record.sku);
      record.sku = this.buildCartesianSkuRows(baseRows, sourceRows);
      this.dragSkuReference = null;
      this.dragDropTarget = null;
      this.setStatus("已生成 " + baseRows.length + " × " + sourceRows.length + " 个 SKU 组合。", "success");
    },

    /** Start dragging one Temu SKU reference onto an 1688 SKU. */
    startTemuDrag: function startTemuDrag(event, sku, index) {
      this.dragSkuReference = getSkuReference(this.selectedTemuRecord, sku, index);
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = "copy";
        event.dataTransfer.setData("text/plain", JSON.stringify(this.dragSkuReference));
      }
    },

    /** Add an 1688 SKU to a Temu SKU mapping row. */
    dropAliOnTemu: function dropAliOnTemu(event, temuSku, temuIndex) {
      event.preventDefault();
      const aliReference = this.dragSkuReference || this.readDraggedReference(event);
      if (!aliReference) {
        return;
      }
      const temuReference = getSkuReference(this.selectedTemuRecord, temuSku, temuIndex);
      this.addMapping(temuReference, aliReference);
      this.dragSkuReference = null;
    },

    /** Add a Temu SKU to an 1688 SKU mapping row. */
    dropTemuOnAli: function dropTemuOnAli(event, aliSku, aliIndex) {
      event.preventDefault();
      const temuReference = this.dragSkuReference || this.readDraggedReference(event);
      if (!temuReference) {
        return;
      }
      const aliReference = getSkuReference(this.selected1688Record, aliSku, aliIndex);
      this.addMapping(temuReference, aliReference);
      this.dragSkuReference = null;
    },

    /** Read a dragged SKU reference from the browser transfer payload. */
    readDraggedReference: function readDraggedReference(event) {
      try {
        const transfer = event.dataTransfer;
        const value = transfer
          ? (transfer.getData("application/x-temu-1688-sku") || transfer.getData("text/plain"))
          : "";
        return value ? JSON.parse(value) : null;
      } catch (error) {
        return null;
      }
    },

    /** Read a dragged 1688 image reference from the browser transfer payload. */
    readDraggedImageReference: function readDraggedImageReference(event) {
      try {
        const transfer = event && event.dataTransfer;
        const value = transfer
          ? (transfer.getData("application/x-temu-1688-image") || transfer.getData("text/plain"))
          : "";
        const parsed = value ? JSON.parse(value) : null;
        return parsed && parsed.image_url ? parsed : null;
      } catch (error) {
        return null;
      }
    },

    /** Add one unique 1688 reference to an existing Temu mapping row. */
    addMapping: function addMapping(temuReference, aliReference) {
      const temuKey = [temuReference.main_id, temuReference.sku_id, temuReference.sku_index].join("|");
      const aliKey = [aliReference.main_id, aliReference.sku_id, aliReference.sku_index].join("|");
      let row = null;
      for (let rowIndex = 0; rowIndex < this.mappingRows.length; rowIndex += 1) {
        if (this.mappingRows[rowIndex].temu_key === temuKey) {
          row = this.mappingRows[rowIndex];
          break;
        }
      }
      if (!row) {
        row = { temu: temuReference, temu_key: temuKey, ali: [], ali_keys: [] };
        this.mappingRows.push(row);
      }
      if (row.ali_keys.indexOf(aliKey) < 0) {
        row.ali.push(aliReference);
        row.ali_keys.push(aliKey);
        this.setStatus("已建立 SKU 配对。", "success");
      }
    },

    /** Remove one 1688 reference from a Temu mapping row. */
    removeMapping: function removeMapping(row, aliIndex) {
      row.ali.splice(aliIndex, 1);
      row.ali_keys.splice(aliIndex, 1);
      if (!row.ali.length) {
        const index = this.mappingRows.indexOf(row);
        if (index >= 0) {
          this.mappingRows.splice(index, 1);
        }
      }
    },

    /** Return all mapping rows sorted by their source Temu identifiers. */
    sortedMappingRows: function sortedMappingRows() {
      const result = [];
      for (let index = 0; index < this.mappingRows.length; index += 1) {
        result.push(this.mappingRows[index]);
      }
      for (let leftIndex = 0; leftIndex < result.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < result.length; rightIndex += 1) {
          if (String(result[leftIndex].temu.main_id).localeCompare(String(result[rightIndex].temu.main_id)) > 0) {
            const item = result[leftIndex];
            result[leftIndex] = result[rightIndex];
            result[rightIndex] = item;
          }
        }
      }
      return result;
    },

    /** Request a streamed server download for the Temu-only 妙手 ZIP. */
    exportMiaoshouZip: async function exportMiaoshouZip() {
      if (this.miaoshouExportBusy || !this.temuRecords.length) {
        return;
      }
      this.miaoshouExportBusy = true;
      try {
        this.setStatus("正在同步当前页面缓存，随后生成妙手 ZIP。", "normal");
        for (let index = 0; index < this.temuRecords.length; index += 1) {
          await this.waitForProductSaveIdle(this.temuRecords[index]);
        }
        this.setStatus("服务器正在以当前缓存生成妙手 ZIP，完成后会自动下载。", "normal");
        window.location.href = apiUrl("/zip");
        const view = this;
        /** Release the ZIP export busy state after the browser starts the download. */
        function releaseMiaoshouExportBusy() {
          view.miaoshouExportBusy = false;
        }
        window.setTimeout(releaseMiaoshouExportBusy, 1500);
      } catch (error) {
        this.miaoshouExportBusy = false;
        this.setStatus("妙手导出前同步缓存失败：" + String(error && error.message || "未知错误。"), "error");
      }
    },

    /** Build and download a new identifier-only group mapping JSON file. */
    exportMappingJson: function exportMappingJson() {
      const mappings = [];
      for (let index = 0; index < this.mappingRows.length; index += 1) {
        mappings.push({ temu: this.mappingRows[index].temu, "1688": this.mappingRows[index].ali });
      }
      const payload = {
        version: "1.0",
        source_file: this.sourceFileName,
        created_at: formatCollectedAt(new Date()),
        mappings: mappings
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = "temu-1688-mapping-" + Date.now() + ".json";
      link.click();
      URL.revokeObjectURL(link.href);
      this.setStatus("组货 JSON 已生成。", "success");
    },

    /** Build and download the normalized records currently rendered by the workbench. */
    exportRenderedJson: function exportRenderedJson() {
      window.location.href = apiUrl("/exports/json");
      this.setStatus("已请求服务器导出当前 JSON。", "success");
    },

    /** Return a human-readable JSON field value for the detail view. */
    stringifyField: function stringifyField(value) {
      return displayValue(value);
    },

    /** Return the two normalized SKU specification groups for one product. */
    skuSpecGroups: function skuSpecGroups(record) {
      const item = record || {};
      const recordKey = [item.main_id, item.platform_id].join("|");
      const baseRows = this.cartesianBaseRows[recordKey];
      if (Array.isArray(baseRows)) {
        return collectSkuSpecGroups({ sku: baseRows });
      }
      return collectSkuSpecGroups(item);
    },

    /** Return only the actual value for one SKU specification column. */
    skuSpecValue: function skuSpecValue(sku, index) {
      const item = sku || {};
      const rawValue = index === 0 ? item.SubSku1 : item.SubSku2;
      const parsed = parseSkuSpecValue(rawValue, "SubSku" + (index + 1));
      return parsed.value;
    },

    /** Return the SKU value shown in a compact table cell. */
    skuValue: function skuValue(sku, index) {
      const item = sku || {};
      return item.SubSku1 || item.SubSku2 || item.sku_id || "SKU " + (index + 1);
    },

    /** Expose the stable SKU key to the Vue template. */
    getSkuKey: function getSkuKey(record, sku, index) {
      return buildSkuKey(record, sku, index);
    }
  }
});

app.component("task-status-indicator", TaskStatusIndicator);
app.mount("#app");
