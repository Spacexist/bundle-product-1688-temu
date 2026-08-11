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
        throw new Error(payload && payload.error ? payload.error : "智能组货请求失败。");
      }
      return payload;
    });
  });
}

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
            <div class="listing-rail-heading"><div class="listing-cache-actions"><button type="button" :disabled="!temuRecords.length" @click="clearTemuCache">清空</button></div></div>
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
            </button>
            <div v-if="!temuRecords.length" class="muted">暂无 Temu 商品。</div>
          </aside>

          <section v-if="selectedTemuRecord" class="panel platform-render temu-render">
            <div class="render-heading"><div><span class="platform-label temu-label">Temu</span><div class="render-title-row"><input class="render-title-input" type="text" v-model="selectedTemuRecord.product_name" @change="saveProductModule(selectedTemuRecord, 'basic')" aria-label="Temu 商品名称"><button v-if="workspaceMode === 'realtime'" class="listing-merge-button" type="button" :disabled="listingMergeBusy || !selected1688Record" @click="mergeSelectedListings">{{ listingMergeBusy ? '生成中…' : 'AI Listing' }}</button><button v-if="workspaceMode === 'smart'" class="workflow-direction-button" type="button" :disabled="workflowPromptBusy || !workflowSelectedImageUrl" @click="generateWorkflowPrompts">{{ workflowPromptBusy ? 'Kimi 分析中…' : selectedWorkflowTask && selectedWorkflowTask.prompts && selectedWorkflowTask.prompts.length ? '重新生成 4 个组货方向' : '生成 4 个组货方向' }}</button><button v-if="hasListingUndo(selectedTemuRecord)" class="operation-undo-button" type="button" :disabled="listingUndoBusy" @click="undoSelectedListing">{{ listingUndoBusy ? '返回中…' : '返回' }}</button></div><input class="render-category-input" type="text" v-model="selectedTemuRecord.product_category" @change="saveProductModule(selectedTemuRecord, 'basic')" placeholder="未提供商品分类" aria-label="Temu 商品分类"></div></div>
            <div class="render-gallery">
               <div class="gallery-thumbs" :class="{ 'is-image-drop-target': isImageDropTarget('temu-gallery') }" @dragenter.prevent.stop="setImageInteractionTarget('temu-gallery')" @dragover.prevent.stop="setImageInteractionTarget('temu-gallery')" @drop.prevent.stop="dropAliImageToTemuGallery($event, selectedTemuRecord)">
                <div v-for="(image, imageIndex) in galleryImages(selectedTemuRecord)" :key="image" class="thumb-item" draggable="true" :class="{ 'is-image-reorder-target': isImageReorderTarget('temu-gallery', imageIndex), 'is-ai-selected': isTemuGalleryEditSelected(selectedTemuRecord, imageIndex) }" @dragstart.stop="startImageReorder($event, selectedTemuRecord, 'gallery', imageIndex)" @dragend="endImageReorder" @dragenter.prevent.stop="setImageInteractionTarget('temu-gallery', imageIndex)" @dragover.prevent.stop="setImageInteractionTarget('temu-gallery', imageIndex)" @drop.prevent.stop="dropAliImageToTemuGallery($event, selectedTemuRecord, imageIndex)">
                  <button class="thumb" :class="{ active: selectedTemuGalleryIndex === imageIndex }" type="button" draggable="true" title="双击打开 Edits" @dragstart.stop="startImageReorder($event, selectedTemuRecord, 'gallery', imageIndex)" @dragend="endImageReorder" @click="handleTemuGallerySelection($event, selectedTemuRecord, imageIndex)" @dblclick.stop="openSingleGalleryImageEditor(selectedTemuRecord, imageIndex)"><img :src="imageSource(image)" referrerpolicy="no-referrer" alt="Temu 商品图片" draggable="false"><span v-if="isTemuGalleryEditSelected(selectedTemuRecord, imageIndex)" class="gallery-ai-check">✓</span></button>
                  <button class="image-delete-button" type="button" aria-label="删除图片" @click.stop="removeGalleryImage(selectedTemuRecord, imageIndex, 'temu')">×</button>
                </div>
                <button v-if="galleryEditSelection.length" class="gallery-ai-edit-button" type="button" @click.stop="openGalleryImageEditor(selectedTemuRecord)">AI 编辑 {{ galleryEditSelection.length }} 张</button>
                <label class="image-upload-button">+ 上传<input type="file" accept="image/*" multiple @change="handleGalleryUpload($event, selectedTemuRecord, 'temu')"></label>
              </div>
               <div class="gallery-main" :class="{ 'is-image-drop-target': isImageDropTarget('temu-gallery', 0), 'is-image-reorder-target': isImageReorderTarget('temu-gallery', 0) }" @dragenter.prevent.stop="setImageInteractionTarget('temu-gallery', 0)" @dragover.prevent.stop="setImageInteractionTarget('temu-gallery', 0)" @drop.prevent.stop="dropAliImageToTemuGallery($event, selectedTemuRecord, 0)"><img v-if="currentImage(selectedTemuRecord, 'temu')" :key="currentImage(selectedTemuRecord, 'temu')" :src="imageSource(currentImage(selectedTemuRecord, 'temu'))" referrerpolicy="no-referrer" alt="Temu 主图" draggable="true" title="双击打开 Edits" @dragstart.stop="startImageReorder($event, selectedTemuRecord, 'gallery', selectedTemuGalleryIndex)" @dragend="endImageReorder" @dblclick.stop="openSingleGalleryImageEditor(selectedTemuRecord, selectedTemuGalleryIndex)"><span v-else class="muted">拖入 1688 图片或暂无图片</span><button v-if="currentImage(selectedTemuRecord, 'temu')" class="gallery-image-search-button" type="button" :disabled="imageSearchBusy" title="用当前图片搜索 1688" aria-label="用当前图片搜索 1688" @click.stop="searchTemuImageOn1688(selectedTemuRecord, currentImage(selectedTemuRecord, 'temu'))"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.2"></circle><path d="m16 16 5 5"></path></svg></button></div>
            </div>
            <div class="facts compact-facts"><div class="fact wide"><label>分类 ID（逗号分隔）</label><input class="fact-edit-input" type="text" :value="stringifyField(selectedTemuRecord.category_ids)" @input="updateCategoryIds(selectedTemuRecord, $event.target.value)" @change="saveProductModule(selectedTemuRecord, 'basic')" aria-label="Temu 分类 ID"></div></div>
             <div class="sku-panel sku-spec-panel" :class="{ 'is-drop-mode': dragSkuReference }" @change="saveProductModule(selectedTemuRecord, 'skus')" @dragover.prevent @drop.prevent="ignoreNativeDrop">
                <div class="sku-spec-groups">
                  <div v-for="(group, groupIndex) in skuSpecGroups(selectedTemuRecord)" :key="groupIndex" class="sku-spec-group">
                    <div class="sku-spec-group-head" :class="{ 'is-drop-target': isAliDropTarget('group', group.name) }" @dragenter.prevent.stop="setAliDropTarget('group', group.name)" @dragover.prevent.stop="setAliDropTarget('group', group.name)" @drop.prevent.stop="dropAliSkuToTemuGroup($event, selectedTemuRecord, group.name)"><span>规格{{ groupIndex + 1 }}:</span><input class="sku-spec-name-input" type="text" :value="group.name" @input="updateSkuSpecName(selectedTemuRecord, group.name, $event.target.value)" aria-label="规格名称"><span class="sku-spec-count">{{ group.values.length }} 个选项</span><span class="sku-drop-badge">拖到此规格</span><button class="sku-spec-delete-button" type="button" @click.stop="removeTemuSpecGroup(selectedTemuRecord, group.name)">删除规格</button></div>
                    <div class="sku-spec-options"><div v-for="(value, optionIndex) in group.values" :key="optionIndex" class="sku-spec-option-wrap" :class="{ 'is-drop-target': isAliDropTarget('option', group.name, value) }" @dragenter.prevent.stop="setAliDropTarget('option', group.name, value)" @dragover.prevent.stop="setAliDropTarget('option', group.name, value)" @drop.prevent.stop="dropAliSkuToTemuOption($event, selectedTemuRecord, group.name, value)"><input class="sku-spec-option-input" type="text" :value="value" @input="updateSkuSpecOption(selectedTemuRecord, group.name, value, $event.target.value)" :aria-label="group.name + '选项'"><button class="sku-spec-option-delete" type="button" @click.stop="removeTemuSpecOption(selectedTemuRecord, group.name, value)" aria-label="删除规格选项">×</button></div></div>
                    <div class="sku-spec-group-actions"><input class="sku-spec-add-input" type="text" :value="specOptionDraft(selectedTemuRecord, group.name)" @input="setSpecOptionDraft(selectedTemuRecord, group.name, $event.target.value)" @keyup.enter="addTemuSpecOption(selectedTemuRecord, group.name)" placeholder="新增选项"><button class="sku-spec-add-button" type="button" @click="addTemuSpecOption(selectedTemuRecord, group.name)">+ 添加选项</button></div>
                  </div>
                  <div v-if="skuSpecGroups(selectedTemuRecord).length < 2" class="sku-spec-add-bar"><input class="sku-spec-add-input" type="text" v-model="newSpecGroupName" @keyup.enter="addTemuSpecGroup(selectedTemuRecord)" placeholder="新增规格名称"><button class="sku-spec-add-button" type="button" @click="addTemuSpecGroup(selectedTemuRecord)">+ 添加规格</button></div>
                  <div v-if="!skuSpecGroups(selectedTemuRecord).length" class="detail-empty">未识别到规格属性，可直接添加规格。</div>
                </div>
               <div class="sku-price-conversion"><strong>{{ selectedTemuRecord.price_conversion_label }}</strong><span>SKU 价格统一按人民币显示</span></div>
               <div class="sku-list-title">SKU列表（{{ selectedTemuRecord.sku.length }}个）</div>
                 <table class="sku-table sku-spec-table"><thead><tr><th>#</th><th>预览图</th><th v-for="group in skuSpecGroups(selectedTemuRecord)" :key="group.name" :class="{ 'is-drop-target': isAliDropTarget('group', group.name) }" @dragenter.prevent.stop="setAliDropTarget('group', group.name)" @dragover.prevent.stop="setAliDropTarget('group', group.name)" @drop.prevent.stop="dropAliSkuToTemuGroup($event, selectedTemuRecord, group.name)">{{ group.name }}</th><th>价格</th><th>库存</th><th>重量(KG)</th></tr></thead><tbody>
                 <tr v-for="(sku, skuIndex) in selectedTemuRecord.sku" :key="getSkuKey(selectedTemuRecord, sku, skuIndex)">
                   <td>{{ skuIndex + 1 }}</td>
                      <td class="sku-image-cell" :class="{ 'is-image-drop-target': isImageDropTarget('temu-sku', skuIndex) }" @dragenter.prevent.stop="setImageDropTarget('temu-sku', skuIndex)" @dragover.prevent.stop="setImageDropTarget('temu-sku', skuIndex)" @drop.prevent.stop="dropAliImageToTemuSku($event, selectedTemuRecord, sku, skuIndex)"><div class="sku-images-editor"><div v-for="(image, imageIndex) in skuImageUrls(sku)" :key="imageIndex" class="sku-image-item"><img :src="imageSource(image)" referrerpolicy="no-referrer" alt="SKU 图片" @click.stop="openImagePreview(image)"><button class="image-delete-button" type="button" aria-label="删除 SKU 图片" @click="removeSkuImageAt(selectedTemuRecord, sku, imageIndex)">×</button></div><label v-if="!skuImageUrls(sku).length" class="sku-image-empty-upload" title="上传 SKU 图片">+<input type="file" accept="image/*" @change.stop="handleSkuImageUpload($event, selectedTemuRecord, sku)"></label><div v-if="skuImageUrls(sku).length === 2 || hasSkuFusionUndo(selectedTemuRecord, sku, skuIndex)" class="sku-image-actions"><button v-if="skuImageUrls(sku).length === 2" class="sku-blend-button" type="button" :disabled="isSkuBlendBusy(selectedTemuRecord, sku, skuIndex)" title="将当前 SKU 的两张图片发送到 BeeAPI 并替换为返回图片" @click.stop="blendSkuImages(selectedTemuRecord, sku, skuIndex)">{{ isSkuBlendBusy(selectedTemuRecord, sku, skuIndex) ? '生成中…' : '溶图' }}</button><button v-if="hasSkuFusionUndo(selectedTemuRecord, sku, skuIndex)" class="sku-fusion-undo-button" type="button" :disabled="isSkuFusionUndoBusy(selectedTemuRecord, sku, skuIndex)" @click.stop="undoSkuImageFusion(selectedTemuRecord, sku, skuIndex)">{{ isSkuFusionUndoBusy(selectedTemuRecord, sku, skuIndex) ? '返回中…' : '返回' }}</button></div></div></td>
                    <td v-for="(group, groupIndex) in skuSpecGroups(selectedTemuRecord)" :key="group.name" class="sku-spec-cell" :class="{ 'is-drop-target': isTemuSkuCellDropTarget(skuIndex, group.name) }" @dragenter.prevent.stop="setTemuSkuCellDropTarget(skuIndex, group.name)" @dragover.prevent.stop="setTemuSkuCellDropTarget(skuIndex, group.name)" @drop.prevent.stop="dropAliSkuToTemuSkuCell($event, selectedTemuRecord, sku, skuIndex, group.name)"><input class="sku-edit-input" type="text" :value="skuSpecValue(sku, groupIndex)" @input="updateSkuSpecValue(sku, groupIndex, $event.target.value)" :aria-label="group.name"></td>
                    <td><input class="sku-edit-input" type="text" inputmode="decimal" v-model="sku.sku_price" aria-label="SKU 价格"></td><td><input class="sku-edit-input" type="text" inputmode="numeric" v-model="sku.sku_stock" aria-label="SKU 库存"></td><td><input class="sku-edit-input" type="text" inputmode="decimal" v-model="sku.sku_weight" aria-label="SKU 重量(KG)"></td>
                 </tr>
                  <tr v-if="!selectedTemuRecord.sku.length"><td :colspan="skuSpecGroups(selectedTemuRecord).length + 5" class="empty">暂无 SKU 数据</td></tr>
               </tbody></table>
             </div>
               <div class="detail-section" :class="{ 'is-image-drop-target': isImageDropTarget('temu-detail') }" @dragenter.prevent.stop="setImageInteractionTarget('temu-detail')" @dragover.prevent.stop="setImageInteractionTarget('temu-detail')" @drop.prevent.stop="dropAliImageToTemuDetail($event, selectedTemuRecord)"><h3>商品详情</h3><div v-if="selectedTemuRecord.detail_image_urls.length" class="detail-images"><div v-for="(image, detailIndex) in selectedTemuRecord.detail_image_urls" :key="image" class="detail-image-editor" draggable="true" title="双击打开 Edits" :class="{ 'is-image-reorder-target': isImageReorderTarget('temu-detail', detailIndex) }" @dragstart.stop="startImageReorder($event, selectedTemuRecord, 'detail', detailIndex)" @dragend="endImageReorder" @dragenter.prevent.stop="setImageInteractionTarget('temu-detail', detailIndex)" @dragover.prevent.stop="setImageInteractionTarget('temu-detail', detailIndex)" @drop.prevent.stop="dropAliImageToTemuDetail($event, selectedTemuRecord, detailIndex)" @dblclick.stop="openDetailImageEditor(selectedTemuRecord, image, detailIndex)"><img :src="imageSource(image)" referrerpolicy="no-referrer" alt="Temu 商品详情图" draggable="false"><button class="image-delete-button" type="button" aria-label="删除详情图" @click="removeDetailImage(selectedTemuRecord, detailIndex)">×</button></div></div><div v-else class="detail-empty-upload"><label class="detail-empty-upload-button" title="上传详情图">+<input type="file" accept="image/*" multiple @change="handleDetailUpload($event, selectedTemuRecord)"></label><span>将右侧 1688 主图/详情图拖到这里。</span></div></div>
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
                  <div class="smart-result-image-wrap"><button class="smart-result-image" type="button" :disabled="!item.image_url" @click="selectWorkflowResult(index)"><img v-if="item.image_url" :src="imageSource(item.image_url)" alt="AI 组货候选图"><span v-else>{{ item.status === 'generating' || item.status === 'queued' ? '后台生成中…' : item.error || '等待生成' }}</span><i v-if="workflowSelectedResultIndex === index">已选择</i></button><button v-if="item.image_url" class="smart-result-search-button" :class="{ 'is-busy': workflowSearchBusyKeys[index] }" type="button" :disabled="workflowSearchBusyKeys[index] || item.status === 'generating' || item.status === 'queued'" title="用这张生成图搜索 1688" :aria-label="workflowSearchBusyKeys[index] ? '1688 搜图中' : '用这张生成图搜索 1688'" @click.stop="searchWorkflow1688(index)"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.2"></circle><path d="m16 16 5 5"></path></svg></button></div>
                  <div class="smart-result-copy"><strong>{{ item.relation }}</strong><span>{{ item.product_intro }}</span></div>
                  <textarea v-model="item.prompt" rows="5" @input="markWorkflowPromptDraft(index, $event.target.value)" :aria-label="item.relation + '生图提示词'"></textarea>
                  <div class="smart-result-actions"><button class="smart-secondary-action" type="button" :disabled="!selectedTemuRecord" @click="generateWorkflowImages(index)">单独重生</button></div>
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
               <div class="sku-price-conversion"><strong>{{ selected1688Record.price_conversion_label }}</strong><span>SKU 价格统一按人民币显示</span></div>
               <div class="sku-list-title">SKU列表（{{ selected1688Record.sku.length }}个）</div>
                <div class="sku-source-hint"><span class="sku-drag-handle hint-handle">⠿</span><span>可拖整行或单个 SubSku：拖到左侧规格组作用于全部 Temu SKU；拖到具体选项只作用于匹配行；拖到 Temu SKU 单元格会追加规格值，不覆盖原值，价格自动相加。</span></div>
               <table class="sku-table sku-spec-table"><thead><tr><th>#</th><th>预览图</th><th>{{ aliSubSkuHeader(selected1688Record, 0) }}</th><th>{{ aliSubSkuHeader(selected1688Record, 1) }}</th><th>价格</th><th>库存</th></tr></thead><tbody>
                 <tr v-for="(sku, skuIndex) in selected1688Record.sku" :key="getSkuKey(selected1688Record, sku, skuIndex)" class="sku-source-row" :class="{ 'is-dragging-source': dragSkuReference && String(dragSkuReference.main_id) === String(selected1688Record.main_id) && String(dragSkuReference.sku_index) === String(skuIndex) }">
                   <td class="sku-index-cell"><button class="sku-drag-handle" type="button" draggable="true" title="拖动整行到左侧" aria-label="拖动 1688 SKU" @dragstart.stop="startAliDrag($event, sku, skuIndex)" @dragend="endAliDrag">⠿</button><span>{{ skuIndex + 1 }}</span></td>
                      <td><div class="sku-images-editor"><div v-for="(image, imageIndex) in skuImageUrls(sku)" :key="imageIndex" class="sku-image-item"><img :src="imageSource(image)" referrerpolicy="no-referrer" alt="SKU 图片" draggable="true" @dragstart.stop="startAliImageDrag($event, selected1688Record, image, 'sku', skuIndex)" @dragend="endAliImageDrag" @click.stop="openImagePreview(image)"><button class="image-delete-button" type="button" aria-label="删除 SKU 图片" @click="removeSkuImageAt(selected1688Record, sku, imageIndex)">×</button></div><label v-if="!skuImageUrls(sku).length" class="sku-image-empty-upload" title="上传 SKU 图片">+<input type="file" accept="image/*" @change.stop="handleSkuImageUpload($event, selected1688Record, sku)"></label></div></td>
                   <td><div class="subsku-editor"><input class="sku-edit-input subsku-value-input" type="text" draggable="true" :class="{ 'is-dragging-subsku': dragSkuReference && String(dragSkuReference.main_id) === String(selected1688Record.main_id) && String(dragSkuReference.sku_index) === String(skuIndex) && dragSkuReference.subsku_index === 0 }" :value="aliSubSkuValue(sku, 0)" :title="'拖动 ' + aliSubSkuHeader(selected1688Record, 0)" :aria-label="'1688 ' + aliSubSkuHeader(selected1688Record, 0)" @dragstart.stop="startAliSubSkuDrag($event, sku, skuIndex, 0)" @dragend="endAliDrag" @input="updateAliSubSkuValue(sku, 0, $event.target.value)"></div></td><td><div class="subsku-editor"><input class="sku-edit-input subsku-value-input" type="text" draggable="true" :disabled="!sku.SubSku2" :class="{ 'is-dragging-subsku': dragSkuReference && String(dragSkuReference.main_id) === String(selected1688Record.main_id) && String(dragSkuReference.sku_index) === String(skuIndex) && dragSkuReference.subsku_index === 1 }" :value="aliSubSkuValue(sku, 1)" :title="'拖动 ' + aliSubSkuHeader(selected1688Record, 1)" :aria-label="'1688 ' + aliSubSkuHeader(selected1688Record, 1)" @dragstart.stop="startAliSubSkuDrag($event, sku, skuIndex, 1)" @dragend="endAliDrag" @input="updateAliSubSkuValue(sku, 1, $event.target.value)"></div></td><td><input class="sku-edit-input" type="text" inputmode="decimal" v-model="sku.sku_price" aria-label="SKU 价格"></td><td><input class="sku-edit-input" type="text" inputmode="numeric" v-model="sku.sku_stock" aria-label="SKU 库存"></td>
                 </tr>
                 <tr v-if="!selected1688Record.sku.length"><td colspan="6" class="empty">暂无 SKU 数据</td></tr>
               </tbody></table>
             </div>
               <div class="detail-section"><h3>商品详情</h3><div v-if="selected1688Record.detail_image_urls.length" class="detail-images"><div v-for="(image, detailIndex) in selected1688Record.detail_image_urls" :key="image" class="detail-image-editor"><img :src="imageSource(image)" referrerpolicy="no-referrer" alt="1688 商品详情图" draggable="true" @dragstart.stop="startAliImageDrag($event, selected1688Record, image, 'detail', detailIndex)" @dragend="endAliImageDrag"></div></div><div v-else class="detail-empty-upload"><span>暂无详情图。</span></div></div>
          </section>
          <section v-else-if="workspaceMode === 'realtime'" class="panel platform-render empty">请选择 1688 商品。</section>
        </div>
        <div v-if="imageEditorOpen" class="image-editor-modal" @click.self="closeGalleryImageEditor">
          <section class="image-editor-dialog" role="dialog" aria-modal="true" aria-label="AI 图片编辑">
            <header class="image-editor-header"><div><strong>{{ galleryEditSelection.length === 2 ? '双图溶图' : '单图编辑' }}</strong><span>{{ galleryEditSelection.length === 2 ? 'Fusion API' : 'Edits API' }}</span></div><button type="button" aria-label="关闭 AI 图片编辑" @click="closeGalleryImageEditor">×</button></header>
            <div class="image-editor-source-list"><img v-for="(image, sourceIndex) in galleryImageEditorSources(selectedTemuRecord)" :key="sourceIndex" :src="imageSource(image)" alt="待编辑图片"></div>
            <label class="image-editor-prompt"><span>提示词</span><textarea v-model="imageEditorPrompt" rows="5" aria-label="图片编辑提示词"></textarea></label>
            <div v-if="imageEditorError" class="image-editor-error">{{ imageEditorError }}</div>
            <div class="image-editor-result"><div v-if="imageEditorBusy" class="image-editor-loading"><span></span><strong>图片生成中…</strong><small>请稍候，完成后会在这里显示。</small></div><img v-else-if="imageEditorGeneratedUrl" :src="imageSource(imageEditorGeneratedUrl)" alt="AI 生成结果"><span v-else>填写提示词后开始生成。</span></div>
            <footer class="image-editor-actions"><button class="image-editor-cancel" type="button" @click="closeGalleryImageEditor">取消</button><button class="image-editor-generate" type="button" :disabled="imageEditorBusy || !imageEditorPrompt.trim()" @click="submitGalleryImageEdit">{{ imageEditorBusy ? '生成中…' : imageEditorGeneratedUrl ? '重新生成' : '开始生成' }}</button><button class="image-editor-confirm" type="button" :disabled="imageEditorBusy || !imageEditorGeneratedUrl" @click="confirmGalleryImageEdit">确认替换</button></footer>
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
    return {
      records: [],
      renderMode: queryMode === "export" ? "export" : "realtime",
      workspaceMode: "realtime",
      realtimeConnected: false,
      realtimeSource: null,
      activePlatform: "temu",
      selectedMainId: "",
      selectedGalleryIndex: 0,
      selectedTemuGalleryIndex: 0,
      selected1688GalleryIndex: 0,
      selectedTemuMainId: "",
      selected1688MainId: "",
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
      imageEditorGeneratedUrl: "",
      imageEditorBusy: false,
      imageEditorError: "",
      imageEditorRequestId: 0,
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
      workflowPromptBusy: false,
      workflowGenerateBusy: false,
       workflowSearchBusyKeys: {},
       workflowStatusText: "等待选择 Temu 商品。",
       workflowStatusType: "normal",
       workflowSource: null,
       pendingCacheEvents: {},
       miaoshouExportBusy: false
    };
  },
  /** Start cache subscription after the Vue view is mounted. */
  mounted: function mountedApp() {
    this.loadImageEditConfig();
    if (this.renderMode === "realtime") {
      this.startRealtimeCache();
    }
    this.startWorkflowStream();
  },
  /** Close the cache subscription before the Vue view is destroyed. */
  beforeUnmount: function cleanupRealtimeCache() {
    this.stopRealtimeCache();
    this.stopWorkflowStream();
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
            throw new Error(payload && payload.error ? payload.error.message : "API 设置保存失败。");
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

    /** Write one edited product module directly back to the backend cache. */
    saveProductModule: function saveProductModule(record, moduleName) {
      if (!record) {
        return;
      }
      const pendingCacheEventKey = this.markPendingCacheEvent(record);
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
      const view = this;
      const endpoint = "/products/" + encodeURIComponent(record.platform) + "/" + encodeURIComponent(record.platform_id) + "/modules/" + encodeURIComponent(moduleName);
      fetch(apiUrl(endpoint), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: Number(record.version || 1), data: data })
      }).then(function handleModuleSaveResponse(response) {
        return response.json().then(function validateModuleSavePayload(payload) {
          if (!response.ok || !payload.ok) {
            throw new Error(payload && payload.error ? payload.error.message : "保存失败。");
          }
          return payload.data;
        });
      }).then(function applySavedModule(result) {
        view.replaceProductViewModel(result.product);
        view.setStatus("cache 已更新。", "success");
      }).catch(function handleModuleSaveError(error) {
        if (pendingCacheEventKey) {
          view.clearPendingCacheEvent(pendingCacheEventKey);
        }
        view.setStatus(error.message || "cache 更新失败。", "error");
      });
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
            throw new Error(payload && payload.error ? payload.error : "Kimi 合并 Listing 失败。");
          }
          return payload;
        });
      }).then(function handleListingMergeSuccess(payload) {
        const undoKey = view.getListingUndoKey(temuRecord);
        view.applyListingToRecord(temuRecord, payload.listing);
        view.listingUndoTokens[undoKey] = String(payload.undo_token || "");
        view.setStatus("Kimi 返回内容已更新到当前页面，暂未自动保存。", "success");
      }).catch(function handleListingMergeError(error) {
        view.setStatus("Listing 合并失败：" + (error.message || "请求失败。"), "error");
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
            throw new Error(payload && payload.error ? payload.error : "Listing 返回失败。");
          }
          return payload;
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
      this.records = records;
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
    },

    /** Apply the long-lived local cache payload received from the server. */
    applyCachePayload: function applyCachePayload(payload) {
      const instruction = payload && payload.update_instruction && typeof payload.update_instruction === "object"
        ? payload.update_instruction
        : {};
      const records = payload && Array.isArray(payload.records) ? payload.records : [];
      this.applyRecords(records, "cache.json", payload);
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
      /** Handle the initial cache HTTP response. */
      fetch(apiUrl("/workbench"), { cache: "no-store" }).then(function handleCacheResponse(response) {
        if (!response.ok) {
          throw new Error("本地 cache 服务未启动。 ");
        }
        return response.json();
      }).then(function handleInitialCachePayload(payload) {
        view.applyCachePayload(payload.data || {});
      }).catch(function handleInitialCacheError() {
        view.setStatus("未连接到本地 cache，请先运行 npm run dev。", "normal");
      });
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
        fetch(apiUrl("/workbench"), { cache: "no-store" }).then(function handleRefreshResponse(response) {
          return response.json();
        }).then(function handleRefreshPayload(payload) {
          view.applyCachePayload(payload.data || {});
        }).catch(function handleRefreshError() {
          view.setStatus("实时数据刷新失败。", "error");
        });
      };
      /** Mark the cache stream as disconnected without clearing loaded data. */
      source.onerror = function handleCacheError() {
        view.realtimeConnected = false;
      };
      this.realtimeSource = source;
    },

    /** Close the current real-time cache stream. */
    stopRealtimeCache: function stopRealtimeCache() {
      if (this.realtimeSource) {
        this.realtimeSource.close();
        this.realtimeSource = null;
      }
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
      if (this.workspaceMode === "smart" && this.selectedTemuRecord) {
        this.syncWorkflowSelection();
      }
    },

    /** Set the visible status message for the inline intelligent-packing workflow. */
    setWorkflowStatus: function setWorkflowStatus(message, type) {
      this.workflowStatusText = String(message || "");
      this.workflowStatusType = type || "normal";
    },

    /** Start receiving persisted intelligent-packing task updates. */
    startWorkflowStream: function startWorkflowStream() {
      this.stopWorkflowStream();
      const view = this;
      this.workflowSource = new EventSource(workflowApiUrl("/workflow/events"));
      this.workflowSource.onmessage = function handleWorkflowMessage(event) {
        try {
          view.applyWorkflowPayload(JSON.parse(event.data));
        } catch (error) {
          view.setWorkflowStatus("智能组货状态格式错误。", "error");
        }
      };
    },

    /** Close the current intelligent-packing task stream. */
    stopWorkflowStream: function stopWorkflowStream() {
      if (this.workflowSource) {
        this.workflowSource.close();
        this.workflowSource = null;
      }
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
        this.setWorkflowStatus(this.workflowTaskStatusText(this.selectedTemuMainId), task.status === "completed" ? "success" : "normal");
      }
    },

    /** Restore the inline workflow controls for the selected Temu record. */
    syncWorkflowSelection: function syncWorkflowSelection() {
      const record = this.selectedTemuRecord;
      const task = this.selectedWorkflowTask;
      const images = this.workflowSourceImages;
      this.workflowPromptDrafts = {};
      this.workflowSearchBusyKeys = {};
      this.workflowSelectedImageUrl = task && task.selected_image_url ? task.selected_image_url : record && record.main_image_url ? record.main_image_url : images[0] || "";
      this.workflowSelectedResultIndex = task && Number.isFinite(Number(task.selected_result_index)) ? Number(task.selected_result_index) : -1;
      this.syncWorkflowPrompts(task);
      this.setWorkflowStatus(task && task.status !== "idle" ? this.workflowTaskStatusText(this.selectedTemuMainId) : record ? "已选择 Temu 商品，请确认分析主图。" : "等待选择 Temu 商品。", "normal");
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

    /** Request four fixed intelligent-packing directions for the selected Temu product. */
    generateWorkflowPrompts: function generateWorkflowPrompts() {
      if (!this.selectedTemuRecord || !this.workflowSelectedImageUrl || this.workflowPromptBusy) {
        return;
      }
      this.workflowPromptBusy = true;
      this.workflowPromptDrafts = {};
      this.setWorkflowStatus("Kimi 正在分析商品并生成四个组货方向…", "normal");
      const view = this;
      const requestedTemuMainId = String(this.selectedTemuRecord.main_id);
      requestWorkflowJson(workflowApiUrl("/workflow/prompts"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          temu_main_id: this.selectedTemuRecord.main_id,
          image_url: this.workflowSelectedImageUrl,
          product: {
            title: this.selectedTemuRecord.product_name,
            category: this.selectedTemuRecord.product_category,
            attributes: this.selectedTemuRecord.attributes_json
          }
        })
      }).then(function handleWorkflowPromptSuccess(payload) {
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
        view.setWorkflowStatus("Kimi 提词失败：" + error.message, "error");
      }).finally(function finishWorkflowPromptRequest() {
        view.workflowPromptBusy = false;
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
        if (String(view.selectedTemuMainId) !== requestedTemuMainId) {
          return;
        }
        view.syncWorkflowPrompts(payload.task);
        if (index === undefined) {
          view.workflowPromptDrafts = {};
        } else {
          delete view.workflowPromptDrafts[String(Number(index))];
        }
        view.setWorkflowStatus(index === undefined ? "已提交后台生成，图片会逐张显示。" : "已提交后台重生，完成后会自动更新。", "success");
      }).catch(function handleWorkflowGenerationError(error) {
        if (String(view.selectedTemuMainId) !== requestedTemuMainId) {
          return;
        }
        view.setWorkflowStatus("BeeAPI 生图失败：" + error.message, "error");
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
      const searchWindow = window.open("about:blank", "_blank");
      const view = this;
      requestWorkflowJson(apiUrl("/images/search-1688"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image_url: result.image_url })
      }).then(function handleWorkflowSearchSuccess(payload) {
        if (String(view.selectedTemuMainId) !== requestedTemuMainId) {
          return;
        }
        const searchData = payload && payload.data && typeof payload.data === "object" ? payload.data : {};
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
        if (!searchWindow || searchWindow.closed) {
          view.setWorkflowStatus("第 " + (resultIndex + 1) + " 张图片搜图完成。浏览器阻止了自动打开，请点击下方“重新打开搜款页”。", "normal");
          return;
        }
        searchWindow.location.href = searchUrl;
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
        if (searchWindow && !searchWindow.closed) {
          searchWindow.close();
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
      this.closeGalleryImageEditor();
      this.syncWorkflowSelection();
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
          throw new Error(payload && payload.error || "删除失败。");
        }
        this.applyCachePayload(payload.data || {});
        this.setStatus("已删除当前 Temu 缓存。", "success");
      } catch (error) {
        this.setStatus("删除 Temu 缓存失败：" + error.message, "error");
      }
    },

    /** Clear every Temu product while preserving all cached 1688 products. */
    clearTemuCache: async function clearTemuCache() {
      if (!this.temuRecords.length || !window.confirm("确认清空全部 Temu 缓存？1688 缓存不会删除。")) {
        return;
      }
      try {
        const response = await fetch(apiUrl("/products/platform/temu"), { method: "DELETE" });
        const payload = await response.json();
        if (!response.ok || !payload || !payload.ok) {
          throw new Error(payload && payload.error || "清空失败。");
        }
        this.applyCachePayload(payload.data || {});
        this.setStatus("Temu 缓存已清空，1688 缓存已保留。", "success");
      } catch (error) {
        this.setStatus("清空 Temu 缓存失败：" + error.message, "error");
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
          throw new Error(payload && payload.error || "清空失败。");
        }
        this.applyCachePayload(payload.data || {});
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

    /** Send the selected Temu image to the server-side 1688 image-search API. */
    searchTemuImageOn1688: function searchTemuImageOn1688(record, image) {
      const source = String(image || "").trim();
      if (!record || !source || this.imageSearchBusy) {
        return;
      }
      this.imageSearchBusy = true;
      this.setStatus("正在用当前图片搜索 1688…", "normal");
      const view = this;
      fetch(apiUrl("/images/search-1688"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image_url: source })
      }).then(function handleImageSearchResponse(response) {
        return response.json().then(function handleImageSearchPayload(payload) {
          if (!response.ok || !payload || !payload.ok) {
            throw new Error(payload && payload.error && payload.error.message ? payload.error.message : "1688 搜图失败。");
          }
          return payload.data || {};
        });
      }).then(function openImageSearchPage(result) {
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

    /** Check whether one SKU is currently waiting for an image-edit response. */
    isSkuBlendBusy: function isSkuBlendBusy(record, sku, index) {
      const key = this.getSkuBlendKey(record, sku, index);
      return Boolean(this.imageEditBusyKeys[key]);
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
      const busyKey = this.getSkuBlendKey(record, sku, rowIndex);
      if (this.imageEditBusyKeys[busyKey]) {
        return;
      }
      this.imageEditBusyKeys[busyKey] = true;
      const view = this;
      const editSize = this.imageEditSize;
      this.setStatus("正在提交两张 SKU 图片到本地 Server…", "normal");
      fetch(apiUrl("/images/fusion"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          image_urls: images,
          size: editSize
        })
      }).then(function handleImageEditResponse(response) {
        return response.json().then(function handleImageEditPayload(payload) {
          if (!response.ok || !payload || !payload.ok) {
            throw new Error(payload && payload.error ? payload.error : "溶图服务请求失败。");
          }
          return payload;
        });
      }).then(function handleImageEditSuccess(payload) {
        const imageUrl = String(payload.image_url || "").trim();
        if (!imageUrl) {
          throw new Error("溶图服务没有返回图片。");
        }
        view.replaceSkuImagesWithGenerated(sku, imageUrl);
        view.imageFusionUndoTokens[busyKey] = String(payload.undo_token || "");
        const size = String(payload.size || editSize || "1k").toUpperCase();
        view.setStatus("SKU #" + (Number(rowIndex) + 1) + " 溶图完成（" + size + "），可点返回恢复两张原图。", "success");
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
            throw new Error(payload && payload.error ? payload.error : "溶图返回失败。");
          }
          return payload;
        });
      }).then(function handleFusionUndoSuccess(payload) {
        const imageUrls = Array.isArray(payload.image_urls) ? payload.image_urls.slice() : [];
        sku.sku_image_urls = imageUrls;
        sku.sku_image_url = imageUrls[0] || "";
        delete view.imageFusionUndoTokens[busyKey];
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
              throw new Error(payload && payload.error ? payload.error.message : "图片缓存失败。");
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
            const imageUrls = asArray(payload && payload.image_urls);
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
              throw new Error(payload && payload.error ? payload.error.message : "JSON 导入失败。");
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
              throw new Error(payload && payload.error ? payload.error.message : "恢复失败。");
            }
            return payload.data;
          });
        }).then(function applyRestoreViewModel(payload) {
          view.applyCachePayload(payload);
          view.workspaceMode = "realtime";
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
      this.imageEditorPrompt = sources.length === 2 ? this.imageEditorFusionPrompt : this.imageEditorEditPrompt;
      this.imageEditorGeneratedUrl = "";
      this.imageEditorError = "";
      this.imageEditorOpen = true;
    },

    /** Submit selected images to the single-image edits or two-image fusion API. */
    submitGalleryImageEdit: function submitGalleryImageEdit() {
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
            throw new Error(payload && payload.error ? payload.error : "图片生成失败。");
          }
          return payload;
        });
      }).then(function handleGalleryEditSuccess(payload) {
        if (requestId !== view.imageEditorRequestId || !view.imageEditorOpen) {
          return;
        }
        view.imageEditorGeneratedUrl = String(payload.image_url || "");
        if (!view.imageEditorGeneratedUrl) {
          throw new Error("图片服务没有返回生成结果。");
        }
      }).catch(function handleGalleryEditError(error) {
        if (requestId === view.imageEditorRequestId && view.imageEditorOpen) {
          view.imageEditorError = error.message || "图片生成失败。";
        }
      }).finally(function handleGalleryEditFinished() {
        if (requestId === view.imageEditorRequestId) {
          view.imageEditorBusy = false;
        }
      });
    },

    /** Replace selected gallery positions only after the user confirms the result. */
    confirmGalleryImageEdit: function confirmGalleryImageEdit() {
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
        this.closeGalleryImageEditor();
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
      this.closeGalleryImageEditor();
    },

    /** Close the image editor without changing gallery JSON. */
    closeGalleryImageEditor: function closeGalleryImageEditor() {
      this.imageEditorRequestId += 1;
      this.imageEditorOpen = false;
      this.imageEditorBusy = false;
      this.imageEditorGeneratedUrl = "";
      this.imageEditorError = "";
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

    /** Start dragging one 1688 product image to a Temu image target. */
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
      this.imageDropTarget = [targetType || "", targetIndex === undefined ? "" : String(targetIndex)].join("|");
    },

    /** Test whether one Temu image area is the active image drop target. */
    isImageDropTarget: function isImageDropTarget(targetType, targetIndex) {
      return this.imageDropTarget === [targetType || "", targetIndex === undefined ? "" : String(targetIndex)].join("|");
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

    /** Mark one position for both new-image insertion and same-list reordering. */
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
      this.setImageDropTarget(targetType, targetIndex);
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

    /** Drop one 1688 image into the Temu product gallery or reorder the current gallery. */
    dropAliImageToTemuGallery: function dropAliImageToTemuGallery(event, record, targetIndex) {
      event.preventDefault();
      event.stopPropagation();
      const reorder = this.imageReorderReference;
      if (reorder && reorder.record_key === this.imageRecordKey(record) && reorder.image_type === "gallery") {
        this.dropImageReorder(event, record, "gallery", targetIndex);
        return;
      }
      const reference = this.dragImageReference || this.readDraggedImageReference(event);
      const imageUrl = reference && reference.image_url ? String(reference.image_url) : "";
      if (record && imageUrl) {
        const added = this.appendTemuGalleryImage(record, imageUrl, targetIndex);
        if (targetIndex === undefined) {
          record.main_image_url = imageUrl;
        }
        this.updateGallerySelection(record, "temu", record.gallery_image_urls.indexOf(imageUrl));
        this.setStatus(targetIndex === undefined
          ? (added ? "已将 1688 图片添加到 Temu 主图。" : "已将已有图片设为 Temu 主图。")
          : (added ? "已将 1688 图片插入 Temu 主图列表。" : "已调整 Temu 主图顺序。"), "success");
        this.saveProductModule(record, "images");
      }
      this.endAliImageDrag();
    },

    /** Drop one 1688 image into the Temu detail image list or reorder the current list. */
    dropAliImageToTemuDetail: function dropAliImageToTemuDetail(event, record, targetIndex) {
      event.preventDefault();
      event.stopPropagation();
      const reorder = this.imageReorderReference;
      if (reorder && reorder.record_key === this.imageRecordKey(record) && reorder.image_type === "detail") {
        this.dropImageReorder(event, record, "detail", targetIndex);
        return;
      }
      const reference = this.dragImageReference || this.readDraggedImageReference(event);
      const imageUrl = reference && reference.image_url ? String(reference.image_url) : "";
      if (record && imageUrl) {
        const added = this.appendTemuDetailImage(record, imageUrl, targetIndex);
        this.setStatus(targetIndex === undefined
          ? "已将 1688 图片添加到 Temu 商品详情。"
          : (added ? "已将 1688 图片插入 Temu 详情图列表。" : "已调整 Temu 详情图顺序。"), "success");
        this.saveProductModule(record, "images");
      }
      this.endAliImageDrag();
    },

    /** Drop one 1688 image into a specific Temu SKU image cell. */
    dropAliImageToTemuSku: function dropAliImageToTemuSku(event, record, targetSku, rowIndex) {
      event.preventDefault();
      event.stopPropagation();
      const reference = this.dragImageReference || this.readDraggedImageReference(event);
      const imageUrl = reference && reference.image_url ? String(reference.image_url) : "";
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

    /** Request the server to generate and download the Temu-only 妙手 ZIP. */
    exportMiaoshouZip: async function exportMiaoshouZip() {
      if (this.miaoshouExportBusy || !this.temuRecords.length) {
        return;
      }
      this.miaoshouExportBusy = true;
      try {
        const response = await fetch(apiUrl("/zip"), { cache: "no-store" });
        if (!response.ok) {
          let message = "服务器妙手导出失败。";
          try {
            const payload = await response.json();
            if (payload && payload.error && payload.error.message) {
              message = payload.error.message;
            }
          } catch (parseError) {
            message = "服务器妙手导出失败，HTTP " + response.status + "。";
          }
          throw new Error(message);
        }
        const blob = await response.blob();
        if (!blob.size) {
          throw new Error("服务器返回了空 ZIP 文件。");
        }
        const contentDisposition = response.headers.get("Content-Disposition") || "";
        const fileMatch = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i);
        const fileName = fileMatch ? decodeURIComponent(fileMatch[1]) : "Temu-妙手导入包-" + Date.now() + ".zip";
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        /** Release the downloaded Blob URL after Windows has started the file transfer. */
        function releaseMiaoshouDownloadUrl() {
          URL.revokeObjectURL(url);
          link.remove();
        }
        window.setTimeout(releaseMiaoshouDownloadUrl, 1000);
        const failureCount = Number(response.headers.get("X-Miaoshou-Image-Failures") || 0);
        const failureText = failureCount ? "，" + failureCount + " 张图片下载失败" : "";
        this.setStatus("服务器已生成妙手 ZIP，共 " + (response.headers.get("X-Miaoshou-Product-Count") || this.temuRecords.length) + " 个 Temu 商品" + failureText + "。", failureCount ? "normal" : "success");
      } catch (error) {
        this.setStatus("妙手 ZIP 导出失败：" + (error.message || "未知错误"), "error");
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

app.mount("#app");
