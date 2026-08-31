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

/** Return one stable code from the shared API error envelope. */
function getApiErrorCode(payload, fallbackCode) {
  const error = payload && payload.error;
  if (error && typeof error === "object" && error.code) {
    return String(error.code);
  }
  if (payload && payload.statusCode) {
    return String(payload.statusCode);
  }
  return String(fallbackCode || "REQUEST_FAILED");
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

/** Convert browser crypto bytes into a lowercase hexadecimal digest. */
function bytesToHex(bytes) {
  let output = "";
  for (let index = 0; index < bytes.length; index += 1) {
    output += bytes[index].toString(16).padStart(2, "0");
  }
  return output;
}

/** Hash the user access code before sending it to the local backend. */
async function hashAccessCode(value) {
  const bytes = new TextEncoder().encode(String(value || "").trim());
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return bytesToHex(new Uint8Array(digest));
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
const SKU_BLEND_INDICATOR_ACK_STORAGE_KEY = "pod-auto-build.sku-blend-indicator-ack";
const RESTORE_UPLOAD_CHUNK_SIZE = 512 * 1024;
const RESTORE_RECORD_BATCH_SIZE = 10;

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

/** Read durable SKU blend indicator acknowledgements retained by this browser. */
function readSkuBlendIndicatorAcknowledgements() {
  try {
    const raw = window.localStorage.getItem(SKU_BLEND_INDICATOR_ACK_STORAGE_KEY);
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
  template: `
    <span
      class="task-status-indicator"
      :class="['is-' + tone, { 'is-pulse': pulse, 'is-complete': complete && !error, 'is-error': error }]"
      role="button"
      tabindex="0"
      :title="label"
      :aria-label="label"
      @click.stop="$emit('activate')"
      @keydown.enter.stop="$emit('activate')"
    >
      <template v-if="!pulse">
        <svg v-if="error" class="indicator-ring-svg indicator-error" viewBox="0 0 16 16" fill="none">
          <circle cx="8" cy="8" r="6.6" class="ring-bg" stroke="currentColor" stroke-width="1.3" fill="none" />
          <path d="M8 4.3V8.7M8 11.2V11.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" />
        </svg>
        <svg v-else-if="complete" class="indicator-ring-svg indicator-complete" viewBox="0 0 16 16" fill="none">
          <circle cx="8" cy="8" r="6.6" class="ring-bg" stroke="currentColor" stroke-width="1.3" fill="none" />
          <path d="M4.8 8.2L6.9 10.3L11.2 5.8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <svg v-else class="indicator-ring-svg indicator-spinner" viewBox="0 0 16 16" fill="none">
          <circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="2" opacity="0.22" />
          <circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-dasharray="11 26" />
        </svg>
      </template>
    </span>
  `
};

const app = createApp({
  template: `
    <div class="shell">
      <div v-if="!cloudAuth.authorized" class="cloud-auth-overlay">
        <section class="cloud-auth-dialog panel" role="dialog" aria-modal="true" aria-label="自动组货授权登录">
          <header>
            <strong>自动组货授权</strong>
            <span>{{ cloudAuth.checking ? '正在连接 Cloudflare' : '请输入访问码' }}</span>
          </header>
          <form @submit.prevent="loginCloudAuth">
            <input
              type="password"
              v-model="cloudAuthAccessCode"
              autocomplete="one-time-code"
              placeholder="16 位访问码"
              :disabled="cloudAuth.checking || cloudAuth.busy"
            >
            <button class="cloud-auth-submit glass-action-button" type="submit" :disabled="cloudAuth.checking || cloudAuth.busy || !cloudAuthAccessCode.trim()">
              {{ cloudAuth.busy ? '验证中…' : '登录并同步配置' }}
            </button>
          </form>
          <p class="cloud-auth-message" :class="{ error: cloudAuth.error }">{{ cloudAuth.message }}</p>
        </section>
      </div>
      <header class="topbar" :class="{ 'is-collapsed': topbarCollapsed }">
        <div class="toolbar">
          <button class="mode-button glass-action-button" :class="{ active: workspaceMode === 'smart' }" type="button" @click="changeWorkspaceMode('smart')">组货模式</button>
          <button class="mode-button glass-action-button" :class="{ active: workspaceMode === 'realtime' }" type="button" @click="changeWorkspaceMode('realtime')">工作台</button>
          <button class="mode-button glass-action-button" type="button" :disabled="!temuRecords.length || miaoshouExportBusy" @click="openMiaoshouExportDialog">{{ miaoshouExportBusy ? '妙手处理中…' : '导出妙手 ZIP' }}</button>
          <label class="mode-button restore-button glass-action-button" :class="{ 'is-busy': restoreProgress.active }">
            {{ restoreProgress.active ? '恢复中…' : '备份恢复' }}
            <input type="file" accept="application/json,.json" :disabled="restoreProgress.active" @change="handleRestoreFile">
          </label>
        </div>
      </header>

      <div v-if="restoreProgress.active" class="clip-loading-progress clip-loading-progress-global restore-loading-progress" :class="'is-' + restoreProgress.status" role="progressbar" aria-label="备份恢复进度" aria-valuemin="0" aria-valuemax="100" :aria-valuenow="restoreProgress.progress">
        <div><strong>备份恢复</strong><span>{{ restoreProgress.message }} · {{ restoreProgress.progress }}%</span></div>
        <span class="clip-loading-track"><i :style="{ width: restoreProgress.progress + '%' }"></i></span>
        <small v-if="restoreProgress.error">{{ restoreProgress.error }}</small>
      </div>

      <div v-if="cloudAuth.authorized && workflowClipLoading.status !== 'ready'" class="clip-loading-progress clip-loading-progress-global" :class="'is-' + workflowClipLoading.status" role="progressbar" aria-label="CLIP 后台加载进度" aria-valuemin="0" aria-valuemax="100" :aria-valuenow="workflowClipLoading.progress">
        <div><strong>CLIP 后台加载</strong><span>{{ workflowClipLoading.message }} · {{ workflowClipLoading.progress }}%</span></div>
        <span class="clip-loading-track"><i :style="{ width: workflowClipLoading.progress + '%' }"></i></span>
        <small v-if="workflowClipLoading.error">{{ workflowClipLoading.error }}</small>
      </div>

      <main class="content">
        <div v-if="!records.length" class="panel empty">{{ renderMode === 'realtime' ? '等待扩展采集商品并写入本地 cache。' : '请先导入统一 JSON 文件。' }}</div>
        <div v-else class="render-layout">
          <aside class="panel listing-rail">
            <div class="listing-rail-heading"><div class="listing-cache-actions"><button class="glass-action-button" type="button" :disabled="bulkClipBusy || bulkCoverBusy" @click="clearEntireCache">清空</button><div class="listing-other-actions" @click.stop><button class="glass-action-button" type="button" :disabled="!temuRecords.length" aria-haspopup="menu" :aria-expanded="bulkActionsMenuOpen ? 'true' : 'false'" @click.stop="toggleBulkActionsMenu">其他功能</button><div v-if="bulkActionsMenuOpen" class="listing-other-actions-menu" role="menu"><button class="glass-action-button" type="button" role="menuitem" :disabled="bulkClipBusy || hasAnyWorkflowOperationBusy()" @click="openBulkClipPrompt"><span>全部重新 CLIP</span><small v-if="bulkClipBusy">{{ bulkClipCurrent }}/{{ bulkClipTotal }}</small></button><button class="glass-action-button" type="button" role="menuitem" :disabled="bulkCoverBusy" @click="startBulkDetailCover"><span>全部主图覆盖</span><small v-if="bulkCoverBusy">{{ bulkCoverCurrent }}/{{ bulkCoverTotal }}</small></button></div></div></div></div>
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
                  <button class="thumb" :class="{ active: selectedTemuGalleryIndex === imageIndex }" type="button" draggable="true" title="双击打开 Edits" @dragstart.stop="startImageReorder($event, selectedTemuRecord, 'gallery', imageIndex)" @dragend="endImageReorder" @click="handleTemuGallerySelection($event, selectedTemuRecord, imageIndex)" @dblclick.stop="openSingleGalleryImageEditor(selectedTemuRecord, imageIndex)"><img :src="imageSource(image)" referrerpolicy="no-referrer" alt="Temu 商品图片" draggable="false"><span v-if="isTemuGalleryEditSelected(selectedTemuRecord, imageIndex)" class="gallery-ai-check"></span></button>
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
                  <td class="sku-image-cell" :class="{ 'is-image-drop-target': isImageDropTarget('temu-sku', skuIndex) }" @dragenter.prevent.stop="setImageDropTarget('temu-sku', skuIndex)" @dragover.prevent.stop="setImageDropTarget('temu-sku', skuIndex)" @drop.prevent.stop="dropAliImageToTemuSku($event, selectedTemuRecord, sku, skuIndex)"><div class="sku-images-editor"><div v-for="(image, imageIndex) in skuImageUrls(sku)" :key="imageIndex" class="sku-image-item"><img :src="imageSource(image)" referrerpolicy="no-referrer" alt="SKU 图片" draggable="true" title="拖到上方主图列表" @dragstart.stop="startSkuImageDrag($event, selectedTemuRecord, image, skuIndex, imageIndex)" @dragend="endAliImageDrag" @click.stop="openImagePreview(image)"><button class="image-delete-button" type="button" aria-label="删除 SKU 图片" @click="removeSkuImageAt(selectedTemuRecord, sku, imageIndex)">×</button></div><label v-if="!skuImageUrls(sku).length" class="sku-image-empty-upload" title="点击上传本地图片，悬停选择主图" @mouseenter="openSkuImagePicker($event, selectedTemuRecord, sku, skuIndex)" @mouseleave="scheduleSkuImagePickerClose">+<input type="file" accept="image/*" @change.stop="handleSkuImageUpload($event, selectedTemuRecord, sku)"></label><div v-if="shouldShowSkuBlendAction(selectedTemuRecord, sku, skuIndex)" class="sku-image-actions sku-image-state-actions"><button class="sku-fusion-state-button" :class="skuBlendActionClass(selectedTemuRecord, sku, skuIndex)" type="button" :disabled="isSkuBlendActionBusy(selectedTemuRecord, sku, skuIndex)" :aria-label="skuBlendActionTitle(selectedTemuRecord, sku, skuIndex)" :data-error-code="skuBlendErrorCode(selectedTemuRecord, sku, skuIndex)" @click.stop="handleSkuBlendAction(selectedTemuRecord, sku, skuIndex)"><span v-if="isSkuBlendActionBusy(selectedTemuRecord, sku, skuIndex)" class="sku-fusion-state-spinner" aria-hidden="true"></span><span v-else class="sku-fusion-state-symbol" :class="skuBlendActionIconClass(selectedTemuRecord, sku, skuIndex)" aria-hidden="true"></span></button></div></div></td>
                    <td v-for="(group, groupIndex) in skuSpecGroups(selectedTemuRecord)" :key="group.name" class="sku-spec-cell" :class="{ 'is-drop-target': isTemuSkuCellDropTarget(skuIndex, group.name) }" @dragenter.prevent.stop="setTemuSkuCellDropTarget(skuIndex, group.name)" @dragover.prevent.stop="setTemuSkuCellDropTarget(skuIndex, group.name)" @drop.prevent.stop="dropAliSkuToTemuSkuCell($event, selectedTemuRecord, sku, skuIndex, group.name)"><input class="sku-edit-input" type="text" :value="skuSpecValue(sku, groupIndex)" @input="updateSkuSpecValue(sku, groupIndex, $event.target.value)" :aria-label="group.name"></td>
                    <td><input class="sku-edit-input" type="text" inputmode="decimal" v-model="sku.sku_price" aria-label="SKU 价格"></td><td><input class="sku-edit-input" type="text" inputmode="numeric" v-model="sku.sku_stock" aria-label="SKU 库存"></td><td class="sku-dimensions-cell"><div class="sku-dimension-bubbles" aria-label="SKU 尺寸"><input class="sku-edit-input sku-dimension-input" type="text" inputmode="decimal" v-model="sku.sku_length" aria-label="SKU 长度"><span class="sku-dimension-separator">:</span><input class="sku-edit-input sku-dimension-input" type="text" inputmode="decimal" v-model="sku.sku_width" aria-label="SKU 宽度"><span class="sku-dimension-separator">:</span><input class="sku-edit-input sku-dimension-input" type="text" inputmode="decimal" v-model="sku.sku_height" aria-label="SKU 高度"></div></td>
                 </tr>
                  <tr v-if="!selectedTemuRecord.sku.length"><td :colspan="skuSpecGroups(selectedTemuRecord).length + 5" class="empty">暂无 SKU 数据</td></tr>
               </tbody></table>
             </div>
               <div class="detail-section" @dragenter.prevent.stop="setImageInteractionTarget('temu-detail')" @dragover.prevent.stop="setImageInteractionTarget('temu-detail')" @drop.prevent.stop="dropAliImageToTemuDetail($event, selectedTemuRecord)"><div class="detail-section-heading"><h3>商品详情</h3><button class="glass-action-button" type="button" :disabled="bulkCoverBusy || !galleryImages(selectedTemuRecord).length" @click.stop="replaceDetailsWithGallery(selectedTemuRecord)">使用主图一键覆盖</button></div><div v-if="selectedTemuRecord.detail_image_urls.length" class="detail-images"><div v-for="(image, detailIndex) in selectedTemuRecord.detail_image_urls" :key="image" class="detail-image-editor" draggable="true" title="双击打开 Edits" :class="{ 'is-image-reorder-target': isImageReorderTarget('temu-detail', detailIndex) }" @dragstart.stop="startImageReorder($event, selectedTemuRecord, 'detail', detailIndex)" @dragend="endImageReorder" @dragenter.prevent.stop="setImageInteractionTarget('temu-detail', detailIndex)" @dragover.prevent.stop="setImageInteractionTarget('temu-detail', detailIndex)" @drop.prevent.stop="dropAliImageToTemuDetail($event, selectedTemuRecord, detailIndex)" @dblclick.stop="openDetailImageEditor(selectedTemuRecord, image, detailIndex)"><img :src="imageSource(image)" referrerpolicy="no-referrer" alt="Temu 商品详情图" draggable="false"><button class="image-delete-button" type="button" aria-label="删除详情图" @click="removeDetailImage(selectedTemuRecord, detailIndex)">×</button></div></div><div v-else class="detail-empty-upload"><label class="detail-empty-upload-button" title="上传详情图">+<input type="file" accept="image/*" multiple @change="handleDetailUpload($event, selectedTemuRecord)"></label><span>暂无详情图，请上传图片。</span></div></div>
          </section>
          <section v-else class="panel platform-render empty">请选择 Temu 商品。</section>

          <section v-if="workspaceMode === 'smart'" class="panel platform-render smart-workflow-render">
            <div class="smart-workflow-heading">
              <div><span class="platform-label ali-label">智能组货</span></div>
              <div class="smart-workflow-heading-actions">
                <div v-if="workflowMode === 'clip'" class="smart-workflow-price-filter" aria-label="CLIP 价格过滤">
                  <input type="number" min="0" step="0.01" inputmode="decimal" v-model="workflowClipMinPrice" placeholder="最低价">
                  <span>—</span>
                  <input type="number" min="0" step="0.01" inputmode="decimal" v-model="workflowClipMaxPrice" placeholder="最高价">
                </div>
                <div v-if="workflowMode === 'clip'" class="smart-workflow-manual-match" aria-label="手动 CLIP 匹配">
                  <input type="text" v-model="workflowClipKeyword" placeholder="手动 keyword" @keyup.enter="searchClipWorkflowCandidates">
                  <button type="button" :disabled="bulkClipBusy || workflowPromptBusy || workflowGenerateBusy || hasWorkflowClipTop10Lock() || !selectedTemuRecord || !workflowClipKeyword.trim()" @click="searchClipWorkflowCandidates">匹配2个</button>
                </div>
                <div class="smart-workflow-mode-switch" role="group" aria-label="组货模式">
                  <button type="button" :class="{ active: workflowMode === 'clip' }" @click="setWorkflowMode('clip')">新版CLIP</button>
                  <button type="button" :class="{ active: workflowMode === 'legacy' }" @click="setWorkflowMode('legacy')">旧版生图</button>
                </div>
                <button class="workflow-direction-button smart-workflow-direction-button" :class="{ 'is-analyzing': workflowPromptBusy, 'is-generating': workflowGenerateBusy, 'is-ready': workflowPrompts.length && !workflowPromptBusy && !workflowGenerateBusy }" type="button" :disabled="bulkClipBusy || workflowPromptBusy || workflowGenerateBusy || hasWorkflowClipTop10Lock() || !workflowSelectedImageUrl" @click="startWorkflowAction">
                  <span v-if="workflowPromptBusy || workflowGenerateBusy" class="workflow-direction-spinner" aria-hidden="true"></span>
                  <span v-else class="workflow-direction-icon" aria-hidden="true">↻</span>
                  <span>{{ workflowPromptBusy ? '分析中' : workflowGenerateBusy ? '生图中' : workflowPrompts.length ? '重新组货' : workflowMode === 'clip' ? '生成CLIP组货' : '生成组货方向' }}</span>
                </button>
              </div>
            </div>
            <div v-if="workflowMode === 'clip'" class="clip-loading-progress" :class="'is-' + workflowClipLoading.status" role="progressbar" aria-label="CLIP 加载进度" aria-valuemin="0" aria-valuemax="100" :aria-valuenow="workflowClipLoading.progress">
              <div><strong>CLIP 引擎</strong><span>{{ workflowClipLoading.message }} · {{ workflowClipLoading.progress }}%</span></div>
              <span class="clip-loading-track"><i :style="{ width: workflowClipLoading.progress + '%' }"></i></span>
              <small v-if="workflowClipLoading.error">{{ workflowClipLoading.error }}</small>
            </div>
            <section v-if="workflowPrompts.length" class="smart-workflow-step">
              <header><span>01</span><div><strong>组货建议</strong><small>{{ workflowMode === 'clip' ? '新版 CLIP 返回真实候选商品，点击搜索按钮走 1688 搜图。' : '四个候选方向会自动生成图片，生成完成后可直接搜图。' }}</small></div></header>
              <div class="smart-result-grid">
                <article v-for="(item, index) in workflowPrompts" :key="'smart-result-' + index" class="smart-result-card" :class="{ selected: workflowSelectedResultIndex === index }">
                  <div class="smart-result-image-wrap"><button class="smart-result-image" type="button" :disabled="!item.image_url" @click="selectWorkflowResult(index)"><img v-if="item.image_url && !item.image_load_error" :src="imageSource(item.image_url)" referrerpolicy="no-referrer" alt="AI 组货候选图" @load="handleWorkflowResultImageLoad(item)" @error="handleWorkflowResultImageError(item)"><span v-else>{{ item.image_url && item.image_load_error ? '图片加载失败，仍可搜图' : item.status === 'generating' || item.status === 'queued' ? '后台生成中…' : item.status === 'error' ? workflowPromptErrorText(item) : item.error || '等待生成' }}</span><i v-if="item.price_label">{{ item.price_label }}</i></button><button v-if="workflowMode === 'clip' && workflowClipTop10Keyword(item)" class="smart-result-top10-button" :class="{ 'is-busy': workflowClipTop10BusyKeys[index] }" type="button" :disabled="bulkClipBusy || !!workflowClipTop10BusyMainId" :title="'用 EN 关键词跑 CLIP Top10：' + workflowClipTop10Keyword(item)" :aria-label="workflowClipTop10BusyKeys[index] ? 'CLIP Top10 检索中' : '用 EN 关键词跑 CLIP Top10'" @click.stop="searchWorkflowClipTop10(index)">★</button><button v-if="item.image_url" class="smart-result-search-button" :class="{ 'is-busy': workflowSearchBusyKeys[index] }" type="button" :disabled="bulkClipBusy || workflowSearchBusyKeys[index] || item.status === 'generating' || item.status === 'queued'" title="用这张候选图搜索 1688" :aria-label="workflowSearchBusyKeys[index] ? '1688 搜图中' : '用这张候选图搜索 1688'" @click.stop="searchWorkflow1688(index)"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.2"></circle><path d="m16 16 5 5"></path></svg></button></div>
                  <div class="smart-result-copy"><strong>{{ item.relation }}</strong><span class="smart-result-intro">{{ item.product_intro }}</span><em v-if="item.product_name && item.product_name !== item.product_intro" class="smart-result-title">{{ item.product_name }}</em><small v-if="item.sales_label">{{ item.sales_label }}</small></div>
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
        <div v-if="miaoshouExportDialogOpen" class="image-editor-modal" @click.self="closeMiaoshouExportDialog">
          <section class="image-editor-dialog miaoshou-export-dialog" role="dialog" aria-modal="true" aria-label="妙手导出">
            <header class="image-editor-header"><div><strong>妙手导出</strong><span>{{ temuRecords.length }} 个 Temu 商品</span></div><button type="button" aria-label="关闭妙手导出" @click="closeMiaoshouExportDialog">×</button></header>
            <div class="miaoshou-export-options">
              <button class="miaoshou-export-option" type="button" :disabled="miaoshouExportBusy" @click="exportMiaoshouZip"><strong>下载 ZIP</strong><span>生成本地妙手导入包</span></button>
              <button class="miaoshou-export-option" :class="{ active: miaoshouExportMode === 'online' }" type="button" :disabled="miaoshouExportBusy" @click="selectMiaoshouOnlineImport"><strong>在线导入</strong><span>保存 Cookie 并上传妙手</span></button>
            </div>
            <div v-if="miaoshouExportMode === 'online'" class="miaoshou-cookie-status" :class="{ 'is-ready': miaoshouSavedCookieReady, 'is-loading': miaoshouSavedCookieLoading }">{{ miaoshouSavedCookieStatusText || '正在读取 Chrome 最新妙手 Cookie' }}</div>
            <label v-if="miaoshouExportMode === 'online'" class="image-editor-prompt"><span>妙手 Cookie</span><textarea v-model="miaoshouCookieDraft" rows="6" autocomplete="off" placeholder="server/cookie.json 有效时可留空；需要更换时粘贴新 Cookie" aria-label="妙手 Cookie"></textarea></label>
            <div v-if="miaoshouExportBusy || miaoshouExportProgress > 0" class="miaoshou-export-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" :aria-valuenow="miaoshouExportProgress">
              <span><i :style="{ width: miaoshouExportProgress + '%' }"></i></span>
              <small>{{ miaoshouExportProgressText || '准备中' }}</small>
            </div>
            <div v-if="miaoshouExportResultText" class="miaoshou-export-result" :class="'is-' + miaoshouExportResultType">{{ miaoshouExportResultText }}</div>
            <div v-if="miaoshouExportError" class="image-editor-error">{{ miaoshouExportError }}</div>
            <footer class="image-editor-actions"><button class="image-editor-cancel" type="button" :disabled="miaoshouExportBusy" @click="closeMiaoshouExportDialog">{{ miaoshouExportResultText ? '关闭' : '取消' }}</button><button v-if="miaoshouExportMode === 'online'" class="image-editor-confirm" type="button" :disabled="miaoshouExportBusy || miaoshouSavedCookieLoading" @click="importMiaoshouOnline">{{ miaoshouExportBusy ? '导入中…' : '开始在线导入' }}</button></footer>
          </section>
        </div>
        <div v-if="workflowPromptDialogOpen" class="image-editor-modal">
          <section class="image-editor-dialog workflow-prompt-dialog" role="dialog" aria-modal="true" aria-label="自定义组货提示词">
            <header class="image-editor-header"><div><strong>{{ workflowBatchPromptPending ? '全部重新 CLIP' : workflowPromptDialogMode === 'clip' ? '自定义新版 CLIP 组货' : '自定义组货方向' }}</strong><span>{{ workflowBatchPromptPending ? '同一提示词将按顺序用于左侧全部 Temu 商品' : workflowPromptDialogMode === 'clip' ? 'Kimi 将按照本次要求生成 CLIP 检索词' : 'Kimi 将按照本次要求推荐 4 个商品' }}</span></div><button type="button" aria-label="关闭组货提示词" @click="closeWorkflowPromptDialog">×</button></header>
            <label class="image-editor-prompt"><span>{{ workflowPromptDialogMode === 'clip' ? '用户提示词' : '组货提示词' }}</span><textarea v-model="workflowCustomPromptDraft" rows="7" :placeholder="workflowPromptDialogMode === 'clip' ? '请输入本次 CLIP 用户要求；系统提示词已隐藏并从 config 读取' : '请输入本次组货方向要求'" aria-label="自定义组货提示词"></textarea></label>
            <div v-if="workflowPromptDialogError" class="image-editor-error">{{ workflowPromptDialogError }}</div>
            <footer class="image-editor-actions"><button class="image-editor-cancel" type="button" @click="closeWorkflowPromptDialog">取消</button><button class="image-editor-confirm" type="button" :disabled="workflowPromptBusy" @click="submitWorkflowPrompts">{{ workflowPromptBusy ? workflowPromptDialogMode === 'clip' ? '检索中…' : '分析中…' : workflowBatchPromptPending ? '开始全部CLIP' : workflowPromptDialogMode === 'clip' ? '开始CLIP组货' : '开始分析' }}</button></footer>
          </section>
        </div>
        <div v-if="imageEditorOpen" class="image-editor-modal" @pointerdown.self="beginImageEditorBackdropPress" @pointerup="finishImageEditorBackdropPress" @pointercancel="cancelImageEditorBackdropPress">
          <section class="image-editor-dialog" role="dialog" aria-modal="true" aria-label="AI 图片编辑">
            <header class="image-editor-header"><div><strong>{{ imageEditorTitle() }}</strong><span>{{ imageEditorSubtitle() }}</span></div><span v-if="imageCarouselSourceMismatch" class="image-editor-header-status">当前显示旧任务 · 所选图片已变化</span><button type="button" aria-label="关闭 AI 图片编辑" @click="closeGalleryImageEditor">×</button></header>
            <div class="image-editor-stage" :class="{ 'has-two-sources': imageEditorState().sourceCount === 2, 'has-result': imageEditorState().hasResult }">
              <span v-if="shouldShowImageEditorStageLabel()" class="image-editor-stage-label">{{ imageEditorStageLabel() }}</span>
              <div v-if="shouldShowImageEditorLoading()" class="image-editor-loading"><span></span><strong>{{ imageEditorLoadingTitle() }}</strong><small>{{ imageEditorLoadingHint() }}</small></div>
              <div v-else-if="shouldShowCarouselViewer()" class="carousel-slide-viewer">
                <button class="carousel-slide-arrow previous" type="button" :disabled="imageCarouselPageIndex <= 0" aria-label="上一张轮播图" @click="changeCarouselPage(-1)">‹</button>
                <article class="carousel-result-card">
                  <img v-if="currentCarouselPage().image_url" :src="imageSource(currentCarouselPage().image_url)" :alt="'轮播图 ' + (imageCarouselPageIndex + 1)">
                  <div v-else class="carousel-result-placeholder"><span>{{ currentCarouselPage().status === 'generating' ? '生成中…' : currentCarouselPage().status === 'failed' ? '[' + currentCarouselPage().error_code + '] ' + currentCarouselPage().error : '等待生成' }}</span><button v-if="currentCarouselPage().status === 'failed'" type="button" :disabled="isCarouselPageBusy(imageCarouselPageIndex)" @click="retryCarouselPage(imageCarouselPageIndex)">{{ isCarouselPageBusy(imageCarouselPageIndex) ? '重试中…' : '重试' }}</button></div>
                </article>
                <button class="carousel-slide-arrow next" type="button" :disabled="imageCarouselPageIndex >= imageCarouselTask.pages.length - 1" aria-label="下一张轮播图" @click="changeCarouselPage(1)">›</button>
                <div class="carousel-slide-meta"><span class="carousel-slide-counter">{{ imageCarouselPageIndex + 1 }} / {{ imageCarouselTask.pages.length }}</span><label v-if="currentCarouselPage().status === 'succeeded'" class="carousel-result-select" :class="{ 'is-selected': currentCarouselPage().selected !== false }"><input type="checkbox" v-model="currentCarouselPage().selected"><span>{{ currentCarouselPage().selected === false ? '点击选用' : '已选用' }}</span></label></div>
              </div>
              <div v-else-if="shouldShowCarouselFailedEmpty()" class="carousel-task-failed-empty">
                <strong>轮播规划失败</strong>
                <span>{{ '[' + (imageCarouselTask.error_code || 'CAROUSEL_FAILED') + '] ' + (imageCarouselTask.error || 'Kimi 未返回可用分镜。') }}</span>
                <small>可以点击下方“重新开始”，或放弃轮播任务。</small>
              </div>
              <img v-else-if="shouldShowDirectGeneratedImage()" class="image-editor-generated-image" :src="imageSource(imageEditorGeneratedUrl)" alt="AI 生成结果">
              <div v-else class="image-editor-source-canvas"><img v-for="(image, sourceIndex) in galleryImageEditorSources(selectedTemuRecord)" :key="sourceIndex" :src="imageSource(image)" alt="待编辑图片"></div>
            </div>
            <div v-if="shouldShowFreshFusionControls()" class="carousel-controls">
              <label class="image-editor-prompt"><span>生成数量</span><input type="number" min="1" max="10" :value="imageCarouselCount" @input="handleCarouselCountInput($event)"></label>
              <label class="image-editor-prompt"><span>市场语言</span><input type="text" v-model="imageCarouselMarketLanguage" placeholder="美国 / English"></label>
              <button class="carousel-mode-note" :class="{ 'is-reasoning': imageCarouselReasoningEnabled }" type="button" :title="imageCarouselReasoningEnabled ? '推理模式，temperature 1；点击切换' : '不推理模式，temperature 0.6；点击切换'" :aria-label="imageCarouselReasoningEnabled ? '当前为推理模式，点击切换为不推理模式' : '当前为不推理模式，点击切换为推理模式'" @click="toggleCarouselReasoningMode"><i></i><span>{{ imageCarouselReasoningEnabled ? '推理模式' : '不推理模式' }}</span></button>
            </div>
            <label v-if="shouldShowDirectOrFreshFusionPrompt()" class="image-editor-prompt"><span>提示词</span><textarea v-model="imageEditorPrompt" rows="4" aria-label="图片编辑提示词"></textarea></label>
            <div v-if="shouldShowCarouselPageEditor()" class="carousel-page-editor">
              <label class="image-editor-prompt"><span>分镜 {{ imageCarouselPageIndex + 1 }} / {{ imageCarouselTask.pages.length }}</span><input type="text" v-model="currentCarouselPage().purpose" :readonly="currentCarouselPage().status === 'generating' || isCarouselPageBusy(imageCarouselPageIndex)" placeholder="页面用途（中文）"></label>
              <label class="image-editor-prompt"><span>提示词</span><textarea v-model="currentCarouselPage().prompt" :readonly="currentCarouselPage().status === 'generating' || isCarouselPageBusy(imageCarouselPageIndex)" rows="4" placeholder="完整生图提示词（中文）"></textarea></label>
            </div>
            <div v-if="imageEditorError" class="image-editor-error">{{ imageEditorError }}</div>
            <footer class="image-editor-actions"><div v-if="canEditCarouselPages()" class="carousel-page-actions"><button type="button" @click="removeCarouselPage(imageCarouselPageIndex)">删除当前分镜</button><button v-if="imageCarouselTask.pages.length < 10" type="button" @click="addCarouselPage">+ 添加分镜</button></div><button v-if="imageCarouselSourceMismatch" class="image-editor-cancel" type="button" @click="replaceExistingCarouselTask">放弃旧任务并使用当前图片</button><button v-else-if="shouldShowAbandonCarouselButton()" class="image-editor-cancel" type="button" @click="abandonCarouselTask">放弃轮播任务</button><button class="image-editor-cancel" type="button" @click="closeGalleryImageEditor">关闭</button><button v-if="shouldShowPrimaryImageEditorGenerateButton()" class="image-editor-generate" type="button" :disabled="isPrimaryImageEditorGenerateDisabled()" @click="submitGalleryImageEdit">{{ imageEditorGenerateButtonLabel() }}</button><button v-if="canStartCarouselImagesDirect()" class="image-editor-main-apply" type="button" :disabled="imageEditorBusy || defaultPromptDialogLoading || defaultPromptDialogBusy" @click="openDefaultPromptDialog">默认分镜生图</button><button v-if="canStartCarouselImagesDirect()" class="image-editor-generate" type="button" :disabled="imageEditorBusy || !imageEditorPrompt.trim()" @click="startCarouselPlan(false)">开始生成图片</button><button v-if="canRegenerateCarouselPages()" class="image-editor-generate" type="button" :disabled="imageCarouselGenerationBusy" @click="regenerateAllCarouselPages">{{ imageCarouselGenerationBusy ? '全部生成中…' : '全部重生' }}</button><button v-if="canRegenerateCarouselPages()" class="image-editor-generate" type="button" :disabled="isCarouselPageBusy(imageCarouselPageIndex) || currentCarouselPage().status === 'generating' || !String(currentCarouselPage().prompt || '').trim()" @click="regenerateCurrentCarouselPage">{{ isCarouselPageBusy(imageCarouselPageIndex) ? '单张生成中…' : '单独重生' }}</button><button v-if="canApplyCarouselReplacement(true)" class="image-editor-main-apply" type="button" title="跳过失败分镜，使用全部成功图片替换所有主图" @click="confirmCarouselReplacement(true)">替换所有主图</button><button v-if="canShowImageEditorConfirm()" class="image-editor-confirm" type="button" :disabled="imageEditorBusy || (imageCarouselTask ? !canApplyCarouselReplacement(false) : !imageEditorGeneratedUrl)" @click="confirmGalleryImageEdit">确认替换</button></footer>
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
        <div v-if="defaultPromptDialogOpen" class="image-editor-modal" @pointerdown.self="beginDefaultPromptBackdropPress" @pointerup="finishDefaultPromptBackdropPress" @pointercancel="cancelDefaultPromptBackdropPress">
          <section class="image-editor-dialog default-prompt-dialog" role="dialog" aria-modal="true" aria-label="默认分镜生图">
            <header class="image-editor-header"><div><strong>默认分镜生图</strong><span>读取并保存 server/default.prompt.json</span></div><button type="button" aria-label="关闭默认分镜生图" @click="closeDefaultPromptDialog">×</button></header>
            <div v-if="defaultPromptDialogLoading" class="image-editor-loading default-prompt-loading"><span></span><strong>正在读取默认分镜</strong><small>这些提示词会直接用于 Fusion 生图。</small></div>
            <div v-else class="default-prompt-list">
              <article v-for="(page, pageIndex) in defaultPromptPages" :key="page.local_id" class="default-prompt-card">
                <header><strong>分镜 {{ pageIndex + 1 }} 提示词</strong><button type="button" :disabled="defaultPromptPages.length <= 1 || defaultPromptDialogBusy" @click="removeDefaultPromptPage(pageIndex)">删除</button></header>
                <input type="text" v-model="page.purpose" autocomplete="off" placeholder="分镜名称，例如：卖点主图" :disabled="defaultPromptDialogBusy">
                <textarea v-model="page.prompt" rows="5" spellcheck="false" autocomplete="off" placeholder="输入这一张分镜的完整生图提示词" :disabled="defaultPromptDialogBusy"></textarea>
              </article>
              <button v-if="defaultPromptPages.length < 10" class="default-prompt-add" type="button" :disabled="defaultPromptDialogBusy" @click="addDefaultPromptPage">+ 添加分镜</button>
            </div>
            <div v-if="defaultPromptSavedText" class="miaoshou-export-result is-success">{{ defaultPromptSavedText }}</div>
            <div v-if="defaultPromptDialogError" class="image-editor-error">{{ defaultPromptDialogError }}</div>
            <footer class="image-editor-actions"><button class="image-editor-cancel" type="button" :disabled="defaultPromptDialogBusy" @click="closeDefaultPromptDialog">关闭</button><button class="image-editor-generate" type="button" :disabled="defaultPromptDialogLoading || defaultPromptDialogBusy" @click="reloadDefaultPromptPages">重新读取</button><button class="image-editor-generate" type="button" :disabled="defaultPromptDialogLoading || defaultPromptDialogBusy" @click="saveDefaultPromptPages">保存模板</button><button class="image-editor-main-apply" type="button" :disabled="defaultPromptDialogLoading || defaultPromptDialogBusy || imageEditorBusy" @click="generateDefaultPromptPages">{{ defaultPromptDialogBusy ? '提交中…' : '保存并生图' }}</button></footer>
          </section>
        </div>

      </main>
    </div>
  `,
  data: function createAppState() {
    const queryMode = new URLSearchParams(window.location.search).get("mode");
    const persistedViewState = readPersistedViewState();
    return {
      cloudAuth: {
        authorized: false,
        checking: true,
        busy: false,
        error: false,
        message: "正在校验云端授权。",
        accountName: "",
        macBound: false,
        lastSyncAt: "",
        configVersion: 0,
        configUpdated: false,
        workbenchStarted: false
      },
      cloudAuthAccessCode: "",
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
      restoreProgress: {
        active: false,
        status: "waiting",
        progress: 0,
        message: "等待选择备份文件。",
        error: ""
      },
      restoreProgressTimer: null,
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
      imageEditorContextStack: [],
      imageDirectTask: null,
      imageDirectTasksByMainId: {},
      imageDirectPollTimer: null,
      imageDirectIndicatorTimer: null,
      imageCarouselCount: 1,
      imageCarouselReviewOnly: true,
      imageCarouselMarketLanguage: "美国 / English",
      imageCarouselReasoningEnabled: false,
      imageCarouselTask: null,
      imageCarouselTasksByMainId: {},
      imageCarouselIgnoredTaskIds: {},
      imageCarouselPageBusyKeys: {},
      imageCarouselPageIndex: 0,
      imageCarouselGenerationBusy: false,
      imageCarouselEstimatedTokens: 0,
      imageCarouselSourceMismatch: false,
      imageCarouselPollTimer: null,
      imageCarouselIndicatorTimer: null,
      imageCarouselCancelBusy: false,
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
      skuBlendIndicatorAcknowledgements: readSkuBlendIndicatorAcknowledgements(),
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
      defaultPromptDialogOpen: false,
      defaultPromptDialogLoading: false,
      defaultPromptDialogBusy: false,
      defaultPromptPages: [],
      defaultPromptDialogError: "",
      defaultPromptSavedText: "",
      defaultPromptBackdropPressed: false,
      workflow: { active_temu_main_id: "", active_source_mode: "", tasks: {} },
      workflowTemporaryState: { updated_at: "", tasks: {} },
      workflowMode: "clip",
      workflowDefaultMode: "clip",
      workflowClipCandidateCount: 10,
      workflowLegacyCandidateCount: 4,
      workflowClipMinPrice: "",
      workflowClipMaxPrice: "",
      workflowClipKeyword: "",
      workflowClipLoading: {
        status: "waiting",
        stage: "waiting",
        progress: 0,
        message: "等待后台加载 CLIP。",
        error: ""
      },
      workflowClipStatusStarted: false,
      workflowClipStatusTimer: null,
      workflowClipRecoverPolls: 0,
      workflowSelectedImageUrl: "",
      workflowSelectedResultIndex: -1,
      workflowPrompts: [],
      workflowPromptDrafts: {},
      workflowPromptDialogOpen: false,
      workflowPromptDialogMode: "legacy",
      workflowBatchPromptPending: false,
      workflowCustomPromptDefault: "请结合当前 Temu 商品信息和图片，按照你认为最有销售价值的方向推荐 4 个可用于组货的商品。不要使用固定分类，候选方向由当前商品特征决定。",
      workflowClipPromptDefault: "",
      workflowCustomPromptDraft: "",
      workflowPromptDialogError: "",
      workflowPromptBusy: false,
      workflowPromptBusyKeys: {},
      workflowPendingModeKeys: {},
      workflowTaskErrorKeys: {},
      workflowIndicatorAcknowledgements: readWorkflowIndicatorAcknowledgements(),
      workflowGenerateBusy: false,
      workflowGenerateBusyKeys: {},
      workflowSearchBusyKeys: {},
      workflowClipTop10BusyKeys: {},
      workflowClipTop10BusyMainId: "",
      workflowStatusText: "等待选择 Temu 商品。",
      workflowStatusType: "normal",
      bulkActionsMenuOpen: false,
      bulkClipBusy: false,
      bulkClipCurrent: 0,
      bulkClipTotal: 0,
      bulkCoverBusy: false,
      bulkCoverCurrent: 0,
      bulkCoverTotal: 0,
      pendingCacheEvents: {},
      productSaveStates: {},
      copyFirstSkuAttributeBusyKeys: {},
      topbarCollapsed: false,
      topbarLastScrollY: 0,
      miaoshouExportDialogOpen: false,
      miaoshouExportMode: "",
      miaoshouCookieDraft: "",
      miaoshouExportError: "",
      miaoshouExportBusy: false,
      miaoshouExportProgress: 0,
      miaoshouExportProgressText: "",
      miaoshouExportProgressTimer: null,
      miaoshouExportResultType: "",
      miaoshouExportResultText: "",
      miaoshouSavedCookieReady: false,
      miaoshouSavedCookieLoading: false,
      miaoshouSavedCookieStatusText: ""
    };
  },
  /** Start cache subscription after the Vue view is mounted. */
  mounted: function mountedApp() {
    window.addEventListener("dragend", this.clearImageDragState, true);
    window.addEventListener("drop", this.clearImageDragState);
    window.addEventListener("blur", this.clearImageDragState);
    window.addEventListener("scroll", this.handleWindowScroll, { passive: true });
    document.addEventListener("click", this.closeBulkActionsMenu);
    this.topbarLastScrollY = Math.max(0, Number(window.scrollY) || 0);
    this.initializeCloudAuth();
  },
  /** Close the cache subscription before the Vue view is destroyed. */
  beforeUnmount: function cleanupRealtimeCache() {
    window.removeEventListener("dragend", this.clearImageDragState, true);
    window.removeEventListener("drop", this.clearImageDragState);
    window.removeEventListener("blur", this.clearImageDragState);
    window.removeEventListener("scroll", this.handleWindowScroll);
    document.removeEventListener("click", this.closeBulkActionsMenu);
    if (this.workflowClipStatusTimer) {
      window.clearTimeout(this.workflowClipStatusTimer);
      this.workflowClipStatusTimer = null;
    }
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
    if (this.restoreProgressTimer) {
      window.clearTimeout(this.restoreProgressTimer);
      this.restoreProgressTimer = null;
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
      return this.workflowTaskForMode(this.selectedTemuMainId, this.workflowMode);
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
    /** Apply one cloud authorization status object to the visible login state. */
    applyCloudAuthStatus: function applyCloudAuthStatus(data) {
      const status = data && typeof data === "object" ? data : {};
      this.cloudAuth.authorized = Boolean(status.authorized);
      this.cloudAuth.accountName = String(status.accountName || "");
      this.cloudAuth.macBound = Boolean(status.macBound);
      this.cloudAuth.lastSyncAt = String(status.lastSyncAt || "");
      this.cloudAuth.configVersion = Number(status.configVersion || 0);
      this.cloudAuth.configUpdated = Boolean(status.configUpdated);
    },

    /** Start the original workbench data subscriptions after cloud authorization succeeds. */
    startAuthorizedWorkbench: function startAuthorizedWorkbench() {
      if (this.cloudAuth.workbenchStarted) {
        return;
      }
      this.cloudAuth.workbenchStarted = true;
      this.loadImageEditConfig();
      this.loadWorkflowPayload();
      this.refreshDirectImageTaskIndicators();
      this.refreshCarouselTaskIndicators();
      this.refreshSkuBlendTaskIndicators();
      this.startClipLoadingReview();
      if (this.renderMode === "realtime") {
        this.startRealtimeCache();
      }
    },

    /** Check the saved local credential against Cloudflare when the page opens. */
    initializeCloudAuth: async function initializeCloudAuth() {
      this.cloudAuth.checking = true;
      this.cloudAuth.error = false;
      this.cloudAuth.message = "正在校验云端授权。";
      try {
        const response = await fetch(apiUrl("/cloud-auth/status"), { cache: "no-store" });
        /** Return null when the authorization status body is not valid JSON. */
        const payload = await response.json().catch(function handleCloudAuthStatusJsonError() {
          return null;
        });
        if (!response.ok || !payload || payload.ok === false) {
          throw new Error(getApiErrorMessage(payload, "请先输入访问码完成授权。"));
        }
        const data = readApiData(payload) || {};
        this.applyCloudAuthStatus(data);
        if (!data.authorized) {
          this.cloudAuth.message = data.message || "请输入访问码完成授权。";
          return;
        }
        this.cloudAuth.message = data.configUpdated ? "授权成功，云端配置已更新；下次启动完全生效。" : "授权成功，配置已是最新版本。";
        this.startAuthorizedWorkbench();
      } catch (error) {
        this.cloudAuth.authorized = false;
        this.cloudAuth.error = true;
        this.cloudAuth.message = String(error && error.message || "云端授权失败，请输入访问码。");
      } finally {
        this.cloudAuth.checking = false;
      }
    },

    /** Login with the typed access code after hashing it in the browser. */
    loginCloudAuth: async function loginCloudAuth() {
      const accessCode = String(this.cloudAuthAccessCode || "").trim();
      if (!accessCode) {
        this.cloudAuth.error = true;
        this.cloudAuth.message = "请输入访问码。";
        return;
      }
      this.cloudAuth.busy = true;
      this.cloudAuth.error = false;
      this.cloudAuth.message = "正在验证访问码并同步云端配置。";
      try {
        const accessHash = await hashAccessCode(accessCode);
        const response = await fetch(apiUrl("/cloud-auth/login"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ accessHash: accessHash })
        });
        /** Return null when the authorization login body is not valid JSON. */
        const payload = await response.json().catch(function handleCloudAuthLoginJsonError() {
          return null;
        });
        if (!response.ok || !payload || payload.ok === false) {
          throw new Error(getApiErrorMessage(payload, "授权登录失败。"));
        }
        const data = readApiData(payload) || {};
        this.applyCloudAuthStatus(data);
        this.cloudAuthAccessCode = "";
        this.cloudAuth.message = data.configUpdated ? "登录成功，云端配置已更新；下次启动完全生效。" : "登录成功，配置已是最新版本。";
        this.startAuthorizedWorkbench();
      } catch (error) {
        this.cloudAuth.authorized = false;
        this.cloudAuth.error = true;
        this.cloudAuth.message = String(error && error.message || "授权登录失败。");
      } finally {
        this.cloudAuth.busy = false;
      }
    },

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

    /** Open the default storyboard editor and load server/default.prompt.json. */
    openDefaultPromptDialog: function openDefaultPromptDialog() {
      if (!this.canStartCarouselImagesDirect()) {
        return;
      }
      this.defaultPromptDialogOpen = true;
      this.defaultPromptBackdropPressed = false;
      this.reloadDefaultPromptPages();
    },

    /** Close the default storyboard editor when no save or submit is running. */
    closeDefaultPromptDialog: function closeDefaultPromptDialog() {
      if (this.defaultPromptDialogBusy) {
        return;
      }
      this.defaultPromptDialogOpen = false;
      this.defaultPromptDialogError = "";
      this.defaultPromptSavedText = "";
      this.defaultPromptBackdropPressed = false;
    },

    /** Remember that a default-prompt close gesture started on the empty backdrop. */
    beginDefaultPromptBackdropPress: function beginDefaultPromptBackdropPress() {
      this.defaultPromptBackdropPressed = true;
    },

    /** Close the default-prompt popup only when press and release both hit the backdrop. */
    finishDefaultPromptBackdropPress: function finishDefaultPromptBackdropPress(event) {
      const shouldClose = this.defaultPromptBackdropPressed
        && event && event.target === event.currentTarget;
      this.defaultPromptBackdropPressed = false;
      if (shouldClose) {
        this.closeDefaultPromptDialog();
      }
    },

    /** Cancel one incomplete default-prompt backdrop gesture without closing. */
    cancelDefaultPromptBackdropPress: function cancelDefaultPromptBackdropPress() {
      this.defaultPromptBackdropPressed = false;
    },

    /** Build one stable local editor row for a storyboard prompt page. */
    createDefaultPromptPageDraft: function createDefaultPromptPageDraft(page, index) {
      const source = page && typeof page === "object" ? page : {};
      return {
        local_id: "default-prompt-" + Date.now().toString(36) + "-" + String(index || 0) + "-" + Math.random().toString(36).slice(2, 8),
        purpose: String(source.purpose || "分镜" + (Number(index || 0) + 1)),
        prompt: String(source.prompt || "")
      };
    },

    /** Apply backend storyboard prompt pages to the popup draft list. */
    applyDefaultPromptPages: function applyDefaultPromptPages(pages) {
      const sourcePages = Array.isArray(pages) && pages.length ? pages : [{ purpose: "分镜1", prompt: "" }];
      const drafts = [];
      for (let index = 0; index < sourcePages.length; index += 1) {
        drafts.push(this.createDefaultPromptPageDraft(sourcePages[index], index));
      }
      this.defaultPromptPages = drafts;
    },

    /** Reload manually configured storyboard prompts from the backend. */
    reloadDefaultPromptPages: function reloadDefaultPromptPages() {
      if (this.defaultPromptDialogLoading || this.defaultPromptDialogBusy) {
        return;
      }
      this.defaultPromptDialogLoading = true;
      this.defaultPromptDialogError = "";
      this.defaultPromptSavedText = "";
      const view = this;
      fetch(apiUrl("/config/default-prompts"), { cache: "no-store" }).then(function handleDefaultPromptResponse(response) {
        return response.json().then(function validateDefaultPromptPayload(payload) {
          if (!response.ok || !payload.ok) {
            throw new Error(getApiErrorMessage(payload, "默认分镜读取失败。"));
          }
          return payload.data || {};
        });
      }).then(function applyDefaultPromptPayload(data) {
        view.applyDefaultPromptPages(data.pages);
      }).catch(function handleDefaultPromptError(error) {
        view.defaultPromptDialogError = error.message || "默认分镜读取失败。";
        if (!view.defaultPromptPages.length) {
          view.applyDefaultPromptPages([]);
        }
      }).finally(function finishDefaultPromptLoad() {
        view.defaultPromptDialogLoading = false;
      });
    },

    /** Collect non-empty storyboard prompts from the popup draft list. */
    collectDefaultPromptPages: function collectDefaultPromptPages() {
      const pages = [];
      for (let index = 0; index < this.defaultPromptPages.length; index += 1) {
        const prompt = String(this.defaultPromptPages[index].prompt || "").trim();
        if (prompt) {
          pages.push({
            purpose: String(this.defaultPromptPages[index].purpose || "分镜" + (pages.length + 1)).trim(),
            prompt: prompt
          });
        }
      }
      if (!pages.length) {
        throw new Error("至少填写 1 条默认分镜提示词。");
      }
      return pages;
    },

    /** Add one empty storyboard prompt row to the popup. */
    addDefaultPromptPage: function addDefaultPromptPage() {
      if (this.defaultPromptPages.length >= 10) {
        return;
      }
      this.defaultPromptPages.push(this.createDefaultPromptPageDraft({ purpose: "分镜" + (this.defaultPromptPages.length + 1), prompt: "" }, this.defaultPromptPages.length));
    },

    /** Remove one storyboard prompt row while keeping at least one row. */
    removeDefaultPromptPage: function removeDefaultPromptPage(pageIndex) {
      if (this.defaultPromptPages.length <= 1) {
        return;
      }
      this.defaultPromptPages.splice(Number(pageIndex), 1);
    },

    /** Persist storyboard prompt pages into server/default.prompt.json. */
    async requestSaveDefaultPromptPages(pages) {
      const response = await fetch(apiUrl("/config/default-prompts"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pages: pages })
      });
      const payload = await response.json();
      if (!response.ok || !payload || !payload.ok) {
        throw new Error(getApiErrorMessage(payload, "默认分镜保存失败。"));
      }
      return payload.data || {};
    },

    /** Save the default storyboard template without starting image generation. */
    async saveDefaultPromptPages() {
      if (this.defaultPromptDialogBusy || this.defaultPromptDialogLoading) {
        return;
      }
      this.defaultPromptDialogBusy = true;
      this.defaultPromptDialogError = "";
      this.defaultPromptSavedText = "";
      try {
        const data = await this.requestSaveDefaultPromptPages(this.collectDefaultPromptPages());
        this.applyDefaultPromptPages(data.pages);
        this.defaultPromptSavedText = "默认分镜已保存到 server/default.prompt.json。";
        this.setStatus("默认分镜已保存。", "success");
      } catch (error) {
        this.defaultPromptDialogError = error.message || "默认分镜保存失败。";
      } finally {
        this.defaultPromptDialogBusy = false;
      }
    },

    /** Save manual storyboard prompts, create a ready task, and start Fusion generation. */
    async generateDefaultPromptPages() {
      const record = this.selectedTemuRecord;
      const sources = this.galleryImageEditorSources(record);
      if (!record || sources.length !== 2 || this.imageEditorBusy || this.imageCarouselTask) {
        this.defaultPromptDialogError = "请先选择两张图片，并确保当前没有未完成轮播任务。";
        return;
      }
      const requestId = Number(this.imageEditorRequestId);
      let pages;
      try {
        pages = this.collectDefaultPromptPages();
      } catch (error) {
        this.defaultPromptDialogError = error.message || "默认分镜不能为空。";
        return;
      }
      this.defaultPromptDialogBusy = true;
      this.defaultPromptDialogError = "";
      this.defaultPromptSavedText = "";
      this.imageEditorBusy = true;
      this.imageEditorRestoreMainId = String(record.main_id || "");
      this.imageCarouselReviewOnly = false;
      this.imageCarouselEstimatedTokens = 0;
      this.imageEditorError = "";
      this.persistViewState();
      try {
        const saved = await this.requestSaveDefaultPromptPages(pages);
        this.applyDefaultPromptPages(saved.pages);
        const savedPages = Array.isArray(saved.pages) && saved.pages.length ? saved.pages : pages;
        const response = await fetch(apiUrl("/workflow/carousel/manual"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mode: "carousel",
            temu_main_id: record.main_id,
            temu_platform_id: record.platform_id,
            image_urls: sources,
            source_indices: this.galleryEditSelection.slice(),
            gallery_snapshot: this.galleryImages(record).slice(),
            market_language: String(this.imageCarouselMarketLanguage || "美国 / English"),
            pages: savedPages,
            size: this.imageEditSize
          })
        });
        const payload = await response.json();
        if (!response.ok || !payload || !payload.ok) {
          throw new Error(getApiErrorMessage(payload, "默认分镜任务提交失败。"));
        }
        const task = payload.data && payload.data.task ? payload.data.task : null;
        if (!task) {
          throw new Error("后台没有返回默认分镜任务。");
        }
        if (!this.isImageEditorRequestCurrent(requestId)) {
          this.rememberCarouselTask(task);
          return;
        }
        this.applyCarouselTaskSnapshot(task);
        this.imageCarouselCount = Number(task.count || savedPages.length);
        this.defaultPromptDialogOpen = false;
        this.imageEditorBusy = false;
        await this.generateCarouselPages();
      } catch (error) {
        if (this.isImageEditorRequestCurrent(requestId)) {
          this.defaultPromptDialogError = error.message || "默认分镜生图失败。";
          this.imageEditorError = "[" + getWorkflowErrorCode(error) + "] " + (error.message || "默认分镜生图失败。");
        }
        if (this.isImageEditorRequestCurrent(requestId) && !this.imageCarouselTask) {
          this.imageEditorRestoreMainId = "";
          this.persistViewState();
        }
      } finally {
        if (this.isImageEditorRequestCurrent(requestId) || !this.defaultPromptDialogOpen) {
          this.defaultPromptDialogBusy = false;
        }
        if (this.isImageEditorRequestCurrent(requestId)) {
          this.imageEditorBusy = false;
        }
      }
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

    /** Apply one backend CLIP loading snapshot to the dedicated progress bar. */
    applyClipLoadingStatus: function applyClipLoadingStatus(status) {
      const source = status && typeof status === "object" ? status : {};
      this.workflowClipLoading.status = String(source.status || "waiting");
      this.workflowClipLoading.stage = String(source.stage || "waiting");
      this.workflowClipLoading.progress = Math.max(0, Math.min(100, Math.round(Number(source.progress) || 0)));
      this.workflowClipLoading.message = String(source.message || "正在加载 CLIP。");
      this.workflowClipLoading.error = String(source.error || "");
      if (this.workflowClipLoading.status !== "error") {
        this.workflowClipRecoverPolls = 0;
      }
    },

    /** Return whether a late CLIP failure may still recover after slow model loading. */
    shouldRecoverClipLoadingStatus: function shouldRecoverClipLoadingStatus() {
      if (this.workflowClipLoading.status !== "error") {
        return false;
      }
      return this.workflowClipLoading.progress >= 22 && this.workflowClipRecoverPolls < 60;
    },

    /** Schedule the next CLIP loading status read without overlapping requests. */
    scheduleClipLoadingStatusPoll: function scheduleClipLoadingStatusPoll(delayMs) {
      const view = this;
      if (this.workflowClipStatusTimer) {
        window.clearTimeout(this.workflowClipStatusTimer);
      }
      this.workflowClipStatusTimer = window.setTimeout(function pollClipLoadingStatusLater() {
        view.workflowClipStatusTimer = null;
        view.pollClipLoadingStatus();
      }, Math.max(250, Number(delayMs || 700)));
    },

    /** Read real CLIP startup progress until the worker becomes ready or fails. */
    pollClipLoadingStatus: function pollClipLoadingStatus() {
      const view = this;
      fetch(apiUrl("/clip/status"), { cache: "no-store" }).then(function parseClipLoadingStatus(response) {
        return response.json().then(function validateClipLoadingStatus(payload) {
          if (!response.ok || !payload || payload.ok === false) {
            throw new Error(getApiErrorMessage(payload, "CLIP 状态读取失败。"));
          }
          return payload;
        });
      }).then(function applyClipLoadingStatusPayload(payload) {
        const data = readApiData(payload) || {};
        view.applyClipLoadingStatus(data.status);
        if (view.workflowClipLoading.status !== "ready") {
          if (view.workflowClipLoading.status === "error" && !view.shouldRecoverClipLoadingStatus()) {
            return;
          }
          if (view.workflowClipLoading.status === "error") {
            view.workflowClipRecoverPolls += 1;
          }
          view.scheduleClipLoadingStatusPoll(view.workflowClipLoading.status === "error" ? 5000 : 700);
        }
      }).catch(function retryClipLoadingStatus() {
        view.scheduleClipLoadingStatusPoll(1500);
      });
    },

    /** Start status review and ask the backend to warm CLIP after the webpage is ready. */
    startClipLoadingReview: function startClipLoadingReview() {
      if (this.workflowClipStatusStarted) {
        return;
      }
      this.workflowClipStatusStarted = true;
      this.pollClipLoadingStatus();
      fetch(apiUrl("/clip/warmup"), { method: "POST" }).catch(function retainWarmupFailureInStatusLog() {
        return;
      });
    },

    /** Switch the intelligent-packing result source without changing the surrounding UI. */
    setWorkflowMode: function setWorkflowMode(mode) {
      this.workflowMode = mode === "legacy" ? "legacy" : "clip";
      this.syncWorkflowSelection();
    },

    /** Normalize one workflow mode name for separated old/new cache lookup. */
    normalizeWorkflowMode: function normalizeWorkflowMode(mode) {
      return mode === "legacy" ? "legacy" : "clip";
    },

    /** Build the cache key used for one Temu product under one workflow mode. */
    workflowTaskKey: function workflowTaskKey(temuMainId, mode) {
      const mainId = String(temuMainId || "").trim();
      return mainId ? mainId + "::" + this.normalizeWorkflowMode(mode) : "";
    },

    /** Return whether one cached workflow task belongs to the requested separated mode. */
    isWorkflowTaskForMode: function isWorkflowTaskForMode(task, mode) {
      if (!task || typeof task !== "object") {
        return false;
      }
      const sourceMode = this.normalizeWorkflowMode(mode);
      const taskMode = task.source_mode ? this.normalizeWorkflowMode(task.source_mode) : "legacy";
      return taskMode === sourceMode;
    },

    /** Return the mode-specific workflow task while honoring old naked keys by source mode. */
    workflowTaskForMode: function workflowTaskForMode(temuMainId, mode) {
      const mainId = String(temuMainId || "").trim();
      const sourceMode = this.normalizeWorkflowMode(mode);
      const tasks = this.workflow && this.workflow.tasks ? this.workflow.tasks : {};
      if (!mainId) {
        return null;
      }
      const separatedTask = tasks[this.workflowTaskKey(mainId, sourceMode)];
      if (separatedTask && typeof separatedTask === "object") {
        separatedTask.source_mode = sourceMode;
        return separatedTask;
      }
      const nakedTask = tasks[mainId];
      return this.isWorkflowTaskForMode(nakedTask, sourceMode) ? nakedTask : null;
    },

    /** Return every separated workflow task retained for one Temu product. */
    workflowTasksForProduct: function workflowTasksForProduct(temuMainId) {
      const mainId = String(temuMainId || "").trim();
      const tasks = [];
      const clipTask = this.workflowTaskForMode(mainId, "clip");
      const legacyTask = this.workflowTaskForMode(mainId, "legacy");
      if (clipTask) {
        tasks.push(clipTask);
      }
      if (legacyTask && legacyTask !== clipTask) {
        tasks.push(legacyTask);
      }
      return tasks;
    },

    /** Return the temporary refresh-safe task state for the chosen workflow mode. */
    workflowTemporaryTaskForMode: function workflowTemporaryTaskForMode(temuMainId, mode) {
      const mainId = String(temuMainId || "").trim();
      const sourceMode = this.normalizeWorkflowMode(mode);
      const tasks = this.workflowTemporaryState && this.workflowTemporaryState.tasks ? this.workflowTemporaryState.tasks : {};
      if (!mainId) {
        return {};
      }
      const separatedTask = tasks[this.workflowTaskKey(mainId, sourceMode)];
      if (separatedTask && typeof separatedTask === "object") {
        separatedTask.source_mode = sourceMode;
        return separatedTask;
      }
      const nakedTask = tasks[mainId];
      return this.isWorkflowTaskForMode(nakedTask, sourceMode) ? nakedTask : {};
    },

    /** Return every refresh-safe temporary workflow state retained for one Temu product. */
    workflowTemporaryTasksForProduct: function workflowTemporaryTasksForProduct(temuMainId) {
      const mainId = String(temuMainId || "").trim();
      const tasks = [];
      const clipTask = this.workflowTemporaryTaskForMode(mainId, "clip");
      const legacyTask = this.workflowTemporaryTaskForMode(mainId, "legacy");
      if (clipTask && clipTask.status) {
        tasks.push(clipTask);
      }
      if (legacyTask && legacyTask.status && legacyTask !== clipTask) {
        tasks.push(legacyTask);
      }
      return tasks;
    },

    /** Return whether one refresh-safe temporary workflow state is still running. */
    isWorkflowTemporaryTaskRunning: function isWorkflowTemporaryTaskRunning(task) {
      const status = String(task && task.status || "");
      return status === "analyzing" || status === "generating";
    },

    /** Return whether one Temu product has a refresh-safe running workflow state. */
    hasRunningWorkflowTemporaryTask: function hasRunningWorkflowTemporaryTask(record) {
      const tasks = this.workflowTemporaryTasksForProduct(record && record.main_id);
      for (let index = 0; index < tasks.length; index += 1) {
        if (this.isWorkflowTemporaryTaskRunning(tasks[index])) {
          return true;
        }
      }
      return false;
    },

    /** Return whether one Temu product has a refresh-safe failed workflow state. */
    hasWorkflowTemporaryTaskError: function hasWorkflowTemporaryTaskError(record) {
      const tasks = this.workflowTemporaryTasksForProduct(record && record.main_id);
      for (let index = 0; index < tasks.length; index += 1) {
        if (String(tasks[index] && tasks[index].status || "") === "error") {
          return true;
        }
      }
      return false;
    },

    /** Start the selected workflow mode after letting the user confirm its prompt. */
    startWorkflowAction: function startWorkflowAction() {
      if (this.bulkClipBusy) {
        return;
      }
      this.openWorkflowPromptDialog(this.workflowMode);
    },

    /** Toggle the compact batch-action menu beside the cache button. */
    toggleBulkActionsMenu: function toggleBulkActionsMenu() {
      this.bulkActionsMenuOpen = !this.bulkActionsMenuOpen;
    },

    /** Close the compact batch-action menu after an outside selection. */
    closeBulkActionsMenu: function closeBulkActionsMenu() {
      this.bulkActionsMenuOpen = false;
    },

    /** Return whether any single-product workflow is currently analyzing or generating. */
    hasAnyWorkflowOperationBusy: function hasAnyWorkflowOperationBusy() {
      if (this.workflowPromptBusy || this.workflowGenerateBusy || this.workflowClipTop10BusyMainId) {
        return true;
      }
      const records = this.temuRecords;
      for (let index = 0; index < records.length; index += 1) {
        const mainId = String(records[index].main_id || "");
        if (this.workflowPromptBusyKeys[mainId] || this.workflowGenerateBusyKeys[mainId] || this.hasRunningWorkflowTemporaryTask(records[index])) {
          return true;
        }
      }
      return false;
    },

    /** Return the same saved or primary source image used by the existing CLIP workflow. */
    workflowSourceImageForRecord: function workflowSourceImageForRecord(record) {
      if (!record) {
        return "";
      }
      const task = this.workflowTaskForMode(record.main_id, "clip");
      const images = this.galleryImages(record);
      return String(task && task.selected_image_url || record.main_image_url || images[0] || "");
    },

    /** Open one shared CLIP prompt for every Temu product in the left rail. */
    openBulkClipPrompt: function openBulkClipPrompt() {
      this.closeBulkActionsMenu();
      if (this.bulkClipBusy || this.hasAnyWorkflowOperationBusy()) {
        this.setStatus("已有商品任务正在运行，请完成后再执行全部重新 CLIP。", "normal");
        return;
      }
      if (!this.temuRecords.length) {
        this.setStatus("没有可重新组货的 Temu 商品。", "normal");
        return;
      }
      const task = this.selectedTemuRecord ? this.workflowTaskForMode(this.selectedTemuRecord.main_id, "clip") : null;
      const rawSavedPrompt = task ? String(task.custom_prompt || "").trim() : "";
      const legacyManualKeyword = task ? String(task.manual_keyword || "").trim() : "";
      const savedPrompt = this.cleanClipUserPrompt(rawSavedPrompt === legacyManualKeyword ? "" : rawSavedPrompt);
      this.workflowMode = "clip";
      this.workflowPromptDialogMode = "clip";
      this.workflowBatchPromptPending = true;
      this.workflowCustomPromptDraft = savedPrompt || this.workflowClipPromptDefault;
      this.workflowPromptDialogError = "";
      this.workflowPromptDialogOpen = true;
    },

    /** Apply one workflow state snapshot and refresh the selected task. */
    applyWorkflowPayload: function applyWorkflowPayload(payload) {
      const state = payload && payload.workflow ? payload.workflow : payload;
      const temporaryState = payload && payload.state ? payload.state : { updated_at: "", tasks: {} };
      this.workflow = state && typeof state === "object" ? state : { active_temu_main_id: "", active_source_mode: "", tasks: {} };
      this.workflowTemporaryState = temporaryState && typeof temporaryState === "object" ? temporaryState : { updated_at: "", tasks: {} };
      this.resumePendingWorkflowGenerations();
      const task = this.selectedWorkflowTask;
      if (task && Array.isArray(task.prompts) && !this.workflowPromptBusy) {
        this.syncWorkflowPrompts(task);
      }
      if (task && !this.workflowPromptBusy) {
        const statusType = task.status === "completed" || task.status === "images_ready" || task.status === "clip_ready"
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
        const taskKey = String(taskIds[index]);
        const task = tasks[taskKey];
        const mainId = String(task && task.temu_main_id || taskKey).split("::")[0];
        if (task && task.source_mode === "clip") {
          continue;
        }
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
        this.workflow = { active_temu_main_id: "", active_source_mode: "", tasks: {} };
      }
      if (!this.workflow.tasks || typeof this.workflow.tasks !== "object") {
        this.workflow.tasks = {};
      }
      const sourceMode = this.normalizeWorkflowMode(task.source_mode || this.workflowMode);
      task.temu_main_id = String(temuMainId || task.temu_main_id || "");
      task.source_mode = sourceMode;
      this.workflow.tasks[this.workflowTaskKey(task.temu_main_id, sourceMode)] = task;
    },

    /** Normalize one CLIP candidate identity fragment for duplicate filtering. */
    normalizeWorkflowClipDuplicateValue: function normalizeWorkflowClipDuplicateValue(value) {
      return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
    },

    /** Build duplicate keys for one cached CLIP candidate. */
    buildWorkflowClipDuplicateKeys: function buildWorkflowClipDuplicateKeys(item) {
      const source = item && typeof item === "object" ? item : {};
      const product = source.clip_product && typeof source.clip_product === "object" ? source.clip_product : {};
      const keys = [];
      const productId = this.normalizeWorkflowClipDuplicateValue(product.id || product.product_id || product.offer_id || product.item_id);
      const imageUrl = this.normalizeWorkflowClipDuplicateValue(source.image_url || product.img_url || product.image_url || product.MAINIMAGE || product.local_img);
      const familyKey = this.normalizeWorkflowClipDuplicateValue(product.family_key || product.listing_key);
      const title = this.normalizeWorkflowClipDuplicateValue(source.product_name || product.title || product.listing_text || product.title_en);
      if (productId) {
        keys.push("id:" + productId);
      }
      if (imageUrl) {
        keys.push("image:" + imageUrl);
      }
      if (familyKey) {
        keys.push("family:" + familyKey);
      }
      if (title) {
        keys.push("title:" + title);
      }
      return keys;
    },

    /** Return whether one cached CLIP candidate should be skipped as a duplicate. */
    isDuplicateWorkflowClipCandidate: function isDuplicateWorkflowClipCandidate(item, seenKeys) {
      const keys = this.buildWorkflowClipDuplicateKeys(item);
      for (let index = 0; index < keys.length; index += 1) {
        if (seenKeys[keys[index]]) {
          return true;
        }
      }
      for (let index = 0; index < keys.length; index += 1) {
        seenKeys[keys[index]] = true;
      }
      return false;
    },

    /** Restore the inline workflow controls for the selected Temu record. */
    syncWorkflowSelection: function syncWorkflowSelection() {
      const record = this.selectedTemuRecord;
      const images = this.workflowSourceImages;
      this.workflowPromptDrafts = {};
      this.workflowSearchBusyKeys = {};
      const selectedMainId = String(record && record.main_id || "");
      if (this.workflowPendingModeKeys[selectedMainId]) {
        this.workflowMode = this.workflowPendingModeKeys[selectedMainId];
      }
      const task = this.workflowTaskForMode(selectedMainId, this.workflowMode);
      const temporaryTask = this.workflowTemporaryTaskForMode(selectedMainId, this.workflowMode);
      this.workflowPromptBusy = Boolean(this.workflowPromptBusyKeys[selectedMainId]) || temporaryTask.status === "analyzing";
      this.workflowGenerateBusy = Boolean(this.workflowGenerateBusyKeys[selectedMainId]) || temporaryTask.status === "generating";
      this.workflowSelectedImageUrl = task && task.selected_image_url ? task.selected_image_url : record && record.main_image_url ? record.main_image_url : images[0] || "";
      this.workflowSelectedResultIndex = task && Number.isFinite(Number(task.selected_result_index)) ? Number(task.selected_result_index) : -1;
      if (!selectedMainId) {
        this.workflowMode = this.workflowDefaultMode;
      }
      this.syncWorkflowPrompts(task);
      this.setWorkflowStatus(this.workflowPromptBusy ? "Kimi 正在后台分析当前商品…" : task && task.status !== "idle" ? this.workflowTaskStatusText(this.selectedTemuMainId) : record ? "已选择 Temu 商品，请确认分析主图。" : "等待选择 Temu 商品。", "normal");
      if (task && task.status === "prompts_ready" && Array.isArray(task.prompts) && task.prompts.length === 4 && !this.workflowPromptBusy && !this.workflowGenerateBusy) {
        this.generateWorkflowImages(undefined, selectedMainId, task.prompts);
      }
    },

    /** Copy persisted workflow prompts into editable page-local objects. */
    syncWorkflowPrompts: function syncWorkflowPrompts(task) {
      const visibleMode = this.normalizeWorkflowMode(this.workflowMode);
      const taskMode = task && task.source_mode ? this.normalizeWorkflowMode(task.source_mode) : "legacy";
      if (task && taskMode !== visibleMode) {
        this.workflowPrompts = [];
        return;
      }
      const source = task && Array.isArray(task.prompts) ? task.prompts : [];
      const prompts = [];
      const seenClipKeys = {};
      for (let index = 0; index < source.length; index += 1) {
        const promptKey = String(index);
        const hasDraft = Object.prototype.hasOwnProperty.call(this.workflowPromptDrafts, promptKey);
        const sourceItem = source[index] || {};
        const itemMode = sourceItem.source_mode ? this.normalizeWorkflowMode(sourceItem.source_mode) : taskMode;
        if (itemMode !== visibleMode) {
          continue;
        }
        if (itemMode === "clip" && this.isDuplicateWorkflowClipCandidate(sourceItem, seenClipKeys)) {
          continue;
        }
        const clipProduct = sourceItem.clip_product && typeof sourceItem.clip_product === "object" ? sourceItem.clip_product : {};
        const clipPrompt = String(clipProduct.search_prompt || "");
        const rawPrice = sourceItem.price_label || clipProduct.price_usd || clipProduct.price || "";
        const numericPrice = Number(rawPrice);
        const priceLabel = sourceItem.price_label
          ? String(sourceItem.price_label)
          : rawPrice === "" ? "" : Number.isFinite(numericPrice) ? "$" + numericPrice.toFixed(2) : String(rawPrice);
        const rawSales = sourceItem.sales_label || (clipProduct.sales_total === undefined || clipProduct.sales_total === null ? clipProduct.sales : clipProduct.sales_total);
        const salesLabel = sourceItem.sales_label
          ? String(sourceItem.sales_label)
          : rawSales === undefined || rawSales === null || rawSales === "" ? "" : "销量 " + String(rawSales);
        prompts.push({
          relation: String(sourceItem.relation || ""),
          product_name: String(sourceItem.product_name || ""),
          product_intro: String(itemMode === "clip" && clipPrompt ? clipPrompt : sourceItem.product_intro || sourceItem.product_name || ""),
          prompt: hasDraft ? this.workflowPromptDrafts[promptKey] : String(sourceItem.prompt || ""),
          clip_prompt_en: String(sourceItem.clip_prompt_en || clipProduct.search_prompt_en || ""),
          source_mode: itemMode,
          price_label: priceLabel,
          sales_label: salesLabel,
          image_url: String(sourceItem.image_url || ""),
          clip_top10: Boolean(sourceItem.clip_top10),
          clip_top10_query: String(sourceItem.clip_top10_query || ""),
          image_load_error: false,
          status: String(sourceItem.status || ""),
          error: String(sourceItem.error || ""),
          error_code: String(sourceItem.error_code || ""),
          error_status: Number(sourceItem.error_status || 0),
          search_url: String(sourceItem.search_url || ""),
          search_status: this.workflowSearchBusyKeys[promptKey] ? "searching" : String(sourceItem.search_status || ""),
          search_error: String(sourceItem.search_error || "")
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

    /** Clear one CLIP candidate image failure flag after the browser loads it. */
    handleWorkflowResultImageLoad: function handleWorkflowResultImageLoad(item) {
      if (item && typeof item === "object") {
        item.image_load_error = false;
      }
    },

    /** Mark one CLIP candidate image as failed without removing its searchable URL. */
    handleWorkflowResultImageError: function handleWorkflowResultImageError(item) {
      if (item && typeof item === "object") {
        item.image_load_error = true;
      }
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

    /** Open the custom prompt dialog for the requested old or new workflow mode. */
    openWorkflowPromptDialog: function openWorkflowPromptDialog(mode) {
      if (this.bulkClipBusy) {
        return;
      }
      if (this.hasWorkflowClipTop10Lock()) {
        this.setWorkflowStatus("已有 CLIP Top10 正在检索，请等当前结果返回。", "normal");
        return;
      }
      if (!this.selectedTemuRecord || !this.workflowSelectedImageUrl || this.workflowPromptBusy) {
        return;
      }
      const sourceMode = this.normalizeWorkflowMode(mode);
      const task = this.workflowTaskForMode(this.selectedTemuRecord.main_id, sourceMode);
      const rawSavedPrompt = task ? String(task.custom_prompt || "").trim() : "";
      const legacyManualKeyword = task ? String(task.manual_keyword || "").trim() : "";
      const savedPrompt = sourceMode === "clip"
        ? this.cleanClipUserPrompt(rawSavedPrompt === legacyManualKeyword ? "" : rawSavedPrompt)
        : rawSavedPrompt;
      const defaultPrompt = sourceMode === "clip" ? this.workflowClipPromptDefault : this.workflowCustomPromptDefault;
      this.workflowPromptDialogMode = sourceMode;
      this.workflowCustomPromptDraft = savedPrompt || defaultPrompt;
      this.workflowPromptDialogError = "";
      this.workflowPromptDialogOpen = true;
    },

    /** Remove legacy CLIP system prompts from the user-editable prompt box. */
    cleanClipUserPrompt: function cleanClipUserPrompt(prompt) {
      const text = String(prompt || "").trim();
      if (!text) {
        return "";
      }
      const looksLikeSystemPrompt = text.indexOf("你是跨境电商组货商品检索词生成器") >= 0
        || (text.indexOf("只返回合法 JSON 对象") >= 0 && text.indexOf("prompts") >= 0);
      return looksLikeSystemPrompt ? "" : text;
    },

    /** Open the retained legacy custom direction prompt for compatibility callers. */
    generateWorkflowPrompts: function generateWorkflowPrompts() {
      this.openWorkflowPromptDialog("legacy");
    },

    /** Close the custom direction prompt without starting a Kimi request. */
    closeWorkflowPromptDialog: function closeWorkflowPromptDialog() {
      this.workflowPromptDialogOpen = false;
      this.workflowPromptDialogError = "";
      this.workflowBatchPromptPending = false;
    },

    /** Request and persist CLIP candidates for one explicit Temu product. */
    requestClipWorkflowForRecord: async function requestClipWorkflowForRecord(record, imageUrl, customPrompt, options) {
      if (!record || !imageUrl) {
        throw new Error("商品没有可用于 CLIP 组货的主图。");
      }
      const settings = options && typeof options === "object" ? options : {};
      const timeoutMs = Math.max(0, Number(settings.timeoutMs || 0));
      const requestController = timeoutMs ? new AbortController() : null;
      const requestTimeout = requestController ? window.setTimeout(requestController.abort.bind(requestController), timeoutMs) : null;
      const kimiPrompt = String(customPrompt || this.workflowClipPromptDefault || "").trim();
      const requestedTemuMainId = String(record.main_id);
      this.workflowPromptBusyKeys[requestedTemuMainId] = true;
      this.workflowPendingModeKeys[requestedTemuMainId] = "clip";
      this.workflowMode = "clip";
      delete this.workflowTaskErrorKeys[requestedTemuMainId];
      this.workflowPromptDrafts = {};
      if (String(this.selectedTemuMainId) === requestedTemuMainId) {
        this.workflowPromptBusy = true;
        this.setWorkflowStatus("CLIP 正在分析商品并检索真实候选…", "normal");
      }
      try {
        const payload = await requestWorkflowJson(workflowApiUrl("/workflow/clip/assemble"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: requestController ? requestController.signal : undefined,
          body: JSON.stringify({
            temu_main_id: record.main_id,
            image_url: imageUrl,
            custom_prompt: kimiPrompt,
            min_price: settings.minPrice === undefined ? this.workflowClipMinPrice : settings.minPrice,
            max_price: settings.maxPrice === undefined ? this.workflowClipMaxPrice : settings.maxPrice,
            product: {
              title: record.product_name,
              category: record.product_category,
              attributes: record.attributes_json,
              price_reference: getWorkflowPriceReference(record)
            }
          })
        });
        this.storeWorkflowTask(requestedTemuMainId, payload.task);
        delete this.workflowTaskErrorKeys[requestedTemuMainId];
        if (String(this.selectedTemuMainId) === requestedTemuMainId) {
          this.workflowSelectedResultIndex = -1;
          this.syncWorkflowPrompts(payload.task);
          this.setWorkflowStatus("CLIP 已返回 " + this.workflowPrompts.length + " 个真实候选，点击搜索按钮走 1688 搜图。", "success");
        }
        return payload.task;
      } catch (error) {
        const failure = error && error.name === "AbortError" ? new Error("CLIP 组货请求超时，已继续处理其他商品。") : error;
        this.workflowTaskErrorKeys[requestedTemuMainId] = true;
        if (String(this.selectedTemuMainId) === requestedTemuMainId) {
          this.setWorkflowStatus("CLIP 组货失败：" + failure.message, "error");
        }
        throw failure;
      } finally {
        if (requestTimeout) {
          window.clearTimeout(requestTimeout);
        }
        delete this.workflowPromptBusyKeys[requestedTemuMainId];
        delete this.workflowPendingModeKeys[requestedTemuMainId];
        if (String(this.selectedTemuMainId) === requestedTemuMainId) {
          this.workflowPromptBusy = false;
        }
      }
    },

    /** Request real-product CLIP candidates through the existing single-product path. */
    generateClipWorkflowCandidates: async function generateClipWorkflowCandidates(customPrompt) {
      if (this.bulkClipBusy || this.hasWorkflowClipTop10Lock()) {
        this.setWorkflowStatus("已有批量任务或 CLIP Top10 正在运行，请等待当前任务完成。", "normal");
        return;
      }
      if (!this.selectedTemuRecord || !this.workflowSelectedImageUrl || this.workflowPromptBusy) {
        return;
      }
      try {
        await this.requestClipWorkflowForRecord(this.selectedTemuRecord, this.workflowSelectedImageUrl, customPrompt);
      } catch (error) {
        return;
      }
    },

    /** Run one product inside the concurrent CLIP batch and advance settled progress. */
    runBulkClipRecord: async function runBulkClipRecord(record, customPrompt, requestOptions) {
      const imageUrl = this.workflowSourceImageForRecord(record);
      try {
        await this.requestClipWorkflowForRecord(record, imageUrl, customPrompt, requestOptions);
        return true;
      } catch (error) {
        return false;
      } finally {
        this.bulkClipCurrent += 1;
      }
    },

    /** Dispatch every confirmed CLIP request with the existing cross-product concurrency. */
    runBulkClipWorkflows: async function runBulkClipWorkflows(customPrompt) {
      if (this.bulkClipBusy || this.hasAnyWorkflowOperationBusy()) {
        this.setStatus("已有商品任务正在运行，请完成后再执行全部重新 CLIP。", "normal");
        return;
      }
      const records = this.temuRecords.slice();
      this.bulkClipBusy = true;
      this.bulkClipCurrent = 0;
      this.bulkClipTotal = records.length;
      const requestOptions = { minPrice: this.workflowClipMinPrice, maxPrice: this.workflowClipMaxPrice, timeoutMs: 150000 };
      try {
        const requests = [];
        for (let index = 0; index < records.length; index += 1) {
          requests.push(this.runBulkClipRecord(records[index], customPrompt, requestOptions));
        }
        const results = await Promise.all(requests);
        let succeeded = 0;
        for (let index = 0; index < results.length; index += 1) {
          if (results[index]) {
            succeeded += 1;
          }
        }
        const failed = records.length - succeeded;
        this.setStatus("全部重新 CLIP 完成：成功 " + succeeded + "，失败 " + failed + "，总数 " + records.length + "。", failed ? "error" : "success");
      } finally {
        this.bulkClipBusy = false;
      }
    },

    /** Request two manually matched CLIP candidates from one user-entered keyword. */
    searchClipWorkflowCandidates: function searchClipWorkflowCandidates() {
      const keyword = String(this.workflowClipKeyword || "").trim();
      if (this.hasWorkflowClipTop10Lock()) {
        this.setWorkflowStatus("已有 CLIP Top10 正在检索，请等当前结果返回。", "normal");
        return;
      }
      if (!this.selectedTemuRecord || !keyword || this.workflowPromptBusy) {
        return;
      }
      this.workflowPromptBusy = true;
      const requestedTemuMainId = String(this.selectedTemuRecord.main_id);
      this.workflowPromptBusyKeys[requestedTemuMainId] = true;
      this.workflowPendingModeKeys[requestedTemuMainId] = "clip";
      this.workflowMode = "clip";
      delete this.workflowTaskErrorKeys[requestedTemuMainId];
      this.workflowPromptDrafts = {};
      this.setWorkflowStatus("CLIP 正在按 keyword 手动匹配 2 个候选…", "normal");
      const view = this;
      requestWorkflowJson(workflowApiUrl("/workflow/clip/search"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          temu_main_id: this.selectedTemuRecord.main_id,
          image_url: this.workflowSelectedImageUrl,
          keyword: keyword,
          min_price: this.workflowClipMinPrice,
          max_price: this.workflowClipMaxPrice
        })
      }).then(function handleClipManualSearchSuccess(payload) {
        view.storeWorkflowTask(requestedTemuMainId, payload.task);
        delete view.workflowTaskErrorKeys[requestedTemuMainId];
        if (String(view.selectedTemuMainId) === requestedTemuMainId) {
          view.workflowSelectedResultIndex = -1;
          view.syncWorkflowPrompts(payload.task);
          const clipQuery = String(payload.task && payload.task.clip_search_query || keyword).trim();
          view.setWorkflowStatus("手动 CLIP 已返回 " + view.workflowPrompts.length + " 个真实候选，实际检索：" + clipQuery, "success");
        }
      }).catch(function handleClipManualSearchError(error) {
        view.workflowTaskErrorKeys[requestedTemuMainId] = true;
        if (String(view.selectedTemuMainId) === requestedTemuMainId) {
          view.setWorkflowStatus("手动 CLIP 匹配失败：" + error.message, "error");
        }
      }).finally(function finishClipManualSearchRequest() {
        delete view.workflowPromptBusyKeys[requestedTemuMainId];
        delete view.workflowPendingModeKeys[requestedTemuMainId];
        if (String(view.selectedTemuMainId) === requestedTemuMainId) {
          view.workflowPromptBusy = false;
        }
      });
    },

    /** Request four custom intelligent-packing directions for the selected Temu product. */
    submitWorkflowPrompts: function submitWorkflowPrompts() {
      if (this.hasWorkflowClipTop10Lock()) {
        this.setWorkflowStatus("已有 CLIP Top10 正在检索，请等当前结果返回。", "normal");
        return;
      }
      if (this.workflowPromptBusy || (!this.workflowBatchPromptPending && (!this.selectedTemuRecord || !this.workflowSelectedImageUrl))) {
        return;
      }
      const customPrompt = String(this.workflowCustomPromptDraft || "").trim();
      if (!customPrompt) {
        this.workflowPromptDialogError = "请输入组货提示词。";
        return;
      }
      if (this.workflowBatchPromptPending) {
        const total = this.temuRecords.length;
        if (!window.confirm("确认使用当前提示词为左侧全部 " + total + " 个 Temu 商品重新执行 CLIP 组货？")) {
          return;
        }
        this.workflowPromptDialogOpen = false;
        this.workflowPromptDialogError = "";
        this.workflowBatchPromptPending = false;
        this.runBulkClipWorkflows(customPrompt);
        return;
      }
      if (this.normalizeWorkflowMode(this.workflowPromptDialogMode) === "clip") {
        this.workflowPromptDialogOpen = false;
        this.workflowPromptDialogError = "";
        this.generateClipWorkflowCandidates(customPrompt);
        return;
      }
      this.workflowPromptBusy = true;
      const requestedTemuMainId = String(this.selectedTemuRecord.main_id);
      this.workflowPromptBusyKeys[requestedTemuMainId] = true;
      this.workflowPendingModeKeys[requestedTemuMainId] = "legacy";
      this.workflowMode = "legacy";
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
        delete view.workflowPendingModeKeys[requestedTemuMainId];
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
          const separatedTask = tasks[this.workflowTaskKey(requestedTemuMainId, "legacy")];
          const nakedTask = tasks[requestedTemuMainId];
          const task = separatedTask || (this.isWorkflowTaskForMode(nakedTask, "legacy") ? nakedTask : null);
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

    /** Return the English CLIP keyword attached to one visible candidate. */
    workflowClipTop10Keyword: function workflowClipTop10Keyword(item) {
      const source = item && typeof item === "object" ? item : {};
      return String(source.clip_prompt_en || source.clip_top10_query || "").trim();
    },

    /** Return whether another product owns the active CLIP Top10 request. */
    hasWorkflowClipTop10Lock: function hasWorkflowClipTop10Lock() {
      return Boolean(this.workflowClipTop10BusyMainId && String(this.selectedTemuMainId) !== String(this.workflowClipTop10BusyMainId));
    },

    /** Replace visible CLIP candidates with the top 10 matches for one candidate keyword. */
    searchWorkflowClipTop10: function searchWorkflowClipTop10(index) {
      const resultIndex = Number(index);
      const resultKey = String(resultIndex);
      const result = this.workflowPrompts[resultIndex];
      const keyword = this.workflowClipTop10Keyword(result);
      const requestedTemuMainId = String(this.selectedTemuRecord && this.selectedTemuRecord.main_id || "");
      if (this.workflowClipTop10BusyMainId) {
        this.setWorkflowStatus("已有 CLIP Top10 正在检索，请等当前结果返回。", "normal");
        return;
      }
      if (this.workflowClipTop10BusyKeys[resultKey] || resultIndex < 0 || !this.selectedTemuRecord || !keyword) {
        return;
      }
      this.workflowClipTop10BusyMainId = requestedTemuMainId;
      this.workflowClipTop10BusyKeys[resultKey] = true;
      this.workflowPromptBusy = true;
      this.workflowPromptBusyKeys[requestedTemuMainId] = true;
      this.workflowPendingModeKeys[requestedTemuMainId] = "clip";
      delete this.workflowTaskErrorKeys[requestedTemuMainId];
      this.setWorkflowStatus("正在用 EN 关键词跑 CLIP Top10：" + keyword, "normal");
      const view = this;
      requestWorkflowJson(workflowApiUrl("/workflow/clip/top10"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          keyword: keyword,
          min_price: this.workflowClipMinPrice,
          max_price: this.workflowClipMaxPrice
        })
      }).then(function handleClipTop10Success(payload) {
        const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
        if (!candidates.length) {
          throw new Error("CLIP Top10 没有返回候选。");
        }
        const currentTask = view.workflowTaskForMode(requestedTemuMainId, "clip");
        if (currentTask) {
          currentTask.status = "clip_ready";
          currentTask.prompts = candidates;
          currentTask.selected_result_index = -1;
          currentTask.clip_top10_query = String(payload.query || keyword);
        }
        delete view.workflowTaskErrorKeys[requestedTemuMainId];
        if (String(view.selectedTemuMainId) === requestedTemuMainId) {
          view.workflowPrompts = candidates;
          view.workflowSelectedResultIndex = -1;
          view.setWorkflowStatus("CLIP Top10 已返回 " + candidates.length + " 个候选。", "success");
        }
      }).catch(function handleClipTop10Error(error) {
        view.workflowTaskErrorKeys[requestedTemuMainId] = true;
        if (String(view.selectedTemuMainId) === requestedTemuMainId) {
          view.setWorkflowStatus("CLIP Top10 失败：" + error.message, "error");
        }
      }).finally(function finishClipTop10Request() {
        view.workflowClipTop10BusyKeys[resultKey] = false;
        if (String(view.workflowClipTop10BusyMainId) === requestedTemuMainId) {
          view.workflowClipTop10BusyMainId = "";
        }
        delete view.workflowPromptBusyKeys[requestedTemuMainId];
        delete view.workflowPendingModeKeys[requestedTemuMainId];
        if (String(view.selectedTemuMainId) === requestedTemuMainId) {
          view.workflowPromptBusy = false;
        }
      });
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
      this.setWorkflowStatus("正在提交第 " + (resultIndex + 1) + " 张候选图到 search-1688…", "normal");
      const view = this;
      this.request1688ImageSearch(result.image_url, requestedTemuMainId, this.workflowMode).then(function handleWorkflowSearchSuccess(payload) {
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
        view.setWorkflowStatus("第 " + (resultIndex + 1) + " 张候选图已打开 1688 搜款页。", "success");
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
      const task = this.workflowTaskForMode(temuMainId, this.workflowMode);
      const statuses = {
        idle: "等待开始",
        prompts_ready: "提示词已就绪",
        clip_ready: "CLIP 候选已就绪",
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
        const workflowConfig = payload && payload.data && payload.data.workflow ? payload.data.workflow : {};
        view.workflowDefaultMode = workflowConfig.default_mode === "legacy" ? "legacy" : "clip";
        view.workflowMode = view.workflowDefaultMode;
        view.workflowClipCandidateCount = Math.max(1, Number(workflowConfig.clip_candidate_count || 10));
        view.workflowLegacyCandidateCount = Math.max(1, Number(workflowConfig.legacy_candidate_count || 4));
        view.workflowClipPromptDefault = String(workflowConfig.clip_kimi_prompt || view.workflowClipPromptDefault);
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
      if (this.bulkClipBusy || this.bulkCoverBusy) {
        this.setStatus("批量任务运行中，暂时不能删除商品。", "normal");
        return;
      }
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
      if (this.bulkClipBusy || this.bulkCoverBusy) {
        return;
      }
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

    /** Return whether one image URL points to the server-side local image cache. */
    isLocalCachedImageUrl: function isLocalCachedImageUrl(url) {
      const source = String(url || "").trim();
      return source.indexOf("/api/v1/cache/image/") === 0 || /^https?:\/\/[^/]+\/api\/v1\/cache\/image\//i.test(source);
    },

    /** Upload one image to 1688 and return the search identifier and result URL. */
    request1688ImageSearch: function request1688ImageSearch(imageUrl, temuMainId, sourceMode) {
      const body = {
        image_url: String(imageUrl || ""),
        temu_main_id: String(temuMainId || "")
      };
      if (sourceMode) {
        body.source_mode = this.normalizeWorkflowMode(sourceMode);
      }
      return requestWorkflowJson(apiUrl("/images/search-1688"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
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

    /** Build one stable signature for settled SKU blend indicators under one product. */
    skuBlendIndicatorSignature: function skuBlendIndicatorSignature(record) {
      const rows = record && Array.isArray(record.sku) ? record.sku : [];
      const parts = [];
      for (let index = 0; index < rows.length; index += 1) {
        const key = this.getSkuBlendKey(record, rows[index], index);
        const task = this.skuBlendTasksByKey[key] || {};
        const undoToken = String(this.imageFusionUndoTokens[key] || "");
        const errorText = String(this.imageEditErrorKeys[key] || "");
        if (!undoToken && !errorText && !task.id) {
          continue;
        }
        parts.push(key);
        parts.push(String(task.id || ""));
        parts.push(String(task.status || ""));
        parts.push(String(task.image_url || ""));
        parts.push(String(task.error_code || ""));
        parts.push(undoToken);
        parts.push(errorText);
      }
      return parts.join("|");
    },

    /** Return whether the current settled SKU blend indicator was already opened. */
    isSkuBlendIndicatorAcknowledged: function isSkuBlendIndicatorAcknowledged(record) {
      if (!record || this.hasSkuBlendTask(record)) {
        return false;
      }
      const mainId = String(record.main_id || "");
      const signature = this.skuBlendIndicatorSignature(record);
      return Boolean(signature && this.skuBlendIndicatorAcknowledgements[mainId] === signature);
    },

    /** Record that the user opened the current settled SKU blend indicator. */
    acknowledgeSkuBlendIndicator: function acknowledgeSkuBlendIndicator(record) {
      if (!record || this.hasSkuBlendTask(record)) {
        return;
      }
      const mainId = String(record.main_id || "");
      const signature = this.skuBlendIndicatorSignature(record);
      if (!signature) {
        return;
      }
      this.skuBlendIndicatorAcknowledgements[mainId] = signature;
      try {
        window.localStorage.setItem(SKU_BLEND_INDICATOR_ACK_STORAGE_KEY, JSON.stringify(this.skuBlendIndicatorAcknowledgements));
      } catch (error) {
        return;
      }
    },

    /** Return whether any SKU under one product has a retained image-service error. */
    hasSkuBlendError: function hasSkuBlendError(record) {
      if (this.isSkuBlendIndicatorAcknowledged(record)) {
        return false;
      }
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
      if (this.isSkuBlendIndicatorAcknowledged(record)) {
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
      this.acknowledgeSkuBlendIndicator(record);
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

    /** Return the compact error code shown by one SKU fusion failure button. */
    skuBlendErrorCode: function skuBlendErrorCode(record, sku, index) {
      const key = this.getSkuBlendKey(record, sku, index);
      const rawText = String(this.imageEditErrorKeys[key] || "");
      const bracketMatch = rawText.match(/^\[([^\]]+)\]/);
      const rawCode = bracketMatch ? bracketMatch[1] : rawText;
      return this.skuBlendErrorCodeFromValue(rawCode || rawText);
    },

    /** Normalize one raw SKU fusion error value into the shortest useful code. */
    skuBlendErrorCodeFromValue: function skuBlendErrorCodeFromValue(value) {
      const rawText = String(value || "").trim();
      const statusMatch = rawText.match(/([1-5]\d{2})(?!\d)/);
      if (statusMatch) {
        return statusMatch[1];
      }
      return rawText || "ERR";
    },

    /** Return whether one SKU fusion state button is waiting for any server response. */
    isSkuBlendActionBusy: function isSkuBlendActionBusy(record, sku, index) {
      return this.isSkuBlendBusy(record, sku, index) || this.isSkuFusionUndoBusy(record, sku, index);
    },

    /** Return whether one SKU should expose the compact fusion state button. */
    shouldShowSkuBlendAction: function shouldShowSkuBlendAction(record, sku, index) {
      const key = this.getSkuBlendKey(record, sku, index);
      return this.skuImageUrls(sku).length === 2
        || Boolean(this.imageEditBusyKeys[key])
        || Boolean(this.imageEditErrorKeys[key])
        || this.hasSkuFusionUndo(record, sku, index)
        || this.isSkuFusionUndoBusy(record, sku, index);
    },

    /** Return the visual state class for one compact SKU fusion button. */
    skuBlendActionClass: function skuBlendActionClass(record, sku, index) {
      const key = this.getSkuBlendKey(record, sku, index);
      if (this.isSkuBlendActionBusy(record, sku, index)) {
        return "is-busy";
      }
      if (this.imageEditErrorKeys[key]) {
        return "is-error";
      }
      if (this.hasSkuFusionUndo(record, sku, index)) {
        return "is-restore";
      }
      return "is-ready";
    },

    /** Return the wordless icon class for one compact SKU fusion button. */
    skuBlendActionIconClass: function skuBlendActionIconClass(record, sku, index) {
      const key = this.getSkuBlendKey(record, sku, index);
      if (this.imageEditErrorKeys[key]) {
        return "is-error-symbol";
      }
      if (this.hasSkuFusionUndo(record, sku, index)) {
        return "is-restore-symbol";
      }
      return "is-star-symbol";
    },

    /** Return the hover text for one compact SKU fusion button. */
    skuBlendActionTitle: function skuBlendActionTitle(record, sku, index) {
      const key = this.getSkuBlendKey(record, sku, index);
      if (this.imageEditErrorKeys[key]) {
        return this.skuBlendErrorCode(record, sku, index);
      }
      if (this.isSkuBlendBusy(record, sku, index)) {
        return "生成中";
      }
      if (this.isSkuFusionUndoBusy(record, sku, index)) {
        return "恢复中";
      }
      if (this.hasSkuFusionUndo(record, sku, index)) {
        return "恢复原图";
      }
      return "溶图";
    },

    /** Route one compact SKU fusion button click by its current state. */
    handleSkuBlendAction: function handleSkuBlendAction(record, sku, index) {
      const key = this.getSkuBlendKey(record, sku, index);
      if (this.isSkuBlendActionBusy(record, sku, index)) {
        return;
      }
      if (this.imageEditErrorKeys[key]) {
        delete this.imageEditErrorKeys[key];
        this.blendSkuImages(record, sku, index);
        return;
      }
      if (this.hasSkuFusionUndo(record, sku, index)) {
        this.undoSkuImageFusion(record, sku, index);
        return;
      }
      this.blendSkuImages(record, sku, index);
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
          const requestError = new Error(getApiErrorMessage(payload, "溶图任务创建失败。"));
          requestError.code = getApiErrorCode(payload, response.status || "SKU_BLEND_FAILED");
          requestError.statusCode = response.status;
          throw requestError;
        }
        const task = payload.data && payload.data.task ? payload.data.task : localTask;
        this.applySkuBlendTask(task);
        await this.refreshSkuBlendTaskIndicators();
      } catch (error) {
        const errorCode = this.skuBlendErrorCodeFromValue(getWorkflowErrorCode(error));
        this.imageEditBusyKeys[busyKey] = false;
        this.imageEditErrorKeys[busyKey] = "[" + errorCode + "]";
        this.setStatus("溶图失败：" + errorCode, "error");
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
    replaceDetailsWithGallery: function replaceDetailsWithGallery(record, options) {
      const settings = options && typeof options === "object" ? options : {};
      if (this.bulkCoverBusy && !settings.allowBulk) {
        return false;
      }
      const images = this.galleryImages(record).slice();
      if (!record || !images.length) {
        if (!settings.silent) {
          this.setStatus("当前商品没有可用于覆盖详情的主图。", "error");
        }
        return false;
      }
      record.detail_image_urls = images;
      this.saveProductModule(record, "images");
      if (!settings.silent) {
        this.setStatus("已使用全部主图覆盖商品详情。", "success");
      }
      return true;
    },

    /** Confirm and start one serial detail-image overwrite for every Temu product. */
    startBulkDetailCover: function startBulkDetailCover() {
      this.closeBulkActionsMenu();
      if (this.bulkCoverBusy) {
        return;
      }
      const total = this.temuRecords.length;
      if (!total || !window.confirm("确认使用每个商品的全部主图覆盖左侧 " + total + " 个 Temu 商品的详情图？")) {
        return;
      }
      this.runBulkDetailCover();
    },

    /** Reuse the single-product overwrite and await each product save in rail order. */
    runBulkDetailCover: async function runBulkDetailCover() {
      const records = this.temuRecords.slice();
      this.bulkCoverBusy = true;
      this.bulkCoverCurrent = 0;
      this.bulkCoverTotal = records.length;
      let succeeded = 0;
      let failed = 0;
      try {
        for (let index = 0; index < records.length; index += 1) {
          this.bulkCoverCurrent = index + 1;
          const record = records[index];
          try {
            if (!this.replaceDetailsWithGallery(record, { allowBulk: true, silent: true })) {
              throw new Error("商品没有可用于覆盖详情的主图。");
            }
            await this.waitForProductSaveIdle(record);
            succeeded += 1;
          } catch (error) {
            failed += 1;
          }
        }
      } finally {
        this.bulkCoverBusy = false;
        this.setStatus("全部主图覆盖完成：成功 " + succeeded + "，失败 " + failed + "，总数 " + records.length + "。", failed ? "error" : "success");
      }
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

    /** Update the visible backup-restore progress state. */
    setRestoreProgress: function setRestoreProgress(progress, message, status, error) {
      if (this.restoreProgressTimer) {
        window.clearTimeout(this.restoreProgressTimer);
        this.restoreProgressTimer = null;
      }
      this.restoreProgress.active = true;
      this.restoreProgress.progress = Math.max(0, Math.min(100, Math.round(Number(progress || 0))));
      this.restoreProgress.message = String(message || "正在恢复备份。");
      this.restoreProgress.status = String(status || "running");
      this.restoreProgress.error = String(error || "");
    },

    /** Hide the completed backup-restore progress bar after the user can see the result. */
    closeRestoreProgressSoon: function closeRestoreProgressSoon() {
      const view = this;
      if (this.restoreProgressTimer) {
        window.clearTimeout(this.restoreProgressTimer);
      }
      /** Clear the progress bar after the final state has remained visible briefly. */
      this.restoreProgressTimer = window.setTimeout(function hideRestoreProgress() {
        view.restoreProgress.active = false;
        view.restoreProgressTimer = null;
      }, 1400);
    },

    /** Convert one binary file chunk to base64 without loading the whole backup. */
    arrayBufferToBase64: function arrayBufferToBase64(buffer) {
      const bytes = new Uint8Array(buffer);
      const step = 0x8000;
      let binary = "";
      for (let index = 0; index < bytes.length; index += step) {
        const chunk = bytes.subarray(index, Math.min(index + step, bytes.length));
        binary += String.fromCharCode.apply(null, chunk);
      }
      return window.btoa(binary);
    },

    /** Upload one restore chunk and return the backend envelope data. */
    uploadRestoreChunk: function uploadRestoreChunk(uploadId, fileName, chunkIndex, totalChunks, chunkBase64, onUploaded) {
      /** Send one small restore body so large backups never use one huge POST. */
      return new Promise(function sendRestoreChunk(resolve, reject) {
        const xhr = new XMLHttpRequest();
        /** Resolve one parsed chunk response after the server accepts it. */
        xhr.onload = function handleRestoreChunkLoad() {
          let payload = null;
          try {
            payload = JSON.parse(String(xhr.responseText || ""));
          } catch (error) {
            reject(new Error("恢复分片接口返回不是有效 JSON。"));
            return;
          }
          if (xhr.status < 200 || xhr.status >= 300 || !payload || !payload.ok) {
            reject(new Error(getApiErrorMessage(payload, "恢复分片上传失败。")));
            return;
          }
          resolve(payload.data || {});
        };
        /** Reject the current chunk when the browser cannot reach the server. */
        xhr.onerror = function handleRestoreChunkError() {
          reject(new Error("恢复分片发送失败，请确认本地服务正在运行。"));
        };
        /** Mark the final chunk as delivered before the server starts heavy restore work. */
        xhr.upload.onload = function handleRestoreChunkUploaded() {
          if (typeof onUploaded === "function") {
            onUploaded();
          }
        };
        xhr.open("POST", apiUrl("/restore/chunk"));
        xhr.setRequestHeader("Content-Type", "text/plain; charset=utf-8");
        xhr.setRequestHeader("X-Restore-Upload-Id", String(uploadId || ""));
        xhr.setRequestHeader("X-Restore-File-Name", encodeURIComponent(String(fileName || "")));
        xhr.setRequestHeader("X-Restore-Chunk-Index", String(chunkIndex));
        xhr.setRequestHeader("X-Restore-Total-Chunks", String(totalChunks));
        xhr.send(String(chunkBase64 || ""));
      });
    },

    /** Restore one prepared server-side record batch and return its progress. */
    restorePreparedBatch: function restorePreparedBatch(uploadId) {
      /** Parse one restore batch response and surface API errors. */
      function handleRestoreBatchResponse(response) {
        /** Validate one batch response before the next restore batch is requested. */
        return response.json().then(function validateRestoreBatchPayload(payload) {
          if (!response.ok || !payload || !payload.ok) {
            throw new Error(getApiErrorMessage(payload, "恢复批次处理失败。"));
          }
          return payload.data || {};
        });
      }
      const requestOptions = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          upload_id: String(uploadId || ""),
          batch_size: RESTORE_RECORD_BATCH_SIZE
        })
      };
      return fetch(apiUrl("/restore/batch"), requestOptions).then(handleRestoreBatchResponse);
    },

    /** Restore every prepared server-side record batch with visible product progress. */
    restorePreparedBatches: async function restorePreparedBatches(uploadId, totalRecords) {
      const count = Math.max(0, Number(totalRecords || 0));
      let result = null;
      if (!count) {
        throw new Error("JSON 中没有找到商品数组。");
      }
      while (!result || !result.done) {
        const processed = result ? Number(result.processed_records || 0) : 0;
        const baseProgress = 88 + Math.round((processed / count) * 10);
        this.setRestoreProgress(Math.min(98, baseProgress), "正在恢复商品 " + processed + "/" + count + "。", "running", "");
        result = await this.restorePreparedBatch(uploadId);
        const nextProcessed = Math.max(processed, Number(result.processed_records || 0));
        const nextProgress = 88 + Math.round((nextProcessed / count) * 10);
        this.setRestoreProgress(Math.min(98, nextProgress), "正在恢复商品 " + nextProcessed + "/" + count + "。", "running", "");
      }
      if (!result.workbench) {
        throw new Error("恢复批次已完成，但服务器没有返回完整工作台数据。");
      }
      return result.workbench;
    },

    /** Read and upload a backup file in small sequential chunks. */
    restoreFileInChunks: async function restoreFileInChunks(file) {
      const totalSize = Number(file && file.size || 0);
      if (!file || totalSize <= 0) {
        throw new Error("备份文件为空。");
      }
      const uploadId = (window.crypto && typeof window.crypto.randomUUID === "function")
        ? window.crypto.randomUUID()
        : String(Date.now()) + "-" + Math.random().toString(36).slice(2);
      const totalChunks = Math.max(1, Math.ceil(totalSize / RESTORE_UPLOAD_CHUNK_SIZE));
      let finalPayload = null;
      for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex += 1) {
        const start = chunkIndex * RESTORE_UPLOAD_CHUNK_SIZE;
        const end = Math.min(start + RESTORE_UPLOAD_CHUNK_SIZE, totalSize);
        const chunkNumber = chunkIndex + 1;
        const baseProgress = Math.round((start / totalSize) * 88);
        this.setRestoreProgress(Math.max(1, baseProgress), "正在读取分片 " + chunkNumber + "/" + totalChunks + "。", "running", "");
        const buffer = await file.slice(start, end).arrayBuffer();
        const chunkBase64 = this.arrayBufferToBase64(buffer);
        this.setRestoreProgress(Math.max(2, baseProgress), "正在上传分片 " + chunkNumber + "/" + totalChunks + "。", "running", "");
        /** Mark final upload completion before the server prepares record batches. */
        function markRestoreChunkUploaded() {
          if (chunkIndex === totalChunks - 1) {
            this.setRestoreProgress(88, "分片已传完，服务器正在准备分批恢复。", "running", "");
          }
        }
        finalPayload = await this.uploadRestoreChunk(uploadId, file.name, chunkIndex, totalChunks, chunkBase64, markRestoreChunkUploaded.bind(this));
        const uploadedProgress = 2 + Math.round((end / totalSize) * 86);
        if (finalPayload && finalPayload.prepared) {
          this.setRestoreProgress(88, "服务器准备完成，开始分批恢复商品。", "running", "");
        } else {
          this.setRestoreProgress(Math.min(88, uploadedProgress), "已上传 " + chunkNumber + "/" + totalChunks + " 个分片。", "running", "");
        }
      }
      if (!finalPayload || !finalPayload.prepared || !finalPayload.upload_id) {
        throw new Error("恢复分片已上传，但服务器没有准备好分批恢复任务。");
      }
      return this.restorePreparedBatches(finalPayload.upload_id, finalPayload.total_records);
    },

    /** Submit one extension-exported JSON file to the backend restore API. */
    handleRestoreFile: function handleRestoreFile(event) {
      const input = event.target;
      const file = input && input.files ? input.files[0] : null;
      if (!file || this.restoreProgress.active) {
        if (input) {
          input.value = "";
        }
        return;
      }
      const view = this;
      this.setRestoreProgress(1, "正在准备分段恢复。", "running", "");
      this.setStatus("正在分段上传备份文件。", "normal");
      this.restoreFileInChunks(file).then(function applyRestoreViewModel(payload) {
        view.setRestoreProgress(96, "正在刷新工作台。", "running", "");
        view.applyCachePayload(payload);
        view.workspaceMode = "realtime";
        view.persistViewState();
        view.setRestoreProgress(100, "恢复完成。", "success", "");
        view.setStatus("扩展 JSON 已恢复到服务器。", "success");
        view.closeRestoreProgressSoon();
      }).catch(function handleRestoreError(error) {
        const message = error.message || "恢复失败。";
        view.setRestoreProgress(100, "恢复失败。", "error", message);
        view.setStatus(message, "error");
        view.closeRestoreProgressSoon();
      });
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
      this.imageEditorRequestId += 1;
      this.resetImageEditorContextStack();
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
      if (this.imageEditorRecordKey === this.imageRecordKey(record)
        && (sources.length !== this.galleryEditSelection.length || !this.galleryEditSelection.length)
        && Array.isArray(this.imageEditorSourceUrls)
        && this.imageEditorSourceUrls.length) {
        return this.imageEditorSourceUrls.slice();
      }
      return sources;
    },

    /** Remove every stored editor context from the local stack. */
    resetImageEditorContextStack: function resetImageEditorContextStack() {
      this.imageEditorContextStack = [];
    },

    /** Capture the current image editor source context before entering a task state. */
    captureImageEditorContext: function captureImageEditorContext(reason) {
      return {
        reason: String(reason || "image-editor"),
        galleryEditRecordKey: String(this.galleryEditRecordKey || ""),
        galleryEditSelection: this.galleryEditSelection.slice(),
        imageEditorSourceType: String(this.imageEditorSourceType || "gallery"),
        imageEditorSourceUrls: this.galleryImageEditorSources(this.selectedTemuRecord).slice(),
        imageEditorDetailIndex: Number(this.imageEditorDetailIndex),
        imageEditorRecordKey: String(this.imageEditorRecordKey || ""),
        imageEditorPrompt: String(this.imageEditorPrompt || ""),
        imageCarouselCount: Number(this.imageCarouselCount || 1),
        imageCarouselReviewOnly: Boolean(this.imageCarouselReviewOnly),
        imageCarouselMarketLanguage: String(this.imageCarouselMarketLanguage || "美国 / English"),
        imageCarouselReasoningEnabled: Boolean(this.imageCarouselReasoningEnabled),
        imageEditorRestoreMainId: String(this.imageEditorRestoreMainId || "")
      };
    },

    /** Build a stable signature so repeated task refreshes do not grow the stack. */
    imageEditorContextSignature: function imageEditorContextSignature(context) {
      const item = context || {};
      return [
        item.galleryEditRecordKey,
        item.imageEditorSourceType,
        JSON.stringify(item.galleryEditSelection || []),
        JSON.stringify(item.imageEditorSourceUrls || []),
        item.imageEditorDetailIndex,
        item.imageEditorPrompt
      ].join("|");
    },

    /** Push the current image editor context onto the local stack once. */
    pushImageEditorContext: function pushImageEditorContext(reason) {
      const context = this.captureImageEditorContext(reason);
      const stack = Array.isArray(this.imageEditorContextStack) ? this.imageEditorContextStack : [];
      const top = stack.length ? stack[stack.length - 1] : null;
      if (top && this.imageEditorContextSignature(top) === this.imageEditorContextSignature(context)) {
        this.imageEditorContextStack = stack;
        return;
      }
      stack.push(context);
      while (stack.length > 8) {
        stack.shift();
      }
      this.imageEditorContextStack = stack;
    },

    /** Restore one source context from the editor stack and clear task-only fields. */
    restoreImageEditorContext: function restoreImageEditorContext(context) {
      const item = context || {};
      this.galleryEditRecordKey = String(item.galleryEditRecordKey || "");
      this.galleryEditSelection = Array.isArray(item.galleryEditSelection) ? item.galleryEditSelection.slice() : [];
      this.imageEditorSourceType = String(item.imageEditorSourceType || "gallery");
      this.imageEditorSourceUrls = Array.isArray(item.imageEditorSourceUrls) ? item.imageEditorSourceUrls.slice() : [];
      this.imageEditorDetailIndex = Number(item.imageEditorDetailIndex === undefined ? -1 : item.imageEditorDetailIndex);
      this.imageEditorRecordKey = String(item.imageEditorRecordKey || this.galleryEditRecordKey || "");
      this.imageEditorPrompt = String(item.imageEditorPrompt || "");
      this.imageCarouselCount = Number(item.imageCarouselCount || 1);
      this.imageCarouselReviewOnly = Boolean(item.imageCarouselReviewOnly);
      this.imageCarouselMarketLanguage = String(item.imageCarouselMarketLanguage || "美国 / English");
      this.imageCarouselReasoningEnabled = Boolean(item.imageCarouselReasoningEnabled);
      this.imageEditorRestoreMainId = String(item.imageEditorRestoreMainId || "");
      this.imageDirectTask = null;
      this.imageEditorGeneratedUrl = "";
      this.imageEditorBusy = false;
      this.imageEditorError = "";
      this.imageCarouselTask = null;
      this.imageCarouselPageBusyKeys = {};
      this.imageCarouselPageIndex = 0;
      this.imageCarouselGenerationBusy = false;
      this.imageCarouselEstimatedTokens = 0;
      this.imageCarouselSourceMismatch = false;
      this.imageEditorOpen = true;
    },

    /** Pop the most recent editor context and restore it when available. */
    popImageEditorContext: function popImageEditorContext(reason) {
      const stack = Array.isArray(this.imageEditorContextStack) ? this.imageEditorContextStack : [];
      const context = stack.pop();
      this.imageEditorContextStack = stack;
      if (!context) {
        return false;
      }
      this.restoreImageEditorContext(Object.assign({}, context, { reason: String(reason || context.reason || "") }));
      return true;
    },

    /** Return whether one async image-editor callback still belongs to the visible session. */
    isImageEditorRequestCurrent: function isImageEditorRequestCurrent(requestId) {
      return this.imageEditorOpen && Number(this.imageEditorRequestId) === Number(requestId);
    },

    /** Return whether one direct-image callback can update the visible editor UI. */
    isVisibleDirectImageTask: function isVisibleDirectImageTask(taskId) {
      return Boolean(this.imageEditorOpen
        && !this.imageCarouselTask
        && this.imageDirectTask
        && String(this.imageDirectTask.id || "") === String(taskId || ""));
    },

    /** Schedule one background refresh for retained direct-image indicators. */
    scheduleDirectImageIndicatorRefresh: function scheduleDirectImageIndicatorRefresh(delayMs) {
      if (this.imageDirectIndicatorTimer) {
        return;
      }
      const view = this;
      /** Refresh direct-image indicators after the current provider tick has had time to persist. */
      function refreshDirectImageIndicatorsLater() {
        view.imageDirectIndicatorTimer = null;
        view.refreshDirectImageTaskIndicators();
      }
      this.imageDirectIndicatorTimer = window.setTimeout(refreshDirectImageIndicatorsLater, Math.max(250, Number(delayMs || 1000)));
    },

    /** Schedule one background refresh for retained carousel indicators. */
    scheduleCarouselTaskIndicatorRefresh: function scheduleCarouselTaskIndicatorRefresh(delayMs) {
      if (this.imageCarouselIndicatorTimer) {
        return;
      }
      const view = this;
      /** Refresh carousel indicators after server-owned work has progressed. */
      function refreshCarouselIndicatorsLater() {
        view.imageCarouselIndicatorTimer = null;
        view.refreshCarouselTaskIndicators();
      }
      this.imageCarouselIndicatorTimer = window.setTimeout(refreshCarouselIndicatorsLater, Math.max(250, Number(delayMs || 1000)));
    },

    /** Return whether the visible carousel task contains unsaved editable storyboard text. */
    isVisibleCarouselDraftEditable: function isVisibleCarouselDraftEditable() {
      return Boolean(this.imageEditorOpen
        && this.imageCarouselTask
        && String(this.imageCarouselTask.status || "") === "awaiting_review"
        && !this.isCarouselTaskGenerating(this.imageCarouselTask));
    },

    /** Return whether an indicator refresh may safely replace the visible carousel snapshot. */
    canApplyVisibleCarouselIndicatorSnapshot: function canApplyVisibleCarouselIndicatorSnapshot(taskId) {
      if (!this.imageCarouselTask || String(this.imageCarouselTask.id || "") !== String(taskId || "")) {
        return false;
      }
      const status = String(this.imageCarouselTask.status || "");
      return status === "planning" || status === "generating" || this.isCarouselTaskGenerating(this.imageCarouselTask);
    },

    /** Retain one carousel task under its Temu product identifier for reopen controls. */
    rememberCarouselTask: function rememberCarouselTask(task) {
      const item = task && typeof task === "object" ? task : null;
      const taskId = item ? String(item.id || "") : "";
      if (this.isIgnoredCarouselTask(item)) {
        return;
      }
      const key = item ? String(item.temu_main_id || "") : "";
      if (key) {
        const retained = this.imageCarouselTasksByMainId[key] || null;
        const itemTime = Date.parse(item.updated_at || item.created_at || 0);
        const retainedTime = Date.parse(retained && (retained.updated_at || retained.created_at) || 0);
        if (!retained || itemTime >= retainedTime) {
          this.imageCarouselTasksByMainId[key] = item;
        }
      }
      if (this.isCarouselTaskGenerating(item)) {
        this.scheduleCarouselTaskIndicatorRefresh(900);
      }
    },

    /** Return whether one carousel task was abandoned in this browser session. */
    isIgnoredCarouselTask: function isIgnoredCarouselTask(task) {
      const taskId = String(task && task.id || "");
      return Boolean(taskId && this.imageCarouselIgnoredTaskIds[taskId]);
    },

    /** Store one direct-image task under its owning Temu product. */
    storeDirectImageTask: function storeDirectImageTask(task) {
      if (!task || !task.id) {
        return;
      }
      const mainId = String(task.temu_main_id || "");
      if (mainId) {
        const retained = this.imageDirectTasksByMainId[mainId] || null;
        if (!this.isDirectImageSnapshotFresh(task, retained)) {
          return;
        }
        this.imageDirectTasksByMainId[mainId] = task;
      }
      if (this.isDirectImageTaskRunning(task)) {
        this.scheduleDirectImageIndicatorRefresh(900);
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

    /** Return whether one direct-image task is still waiting for a provider result. */
    isDirectImageTaskRunning: function isDirectImageTaskRunning(task) {
      const status = String(task && task.status || "");
      return status === "queued" || status === "generating";
    },

    /** Return whether one direct-image task can be replaced by a fresh retry. */
    isDirectImageTaskRetryable: function isDirectImageTaskRetryable(task) {
      const status = String(task && task.status || "");
      return status === "failed" || status === "interrupted" || Boolean(task && task.error_code);
    },

    /** Return a monotonic rank for direct-image task lifecycle snapshots. */
    directImageTaskStatusRank: function directImageTaskStatusRank(task) {
      const status = String(task && task.status || "");
      if (status === "succeeded") {
        return 4;
      }
      if (status === "failed" || status === "interrupted") {
        return 3;
      }
      if (status === "generating") {
        return 2;
      }
      if (status === "queued") {
        return 1;
      }
      return 0;
    },

    /** Return whether a direct-image task snapshot may replace the retained snapshot. */
    isDirectImageSnapshotFresh: function isDirectImageSnapshotFresh(candidate, retained) {
      if (!candidate || !candidate.id) {
        return false;
      }
      if (!retained || !retained.id || String(candidate.id || "") !== String(retained.id || "")) {
        return true;
      }
      const candidateTime = Date.parse(candidate.updated_at || candidate.created_at || 0);
      const retainedTime = Date.parse(retained.updated_at || retained.created_at || 0);
      if (candidateTime && retainedTime && candidateTime !== retainedTime) {
        return candidateTime > retainedTime;
      }
      return this.directImageTaskStatusRank(candidate) >= this.directImageTaskStatusRank(retained);
    },

    /** Resolve the stable source payload for a visible direct-image generation request. */
    directImageSubmissionSource: function directImageSubmissionSource(record) {
      const selectedSources = this.galleryImageEditorSources(record);
      if (selectedSources.length === 1) {
        return {
          sources: selectedSources,
          sourceType: this.imageEditorSourceType === "detail" ? "detail" : "gallery",
          sourceIndices: this.imageEditorSourceType === "gallery" ? this.galleryEditSelection.slice() : [],
          detailIndex: Number(this.imageEditorDetailIndex)
        };
      }
      const task = this.imageDirectTask && !this.imageCarouselTask ? this.imageDirectTask : null;
      const taskSources = Array.isArray(task && task.source_image_urls) ? task.source_image_urls.slice() : [];
      if (!record || !task || String(task.temu_main_id || "") !== String(record.main_id || "") || taskSources.length !== 1) {
        return null;
      }
      return {
        sources: taskSources,
        sourceType: task.source_type === "detail" ? "detail" : "gallery",
        sourceIndices: Array.isArray(task.source_indices) ? task.source_indices.slice() : [],
        detailIndex: Number(task.detail_index === undefined ? -1 : task.detail_index)
      };
    },

    /** Resolve the gallery index owned by one retained direct-image task. */
    directImageTaskGallerySelection: function directImageTaskGallerySelection(record, task) {
      if (!record || !task || String(task.source_type || "gallery") !== "gallery") {
        return [];
      }
      const images = this.galleryImages(record);
      const sourceIndices = Array.isArray(task.source_indices) ? task.source_indices : [];
      if (sourceIndices.length) {
        const imageIndex = Number(sourceIndices[0]);
        if (imageIndex >= 0 && imageIndex < images.length) {
          return [imageIndex];
        }
      }
      const sourceUrls = Array.isArray(task.source_image_urls) ? task.source_image_urls : [];
      const sourceUrl = String(sourceUrls[0] || "");
      for (let index = 0; index < images.length; index += 1) {
        if (String(images[index]) === sourceUrl) {
          return [index];
        }
      }
      return [];
    },

    /** Return whether a retained Edits task still points at the current source image. */
    directImageTaskSourceStillCurrent: function directImageTaskSourceStillCurrent(record, task) {
      if (!record || !task) {
        return false;
      }
      const sourceUrls = Array.isArray(task.source_image_urls) ? task.source_image_urls : [];
      if (String(task.source_type || "gallery") === "detail") {
        const detailList = this.imageListForType(record, "detail");
        const detailIndex = Number(task.detail_index === undefined ? -1 : task.detail_index);
        return detailIndex >= 0 && String(detailList[detailIndex] || "") === String(sourceUrls[0] || "");
      }
      return this.directImageTaskMatches(task, record, this.galleryImageEditorSources(record));
    },

    /** Apply one persisted direct-image task to the currently retained editor session. */
    applyDirectImageTask: function applyDirectImageTask(task) {
      if (!task || !task.id) {
        return;
      }
      if (this.imageDirectTask && !this.isDirectImageSnapshotFresh(task, this.imageDirectTask)) {
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
        this.imageEditorGeneratedUrl = this.isGeneratedImageTaskReady(task) ? String(task.image_url || "") : "";
        this.imageEditorError = this.imageEditorGeneratedUrl
          ? ""
          : "[DIRECT_IMAGE_RESULT_NOT_READY] 图片还没有写入本地缓存，请重新生成。";
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
        if (!view.isVisibleDirectImageTask(safeTaskId)) {
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
        if (!view.isVisibleDirectImageTask(safeTaskId)) {
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
      const requestTaskId = this.imageDirectTask ? String(this.imageDirectTask.id || "") : "";
      const requestId = Number(this.imageEditorRequestId);
      fetch(apiUrl("/images/direct-tasks/product/" + encodeURIComponent(String(record.main_id || ""))), { cache: "no-store" }).then(function handleProductDirectTaskResponse(response) {
        if (!response.ok) {
          return null;
        }
        return response.json();
      }).then(function handleProductDirectTaskPayload(payload) {
        const task = payload && payload.ok && payload.data ? payload.data.task : null;
        if (!view.isImageEditorRequestCurrent(requestId)) {
          return;
        }
        if (!view.directImageTaskMatches(task, record, sources)) {
          return;
        }
        if (view.imageDirectTask
          && String(view.imageDirectTask.id || "") !== String(task.id || "")
          && String(view.imageDirectTask.id || "") !== requestTaskId) {
          return;
        }
        if (view.imageDirectTask
          && String(view.imageDirectTask.id || "") !== String(task.id || "")
          && view.isDirectImageTaskRunning(view.imageDirectTask)) {
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
        const visibleTaskId = this.imageDirectTask ? String(this.imageDirectTask.id || "") : "";
        const response = await fetch(apiUrl("/images/direct-tasks"), { cache: "no-store" });
        const payload = await response.json();
        if (!response.ok || !payload || !payload.ok) {
          return false;
        }
        const tasks = payload.data && Array.isArray(payload.data.tasks) ? payload.data.tasks : [];
        const taskLookup = {};
        let visibleTask = null;
        let hasActiveTask = false;
        for (let index = 0; index < tasks.length; index += 1) {
          const key = String(tasks[index] && tasks[index].temu_main_id || "");
          if (key) {
            const retained = taskLookup[key] || null;
            const taskTime = Date.parse(tasks[index].updated_at || tasks[index].created_at || 0);
            const retainedTime = Date.parse(retained && (retained.updated_at || retained.created_at) || 0);
            if (!retained || taskTime >= retainedTime) {
              taskLookup[key] = tasks[index];
            }
          }
          if (visibleTaskId && String(tasks[index] && tasks[index].id || "") === visibleTaskId) {
            visibleTask = tasks[index];
          }
          if (tasks[index] && (tasks[index].status === "queued" || tasks[index].status === "generating")) {
            hasActiveTask = true;
          }
        }
        this.imageDirectTasksByMainId = taskLookup;
        if (visibleTask && this.isVisibleDirectImageTask(visibleTaskId)) {
          this.applyDirectImageTask(visibleTask);
        }
        if (hasActiveTask) {
          this.scheduleDirectImageIndicatorRefresh(1000);
        }
        return true;
      } catch (error) {
        return false;
      }
    },

    /** Refresh all retained carousel tasks used by the two homepage reopen controls. */
    async refreshCarouselTaskIndicators() {
      try {
        const visibleTaskId = this.imageCarouselTask ? String(this.imageCarouselTask.id || "") : "";
        const response = await fetch(apiUrl("/workflow/carousel"), { cache: "no-store" });
        const payload = await response.json();
        if (!response.ok || !payload || !payload.ok) {
          return false;
        }
        const tasks = payload.data && Array.isArray(payload.data.tasks) ? payload.data.tasks : [];
        const taskLookup = {};
        let visibleTask = null;
        let hasActiveTask = false;
        for (let index = 0; index < tasks.length; index += 1) {
          const taskId = String(tasks[index] && tasks[index].id || "");
          if (taskId && this.imageCarouselIgnoredTaskIds[taskId]) {
            continue;
          }
          const key = String(tasks[index] && tasks[index].temu_main_id || "");
          if (key) {
            taskLookup[key] = tasks[index];
          }
          if (visibleTaskId && String(tasks[index] && tasks[index].id || "") === visibleTaskId) {
            visibleTask = tasks[index];
          }
          if (tasks[index] && (tasks[index].status === "planning" || tasks[index].status === "generating")) {
            hasActiveTask = true;
          }
        }
        this.imageCarouselTasksByMainId = taskLookup;
        if (this.isVisibleCarouselDraftEditable()) {
          const mainId = String(this.imageCarouselTask.temu_main_id || "");
          if (mainId) {
            this.imageCarouselTasksByMainId[mainId] = this.imageCarouselTask;
          }
        } else if (visibleTask && this.canApplyVisibleCarouselIndicatorSnapshot(visibleTaskId)) {
          this.applyCarouselTaskSnapshot(visibleTask);
        }
        if (hasActiveTask) {
          this.scheduleCarouselTaskIndicatorRefresh(1000);
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
      if (this.workflowPromptBusyKeys[mainId] || this.workflowGenerateBusyKeys[mainId] || this.hasRunningWorkflowTemporaryTask(record)) {
        return true;
      }
      const retainedTasks = this.workflowTasksForProduct(mainId);
      let hasPrompts = false;
      for (let index = 0; index < retainedTasks.length; index += 1) {
        if (Array.isArray(retainedTasks[index].prompts) && retainedTasks[index].prompts.length) {
          hasPrompts = true;
          break;
        }
      }
      if (!this.workflowTaskErrorKeys[mainId] && !this.hasWorkflowTemporaryTaskError(record) && !hasPrompts) {
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
      const retainedTasks = this.workflowTasksForProduct(mainId);
      const signatureParts = [];
      for (let taskIndex = 0; taskIndex < retainedTasks.length; taskIndex += 1) {
        const task = retainedTasks[taskIndex] || {};
        signatureParts.push(String(task.source_mode || ""));
        signatureParts.push(String(task.status || ""));
        signatureParts.push(String(task.selected_image_url || ""));
        signatureParts.push(String(task.custom_prompt || ""));
        const prompts = Array.isArray(task.prompts) ? task.prompts : [];
        for (let index = 0; index < prompts.length; index += 1) {
          signatureParts.push(String(prompts[index].status || ""));
          signatureParts.push(String(prompts[index].image_url || ""));
          signatureParts.push(String(prompts[index].error_code || ""));
        }
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
      if (this.workflowPromptBusyKeys[mainId] || this.workflowGenerateBusyKeys[mainId] || this.hasRunningWorkflowTemporaryTask(record)) {
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

    /** Return whether one CLIP intelligent-packing task already has terminal real candidates. */
    workflowTaskHasReadyClipCandidates: function workflowTaskHasReadyClipCandidates(task) {
      if (!task || task.source_mode !== "clip") {
        return false;
      }
      const status = String(task.status || "");
      const terminal = status === "clip_ready" || status === "waiting_1688_confirmation" || status === "completed";
      const prompts = Array.isArray(task.prompts) ? task.prompts : [];
      if (!terminal || !prompts.length) {
        return false;
      }
      for (let index = 0; index < prompts.length; index += 1) {
        if (prompts[index].status === "generated" && prompts[index].image_url) {
          return true;
        }
      }
      return false;
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
      if (this.workflowPromptBusyKeys[mainId] || this.workflowGenerateBusyKeys[mainId] || this.hasRunningWorkflowTemporaryTask(record)) {
        return false;
      }
      const retainedTasks = this.workflowTasksForProduct(mainId);
      for (let index = 0; index < retainedTasks.length; index += 1) {
        if (this.workflowTaskHasReadyClipCandidates(retainedTasks[index]) || this.workflowTaskHasGeneratedAllImages(retainedTasks[index])) {
          return true;
        }
      }
      return false;
    },

    /** Return whether one intelligent-packing task retained a generation or search failure. */
    hasWorkflowTaskError: function hasWorkflowTaskError(record) {
      if (!record) {
        return false;
      }
      const mainId = String(record.main_id || "");
      if (this.workflowPromptBusyKeys[mainId] || this.workflowGenerateBusyKeys[mainId] || this.hasRunningWorkflowTemporaryTask(record)) {
        return false;
      }
      const retainedTasks = this.workflowTasksForProduct(mainId);
      for (let index = 0; index < retainedTasks.length; index += 1) {
        if (this.workflowTaskHasGenerationError(retainedTasks[index])) {
          return true;
        }
      }
      return Boolean(this.workflowTaskErrorKeys[mainId] || this.hasWorkflowTemporaryTaskError(record));
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
      if (!this.workflowTaskForMode(record.main_id, this.workflowMode)) {
        if (this.workflowTaskForMode(record.main_id, "clip")) {
          this.workflowMode = "clip";
        } else if (this.workflowTaskForMode(record.main_id, "legacy")) {
          this.workflowMode = "legacy";
        }
      }
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

    /** Return whether one completed image task has a locally cached generated image. */
    isGeneratedImageTaskReady: function isGeneratedImageTaskReady(task) {
      const imageUrl = String(task && task.image_url || "").trim();
      if (String(task && task.status || "") !== "succeeded" || !imageUrl) {
        return false;
      }
      return task.image_ready === true || this.isLocalCachedImageUrl(imageUrl);
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
        return this.isGeneratedImageTaskReady(directTask);
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
      if (this.isIgnoredCarouselTask(task)) {
        delete this.imageCarouselTasksByMainId[mainId];
        return;
      }
      if (!directTask && !task) {
        return;
      }
      this.imageEditorRequestId += 1;
      this.resetImageEditorContextStack();
      const sameSession = this.imageEditorRecordKey === this.imageRecordKey(record)
        && Boolean(directTask ? this.imageDirectTask : this.imageCarouselTask);
      this.selectedTemuMainId = record.main_id;
      this.imageEditorRestoreMainId = mainId;
      this.selectBound1688ForTemu(record);
      if (!sameSession && directTask) {
        this.galleryEditRecordKey = this.imageRecordKey(record);
        this.imageEditorSourceType = directTask.source_type === "detail" ? "detail" : "gallery";
        this.galleryEditSelection = this.imageEditorSourceType === "gallery" ? this.directImageTaskGallerySelection(record, directTask) : [];
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
        this.imageEditorSourceUrls = Array.isArray(task.source_image_urls) ? task.source_image_urls.slice() : [];
        this.imageEditorDetailIndex = -1;
        this.imageEditorRecordKey = this.galleryEditRecordKey;
        this.imageDirectTask = null;
        this.imageEditorGeneratedUrl = "";
        this.imageEditorError = "";
        this.imageCarouselPageIndex = 0;
        if (this.imageDirectPollTimer) {
          window.clearTimeout(this.imageDirectPollTimer);
          this.imageDirectPollTimer = null;
        }
      }
      if (task) {
        this.pushImageEditorContext("retained-carousel-source");
        this.applyCarouselTaskSnapshot(task);
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
      this.imageEditorRequestId += 1;
      this.resetImageEditorContextStack();
      this.imageEditorSourceType = "gallery";
      this.imageEditorSourceUrls = sources.slice();
      this.imageEditorDetailIndex = -1;
      this.imageEditorRecordKey = this.imageRecordKey(record);
      this.imageCarouselCount = 1;
      this.imageCarouselReviewOnly = true;
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
      if (sources.length === 2) {
        this.pushImageEditorContext("fresh-fusion-source");
      }
      if (sources.length === 1) {
        this.loadDirectImageTaskForProduct(record, sources);
      } else {
        this.loadCarouselTaskForProduct(record, sources);
      }
    },

    /** Resolve the visible image editor into one finite UI state. */
    imageEditorState: function imageEditorState() {
      const sources = this.galleryImageEditorSources(this.selectedTemuRecord);
      const task = this.imageCarouselTask && !this.isIgnoredCarouselTask(this.imageCarouselTask) ? this.imageCarouselTask : null;
      const taskStatus = String(task && task.status || "");
      const pages = task && Array.isArray(task.pages) ? task.pages : [];
      const hasCarouselTask = Boolean(task);
      const hasCarouselPages = Boolean(pages.length);
      const hasDirectResult = Boolean(!hasCarouselTask && this.imageEditorGeneratedUrl);
      let phase = "empty";
      if (!this.imageEditorOpen) {
        phase = "closed";
      } else if (hasCarouselTask) {
        if (taskStatus === "planning") {
          phase = "carousel_planning";
        } else if ((taskStatus === "failed" || taskStatus === "interrupted") && !hasCarouselPages) {
          phase = "carousel_failed_empty";
        } else if (taskStatus === "awaiting_review") {
          phase = "carousel_review";
        } else if (this.isCarouselTaskGenerating(task)) {
          phase = "carousel_generating";
        } else if (hasCarouselPages) {
          phase = "carousel_results";
        } else {
          phase = "carousel_empty";
        }
      } else if (sources.length === 2) {
        phase = this.imageEditorBusy ? "fusion_planning" : "fusion_source";
      } else if (this.imageEditorBusy) {
        phase = "direct_generating";
      } else if (hasDirectResult) {
        phase = "direct_result";
      } else {
        phase = "direct_source";
      }
      return {
        phase: phase,
        sourceCount: sources.length,
        hasCarouselTask: hasCarouselTask,
        hasCarouselPages: hasCarouselPages,
        hasResult: hasDirectResult || hasCarouselTask
      };
    },

    /** Return the title for the current image editor state. */
    imageEditorTitle: function imageEditorTitle() {
      const state = this.imageEditorState();
      if (state.hasCarouselTask && state.hasCarouselPages && this.imageCarouselTask && this.imageCarouselTask.pages.length > 1) {
        return "轮播修改模式";
      }
      if (state.sourceCount === 2 || state.hasCarouselTask) {
        return "双图提示词";
      }
      return "单图编辑";
    },

    /** Return the subtitle for the current image editor state. */
    imageEditorSubtitle: function imageEditorSubtitle() {
      const state = this.imageEditorState();
      return state.sourceCount === 2 || state.hasCarouselTask ? "Kimi 提示词预审" : "Edits API";
    },

    /** Return whether the stage label belongs to the current state. */
    shouldShowImageEditorStageLabel: function shouldShowImageEditorStageLabel() {
      return !this.imageEditorState().hasCarouselTask;
    },

    /** Return the small stage label for source, busy, or result states. */
    imageEditorStageLabel: function imageEditorStageLabel() {
      const state = this.imageEditorState();
      if (state.phase === "direct_generating" || state.phase === "fusion_planning") {
        return "处理中";
      }
      if (state.phase === "direct_result") {
        return "生成结果";
      }
      return state.sourceCount === 2 ? "待溶图片" : "待编辑图片";
    },

    /** Return whether the carousel viewer should own the visual stage. */
    shouldShowCarouselViewer: function shouldShowCarouselViewer() {
      const state = this.imageEditorState();
      return state.hasCarouselTask && state.hasCarouselPages && state.phase !== "carousel_planning";
    },

    /** Return whether an empty failed carousel task should show the failure panel. */
    shouldShowCarouselFailedEmpty: function shouldShowCarouselFailedEmpty() {
      return this.imageEditorState().phase === "carousel_failed_empty";
    },

    /** Return whether the direct Edits generated image should be shown. */
    shouldShowDirectGeneratedImage: function shouldShowDirectGeneratedImage() {
      return this.imageEditorState().phase === "direct_result";
    },

    /** Return whether the fresh two-image controls should be shown before task creation. */
    shouldShowFreshFusionControls: function shouldShowFreshFusionControls() {
      const state = this.imageEditorState();
      return state.phase === "fusion_source" || state.phase === "fusion_planning";
    },

    /** Return whether the freeform prompt field belongs to the current state. */
    shouldShowDirectOrFreshFusionPrompt: function shouldShowDirectOrFreshFusionPrompt() {
      return !this.imageEditorState().hasCarouselTask;
    },

    /** Return whether a persisted carousel page can be edited in the current state. */
    shouldShowCarouselPageEditor: function shouldShowCarouselPageEditor() {
      const state = this.imageEditorState();
      return state.hasCarouselTask && state.hasCarouselPages && state.phase !== "carousel_planning";
    },

    /** Return whether the advanced storyboard page controls are editable. */
    canEditCarouselPages: function canEditCarouselPages() {
      const state = this.imageEditorState();
      return state.phase === "carousel_review" && this.imageCarouselTask && this.imageCarouselTask.pages.length > 0;
    },

    /** Return whether the carousel abandon action applies to the current state. */
    shouldShowAbandonCarouselButton: function shouldShowAbandonCarouselButton() {
      return this.imageEditorState().hasCarouselTask;
    },

    /** Return whether the primary image generation button should be visible. */
    shouldShowPrimaryImageEditorGenerateButton: function shouldShowPrimaryImageEditorGenerateButton() {
      const state = this.imageEditorState();
      return !state.hasCarouselTask
        || state.phase === "carousel_review"
        || state.phase === "carousel_failed_empty";
    },

    /** Return whether the primary image generation button should be disabled. */
    isPrimaryImageEditorGenerateDisabled: function isPrimaryImageEditorGenerateDisabled() {
      const state = this.imageEditorState();
      return Boolean(this.imageEditorBusy
        || (state.hasCarouselTask && this.imageCarouselGenerationBusy)
        || !String(this.imageEditorPrompt || "").trim());
    },

    /** Return whether carousel pages can be regenerated from existing prompts. */
    canRegenerateCarouselPages: function canRegenerateCarouselPages() {
      const state = this.imageEditorState();
      return state.hasCarouselTask
        && state.hasCarouselPages
        && state.phase !== "carousel_planning"
        && state.phase !== "carousel_review"
        && state.phase !== "carousel_failed_empty";
    },

    /** Reset the freeform prompt to the default for the current source count. */
    resetImageEditorPromptForCurrentSources: function resetImageEditorPromptForCurrentSources() {
      const sourceCount = this.galleryImageEditorSources(this.selectedTemuRecord).length;
      this.imageEditorPrompt = sourceCount === 2 ? this.imageEditorFusionPrompt : this.imageEditorEditPrompt;
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

    /** Return whether the visible image editor is working with two source images. */
    isFusionPromptReviewSession: function isFusionPromptReviewSession() {
      return this.galleryImageEditorSources(this.selectedTemuRecord).length === 2;
    },

    /** Return whether a fresh two-image editor can start Fusion immediately. */
    canStartCarouselImagesDirect: function canStartCarouselImagesDirect() {
      return this.imageEditorState().phase === "fusion_source";
    },

    /** Return whether the editor stage should show a full loading overlay. */
    shouldShowImageEditorLoading: function shouldShowImageEditorLoading() {
      const phase = this.imageEditorState().phase;
      return phase === "direct_generating"
        || phase === "fusion_planning"
        || phase === "carousel_planning";
    },

    /** Return the primary busy label for the visible image editor. */
    imageEditorLoadingTitle: function imageEditorLoadingTitle() {
      const state = this.imageEditorState();
      if (state.sourceCount === 2 || state.hasCarouselTask) {
        return this.imageCarouselReasoningEnabled ? "Kimi 推理生成提示词…" : "Kimi 快速生成提示词…";
      }
      return "图片生成中…";
    },

    /** Return the secondary busy label for the visible image editor. */
    imageEditorLoadingHint: function imageEditorLoadingHint() {
      const state = this.imageEditorState();
      if (state.sourceCount === 2 || state.hasCarouselTask) {
        const reviewOnly = this.imageCarouselTask
          ? String(this.imageCarouselTask.mode || "") === "advanced"
          : this.imageCarouselReviewOnly;
        return "已输出约 " + Number(this.imageCarouselEstimatedTokens || 0) + " tokens，" + (reviewOnly ? "先审核提示词，不会自动提交 Fusion。" : "规划完成后会自动开始生成图片。");
      }
      return "完成后可确认替换当前图片。";
    },

    /** Return the submit button label for direct Edits or two-image prompt review. */
    imageEditorGenerateButtonLabel: function imageEditorGenerateButtonLabel() {
      const state = this.imageEditorState();
      if (this.imageEditorBusy) {
        if (state.sourceCount === 2 || state.hasCarouselTask) {
          return this.imageCarouselReviewOnly ? "生成提示词中…" : "规划中…";
        }
        return "生成中…";
      }
      if (state.phase === "carousel_failed_empty") {
        return "重新开始";
      }
      if (state.phase === "carousel_review") {
        return "开始生成图片";
      }
      if (state.sourceCount === 2) {
        return "仅生成提示词";
      }
      return this.imageEditorGeneratedUrl ? "重新生成" : "开始生成";
    },

    /** Return whether the final replacement button should be shown. */
    canShowImageEditorConfirm: function canShowImageEditorConfirm() {
      if (this.imageEditorState().hasCarouselTask) {
        return this.canApplyCarouselReplacement(false);
      }
      return Boolean(this.imageEditorGeneratedUrl);
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
      const state = this.imageEditorState();
      if (state.sourceCount === 2 || state.hasCarouselTask) {
        if (state.phase === "carousel_review") {
          this.saveAdvancedCarouselPlan();
          return;
        }
        if (state.phase === "carousel_failed_empty") {
          this.restartCarouselPlan(true);
          return;
        }
        if (state.phase === "carousel_results") {
          this.generateCarouselPages();
          return;
        }
        if (state.phase === "fusion_source") {
          this.startCarouselPlan(true);
        }
        return;
      }
      this.submitDirectGalleryImageEdit();
    },

    /** Submit one selected image as one recoverable Edits task. */
    submitDirectGalleryImageEdit: function submitDirectGalleryImageEdit() {
      const record = this.selectedTemuRecord;
      const submission = this.directImageSubmissionSource(record);
      const sources = submission ? submission.sources : [];
      const prompt = String(this.imageEditorPrompt || "").trim();
      if (!record || !prompt || !submission || sources.length !== 1 || this.imageEditorBusy) {
        if (record && prompt && !this.imageEditorBusy) {
          this.imageEditorError = "[DIRECT_IMAGE_SOURCE_MISSING] 当前单图来源丢失，请重新打开这张图再生成。";
        }
        return;
      }
      if (this.directImageTaskMatches(this.imageDirectTask, record, sources)
        && this.isDirectImageTaskRetryable(this.imageDirectTask)) {
        this.deleteDirectImageTask();
        this.imageEditorGeneratedUrl = "";
        this.imageEditorError = "";
      }
      const taskId = "direct-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
      const directTask = {
        id: taskId,
        temu_main_id: String(record.main_id || ""),
        temu_platform_id: String(record.platform_id || ""),
        mode: "edit",
        source_image_urls: sources.slice(),
        source_type: submission.sourceType,
        source_indices: submission.sourceIndices,
        detail_index: submission.detailIndex,
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
        if (!task) {
          return;
        }
        view.storeDirectImageTask(task);
        if (!view.isVisibleDirectImageTask(taskId)) {
          return;
        }
        view.applyDirectImageTask(task);
      }).catch(function keepPollingAfterDirectImageCreateFailure(error) {
        if (!error || !error.receivedResponse || !view.isVisibleDirectImageTask(taskId)) {
          return;
        }
        if (view.imageDirectPollTimer) {
          window.clearTimeout(view.imageDirectPollTimer);
          view.imageDirectPollTimer = null;
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

    /** Return whether a carousel task still has active planning or image-generation work. */
    isCarouselTaskGenerating: function isCarouselTaskGenerating(task) {
      const item = task && typeof task === "object" ? task : null;
      const status = String(item && item.status || "");
      if (status === "planning" || status === "generating") {
        return true;
      }
      const pages = item && Array.isArray(item.pages) ? item.pages : [];
      for (let index = 0; index < pages.length; index += 1) {
        if (pages[index] && pages[index].status === "generating") {
          return true;
        }
      }
      return false;
    },

    /** Apply one carousel snapshot and derive the local busy flag from page state. */
    applyCarouselTaskSnapshot: function applyCarouselTaskSnapshot(task) {
      if (this.isIgnoredCarouselTask(task)) {
        this.imageCarouselTask = null;
        this.imageCarouselGenerationBusy = false;
        this.imageEditorBusy = false;
        this.imageCarouselPageIndex = 0;
        return;
      }
      this.imageCarouselTask = task || null;
      if (this.imageCarouselTask) {
        this.imageCarouselReviewOnly = String(this.imageCarouselTask.mode || "") === "advanced";
      }
      this.rememberCarouselTask(this.imageCarouselTask);
      this.imageCarouselGenerationBusy = this.isCarouselTaskGenerating(this.imageCarouselTask);
      if (this.imageCarouselTask
        && String(this.imageCarouselTask.status || "") !== "planning"
        && !this.imageCarouselGenerationBusy) {
        this.imageEditorBusy = false;
      }
      this.normalizeCarouselPageIndex();
    },

    /** Return whether the current carousel task has confirmed results ready to apply. */
    canApplyCarouselReplacement: function canApplyCarouselReplacement(includeUnselected) {
      return Boolean(this.imageCarouselTask
        && !this.isCarouselTaskGenerating(this.imageCarouselTask)
        && this.successfulCarouselPageCount(includeUnselected) > 0);
    },

    /** Load and display the single retained carousel task for one Temu product. */
    async loadCarouselTaskForProduct(record, sources) {
      if (!record) {
        return;
      }
      const requestId = Number(this.imageEditorRequestId);
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
        if (this.isIgnoredCarouselTask(task)) {
          return;
        }
        if (!this.isImageEditorRequestCurrent(requestId)) {
          return;
        }
        if (!this.imageEditorContextStack.length) {
          this.pushImageEditorContext("loaded-carousel-source");
        }
        this.applyCarouselTaskSnapshot(task);
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
        if (this.isImageEditorRequestCurrent(requestId)) {
          this.imageEditorError = error.message || "轮播任务读取失败。";
        }
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
        if (this.isIgnoredCarouselTask(state.task)) {
          return;
        }
        this.applyCarouselTaskSnapshot(state.task);
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

    /** Submit one server-owned Fusion pipeline and optionally stop after Kimi prompt planning. */
    async startCarouselPlan(reviewOnly) {
      const record = this.selectedTemuRecord;
      const sources = this.galleryImageEditorSources(record);
      const count = Math.max(1, Math.min(10, Number(this.imageCarouselCount || 1)));
      if (!record || sources.length !== 2 || this.imageEditorBusy) {
        return;
      }
      const requestId = Number(this.imageEditorRequestId);
      this.imageCarouselCount = count;
      this.imageCarouselReviewOnly = Boolean(reviewOnly);
      if (!this.imageCarouselTask && !this.imageEditorContextStack.length) {
        this.pushImageEditorContext("started-carousel-source");
      }
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
            advanced: Boolean(reviewOnly),
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
        if (!this.isImageEditorRequestCurrent(requestId)) {
          this.rememberCarouselTask(task);
          return;
        }
        this.applyCarouselTaskSnapshot(task);
        this.scheduleCarouselTaskPoll();
      } catch (error) {
        if (this.isImageEditorRequestCurrent(requestId)) {
          this.imageEditorError = "[" + getWorkflowErrorCode(error) + "] " + (error.message || "轮播后台任务提交失败。");
        }
        if (this.isImageEditorRequestCurrent(requestId) && !this.imageCarouselTask) {
          this.imageEditorRestoreMainId = "";
          this.persistViewState();
        }
      } finally {
        if (this.isImageEditorRequestCurrent(requestId)) {
          this.imageEditorBusy = false;
        }
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
        this.applyCarouselTaskSnapshot(payload.data.task);
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
      if (this.imageCarouselTask && String(this.imageCarouselTask.id || "") === String(submittedTask.id || "")) {
        this.applyCarouselTaskSnapshot(submittedTask);
        this.scheduleCarouselTaskPoll();
      } else {
        this.rememberCarouselTask(submittedTask);
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
    async refreshCarouselTask(requestId) {
      const record = this.selectedTemuRecord;
      const expectedRequestId = requestId === undefined ? Number(this.imageEditorRequestId) : Number(requestId);
      if (!record || !this.isImageEditorRequestCurrent(expectedRequestId)) {
        return;
      }
      const response = await fetch(apiUrl("/workflow/carousel/product/" + encodeURIComponent(String(record.main_id))), { cache: "no-store" });
      const payload = await response.json();
      if (response.ok && payload && payload.ok && this.isImageEditorRequestCurrent(expectedRequestId)) {
        const task = payload.data.task || null;
        if (this.isIgnoredCarouselTask(task)) {
          this.applyCarouselTaskSnapshot(null);
          return;
        }
        this.applyCarouselTaskSnapshot(task);
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
      const requestId = Number(this.imageEditorRequestId);
      /** Refresh one retained task and continue only while it is active. */
      async function pollCarouselTask() {
        view.imageCarouselPollTimer = null;
        if (!view.isImageEditorRequestCurrent(requestId)) {
          return;
        }
        try {
          await view.refreshCarouselTask(requestId);
        } catch (error) {
          if (view.isImageEditorRequestCurrent(requestId)) {
            view.imageEditorError = error.message || "轮播任务刷新失败，正在重试。";
          }
          if (view.isImageEditorRequestCurrent(requestId) && view.imageCarouselTask && view.isCarouselTaskGenerating(view.imageCarouselTask)) {
            view.scheduleCarouselTaskPoll();
          }
          return;
        }
        const task = view.imageCarouselTask;
        if (task && view.isCarouselTaskGenerating(task)) {
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
      if (!task || this.imageCarouselCancelBusy) {
        return;
      }
      try {
        await this.deleteCarouselTaskOnServer(task);
      } catch (error) {
        this.imageEditorError = "[CAROUSEL_CANCEL_FAILED] " + String(error && error.message || "旧轮播任务放弃失败。");
        return;
      }
      this.releaseCarouselTaskClientState(task);
      this.imageEditorError = "";
      await this.startCarouselPlan(true);
    },

    /** Delete one carousel task on the server and reject any unsuccessful response. */
    async deleteCarouselTaskOnServer(task) {
      if (!task || !task.id) {
        return false;
      }
      this.imageCarouselCancelBusy = true;
      try {
        const response = await fetch(apiUrl("/workflow/carousel/" + encodeURIComponent(String(task.id))), { method: "DELETE" });
        /** Return null when a proxy or server error does not contain a JSON body. */
        function ignoreCarouselDeleteJsonError() {
          return null;
        }
        const payload = await response.json().catch(ignoreCarouselDeleteJsonError);
        if (!response.ok || !payload || !payload.ok) {
          throw new Error(getApiErrorMessage(payload, "轮播任务放弃失败。"));
        }
        return true;
      } finally {
        this.imageCarouselCancelBusy = false;
      }
    },

    /** Invalidate late callbacks and remove one abandoned task from every frontend store. */
    releaseCarouselTaskClientState: function releaseCarouselTaskClientState(task) {
      const taskId = String(task && task.id || "");
      const mainId = String(task && task.temu_main_id || "");
      if (taskId) {
        this.imageCarouselIgnoredTaskIds[taskId] = true;
      }
      this.imageEditorRequestId += 1;
      if (this.imageCarouselPollTimer) {
        window.clearTimeout(this.imageCarouselPollTimer);
        this.imageCarouselPollTimer = null;
      }
      if (mainId && this.imageCarouselTasksByMainId[mainId]
        && String(this.imageCarouselTasksByMainId[mainId].id || "") === taskId) {
        delete this.imageCarouselTasksByMainId[mainId];
      }
      if (this.imageCarouselTask && String(this.imageCarouselTask.id || "") === taskId) {
        this.imageCarouselTask = null;
      }
      this.imageCarouselPageBusyKeys = {};
      this.imageCarouselPageIndex = 0;
      this.imageCarouselGenerationBusy = false;
      this.imageCarouselEstimatedTokens = 0;
      this.imageCarouselSourceMismatch = false;
      this.imageEditorBusy = false;
      this.scheduleCarouselTaskIndicatorRefresh(250);
    },

    /** Abandon the visible task and return the dialog to its original controls. */
    async abandonCarouselTask() {
      const task = this.imageCarouselTask;
      if (!task || this.imageCarouselCancelBusy) {
        return;
      }
      try {
        await this.deleteCarouselTaskOnServer(task);
      } catch (error) {
        this.imageEditorError = "[CAROUSEL_CANCEL_FAILED] " + String(error && error.message || "轮播任务放弃失败。");
        return;
      }
      this.releaseCarouselTaskClientState(task);
      if (!this.popImageEditorContext("abandon-carousel")) {
        this.imageCarouselCount = 1;
        this.imageCarouselReviewOnly = true;
        this.imageCarouselReasoningEnabled = false;
        this.imageCarouselEstimatedTokens = 0;
        this.imageCarouselSourceMismatch = false;
        this.resetImageEditorPromptForCurrentSources();
      }
      this.imageEditorError = "";
      this.imageEditorRestoreMainId = "";
      this.persistViewState();
    },

    /** Delete one failed plan before submitting the same source pair again. */
    async restartCarouselPlan(reviewOnly) {
      const task = this.imageCarouselTask;
      if (task) {
        try {
          await this.deleteCarouselTaskOnServer(task);
        } catch (error) {
          this.imageEditorError = "[CAROUSEL_CANCEL_FAILED] " + String(error && error.message || "旧轮播任务放弃失败。");
          return;
        }
        this.releaseCarouselTaskClientState(task);
      }
      await this.startCarouselPlan(reviewOnly);
    },

    /** Verify the visible Edits task still exists before applying its generated image. */
    async verifyDirectImageTaskBeforeApply(task, generatedUrl) {
      if (!task || !task.id) {
        return;
      }
      const response = await fetch(apiUrl("/images/direct-tasks/" + encodeURIComponent(String(task.id))), { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok || !payload || !payload.ok) {
        throw new Error(getApiErrorMessage(payload, "当前 Edits 任务已失效，请重新生成。"));
      }
      const latestTask = payload.data && payload.data.task ? payload.data.task : null;
      if (!latestTask || latestTask.status !== "succeeded" || String(latestTask.image_url || "") !== String(generatedUrl || "")) {
        throw new Error("当前 Edits 结果已不是最新任务，请重新生成。");
      }
      this.applyDirectImageTask(latestTask);
    },

    /** Ask whether a generated image should become the first main image after its source disappeared. */
    confirmInsertDirectImageAtFirstPosition: function confirmInsertDirectImageAtFirstPosition(record, generatedUrl) {
      const imageUrl = String(generatedUrl || "").trim();
      if (!record || !imageUrl) {
        return false;
      }
      if (!window.confirm("原图已经消失，是否允许把生成图插入到首图？")) {
        return false;
      }
      const list = this.imageListForType(record, "gallery");
      if (!list.length && record.main_image_url && String(record.main_image_url) !== imageUrl) {
        list.push(String(record.main_image_url));
      }
      for (let index = list.length - 1; index >= 0; index -= 1) {
        if (String(list[index] || "") === imageUrl) {
          list.splice(index, 1);
        }
      }
      list.unshift(imageUrl);
      record.main_image_url = imageUrl;
      this.selectedTemuGalleryIndex = 0;
      this.selectedGalleryIndex = 0;
      this.saveProductModule(record, "images");
      this.setStatus("原图已消失，已将生成图插入到首图。", "success");
      this.deleteDirectImageTask();
      this.closeGalleryImageEditor(true);
      return true;
    },

    /** Replace selected gallery positions only after the user confirms the result. */
    async confirmGalleryImageEdit() {
      if (this.imageCarouselTask) {
        this.confirmCarouselReplacement();
        return;
      }
      const record = this.selectedTemuRecord;
      const generatedUrl = String(this.imageEditorGeneratedUrl || "").trim();
      if (!record || !generatedUrl || this.imageEditorBusy) {
        return;
      }
      const requestId = Number(this.imageEditorRequestId);
      this.imageEditorBusy = true;
      try {
        await this.verifyDirectImageTaskBeforeApply(this.imageDirectTask, generatedUrl);
      } catch (error) {
        this.imageEditorError = "[" + getWorkflowErrorCode(error) + "] " + (error.message || "当前 Edits 任务已失效，请重新生成。");
        this.imageEditorBusy = false;
        return;
      }
      if (!this.isImageEditorRequestCurrent(requestId) || !this.imageDirectTask || String(this.imageDirectTask.image_url || "") !== generatedUrl) {
        this.imageEditorBusy = false;
        return;
      }
      if (!this.directImageTaskSourceStillCurrent(record, this.imageDirectTask)) {
        this.imageEditorBusy = false;
        if (this.confirmInsertDirectImageAtFirstPosition(record, generatedUrl)) {
          return;
        }
        this.imageEditorError = "[DIRECT_IMAGE_SOURCE_CHANGED] 原图位置已变化，请重新打开当前图片再生成。";
        return;
      }
      this.imageEditorBusy = false;
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
      let indices = this.galleryEditSelection.slice();
      if (!indices.length && this.imageDirectTask) {
        indices = this.directImageTaskGallerySelection(record, this.imageDirectTask);
        this.galleryEditSelection = indices.slice();
      }
      indices = indices.sort(function sortImageIndices(first, second) {
        return first - second;
      });
      if (!indices.length) {
        this.imageEditorError = "[DIRECT_IMAGE_SOURCE_MISSING] 找不到要替换的原图位置，请重新打开原图再生成。";
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
      this.imageCarouselGenerationBusy = this.isCarouselTaskGenerating(task);
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
      this.resetImageEditorContextStack();
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

    /** Open the 妙手 export choice dialog before starting a download or online import. */
    openMiaoshouExportDialog: function openMiaoshouExportDialog() {
      if (!this.temuRecords.length || this.miaoshouExportBusy) {
        return;
      }
      this.miaoshouExportMode = "";
      this.miaoshouExportError = "";
      this.clearMiaoshouExportResult();
      this.clearMiaoshouSavedCookieStatus();
      this.stopMiaoshouExportProgress(0, "");
      this.miaoshouExportDialogOpen = true;
    },

    /** Close the 妙手 export dialog when no import or ZIP generation is running. */
    closeMiaoshouExportDialog: function closeMiaoshouExportDialog() {
      if (this.miaoshouExportBusy) {
        return;
      }
      this.miaoshouExportDialogOpen = false;
      this.miaoshouExportMode = "";
      this.miaoshouExportError = "";
      this.clearMiaoshouExportResult();
      this.clearMiaoshouSavedCookieStatus();
      this.stopMiaoshouExportProgress(0, "");
    },

    /** Switch the 妙手 export dialog into online-import mode. */
    selectMiaoshouOnlineImport: function selectMiaoshouOnlineImport() {
      if (this.miaoshouExportBusy) {
        return;
      }
      this.miaoshouExportMode = "online";
      this.miaoshouExportError = "";
      this.clearMiaoshouExportResult();
      this.stopMiaoshouExportProgress(0, "");
      this.loadMiaoshouCookieStatus();
    },

    /** Reset the frontend-only saved-cookie status shown in the Miaoshou modal. */
    clearMiaoshouSavedCookieStatus: function clearMiaoshouSavedCookieStatus() {
      this.miaoshouSavedCookieReady = false;
      this.miaoshouSavedCookieLoading = false;
      this.miaoshouSavedCookieStatusText = "";
    },

    /** Format the saved Miaoshou Cookie expiry for the small modal status line. */
    formatMiaoshouCookieExpiresAt: function formatMiaoshouCookieExpiresAt(value) {
      if (!value) {
        return "有效期未知";
      }
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) {
        return "有效期未知";
      }
      return date.toLocaleString();
    },

    /** Ask the Chrome extension to read the latest Miaoshou Cookie and save it to the backend. */
    requestMiaoshouCookieSyncFromExtension: function requestMiaoshouCookieSyncFromExtension() {
      const requestId = "miaoshou-cookie-" + Date.now() + "-" + Math.random().toString(16).slice(2);
      return new Promise(function createMiaoshouCookieSyncPromise(resolve, reject) {
        let finished = false;
        /** Remove the event listener and timeout for one bridge request. */
        function cleanupMiaoshouCookieSync(timer) {
          finished = true;
          window.clearTimeout(timer);
          window.removeEventListener("message", handleMiaoshouCookieSyncMessage);
        }
        /** Accept only the matching extension bridge response for this request. */
        function handleMiaoshouCookieSyncMessage(event) {
          const data = event && event.data && typeof event.data === "object" ? event.data : {};
          if (event.origin !== window.location.origin
            || data.type !== "autoPackingMiaoshouCookieSynced"
            || data.requestId !== requestId) {
            return;
          }
          cleanupMiaoshouCookieSync(timer);
          if (!data.ok) {
            reject(new Error(data.error || "扩展读取最新妙手 Cookie 失败。"));
            return;
          }
          resolve(data.data || {});
        }
        const timer = window.setTimeout(function handleMiaoshouCookieSyncTimeout() {
          if (finished) {
            return;
          }
          cleanupMiaoshouCookieSync(timer);
          reject(new Error("扩展未响应，请确认自动组货采集器已重新加载。"));
        }, 2800);
        window.addEventListener("message", handleMiaoshouCookieSyncMessage);
        window.postMessage({ type: "autoPackingSyncMiaoshouCookie", requestId: requestId }, window.location.origin);
      });
    },

    /** Refresh the saved Miaoshou Cookie by reading the latest Chrome cookie through the extension. */
    syncLatestMiaoshouCookie: async function syncLatestMiaoshouCookie() {
      this.miaoshouSavedCookieReady = false;
      this.miaoshouSavedCookieLoading = true;
      this.miaoshouSavedCookieStatusText = "正在读取 Chrome 最新妙手 Cookie";
      const data = await this.requestMiaoshouCookieSyncFromExtension();
      if (!data.hasCookie) {
        throw new Error("Chrome 里的妙手 Cookie 不可用，请重新登录妙手。");
      }
      this.miaoshouSavedCookieReady = true;
      this.miaoshouSavedCookieStatusText = "已同步 Chrome 最新妙手 Cookie，导入时由妙手接口实时校验。";
      this.miaoshouSavedCookieLoading = false;
      return data;
    },

    /** Read server/cookie.json status so saved valid cookies can be reused. */
    loadMiaoshouCookieStatus: async function loadMiaoshouCookieStatus() {
      this.miaoshouSavedCookieReady = false;
      this.miaoshouSavedCookieLoading = true;
      this.miaoshouSavedCookieStatusText = "正在读取 Chrome 最新妙手 Cookie";
      try {
        await this.syncLatestMiaoshouCookie();
        return;
      } catch (syncError) {
        this.miaoshouSavedCookieReady = false;
        this.miaoshouSavedCookieStatusText = "未读取到 Chrome 最新妙手 Cookie：" + String(syncError && syncError.message || "请重新加载扩展或手动粘贴。");
      } finally {
        this.miaoshouSavedCookieLoading = false;
      }
    },

    /** Return true when one Miaoshou import failure is likely fixed by refreshing Cookie once. */
    isMiaoshouCookieFailureMessage: function isMiaoshouCookieFailureMessage(message) {
      return /Cookie|cookie|token|登录|登陆|授权|过期|无效|未登录|未登陆/i.test(String(message || ""));
    },

    /** Submit one backend Miaoshou online import request and unwrap the response body. */
    requestMiaoshouOnlineImport: async function requestMiaoshouOnlineImport(cookie) {
      const response = await fetch(apiUrl("/miaoshou/import"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cookie: cookie || undefined, auto_fetch: true })
      });
      const payload = await response.json().catch(function handleMiaoshouImportJsonError() {
        return null;
      });
      if (!response.ok || !payload || payload.ok === false) {
        const fallback = response.status === 401 ? "妙手 Cookie 已过期或无效，请重新登录妙手后再试。" : "妙手在线导入失败。";
        throw new Error(getApiErrorMessage(payload, fallback));
      }
      return readApiData(payload) || {};
    },

    /** Show one persistent 妙手 export result message inside the modal. */
    setMiaoshouExportResult: function setMiaoshouExportResult(type, text) {
      this.miaoshouExportResultType = String(type || "normal");
      this.miaoshouExportResultText = String(text || "");
    },

    /** Clear the modal's persistent 妙手 export result message. */
    clearMiaoshouExportResult: function clearMiaoshouExportResult() {
      this.miaoshouExportResultType = "";
      this.miaoshouExportResultText = "";
    },

    /** Update the visible 妙手 export progress bar and its short stage label. */
    setMiaoshouExportProgress: function setMiaoshouExportProgress(value, text) {
      const nextValue = Math.max(0, Math.min(100, Number(value) || 0));
      this.miaoshouExportProgress = Math.round(nextValue);
      this.miaoshouExportProgressText = String(text || "");
    },

    /** Start a conservative progress ticker while the backend performs a long import request. */
    startMiaoshouExportProgress: function startMiaoshouExportProgress(text) {
      this.stopMiaoshouExportProgress(Math.max(this.miaoshouExportProgress, 52), text);
      const view = this;
      /** Move the progress bar forward without claiming completion before the API returns. */
      function advanceMiaoshouExportProgress() {
        if (!view.miaoshouExportBusy) {
          window.clearInterval(view.miaoshouExportProgressTimer);
          view.miaoshouExportProgressTimer = null;
          return;
        }
        if (view.miaoshouExportProgress < 92) {
          view.miaoshouExportProgress += view.miaoshouExportProgress < 76 ? 4 : 1;
        }
      }
      this.miaoshouExportProgressTimer = window.setInterval(advanceMiaoshouExportProgress, 650);
    },

    /** Stop any running 妙手 export ticker and set the final displayed stage. */
    stopMiaoshouExportProgress: function stopMiaoshouExportProgress(value, text) {
      if (this.miaoshouExportProgressTimer) {
        window.clearInterval(this.miaoshouExportProgressTimer);
        this.miaoshouExportProgressTimer = null;
      }
      this.setMiaoshouExportProgress(value, text);
    },

    /** Force the visible Temu image state into the backend before Miaoshou reads cache. */
    syncMiaoshouExportImages: async function syncMiaoshouExportImages(record) {
      if (!record) {
        return;
      }
      await this.waitForProductSaveIdle(record);
      this.saveProductModule(record, "images");
      await this.waitForProductSaveIdle(record);
    },

    /** Wait until all visible Temu image save requests have finished before exporting. */
    waitForMiaoshouExportReady: async function waitForMiaoshouExportReady() {
      for (let index = 0; index < this.temuRecords.length; index += 1) {
        await this.syncMiaoshouExportImages(this.temuRecords[index]);
      }
    },

    /** Collect the exact main-image order that Miaoshou ZIP export will read. */
    collectMiaoshouMainExportImages: function collectMiaoshouMainExportImages(record) {
      const item = record || {};
      const result = [];
      const candidates = [];
      if (item.main_image_url) {
        candidates.push(item.main_image_url);
      }
      if (Array.isArray(item.gallery_image_urls)) {
        for (let index = 0; index < item.gallery_image_urls.length; index += 1) {
          candidates.push(item.gallery_image_urls[index]);
        }
      }
      for (let index = 0; index < candidates.length; index += 1) {
        const source = String(candidates[index] || "").trim();
        if (source && result.indexOf(source) < 0) {
          result.push(source);
        }
      }
      return result;
    },

    /** Read one browser-loadable image's natural dimensions for export warnings. */
    readMiaoshouImageSize: function readMiaoshouImageSize(source) {
      const url = this.imageSource(source);
      if (!url) {
        return Promise.resolve(null);
      }
      return new Promise(function resolveMiaoshouImageSize(resolve) {
        const image = new Image();
        /** Resolve with dimensions after the browser finishes decoding the image. */
        function handleMiaoshouImageLoaded() {
          resolve({ width: Number(image.naturalWidth || 0), height: Number(image.naturalHeight || 0) });
        }
        /** Ignore unreadable images so export warnings never block the real export. */
        function handleMiaoshouImageError() {
          resolve(null);
        }
        image.onload = handleMiaoshouImageLoaded;
        image.onerror = handleMiaoshouImageError;
        image.referrerPolicy = "no-referrer";
        image.src = url;
      });
    },

    /** Return a warning when any exported product main image is not square. */
    inspectMiaoshouMainImageShapes: async function inspectMiaoshouMainImageShapes() {
      let nonSquareCount = 0;
      const samples = [];
      for (let productIndex = 0; productIndex < this.temuRecords.length; productIndex += 1) {
        const record = this.temuRecords[productIndex] || {};
        const images = this.collectMiaoshouMainExportImages(record);
        for (let imageIndex = 0; imageIndex < images.length; imageIndex += 1) {
          const size = await this.readMiaoshouImageSize(images[imageIndex]);
          if (!size || !size.width || !size.height || size.width === size.height) {
            continue;
          }
          nonSquareCount += 1;
          if (samples.length < 3) {
            samples.push("第 " + (productIndex + 1) + " 个商品主图 " + (imageIndex + 1) + " 是 " + size.width + "x" + size.height);
          }
        }
      }
      if (!nonSquareCount) {
        return "";
      }
      return "提示：检测到 " + nonSquareCount + " 张产品主图不是 1:1，妙手可能不会自动带入；" + samples.join("，") + "。";
    },

    /** Read a downloadable filename from one Content-Disposition response header. */
    readMiaoshouDownloadFileName: function readMiaoshouDownloadFileName(disposition) {
      const header = String(disposition || "");
      const encodedMatch = header.match(/filename\*=UTF-8''([^;]+)/i);
      if (encodedMatch) {
        try {
          return decodeURIComponent(encodedMatch[1].replace(/^"+|"+$/g, ""));
        } catch (error) {
          return encodedMatch[1].replace(/^"+|"+$/g, "");
        }
      }
      const plainMatch = header.match(/filename="?([^";]+)"?/i);
      if (plainMatch) {
        return plainMatch[1];
      }
      return "Temu-妙手导入包-" + Date.now() + ".zip";
    },

    /** Trigger a browser download for one server-produced Miaoshou ZIP blob. */
    downloadMiaoshouZipBlob: function downloadMiaoshouZipBlob(blob, fileName) {
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.setTimeout(function revokeMiaoshouZipObjectUrl() {
        URL.revokeObjectURL(objectUrl);
      }, 1000);
    },

    /** Read the server ZIP error body without assuming a specific response format. */
    readMiaoshouZipErrorMessage: async function readMiaoshouZipErrorMessage(response) {
      const payload = await response.clone().json().catch(function ignoreMiaoshouZipJsonError() {
        return null;
      });
      if (payload) {
        return getApiErrorMessage(payload, "妙手 ZIP 导出失败。");
      }
      const text = await response.text().catch(function ignoreMiaoshouZipTextError() {
        return "";
      });
      return text ? text.slice(0, 300) : "妙手 ZIP 导出失败，HTTP " + response.status + "。";
    },

    /** Request a streamed server download for the Temu-only 妙手 ZIP. */
    exportMiaoshouZip: async function exportMiaoshouZip() {
      if (this.miaoshouExportBusy || !this.temuRecords.length) {
        return;
      }
      this.miaoshouExportBusy = true;
      this.miaoshouExportError = "";
      this.clearMiaoshouExportResult();
      try {
        this.setMiaoshouExportProgress(12, "同步当前页面缓存");
        this.setStatus("正在同步当前页面缓存，随后生成妙手 ZIP。", "normal");
        await this.waitForMiaoshouExportReady();
        this.setMiaoshouExportProgress(36, "检查主图比例");
        const mainImageWarning = await this.inspectMiaoshouMainImageShapes();
        this.setMiaoshouExportProgress(55, "生成本地 ZIP");
        this.setStatus("服务器正在以当前缓存生成妙手 ZIP。", "normal");
        const response = await fetch(apiUrl("/zip"));
        if (!response.ok) {
          throw new Error(await this.readMiaoshouZipErrorMessage(response));
        }
        this.setMiaoshouExportProgress(82, "接收 ZIP 文件");
        const blob = await response.blob();
        this.setMiaoshouExportProgress(96, "写入浏览器下载");
        const fileName = this.readMiaoshouDownloadFileName(response.headers.get("Content-Disposition"));
        this.downloadMiaoshouZipBlob(blob, fileName);
        this.stopMiaoshouExportProgress(100, "ZIP 已生成并下载");
        this.setMiaoshouExportResult(mainImageWarning ? "warning" : "success", "妙手 ZIP 已生成并开始下载：" + fileName + (mainImageWarning ? "\n" + mainImageWarning : ""));
      } catch (error) {
        this.stopMiaoshouExportProgress(0, "");
        const message = "妙手 ZIP 导出失败：" + String(error && error.message || "未知错误。");
        this.setMiaoshouExportResult("error", message);
        this.setStatus(message, "error");
      } finally {
        this.miaoshouExportBusy = false;
      }
    },

    /** Upload the current Temu-only 妙手 ZIP directly through the backend import flow. */
    importMiaoshouOnline: async function importMiaoshouOnline() {
      if (this.miaoshouExportBusy || !this.temuRecords.length) {
        return;
      }
      const cookie = String(this.miaoshouCookieDraft || "").trim();
      if (!cookie) {
        try {
          await this.syncLatestMiaoshouCookie();
        } catch (error) {
          this.miaoshouExportError = "";
          this.setMiaoshouExportResult("error", "没有可用妙手 Cookie：" + String(error && error.message || "请重新登录妙手。"));
          return;
        } finally {
          this.miaoshouSavedCookieLoading = false;
        }
      }
      this.miaoshouExportBusy = true;
      this.miaoshouExportError = "";
      this.clearMiaoshouExportResult();
      try {
        this.setMiaoshouExportProgress(10, "同步当前页面缓存");
        this.setStatus("正在同步当前页面缓存，随后在线导入妙手。", "normal");
        await this.waitForMiaoshouExportReady();
        this.setMiaoshouExportProgress(32, "检查主图比例");
        const mainImageWarning = await this.inspectMiaoshouMainImageShapes();
        this.startMiaoshouExportProgress("生成 ZIP、上传 OSS 并提交妙手");
        let data = null;
        try {
          data = await this.requestMiaoshouOnlineImport(cookie);
        } catch (firstError) {
          if (cookie || !this.isMiaoshouCookieFailureMessage(firstError && firstError.message)) {
            throw firstError;
          }
          this.setMiaoshouExportProgress(42, "刷新妙手 Cookie 后重试");
          await this.syncLatestMiaoshouCookie();
          data = await this.requestMiaoshouOnlineImport("");
        }
        this.stopMiaoshouExportProgress(100, "导入任务已提交");
        this.miaoshouCookieDraft = "";
        this.miaoshouSavedCookieReady = true;
        this.setMiaoshouExportResult(mainImageWarning ? "warning" : "success", "妙手在线导入已提交：" + String(data.productCount || 0) + " 个商品，isAutoFetch=1。" + (mainImageWarning ? "\n" + mainImageWarning : ""));
        this.setStatus(this.miaoshouExportResultText, "success");
      } catch (error) {
        const message = String(error && error.message || "未知错误。");
        this.stopMiaoshouExportProgress(0, "");
        this.miaoshouExportError = "";
        this.setMiaoshouExportResult("error", "妙手在线导入失败：" + message);
        this.setStatus("妙手在线导入失败：" + message, "error");
      } finally {
        this.miaoshouExportBusy = false;
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
