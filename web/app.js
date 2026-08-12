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

/** Reusable running/completed task indicator shared by image and SKU workflows. */
const TaskStatusIndicator = {
  props: {
    tone: { type: String, default: "green" },
    complete: { type: Boolean, default: false },
    label: { type: String, default: "打开任务" }
  },
  emits: ["activate"],
  template: `<span class="task-status-indicator" :class="['is-' + tone, { 'is-complete': complete }]" role="button" tabindex="0" :title="label" :aria-label="label" @click.stop="$emit('activate')" @keydown.enter.stop="$emit('activate')">{{ complete ? '✓' : '' }}</span>`
};

const app = createApp({
  template: `
    <div class="shell">
      <header class="topbar">
        <div class="toolbar">
          <button class="mode-button" :class="{ active: workspaceMode === 'smart' }" type="button" @click="changeWorkspaceMode('smart')">组货模式</button>
          <button class="mode-button" :class="{ active: workspaceMode === 'realtime' }" type="button" @click="changeWorkspaceMode('realtime')">工作台</button>
          <button class="mode-button" type="button" :disabled="!temuRecords.length || miaoshouExportBusy" @click="exportMiaoshouZip">{{ miaoshouExportBusy ? '妙手导出中…' : '导出妙手 ZIP' }}</button>
          <label class="mode-button restore-button">
            备份恢复
            <input type="file" accept="application/json,.json" @change="handleRestoreFile">
          </label>
        </div>
      </header>

      <main class="content">
        <div v-if="!records.length" class="panel empty">{{ renderMode === 'realtime' ? '等待扩展采集商品并写入本地 cache。' : '请先导入统一 JSON 文件。' }}</div>
        <div v-else class="render-layout">
          <aside class="panel listing-rail">
            <div class="listing-rail-heading"><div class="listing-cache-actions"><button type="button" @click="clearEntireCache">清空</button></div></div>
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
              <span v-if="hasOpenableImageTask(record) || hasSkuBlendTask(record) || hasCompletedSkuBlendTask(record)" class="task-status-indicators listing-task-status-indicators"><task-status-indicator v-if="hasOpenableImageTask(record)" tone="green" :complete="isImageTaskComplete(record)" label="打开图片任务" @activate="openRetainedImageEditor(record)"></task-status-indicator><task-status-indicator v-if="hasSkuBlendTask(record) || hasCompletedSkuBlendTask(record)" tone="yellow" :complete="hasCompletedSkuBlendTask(record)" label="打开 SKU 溶图任务" @activate="openSkuBlendTask(record)"></task-status-indicator></span>
            </button>
            <div v-if="!temuRecords.length" class="muted">暂无 Temu 商品。</div>
          </aside>

          <section v-if="selectedTemuRecord" class="panel platform-render temu-render">
            <div class="render-heading"><div><span class="platform-label temu-label">Temu</span><span v-if="hasOpenableImageTask(selectedTemuRecord) || hasSkuBlendTask(selectedTemuRecord) || hasCompletedSkuBlendTask(selectedTemuRecord)" class="task-status-indicators heading-task-status-indicators"><task-status-indicator v-if="hasOpenableImageTask(selectedTemuRecord)" tone="green" :complete="isImageTaskComplete(selectedTemuRecord)" label="打开图片任务" @activate="openRetainedImageEditor(selectedTemuRecord)"></task-status-indicator><task-status-indicator v-if="hasSkuBlendTask(selectedTemuRecord) || hasCompletedSkuBlendTask(selectedTemuRecord)" tone="yellow" :complete="hasCompletedSkuBlendTask(selectedTemuRecord)" label="打开 SKU 溶图任务" @activate="openSkuBlendTask(selectedTemuRecord)"></task-status-indicator></span><div class="render-title-row"><input class="render-title-input" type="text" v-model="selectedTemuRecord.product_name" @change="saveProductModule(selectedTemuRecord, 'basic')" aria-label="Temu 商品名称"><button v-if="workspaceMode === 'realtime'" class="listing-merge-button" type="button" :disabled="listingMergeBusy || !selected1688Record" @click="mergeSelectedListings">{{ listingMergeBusy ? '生成中…' : 'AI Listing' }}</button><button v-if="workspaceMode === 'smart'" class="workflow-direction-button" type="button" :disabled="workflowPromptBusy || !workflowSelectedImageUrl" @click="generateWorkflowPrompts">{{ workflowPromptBusy ? 'Kimi 分析中…' : selectedWorkflowTask && selectedWorkflowTask.prompts && selectedWorkflowTask.prompts.length ? '重新生成 4 个组货方向' : '生成 4 个组货方向' }}</button><button v-if="hasListingUndo(selectedTemuRecord)" class="operation-undo-button" type="button" :disabled="listingUndoBusy" @click="undoSelectedListing">{{ listingUndoBusy ? '返回中…' : '返回' }}</button><button v-if="hasCarouselUndo(selectedTemuRecord)" class="operation-undo-button" type="button" @click="undoCarouselReplacement(selectedTemuRecord)">恢复轮播替换</button></div><input class="render-category-input" type="text" v-model="selectedTemuRecord.product_category" @change="saveProductModule(selectedTemuRecord, 'basic')" placeholder="未提供商品分类" aria-label="Temu 商品分类"></div></div>
            <div class="render-gallery">
               <div class="gallery-thumbs" @dragenter.prevent.stop="setImageInteractionTarget('temu-gallery')" @dragover.prevent.stop="setImageInteractionTarget('temu-gallery')" @drop.prevent.stop="dropAliImageToTemuGallery($event, selectedTemuRecord)">
                <div v-for="(image, imageIndex) in galleryImages(selectedTemuRecord)" :key="image" class="thumb-item" draggable="true" :class="{ 'is-image-reorder-target': isImageReorderTarget('temu-gallery', imageIndex), 'is-ai-selected': isTemuGalleryEditSelected(selectedTemuRecord, imageIndex) }" @dragstart.stop="startImageReorder($event, selectedTemuRecord, 'gallery', imageIndex)" @dragend="endImageReorder" @dragenter.prevent.stop="setImageInteractionTarget('temu-gallery', imageIndex)" @dragover.prevent.stop="setImageInteractionTarget('temu-gallery', imageIndex)" @drop.prevent.stop="dropAliImageToTemuGallery($event, selectedTemuRecord, imageIndex)">
                  <button class="thumb" :class="{ active: selectedTemuGalleryIndex === imageIndex }" type="button" draggable="true" title="双击打开 Edits" @dragstart.stop="startImageReorder($event, selectedTemuRecord, 'gallery', imageIndex)" @dragend="endImageReorder" @click="handleTemuGallerySelection($event, selectedTemuRecord, imageIndex)" @dblclick.stop="openSingleGalleryImageEditor(selectedTemuRecord, imageIndex)"><img :src="imageSource(image)" referrerpolicy="no-referrer" alt="Temu 商品图片" draggable="false"><span v-if="isTemuGalleryEditSelected(selectedTemuRecord, imageIndex)" class="gallery-ai-check">✓</span></button>
                  <button class="image-delete-button" type="button" aria-label="删除图片" @click.stop="removeGalleryImage(selectedTemuRecord, imageIndex, 'temu')">×</button>
                </div>
                <button v-if="galleryEditSelection.length === 2" class="gallery-ai-edit-button" type="button" @click.stop="openGalleryImageEditor(selectedTemuRecord)">AI 编辑 2 张</button>
                <label class="image-upload-button">+ 上传<input type="file" accept="image/*" multiple @change="handleGalleryUpload($event, selectedTemuRecord, 'temu')"></label>
              </div>
               <div class="gallery-main" :class="{ 'is-image-reorder-target': isImageReorderTarget('temu-gallery', 0) }" @dragenter.prevent.stop="setImageInteractionTarget('temu-gallery', 0)" @dragover.prevent.stop="setImageInteractionTarget('temu-gallery', 0)" @drop.prevent.stop="dropAliImageToTemuGallery($event, selectedTemuRecord, 0)"><img v-if="currentImage(selectedTemuRecord, 'temu')" :key="currentImage(selectedTemuRecord, 'temu')" :src="imageSource(currentImage(selectedTemuRecord, 'temu'))" referrerpolicy="no-referrer" alt="Temu 主图" draggable="true" title="双击打开 Edits" @dragstart.stop="startImageReorder($event, selectedTemuRecord, 'gallery', selectedTemuGalleryIndex)" @dragend="endImageReorder" @dblclick.stop="openSingleGalleryImageEditor(selectedTemuRecord, selectedTemuGalleryIndex)"><span v-else class="muted">暂无图片</span><button v-if="currentImage(selectedTemuRecord, 'temu')" class="gallery-image-search-button" type="button" :disabled="imageSearchBusy" title="用当前图片搜索 1688" aria-label="用当前图片搜索 1688" @click.stop="searchTemuImageOn1688(selectedTemuRecord, currentImage(selectedTemuRecord, 'temu'))"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.2"></circle><path d="m16 16 5 5"></path></svg></button></div>
            </div>
            <div class="facts compact-facts"><div class="fact wide"><label>分类 ID（逗号分隔）</label><input class="fact-edit-input" type="text" :value="stringifyField(selectedTemuRecord.category_ids)" @input="updateCategoryIds(selectedTemuRecord, $event.target.value)" @change="saveProductModule(selectedTemuRecord, 'basic')" aria-label="Temu 分类 ID"></div></div>
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
                 <table class="sku-table sku-spec-table"><thead><tr><th>#</th><th>预览图</th><th v-for="group in skuSpecGroups(selectedTemuRecord)" :key="group.name" :class="{ 'is-drop-target': isAliDropTarget('group', group.name) }" @dragenter.prevent.stop="setAliDropTarget('group', group.name)" @dragover.prevent.stop="setAliDropTarget('group', group.name)" @drop.prevent.stop="dropAliSkuToTemuGroup($event, selectedTemuRecord, group.name)">{{ group.name }}</th><th>价格</th><th>库存</th><th class="sku-dimensions-column">长宽高</th></tr></thead><tbody>
                 <tr v-for="(sku, skuIndex) in selectedTemuRecord.sku" :key="getSkuKey(selectedTemuRecord, sku, skuIndex)">
                   <td>{{ skuIndex + 1 }}</td>
                  <td class="sku-image-cell" :class="{ 'is-image-drop-target': isImageDropTarget('temu-sku', skuIndex) }" @dragenter.prevent.stop="setImageDropTarget('temu-sku', skuIndex)" @dragover.prevent.stop="setImageDropTarget('temu-sku', skuIndex)" @drop.prevent.stop="dropAliImageToTemuSku($event, selectedTemuRecord, sku, skuIndex)"><div class="sku-images-editor"><div v-for="(image, imageIndex) in skuImageUrls(sku)" :key="imageIndex" class="sku-image-item"><img :src="imageSource(image)" referrerpolicy="no-referrer" alt="SKU 图片" @click.stop="openImagePreview(image)"><button class="image-delete-button" type="button" aria-label="删除 SKU 图片" @click="removeSkuImageAt(selectedTemuRecord, sku, imageIndex)">×</button></div><label v-if="!skuImageUrls(sku).length" class="sku-image-empty-upload" title="上传 SKU 图片">+<input type="file" accept="image/*" @change.stop="handleSkuImageUpload($event, selectedTemuRecord, sku)"></label><div v-if="skuImageUrls(sku).length === 2 || hasSkuFusionUndo(selectedTemuRecord, sku, skuIndex)" class="sku-image-actions"><button v-if="skuImageUrls(sku).length === 2" class="sku-blend-button" type="button" :disabled="isSkuBlendBusy(selectedTemuRecord, sku, skuIndex)" title="将当前 SKU 的两张图片发送到 BeeAPI 并替换为返回图片" @click.stop="blendSkuImages(selectedTemuRecord, sku, skuIndex)">{{ isSkuBlendBusy(selectedTemuRecord, sku, skuIndex) ? '生成中…' : '溶图' }}</button><button v-if="hasSkuFusionUndo(selectedTemuRecord, sku, skuIndex)" class="sku-fusion-undo-button" type="button" :disabled="isSkuFusionUndoBusy(selectedTemuRecord, sku, skuIndex)" @click.stop="undoSkuImageFusion(selectedTemuRecord, sku, skuIndex)">{{ isSkuFusionUndoBusy(selectedTemuRecord, sku, skuIndex) ? '恢复中…' : '恢复原图' }}</button></div></div></td>
                    <td v-for="(group, groupIndex) in skuSpecGroups(selectedTemuRecord)" :key="group.name" class="sku-spec-cell" :class="{ 'is-drop-target': isTemuSkuCellDropTarget(skuIndex, group.name) }" @dragenter.prevent.stop="setTemuSkuCellDropTarget(skuIndex, group.name)" @dragover.prevent.stop="setTemuSkuCellDropTarget(skuIndex, group.name)" @drop.prevent.stop="dropAliSkuToTemuSkuCell($event, selectedTemuRecord, sku, skuIndex, group.name)"><input class="sku-edit-input" type="text" :value="skuSpecValue(sku, groupIndex)" @input="updateSkuSpecValue(sku, groupIndex, $event.target.value)" :aria-label="group.name"></td>
                    <td><input class="sku-edit-input" type="text" inputmode="decimal" v-model="sku.sku_price" aria-label="SKU 价格"></td><td><input class="sku-edit-input" type="text" inputmode="numeric" v-model="sku.sku_stock" aria-label="SKU 库存"></td><td class="sku-dimensions-cell"><div class="sku-dimension-bubbles" aria-label="SKU 尺寸"><input class="sku-edit-input sku-dimension-input" type="text" inputmode="decimal" v-model="sku.sku_length" aria-label="SKU 长度"><span class="sku-dimension-separator">:</span><input class="sku-edit-input sku-dimension-input" type="text" inputmode="decimal" v-model="sku.sku_width" aria-label="SKU 宽度"><span class="sku-dimension-separator">:</span><input class="sku-edit-input sku-dimension-input" type="text" inputmode="decimal" v-model="sku.sku_height" aria-label="SKU 高度"></div></td>
                 </tr>
                  <tr v-if="!selectedTemuRecord.sku.length"><td :colspan="skuSpecGroups(selectedTemuRecord).length + 5" class="empty">暂无 SKU 数据</td></tr>
               </tbody></table>
             </div>
               <div class="detail-section" @dragenter.prevent.stop="setImageInteractionTarget('temu-detail')" @dragover.prevent.stop="setImageInteractionTarget('temu-detail')" @drop.prevent.stop="dropAliImageToTemuDetail($event, selectedTemuRecord)"><h3>商品详情</h3><div v-if="selectedTemuRecord.detail_image_urls.length" class="detail-images"><div v-for="(image, detailIndex) in selectedTemuRecord.detail_image_urls" :key="image" class="detail-image-editor" draggable="true" title="双击打开 Edits" :class="{ 'is-image-reorder-target': isImageReorderTarget('temu-detail', detailIndex) }" @dragstart.stop="startImageReorder($event, selectedTemuRecord, 'detail', detailIndex)" @dragend="endImageReorder" @dragenter.prevent.stop="setImageInteractionTarget('temu-detail', detailIndex)" @dragover.prevent.stop="setImageInteractionTarget('temu-detail', detailIndex)" @drop.prevent.stop="dropAliImageToTemuDetail($event, selectedTemuRecord, detailIndex)" @dblclick.stop="openDetailImageEditor(selectedTemuRecord, image, detailIndex)"><img :src="imageSource(image)" referrerpolicy="no-referrer" alt="Temu 商品详情图" draggable="false"><button class="image-delete-button" type="button" aria-label="删除详情图" @click="removeDetailImage(selectedTemuRecord, detailIndex)">×</button></div></div><div v-else class="detail-empty-upload"><label class="detail-empty-upload-button" title="上传详情图">+<input type="file" accept="image/*" multiple @change="handleDetailUpload($event, selectedTemuRecord)"></label><span>暂无详情图，请上传图片。</span></div></div>
          </section>
          <section v-else class="panel platform-render empty">请选择 Temu 商品。</section>

          <section v-if="workspaceMode === 'smart'" class="panel platform-render smart-workflow-render">
            <div class="smart-workflow-heading">
              <div><span class="platform-label ali-label">智能组货</span><h2>Temu 选品 · 1688 搜款</h2><p>在当前页面完成分析、生图和搜款准备。</p></div>
            </div>
            <section v-if="workflowPrompts.length" class="smart-workflow-step">
              <header><span>01</span><div><strong>组货建议</strong><small>下面的生图提示词可以直接修改，多个候选图可以同时搜图。</small></div></header>
              <div class="smart-workflow-actions"><button class="smart-primary-action" type="button" :disabled="!selectedTemuRecord" @click="generateWorkflowImages()">{{ workflowGenerateBusy ? '提交中…' : workflowHasGeneratedImages ? '全部重新生成' : '一次生成 4 张白底图' }}</button></div>
              <div class="smart-result-grid">
                <article v-for="(item, index) in workflowPrompts" :key="'smart-result-' + index" class="smart-result-card" :class="{ selected: workflowSelectedResultIndex === index }">
                  <div class="smart-result-image-wrap"><button class="smart-result-image" type="button" :disabled="!item.image_url" @click="selectWorkflowResult(index)"><img v-if="item.image_url" :src="imageSource(item.image_url)" alt="AI 组货候选图"><span v-else>{{ item.status === 'generating' || item.status === 'queued' ? '后台生成中…' : item.status === 'error' ? workflowPromptErrorText(item) : item.error || '等待生成' }}</span><i v-if="workflowSelectedResultIndex === index">已选择</i></button><button v-if="item.image_url" class="smart-result-search-button" :class="{ 'is-busy': workflowSearchBusyKeys[index] }" type="button" :disabled="workflowSearchBusyKeys[index] || item.status === 'generating' || item.status === 'queued'" title="用这张生成图搜索 1688" :aria-label="workflowSearchBusyKeys[index] ? '1688 搜图中' : '用这张生成图搜索 1688'" @click.stop="searchWorkflow1688(index)"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.2"></circle><path d="m16 16 5 5"></path></svg></button></div>
                  <div class="smart-result-copy"><strong>{{ item.relation }}</strong><span>{{ item.product_intro }}</span></div>
                  <label class="smart-result-prompt"><span>生图提示词</span><textarea v-model="item.prompt" rows="4" @input="markWorkflowPromptDraft(index, $event.target.value)" :aria-label="item.relation + '生图提示词'"></textarea></label>
                  <div class="smart-result-actions"><button class="smart-secondary-action" type="button" :disabled="!selectedTemuRecord" @click="generateWorkflowImages(index)"><span aria-hidden="true">↻</span> 重新生成</button></div>
                </article>
              </div>
              <div v-if="selectedWorkflowTask && selectedWorkflowTask.search_url" class="smart-search-ready"><span>搜款页已生成，进入满意商品详情后选择 Temu，并点击扩展确认绑定。</span><a :href="selectedWorkflowTask.search_url" target="_blank">重新打开搜款页</a></div>
            </section>
            <div v-if="!selectedTemuRecord" class="smart-workflow-empty">请先从左侧选择 Temu 商品。</div>
          </section>

          <section v-if="workspaceMode === 'realtime' && selected1688Record" class="panel platform-render ali-render">
            <div class="render-heading"><div><span class="platform-label ali-label">1688</span><input class="render-title-input" type="text" v-model="selected1688Record.product_name" @change="saveProductModule(selected1688Record, 'basic')" aria-label="1688 商品名称"><input class="render-category-input" type="text" v-model="selected1688Record.product_category" @change="saveProductModule(selected1688Record, 'basic')" placeholder="未提供商品分类" aria-label="1688 商品分类"></div></div>
             <div class="render-gallery"><div class="gallery-thumbs"><div v-for="(image, imageIndex) in galleryImages(selected1688Record)" :key="image" class="thumb-item"><button class="thumb" :class="{ active: selected1688GalleryIndex === imageIndex }" type="button" draggable="true" @dragstart.stop="startAliImageDrag($event, selected1688Record, image, 'gallery', imageIndex)" @dragend="endAliImageDrag" @click="selectGallery(imageIndex, '1688')"><img :src="imageSource(image)" referrerpolicy="no-referrer" alt="1688 商品图片" draggable="false"></button></div></div><div class="gallery-main"><img v-if="currentImage(selected1688Record, '1688')" :key="currentImage(selected1688Record, '1688')" :src="imageSource(currentImage(selected1688Record, '1688'))" referrerpolicy="no-referrer" alt="1688 主图" draggable="true" @dragstart.stop="startAliImageDrag($event, selected1688Record, currentImage(selected1688Record, '1688'), 'gallery', selected1688GalleryIndex)" @dragend="endAliImageDrag"><span v-else class="muted">暂无图片</span></div></div>
            <div class="facts compact-facts"><div class="fact wide"><label>分类 ID（逗号分隔）</label><input class="fact-edit-input" type="text" :value="stringifyField(selected1688Record.category_ids)" @input="updateCategoryIds(selected1688Record, $event.target.value)" aria-label="1688 分类 ID"></div></div>
             <div class="sku-panel sku-spec-panel" @change="saveProductModule(selected1688Record, 'skus')" @dragover.prevent @drop.prevent="ignoreNativeDrop">
               <div class="ali-sku-toolbar">
                 <div class="ali-sku-toolbar-heading"><div class="sku-list-title">SKU列表 <span class="ali-sku-count">{{ selected1688Record.sku.length }}</span></div><div class="sku-price-conversion"><strong>{{ selected1688Record.price_conversion_label }}</strong><span>价格统一按人民币显示</span></div></div>
                 <div class="sku-source-hint"><span class="sku-drag-handle hint-handle">⠿</span><span><strong>拖拽组货</strong> 可拖整行或单个 SubSku 到左侧规格组、选项或具体 SKU；规格值会追加，价格自动相加。</span></div>
               </div>
               <table class="sku-table sku-spec-table"><thead><tr><th>#</th><th>预览图</th><th>{{ aliSubSkuHeader(selected1688Record, 0) }}</th><th>{{ aliSubSkuHeader(selected1688Record, 1) }}</th><th>价格</th><th>库存</th></tr></thead><tbody>
                 <tr v-for="(sku, skuIndex) in selected1688Record.sku" :key="getSkuKey(selected1688Record, sku, skuIndex)" class="sku-source-row" :class="{ 'is-dragging-source': dragSkuReference && String(dragSkuReference.main_id) === String(selected1688Record.main_id) && String(dragSkuReference.sku_index) === String(skuIndex) }">
                   <td class="sku-index-cell"><button class="sku-drag-handle" type="button" draggable="true" title="拖动整行到左侧" aria-label="拖动 1688 SKU" @dragstart.stop="startAliDrag($event, sku, skuIndex)" @dragend="endAliDrag">⠿</button><span>{{ skuIndex + 1 }}</span></td>
                      <td><div class="sku-images-editor"><div v-for="(image, imageIndex) in skuImageUrls(sku)" :key="imageIndex" class="sku-image-item"><img :src="imageSource(image)" referrerpolicy="no-referrer" alt="SKU 图片" draggable="true" @dragstart.stop="startAliImageDrag($event, selected1688Record, image, 'sku', skuIndex)" @dragend="endAliImageDrag" @click.stop="openImagePreview(image)"><button class="image-delete-button" type="button" aria-label="删除 SKU 图片" @click="removeSkuImageAt(selected1688Record, sku, imageIndex)">×</button></div><label v-if="!skuImageUrls(sku).length" class="sku-image-empty-upload" title="上传 SKU 图片">+<input type="file" accept="image/*" @change.stop="handleSkuImageUpload($event, selected1688Record, sku)"></label></div></td>
                   <td><div class="subsku-editor"><input class="sku-edit-input subsku-value-input" type="text" draggable="true" :class="{ 'is-dragging-subsku': dragSkuReference && String(dragSkuReference.main_id) === String(selected1688Record.main_id) && String(dragSkuReference.sku_index) === String(skuIndex) && dragSkuReference.subsku_index === 0 }" :value="aliSubSkuValue(sku, 0)" :title="'拖动 ' + aliSubSkuHeader(selected1688Record, 0)" :aria-label="'1688 ' + aliSubSkuHeader(selected1688Record, 0)" @dragstart.stop="startAliSubSkuDrag($event, sku, skuIndex, 0)" @dragend="endAliDrag" @input="updateAliSubSkuValue(sku, 0, $event.target.value)"></div></td><td><div class="subsku-editor"><input class="sku-edit-input subsku-value-input" type="text" draggable="true" :disabled="!sku.SubSku2" :class="{ 'is-dragging-subsku': dragSkuReference && String(dragSkuReference.main_id) === String(selected1688Record.main_id) && String(dragSkuReference.sku_index) === String(skuIndex) && dragSkuReference.subsku_index === 1 }" :value="aliSubSkuValue(sku, 1)" :title="'拖动 ' + aliSubSkuHeader(selected1688Record, 1)" :aria-label="'1688 ' + aliSubSkuHeader(selected1688Record, 1)" @dragstart.stop="startAliSubSkuDrag($event, sku, skuIndex, 1)" @dragend="endAliDrag" @input="updateAliSubSkuValue(sku, 1, $event.target.value)"></div></td><td><input class="sku-edit-input" type="text" inputmode="decimal" v-model="sku.sku_price" aria-label="SKU 价格"></td><td><input class="sku-edit-input" type="text" inputmode="numeric" v-model="sku.sku_stock" aria-label="SKU 库存"></td>
                 </tr>
                 <tr v-if="!selected1688Record.sku.length"><td colspan="6" class="empty">暂无 SKU 数据</td></tr>
               </tbody></table>
             </div>
               <div class="detail-section"><h3>商品详情</h3><div v-if="selected1688Record.detail_image_urls.length" class="detail-images"><div v-for="(image, detailIndex) in selected1688Record.detail_image_urls" :key="image" class="detail-image-editor" draggable="true" @dragstart.stop="startAliImageDrag($event, selected1688Record, image, 'detail', detailIndex)" @dragend="endAliImageDrag"><img :src="imageSource(image)" referrerpolicy="no-referrer" alt="1688 商品详情图"></div></div><div v-else class="detail-empty-upload"><span>暂无详情图。</span></div></div>
          </section>
          <section v-else-if="workspaceMode === 'realtime'" class="panel platform-render empty">请选择 1688 商品。</section>
        </div>
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
            <header class="image-editor-header"><div><strong>{{ galleryEditSelection.length === 2 && imageCarouselCount > 1 ? '轮播修改模式' : galleryEditSelection.length === 2 ? '双图溶图' : '单图编辑' }}</strong><span>{{ galleryEditSelection.length === 2 && imageCarouselCount > 1 ? 'Kimi + Fusion API' : galleryEditSelection.length === 2 ? 'Fusion API' : 'Edits API' }}</span></div><button type="button" aria-label="关闭 AI 图片编辑" @click="closeGalleryImageEditor">×</button></header>
            <div class="image-editor-stage" :class="{ 'has-two-sources': galleryImageEditorSources(selectedTemuRecord).length === 2, 'has-result': imageEditorGeneratedUrl || imageCarouselTask }">
              <span class="image-editor-stage-label">{{ imageCarouselTask && imageCarouselTask.status === 'planning' ? '轮播规划中' : imageEditorBusy ? '处理中' : imageCarouselTask ? '轮播预览' : imageEditorGeneratedUrl ? '生成结果' : galleryImageEditorSources(selectedTemuRecord).length === 2 ? '待溶图片' : '待编辑图片' }}</span>
              <div v-if="imageEditorBusy || (imageCarouselTask && imageCarouselTask.status === 'planning')" class="image-editor-loading"><span></span><strong>{{ imageCarouselCount > 1 ? 'Kimi 推理规划中…' : '图片生成中…' }}</strong><small v-if="imageCarouselCount > 1">已输出约 {{ imageCarouselEstimatedTokens }} tokens，页面没有卡住。</small><small v-else>完成后可确认替换当前图片。</small></div>
              <div v-else-if="imageCarouselTask && imageCarouselTask.pages && imageCarouselTask.pages.length" class="carousel-slide-viewer">
                <button class="carousel-slide-arrow previous" type="button" :disabled="imageCarouselPageIndex <= 0" aria-label="上一张轮播图" @click="changeCarouselPage(-1)">‹</button>
                <article class="carousel-result-card">
                  <img v-if="currentCarouselPage().image_url" :src="imageSource(currentCarouselPage().image_url)" :alt="'轮播图 ' + (imageCarouselPageIndex + 1)">
                  <div v-else class="carousel-result-placeholder"><span>{{ currentCarouselPage().status === 'generating' ? '生成中…' : currentCarouselPage().status === 'failed' ? '[' + currentCarouselPage().error_code + '] ' + currentCarouselPage().error : '等待生成' }}</span><button v-if="currentCarouselPage().status === 'failed'" type="button" @click="retryCarouselPage(imageCarouselPageIndex)">重试</button></div>
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
              <span class="carousel-mode-note">n &gt; 1 时为第二种模式</span>
            </div>
            <label v-if="!imageCarouselTask" class="image-editor-prompt"><span>提示词</span><textarea v-model="imageEditorPrompt" rows="4" aria-label="图片编辑提示词"></textarea></label>
            <div v-if="imageCarouselTask && imageCarouselTask.pages && imageCarouselTask.pages.length" class="carousel-page-editor">
              <label class="image-editor-prompt"><span>分镜 {{ imageCarouselPageIndex + 1 }} / {{ imageCarouselTask.pages.length }}</span><input type="text" v-model="currentCarouselPage().purpose" :readonly="imageCarouselTask.status !== 'awaiting_review'" placeholder="页面用途（中文）"></label>
              <label class="image-editor-prompt"><span>提示词</span><textarea v-model="currentCarouselPage().prompt" :readonly="imageCarouselTask.status !== 'awaiting_review'" rows="4" placeholder="完整生图提示词（中文）"></textarea></label>
              <div v-if="imageCarouselTask.status === 'awaiting_review'" class="carousel-page-actions"><button type="button" @click="removeCarouselPage(imageCarouselPageIndex)">删除当前分镜</button><button v-if="imageCarouselTask.pages.length < 10" type="button" @click="addCarouselPage">+ 添加分镜</button></div>
            </div>
            <div v-if="imageEditorError" class="image-editor-error">{{ imageEditorError }}</div>
            <footer class="image-editor-actions"><button v-if="imageCarouselSourceMismatch" class="image-editor-cancel" type="button" @click="replaceExistingCarouselTask">放弃旧任务并使用当前图片</button><button v-else-if="imageCarouselTask" class="image-editor-cancel" type="button" @click="abandonCarouselTask">放弃轮播任务</button><button class="image-editor-cancel" type="button" @click="closeGalleryImageEditor">关闭</button><button class="image-editor-generate" type="button" :disabled="imageEditorBusy || imageCarouselGenerationBusy || !imageEditorPrompt.trim()" @click="submitGalleryImageEdit">{{ imageEditorBusy ? '规划中…' : imageCarouselTask && imageCarouselTask.status === 'awaiting_review' ? '确认分镜并生成' : imageCarouselGenerationBusy ? '生成中…' : imageEditorGeneratedUrl || imageCarouselTask ? '重新生成' : '开始生成' }}</button><button v-if="imageCarouselTask && imageCarouselTask.status === 'generated' && isImageTaskComplete(selectedTemuRecord)" class="image-editor-main-apply" type="button" :disabled="imageCarouselGenerationBusy" title="使用全部成功分镜替换所有主图" @click="confirmCarouselReplacement(true)">替换所有主图</button><button class="image-editor-confirm" type="button" :disabled="imageEditorBusy || imageCarouselGenerationBusy || (imageCarouselTask ? successfulCarouselPageCount() < 1 : !imageEditorGeneratedUrl)" @click="confirmGalleryImageEdit">确认替换</button></footer>
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
      imageEditorRequestId: 0,
      imageEditorBackdropPressed: false,
      imageCarouselCount: 1,
      imageCarouselMarketLanguage: "美国 / English",
      imageCarouselTask: null,
      imageCarouselTasksByMainId: {},
      imageCarouselPageIndex: 0,
      imageCarouselGenerationBusy: false,
      imageCarouselEstimatedTokens: 0,
      imageCarouselSourceMismatch: false,
      imageCarouselPollTimer: null,
      imageSearchBusy: false,
      specOptionDrafts: {},
      newSpecGroupName: "",
      detailImageRequests: {},
      imageEditSize: "1k",
      imageEditPrices: {},
      imageEditModel: "",
      imageEditBusyKeys: {},
      imageFusionUndoBusyKeys: {},
      imageFusionUndoTokens: {},
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
      workflowGenerateBusy: false,
      workflowSearchBusyKeys: {},
      workflowStatusText: "等待选择 Temu 商品。",
      workflowStatusType: "normal",
      pendingCacheEvents: {},
      productSaveStates: {},
      miaoshouExportBusy: false
    };
  },
  /** Start cache subscription after the Vue view is mounted. */
  mounted: function mountedApp() {
    window.addEventListener("dragend", this.clearImageDragState, true);
    window.addEventListener("drop", this.clearImageDragState);
    window.addEventListener("blur", this.clearImageDragState);
    this.loadImageEditConfig();
    this.loadWorkflowPayload();
    if (this.renderMode === "realtime") {
      this.startRealtimeCache();
    }
  },
  /** Close the cache subscription before the Vue view is destroyed. */
  beforeUnmount: function cleanupRealtimeCache() {
    window.removeEventListener("dragend", this.clearImageDragState, true);
    window.removeEventListener("drop", this.clearImageDragState);
    window.removeEventListener("blur", this.clearImageDragState);
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
    /** Persist the current workspace and product selection for the next browser refresh. */
    persistViewState: function persistViewState() {
      try {
        window.localStorage.setItem(VIEW_STATE_STORAGE_KEY, JSON.stringify({
          workspaceMode: this.workspaceMode,
          selectedTemuMainId: this.selectedTemuMainId,
          selected1688MainId: this.selected1688MainId
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
      this.galleryEditRecordKey = "";
      this.galleryEditSelection = [];
      this.imageEditorSourceType = "gallery";
      this.imageEditorSourceUrls = [];
      this.imageEditorDetailIndex = -1;
      this.imageEditorRecordKey = "";
      this.syncWorkflowSelection();
      this.imageEditorOpen = false;
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
      this.refreshCarouselTaskIndicators();
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
      this.workflow = state && typeof state === "object" ? state : { active_temu_main_id: "", tasks: {} };
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
      this.workflowPromptBusy = Boolean(this.workflowPromptBusyKeys[String(record && record.main_id || "")]);
      this.workflowSelectedImageUrl = task && task.selected_image_url ? task.selected_image_url : record && record.main_image_url ? record.main_image_url : images[0] || "";
      this.workflowSelectedResultIndex = task && Number.isFinite(Number(task.selected_result_index)) ? Number(task.selected_result_index) : -1;
      this.syncWorkflowPrompts(task);
      this.setWorkflowStatus(this.workflowPromptBusy ? "Kimi 正在后台分析当前商品…" : task && task.status !== "idle" ? this.workflowTaskStatusText(this.selectedTemuMainId) : record ? "已选择 Temu 商品，请确认分析主图。" : "等待选择 Temu 商品。", "normal");
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
        if (String(view.selectedTemuMainId) !== requestedTemuMainId) {
          return;
        }
        view.syncWorkflowPrompts(payload.task);
        view.workflowSelectedResultIndex = -1;
        view.setWorkflowStatus("四个组货方向已生成，可以修改提示词后生图。", "success");
      }).catch(function handleWorkflowPromptError(error) {
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

    /** Generate all four candidate images or regenerate one candidate. */
    generateWorkflowImages: function generateWorkflowImages(index) {
      if (!this.selectedTemuRecord || this.workflowPrompts.length !== 4) {
        return;
      }
      this.workflowGenerateBusy = true;
      this.setWorkflowStatus(index === undefined ? "BeeAPI 正在依次生成四张白底图…" : "BeeAPI 正在重新生成第 " + (Number(index) + 1) + " 张图…", "normal");
      const prompts = [];
      for (let promptIndex = 0; promptIndex < this.workflowPrompts.length; promptIndex += 1) {
        prompts.push(this.workflowPrompts[promptIndex].prompt);
      }
      const body = { temu_main_id: this.selectedTemuRecord.main_id, prompts: prompts };
      if (index !== undefined) {
        body.index = Number(index);
      }
      const view = this;
      const requestedTemuMainId = String(this.selectedTemuRecord.main_id);
      requestWorkflowJson(workflowApiUrl("/workflow/generate"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      }).then(function handleWorkflowGenerationSuccess(payload) {
        view.storeWorkflowTask(requestedTemuMainId, payload.task);
        if (String(view.selectedTemuMainId) !== requestedTemuMainId) {
          return;
        }
        view.syncWorkflowPrompts(payload.task);
        if (index === undefined) {
          view.workflowPromptDrafts = {};
        } else {
          delete view.workflowPromptDrafts[String(Number(index))];
        }
        view.setWorkflowStatus(index === undefined ? "四张白底图已生成，请选择一张。" : "图片已重新生成。", "success");
      }).catch(function handleWorkflowGenerationError(error) {
        if (String(view.selectedTemuMainId) !== requestedTemuMainId) {
          return;
        }
        view.setWorkflowStatus("BeeAPI 生图失败 [" + getWorkflowErrorCode(error) + "]：" + error.message, "error");
      }).finally(function finishWorkflowGenerationRequest() {
        view.workflowGenerateBusy = false;
      });
    },

    /** Select one generated image for the 1688 image-search step. */
    selectWorkflowResult: function selectWorkflowResult(index) {
      if (this.workflowPrompts[index] && this.workflowPrompts[index].image_url) {
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
      this.workflowSearchBusyKeys[resultKey] = true;
      result.search_status = "searching";
      result.search_error = "";
      this.setWorkflowStatus("正在提交第 " + (resultIndex + 1) + " 张图片到 search-1688…", "normal");
      const view = this;
      this.request1688ImageSearch(result.image_url, requestedTemuMainId).then(function handleWorkflowSearchSuccess(payload) {
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
      this.selectedTemuMainId = record ? record.main_id : "";
      this.selectBound1688ForTemu(record);
      this.selectedTemuGalleryIndex = 0;
      this.selected1688GalleryIndex = 0;
      this.galleryEditRecordKey = "";
      this.galleryEditSelection = [];
      this.closeWorkflowPromptDialog();
      this.closeGalleryImageEditor(true);
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

    /** Send exactly two SKU images to BeeAPI and keep its single returned image. */
    blendSkuImages: function blendSkuImages(record, sku, rowIndex) {
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
      const cacheKey = this.productCacheEventKey(record);
      const skuId = String(sku.sku_id || "");
      this.imageEditBusyKeys[busyKey] = true;
      const view = this;
      const editSize = this.imageEditSize;
      this.setStatus("正在提交两张 SKU 图片到本地 Server…", "normal");
      fetch(apiUrl("/images/fusion"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          image_urls: images,
          prompt: fusionPrompt,
          size: editSize
        })
      }).then(function handleImageEditResponse(response) {
        return response.json().then(function handleImageEditPayload(payload) {
          if (!response.ok || !payload || !payload.ok) {
            throw new Error(getApiErrorMessage(payload, "溶图服务请求失败。"));
          }
          return readApiData(payload);
        });
      }).then(function handleImageEditSuccess(payload) {
        const imageUrl = String(payload.image_url || "").trim();
        if (!imageUrl) {
          throw new Error("溶图服务没有返回图片。");
        }
        const currentTarget = view.findCurrentSkuTarget(cacheKey, skuId, rowIndex);
        if (!currentTarget) {
          throw new Error("当前 SKU 已发生变化，无法应用溶图结果。");
        }
        view.replaceSkuImagesWithGenerated(currentTarget.sku, imageUrl);
        view.imageFusionUndoTokens[busyKey] = String(payload.undo_token || "");
        view.saveProductModule(currentTarget.record, "skus");
        const size = String(payload.size || editSize || "1k").toUpperCase();
        view.setStatus("SKU #" + (currentTarget.rowIndex + 1) + " 溶图完成（" + size + "），可点恢复原图。", "success");
      }).catch(function handleImageEditError(error) {
        view.setStatus("溶图失败：" + (error.message || "请求失败。"), "error");
      }).finally(function handleImageEditFinished() {
        view.imageEditBusyKeys[busyKey] = false;
      });
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
      this.imageEditorOpen = true;
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
        for (let index = 0; index < tasks.length; index += 1) {
          const key = String(tasks[index] && tasks[index].temu_main_id || "");
          if (key) {
            taskLookup[key] = tasks[index];
          }
        }
        this.imageCarouselTasksByMainId = taskLookup;
      } catch (error) {
        return;
      }
    },

    /** Return whether one Temu product owns hidden image work that can be reopened. */
    hasOpenableImageTask: function hasOpenableImageTask(record) {
      if (!record || this.imageEditorOpen) {
        return false;
      }
      const mainId = String(record.main_id || "");
      if (this.imageCarouselTasksByMainId[mainId]) {
        return true;
      }
      const sameRecord = this.imageEditorRecordKey === this.imageRecordKey(record);
      return sameRecord && Boolean(this.imageEditorBusy || this.imageEditorGeneratedUrl || this.imageCarouselTask);
    },

    /** Return whether every image in one retained image task has generated successfully. */
    isImageTaskComplete: function isImageTaskComplete(record) {
      if (!record) {
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
      const sameRecord = this.imageEditorRecordKey === this.imageRecordKey(record);
      return sameRecord && !this.imageEditorBusy && Boolean(this.imageEditorGeneratedUrl);
    },

    /** Select the owning Temu product and reopen its retained image task. */
    openRetainedImageEditor: function openRetainedImageEditor(record) {
      if (!record) {
        return;
      }
      const mainId = String(record.main_id || "");
      const task = this.imageCarouselTasksByMainId[mainId] || null;
      const sameSession = this.imageEditorRecordKey === this.imageRecordKey(record)
        && Boolean(this.imageEditorBusy || this.imageEditorGeneratedUrl || this.imageCarouselTask);
      this.selectedTemuMainId = record.main_id;
      this.selectBound1688ForTemu(record);
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
        this.imageCarouselCount = Number(task.count || 2);
        this.imageCarouselMarketLanguage = String(task.market_language || "美国 / English");
        this.imageEditorPrompt = String(task.requirement || "");
        this.imageCarouselEstimatedTokens = Number(task.estimated_tokens || 0);
      }
      this.imageEditorOpen = true;
      this.persistViewState();
      if (task) {
        this.loadCarouselTaskForProduct(record, task.source_image_urls || []);
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
      this.imageEditorPrompt = sources.length === 2 ? this.imageEditorFusionPrompt : this.imageEditorEditPrompt;
      this.imageEditorGeneratedUrl = "";
      this.imageEditorError = "";
      this.imageEditorBackdropPressed = false;
      this.imageCarouselTask = null;
      this.imageCarouselPageIndex = 0;
      this.imageCarouselEstimatedTokens = 0;
      this.imageCarouselSourceMismatch = false;
      this.imageEditorOpen = true;
      if (sources.length === 2) {
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

    /** Route one dialog submission through the original or carousel workflow. */
    submitGalleryImageEdit: function submitGalleryImageEdit() {
      const sources = this.galleryImageEditorSources(this.selectedTemuRecord);
      if (sources.length === 2 && Number(this.imageCarouselCount) > 1) {
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

    /** Submit selected images through the unchanged single-result image API path. */
    submitDirectGalleryImageEdit: function submitDirectGalleryImageEdit() {
      const record = this.selectedTemuRecord;
      const sources = this.galleryImageEditorSources(record);
      const prompt = String(this.imageEditorPrompt || "").trim();
      if (!record || !prompt || (sources.length !== 1 && sources.length !== 2) || this.imageEditorBusy) {
        return;
      }
      const endpoint = sources.length === 2 ? apiUrl("/images/fusion") : apiUrl("/images/edits");
      this.imageEditorBusy = true;
      this.imageEditorError = "";
      this.imageEditorGeneratedUrl = "";
      this.imageEditorRequestId += 1;
      const requestId = this.imageEditorRequestId;
      const view = this;
      fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image_urls: sources, prompt: prompt, size: this.imageEditSize })
      }).then(function handleGalleryEditResponse(response) {
        return response.json().then(function handleGalleryEditPayload(payload) {
          if (!response.ok || !payload || !payload.ok) {
            const apiError = payload && payload.error && typeof payload.error === "object" ? payload.error : {};
            const error = new Error(getApiErrorMessage(payload, "图片生成失败。"));
            error.code = String(apiError.code || response.status || "REQUEST_FAILED");
            error.statusCode = Number(response.status || 500);
            throw error;
          }
          return readApiData(payload);
        });
      }).then(function handleGalleryEditSuccess(payload) {
        if (requestId !== view.imageEditorRequestId) {
          return;
        }
        view.imageEditorGeneratedUrl = String(payload.image_url || "");
        if (!view.imageEditorGeneratedUrl) {
          throw new Error("图片服务没有返回生成结果。");
        }
      }).catch(function handleGalleryEditError(error) {
        if (requestId === view.imageEditorRequestId) {
          view.imageEditorError = "[" + getWorkflowErrorCode(error) + "] " + (error.message || "图片生成失败。");
        }
      }).finally(function handleGalleryEditFinished() {
        if (requestId === view.imageEditorRequestId) {
          view.imageEditorBusy = false;
        }
      });
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
        this.normalizeCarouselPageIndex();
        this.imageCarouselCount = Number(task.count || 1);
        this.imageCarouselMarketLanguage = String(task.market_language || "美国 / English");
        this.imageEditorPrompt = String(task.requirement || this.imageEditorPrompt || "");
        this.imageCarouselEstimatedTokens = Number(task.estimated_tokens || 0);
        this.imageCarouselSourceMismatch = !this.hasSameCarouselSources(task.source_image_urls, sources);
        if (this.imageCarouselSourceMismatch) {
          this.imageEditorError = "该商品已有未完成任务，当前显示的是旧任务。";
        }
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

    /** Create and stream one Kimi reasoning-mode carousel plan. */
    async startCarouselPlan() {
      const record = this.selectedTemuRecord;
      const sources = this.galleryImageEditorSources(record);
      const count = Math.max(2, Math.min(10, Number(this.imageCarouselCount || 2)));
      if (!record || sources.length !== 2 || this.imageEditorBusy) {
        return;
      }
      this.imageCarouselCount = count;
      this.imageEditorBusy = true;
      this.imageEditorError = "";
      this.imageEditorBackdropPressed = false;
      this.imageCarouselEstimatedTokens = 0;
      try {
        const response = await fetch(apiUrl("/workflow/prompts"), {
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
            size: this.imageEditSize
          })
        });
        const task = await this.readCarouselPlanStream(response);
        if (!task) {
          throw new Error("Kimi 没有返回轮播任务。");
        }
        this.imageCarouselTask = task;
        this.rememberCarouselTask(task);
        if (task.status === "ready") {
          this.imageEditorBusy = false;
          await this.generateCarouselPages();
        }
      } catch (error) {
        if (error.details && error.details.task) {
          this.imageCarouselTask = error.details.task;
          this.rememberCarouselTask(this.imageCarouselTask);
          this.imageCarouselSourceMismatch = true;
        }
        this.imageEditorError = "[" + getWorkflowErrorCode(error) + "] " + (error.message || "轮播规划失败。");
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

    /** Start every pending carousel page concurrently through the shared Fusion API. */
    async generateCarouselPages() {
      const task = this.imageCarouselTask;
      if (!task || !task.pages || this.imageCarouselGenerationBusy) {
        return;
      }
      this.imageCarouselGenerationBusy = true;
      this.imageEditorError = "";
      const requests = [];
      for (let index = 0; index < task.pages.length; index += 1) {
        requests.push(this.generateCarouselPage(index));
      }
      await Promise.all(requests);
      this.imageCarouselGenerationBusy = false;
      await this.refreshCarouselTask();
    },

    /** Generate or retry exactly one carousel page through Fusion. */
    async generateCarouselPage(pageIndex) {
      const task = this.imageCarouselTask;
      const page = task && task.pages ? task.pages[Number(pageIndex)] : null;
      if (!task || !page) {
        return;
      }
      page.status = "generating";
      page.error = "";
      try {
        const response = await fetch(apiUrl("/images/fusion"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            image_urls: task.source_image_urls,
            prompt: page.prompt,
            size: task.size || this.imageEditSize,
            carousel_task_id: task.id,
            carousel_page_index: Number(pageIndex)
          })
        });
        const payload = await response.json();
        if (!response.ok || !payload || !payload.ok) {
          const error = new Error(getApiErrorMessage(payload, "图片生成失败。"));
          error.code = String(payload && payload.error && payload.error.code || response.status);
          throw error;
        }
        page.status = "succeeded";
        page.image_url = String(payload.data && payload.data.image_url || "");
        page.selected = true;
      } catch (error) {
        page.status = "failed";
        page.error = error.message || "图片生成失败。";
        page.error_code = String(error.code || "IMAGE_GENERATION_FAILED");
      }
    },

    /** Retry one failed result without regenerating successful pages. */
    async retryCarouselPage(pageIndex) {
      if (this.imageCarouselGenerationBusy) {
        return;
      }
      this.imageCarouselGenerationBusy = true;
      await this.generateCarouselPage(pageIndex);
      this.imageCarouselGenerationBusy = false;
      await this.refreshCarouselTask();
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

    /** Return the number of selected successful carousel outputs. */
    successfulCarouselPageCount: function successfulCarouselPageCount() {
      const pages = this.imageCarouselTask && Array.isArray(this.imageCarouselTask.pages) ? this.imageCarouselTask.pages : [];
      let count = 0;
      for (let index = 0; index < pages.length; index += 1) {
        if (pages[index].status === "succeeded" && pages[index].selected !== false) {
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
      this.imageCarouselEstimatedTokens = 0;
      this.imageCarouselSourceMismatch = false;
      this.imageEditorError = "";
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
        this.setStatus("已确认编辑并替换详情图。", "success");
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
      this.selectedTemuGalleryIndex = insertIndex;
      this.selectedGalleryIndex = insertIndex;
      this.setStatus(indices.length === 2 ? "已确认溶图并替换两张原图。" : "已确认编辑并替换原图。", "success");
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
      this.imageEditorOpen = false;
      if (!forceReset && (this.imageEditorBusy || this.imageCarouselGenerationBusy || this.imageEditorGeneratedUrl || this.imageCarouselTask)) {
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
      const imageUrl = reference && String(reference.source_type || "") === "gallery" ? String(reference.image_url || "") : "";
      if (record && imageUrl) {
        const added = this.appendTemuGalleryImage(record, imageUrl, targetIndex);
        if (targetIndex === undefined) {
          record.main_image_url = imageUrl;
        }
        this.updateGallerySelection(record, "temu", record.gallery_image_urls.indexOf(imageUrl));
        this.setStatus(targetIndex === undefined
          ? (added ? "已将 1688 主图添加到 Temu 主图。" : "已将已有图片设为 Temu 主图。")
          : (added ? "已将 1688 主图插入 Temu 主图列表。" : "已调整 Temu 主图顺序。"), "success");
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

    /** Drop one 1688 image into a specific Temu SKU image cell. */
    dropAliImageToTemuSku: function dropAliImageToTemuSku(event, record, targetSku, rowIndex) {
      event.preventDefault();
      event.stopPropagation();
      const reference = this.dragImageReference || this.readDraggedImageReference(event);
      const isSkuImage = reference && String(reference.source_type || "") === "sku";
      const imageUrl = isSkuImage && reference.image_url ? String(reference.image_url) : "";
      if (targetSku && imageUrl) {
        const beforeCount = this.skuImageUrls(targetSku).length;
        this.appendSkuImage(targetSku, imageUrl);
        const afterCount = this.skuImageUrls(targetSku).length;
        if (afterCount > beforeCount) {
          this.setStatus("已将 1688 图片添加到 Temu SKU #" + (Number(rowIndex) + 1) + "。", "success");
          this.saveProductModule(record, "skus");
        }
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
      this.setStatus("服务器正在流式生成妙手 ZIP，完成后会自动下载。", "normal");
      window.location.href = apiUrl("/zip");
      const view = this;
      /** Release the ZIP export busy state after the browser starts the download. */
      function releaseMiaoshouExportBusy() {
        view.miaoshouExportBusy = false;
      }
      window.setTimeout(releaseMiaoshouExportBusy, 1500);
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
