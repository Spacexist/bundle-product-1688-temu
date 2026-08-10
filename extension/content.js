var unifiedCollectorButtonId = "unified-platform-collector-button";
var unifiedBindingPanelId = "unified-temu-binding-panel";
var unifiedBindingModalId = "unified-temu-binding-modal";
var unifiedTemuProductPattern = /(?:^|-)g-\d+\.html(?:$|[?#])/i;
var unified1688ProductPattern = /\/offer\/\d+\.html/i;
var unifiedSelectedTemuRecord = null;

/** Resolve the current page platform and whether it is a product detail page. */
function getCurrentUnifiedPlatform() {
  var host = location.hostname.toLowerCase();
  var path = location.pathname + location.search;
  if ((host === "temu.com" || host.endsWith(".temu.com"))
    && unifiedTemuProductPattern.test(path)) {
    return "temu";
  }
  if (host === "detail.1688.com" && unified1688ProductPattern.test(location.pathname)) {
    return "1688";
  }
  return "";
}

/** Return the button label for the current platform. */
function getUnifiedButtonText(platform) {
  return platform === "1688" ? "确认并绑定" : "采集Temu";
}

/** Add the unified collection button to the current product page. */
function initializeUnifiedCollectorButton() {
  var platform = getCurrentUnifiedPlatform();
  var oldButton = document.getElementById(unifiedCollectorButtonId);
  if (!platform) {
    if (oldButton) {
      oldButton.remove();
    }
    return;
  }
  if (oldButton) {
    oldButton.textContent = getUnifiedButtonText(platform);
    oldButton.dataset.platform = platform;
    return;
  }
  var button = document.createElement("button");
  button.id = unifiedCollectorButtonId;
  button.type = "button";
  button.dataset.platform = platform;
  button.textContent = getUnifiedButtonText(platform);
  button.title = "采集当前商品并写入统一批次";
  button.addEventListener("click", handleUnifiedCollectorClick);
  document.documentElement.appendChild(button);
}

/** Send the current platform collection request to the background worker. */
function handleUnifiedCollectorClick(event) {
  var button = event.currentTarget;
  var platform = button.dataset.platform || getCurrentUnifiedPlatform();
  var targetTemuMainId = platform === "1688" && unifiedSelectedTemuRecord
    ? String(unifiedSelectedTemuRecord.main_id || unifiedSelectedTemuRecord.mainid || "")
    : "";
  var targetTemuPlatformId = platform === "1688" && unifiedSelectedTemuRecord
    ? String(unifiedSelectedTemuRecord.platform_id || "")
    : "";
  button.disabled = true;
  button.classList.remove("is-success", "is-error");
  button.classList.add("is-loading");
  button.textContent = "采集中";
  chrome.runtime.sendMessage({
    type: "collectUnifiedProduct",
    platform: platform,
    targetTemuMainId: targetTemuMainId,
    targetTemuPlatformId: targetTemuPlatformId
  }, function handleUnifiedResponse(response) {
    var lastError = chrome.runtime.lastError;
    button.classList.remove("is-loading");
    if (lastError || !response || !response.ok) {
      button.classList.add("is-error");
      button.textContent = "重试";
      button.title = lastError ? lastError.message : response && response.error ? response.error : "采集失败";
      window.setTimeout(resetUnifiedCollectorButton, 2600, button);
      return;
    }
    button.classList.add("is-success");
    button.textContent = response.workflow_completed ? "已绑定Temu" : response.replaced ? "已更新" : "已加入";
    window.setTimeout(resetUnifiedCollectorButton, 2400, button);
  });
}

/** Reset the unified page button after a collection result. */
function resetUnifiedCollectorButton(button) {
  button.disabled = false;
  button.classList.remove("is-success", "is-error");
  button.textContent = getUnifiedButtonText(button.dataset.platform || getCurrentUnifiedPlatform());
  button.title = "采集当前商品并写入统一批次";
}

/** Read one Temu title from a unified cache record. */
function getUnifiedBindingTitle(record) {
  var source = record && record.source_data ? record.source_data : {};
  var goods = source.goods || {};
  return String(record && record.product_name || goods.goodsName || "未命名 Temu 商品");
}

/** Read one Temu main image from a unified cache record. */
function getUnifiedBindingImage(record) {
  var source = record && record.source_data ? record.source_data : {};
  var goods = source.goods || {};
  var gallery = Array.isArray(goods.gallery) ? goods.gallery : [];
  if (record && record.main_image_url) {
    return String(record.main_image_url);
  }
  if (source.mainImageUrl) {
    return String(source.mainImageUrl);
  }
  if (gallery.length) {
    return String(typeof gallery[0] === "string" ? gallery[0] : gallery[0].url || gallery[0].imageUrl || "");
  }
  return "";
}

/** Read the compact Listing title displayed in the 1688 binding modal. */
function getUnifiedBindingListingTitle(record) {
  var source = record && record.source_data ? record.source_data : {};
  var listing = record && record.listing_json && typeof record.listing_json === "object"
    ? record.listing_json
    : source.listing && typeof source.listing === "object" ? source.listing : {};
  return String(listing.title || getUnifiedBindingTitle(record));
}

/** Read Temu SKU rows from one unified cache record. */
function getUnifiedBindingSkus(record) {
  var source = record && record.source_data ? record.source_data : {};
  if (Array.isArray(record && record.sku)) {
    return record.sku;
  }
  return Array.isArray(source.sku) ? source.sku : [];
}

/** Return one concise specification label for a Temu SKU row. */
function getUnifiedBindingSkuText(sku) {
  var item = sku || {};
  var parts = [];
  if (item.SubSku1 || item.subSku1) {
    parts.push(String(item.SubSku1 || item.subSku1));
  }
  if (item.SubSku2 || item.subSku2) {
    parts.push(String(item.SubSku2 || item.subSku2));
  }
  var specs = Array.isArray(item.specs) ? item.specs : [];
  for (var index = 0; index < specs.length && parts.length < 2; index += 1) {
    var spec = specs[index] || {};
    var value = spec.specValue || spec.value || spec.name || "";
    if (value) {
      parts.push(String(value));
    }
  }
  return parts.length ? parts.join(" / ") : "默认规格";
}

/** Close the Temu binding detail modal on a 1688 page. */
function closeUnifiedBindingModal() {
  var modal = document.getElementById(unifiedBindingModalId);
  if (modal) {
    modal.remove();
  }
}

/** Collect the current 1688 detail page and bind it to one selected Temu record. */
function confirmUnifiedTemuBinding(record, button) {
  var temuMainId = String(record && (record.main_id || record.mainid) || "");
  if (!temuMainId || !button) {
    return;
  }
  button.disabled = true;
  button.textContent = "正在采集并绑定…";
  chrome.runtime.sendMessage({
    type: "collectUnifiedProduct",
    platform: "1688",
    targetTemuMainId: temuMainId,
    targetTemuPlatformId: String(record && record.platform_id || "")
  }, function handleBindingCollectionResponse(response) {
    var lastError = chrome.runtime.lastError;
    if (lastError || !response || !response.ok) {
      button.disabled = false;
      button.textContent = lastError ? lastError.message : response && response.error ? response.error : "绑定失败，请重试";
      return;
    }
    button.textContent = "绑定成功，正在返回工作台";
    window.setTimeout(closeUnifiedBindingModal, 900);
  });
}

/** Open a compact Temu main-image, Listing and SKU preview modal. */
function openUnifiedBindingModal(record) {
  closeUnifiedBindingModal();
  var modal = document.createElement("div");
  modal.id = unifiedBindingModalId;
  var dialog = document.createElement("section");
  dialog.className = "unified-binding-dialog";
  var closeButton = document.createElement("button");
  closeButton.className = "unified-binding-close";
  closeButton.type = "button";
  closeButton.textContent = "×";
  closeButton.addEventListener("click", closeUnifiedBindingModal);
  var image = document.createElement("img");
  image.className = "unified-binding-main-image";
  image.src = getUnifiedBindingImage(record);
  image.alt = "Temu 主图";
  var copy = document.createElement("div");
  copy.className = "unified-binding-copy";
  var eyebrow = document.createElement("span");
  eyebrow.textContent = "TEMU LISTING";
  var title = document.createElement("h3");
  title.textContent = getUnifiedBindingListingTitle(record);
  var meta = document.createElement("p");
  meta.textContent = "main_id " + String(record && (record.main_id || record.mainid) || "");
  copy.appendChild(eyebrow);
  copy.appendChild(title);
  copy.appendChild(meta);
  var skuTitle = document.createElement("strong");
  var skus = getUnifiedBindingSkus(record);
  skuTitle.className = "unified-binding-sku-title";
  skuTitle.textContent = "SKU（" + skus.length + "）";
  var skuList = document.createElement("div");
  skuList.className = "unified-binding-skus";
  for (var index = 0; index < skus.length && index < 8; index += 1) {
    var skuRow = document.createElement("div");
    var skuName = document.createElement("span");
    var skuPrice = document.createElement("small");
    skuName.textContent = getUnifiedBindingSkuText(skus[index]);
    skuPrice.textContent = String(skus[index].sku_price || skus[index].price || "—");
    skuRow.appendChild(skuName);
    skuRow.appendChild(skuPrice);
    skuList.appendChild(skuRow);
  }
  if (skus.length > 8) {
    var more = document.createElement("div");
    more.textContent = "还有 " + (skus.length - 8) + " 个 SKU";
    skuList.appendChild(more);
  }
  var confirmButton = document.createElement("button");
  confirmButton.className = "unified-binding-confirm";
  confirmButton.type = "button";
  confirmButton.textContent = "确认并绑定";
  confirmButton.addEventListener("click", function handleBindingConfirmClick() {
    confirmUnifiedTemuBinding(record, confirmButton);
  });
  dialog.appendChild(closeButton);
  dialog.appendChild(image);
  dialog.appendChild(copy);
  dialog.appendChild(skuTitle);
  dialog.appendChild(skuList);
  dialog.appendChild(confirmButton);
  modal.appendChild(dialog);
  modal.addEventListener("click", function handleBindingModalBackdrop(event) {
    if (event.target === modal) {
      closeUnifiedBindingModal();
    }
  });
  document.documentElement.appendChild(modal);
}

/** Select the Temu record stored on one clicked 1688 binding card. */
function handleUnifiedBindingCardClick(event) {
  var card = event.currentTarget;
  if (!card || !card.unifiedBindingRecord) {
    return;
  }
  unifiedSelectedTemuRecord = card.unifiedBindingRecord;
  var panel = document.getElementById(unifiedBindingPanelId);
  var cards = panel ? panel.querySelectorAll(".unified-binding-card") : [];
  for (var index = 0; index < cards.length; index += 1) {
    var currentCard = cards[index];
    var currentRecord = currentCard.unifiedBindingRecord || {};
    var currentMainId = String(currentRecord.main_id || currentRecord.mainid || "");
    var selectedMainId = String(unifiedSelectedTemuRecord.main_id || unifiedSelectedTemuRecord.mainid || "");
    var selected = currentMainId === selectedMainId;
    currentCard.classList.toggle("is-active", selected);
    if (currentCard.unifiedBindingMeta) {
      currentCard.unifiedBindingMeta.textContent = selected ? "当前已选择" : "main_id " + currentMainId;
    }
  }
}

/** Open the selected Temu Listing and SKU preview on a card double-click. */
function handleUnifiedBindingCardDoubleClick(event) {
  var card = event.currentTarget;
  if (card && card.unifiedBindingRecord) {
    openUnifiedBindingModal(card.unifiedBindingRecord);
  }
}

/** Render the Temu task list on one 1688 product detail page. */
function renderUnifiedBindingPanel(payload) {
  var oldPanel = document.getElementById(unifiedBindingPanelId);
  if (oldPanel) {
    oldPanel.remove();
  }
  var records = payload && Array.isArray(payload.records) ? payload.records : [];
  var activeTemuMainId = String(payload && payload.active_temu_main_id || "");
  var selectedTemuMainId = unifiedSelectedTemuRecord
    ? String(unifiedSelectedTemuRecord.main_id || unifiedSelectedTemuRecord.mainid || "")
    : activeTemuMainId;
  if (!selectedTemuMainId && records.length) {
    selectedTemuMainId = String(records[0].main_id || records[0].mainid || "");
  }
  unifiedSelectedTemuRecord = null;
  var panel = document.createElement("aside");
  panel.id = unifiedBindingPanelId;
  var heading = document.createElement("div");
  heading.className = "unified-binding-panel-heading";
  var title = document.createElement("strong");
  var count = document.createElement("span");
  title.textContent = "Temu 待组货";
  count.textContent = String(records.length);
  heading.appendChild(title);
  heading.appendChild(count);
  panel.appendChild(heading);
  for (var index = 0; index < records.length; index += 1) {
    var record = records[index];
    var mainId = String(record.main_id || record.mainid || "");
    var card = document.createElement("button");
    card.type = "button";
    card.title = "单击切换绑定对象，双击查看 Listing 和 SKU";
    var selected = mainId === selectedTemuMainId;
    card.className = "unified-binding-card" + (selected ? " is-active" : "");
    var image = document.createElement("img");
    image.src = getUnifiedBindingImage(record);
    image.alt = "Temu";
    var copy = document.createElement("span");
    var cardTitle = document.createElement("strong");
    var cardMeta = document.createElement("small");
    cardTitle.textContent = getUnifiedBindingTitle(record);
    cardMeta.textContent = selected ? "当前已选择" : "main_id " + mainId;
    copy.appendChild(cardTitle);
    copy.appendChild(cardMeta);
    card.appendChild(image);
    card.appendChild(copy);
    card.unifiedBindingRecord = record;
    card.unifiedBindingMeta = cardMeta;
    if (selected) {
      unifiedSelectedTemuRecord = record;
    }
    card.addEventListener("click", handleUnifiedBindingCardClick);
    card.addEventListener("dblclick", handleUnifiedBindingCardDoubleClick);
    panel.appendChild(card);
  }
  if (!records.length) {
    var empty = document.createElement("p");
    empty.textContent = "暂无 Temu 商品";
    panel.appendChild(empty);
  }
  document.documentElement.appendChild(panel);
}

/** Load and display the Temu binding list only on 1688 detail pages. */
function initializeUnifiedBindingPanel() {
  var platform = getCurrentUnifiedPlatform();
  if (platform !== "1688") {
    var panel = document.getElementById(unifiedBindingPanelId);
    if (panel) {
      panel.remove();
    }
    closeUnifiedBindingModal();
    return;
  }
  chrome.runtime.sendMessage({ type: "getUnifiedBindingPanelData" }, function handleBindingPanelResponse(response) {
    if (chrome.runtime.lastError || !response || !response.ok) {
      return;
    }
    renderUnifiedBindingPanel(response.payload);
  });
}

/** Keep the unified button correct when either platform navigates through an SPA. */
function observeUnifiedProductNavigation() {
  var lastUrl = location.href;
  window.setInterval(function observeUnifiedLocation() {
    if (lastUrl === location.href) {
      return;
    }
    lastUrl = location.href;
    initializeUnifiedCollectorButton();
    initializeUnifiedBindingPanel();
  }, 1000);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initializeUnifiedCollectorButton);
} else {
  initializeUnifiedCollectorButton();
}
initializeUnifiedBindingPanel();
observeUnifiedProductNavigation();
