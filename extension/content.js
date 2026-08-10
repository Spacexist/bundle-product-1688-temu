var unifiedCollectorButtonId = "unified-platform-collector-button";
var unifiedTemuProductPattern = /(?:^|-)g-\d+\.html(?:$|[?#])/i;
var unified1688ProductPattern = /\/offer\/\d+\.html/i;

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
  return platform === "1688" ? "采集1688" : "采集Temu";
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
  button.disabled = true;
  button.classList.remove("is-success", "is-error");
  button.classList.add("is-loading");
  button.textContent = "采集中";
  chrome.runtime.sendMessage({ type: "collectUnifiedProduct", platform: platform }, function handleUnifiedResponse(response) {
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
    button.textContent = response.replaced ? "已更新" : "已加入";
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

/** Keep the unified button correct when either platform navigates through an SPA. */
function observeUnifiedProductNavigation() {
  var lastUrl = location.href;
  window.setInterval(function observeUnifiedLocation() {
    if (lastUrl === location.href) {
      return;
    }
    lastUrl = location.href;
    initializeUnifiedCollectorButton();
  }, 1000);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initializeUnifiedCollectorButton);
} else {
  initializeUnifiedCollectorButton();
}
observeUnifiedProductNavigation();
