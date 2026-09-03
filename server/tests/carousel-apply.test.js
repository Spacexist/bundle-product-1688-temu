const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { compile } = require("@vue/compiler-dom");
const { ProductService } = require("../services/product.service");

/** Exercise real product mutations with in-memory storage and no image downloads. */
function productFixture(gallery = ["original-a", "original-b"]) {
  const record = { platform: "temu", platform_id: "product-1", main_id: "main-1", version: 3,
    gallery_image_urls: gallery.slice(), main_image_url: gallery[0] || "" };
  const snapshots = [];
  const events = [];
  const service = new ProductService({
    repository: {
      cacheDirectory: os.tmpdir(),
      /** Run the transaction in memory without touching the user's products. */
      async mutate(callback) { return { result: await callback({ records: [record] }) }; },
      /** Retain the exact pre-apply record for undo assertions. */
      createHistorySnapshot(value, action) { snapshots.push({ record: structuredClone(value), action }); return "undo-1"; }
    },
    viewModels: {
      /** Return a detached product to mirror the production response boundary. */
      normalizeRecord(value) { return structuredClone(value); }
    },
    images: {
      /** Keep fixture URLs unchanged and never call external services. */
      async cacheEditableRecordImages() {}
    },
    events: {
      /** Collect product events without opening a network connection. */
      publish(event, requestId) { events.push({ event, requestId }); }
    }
  });
  const task = { id: "task-1", temu_platform_id: "product-1", temu_main_id: "main-1", source_indices: [0, 1],
    pages: [
      { status: "succeeded", image_url: "generated-a", selected: true },
      { status: "failed", image_url: "failed-output" },
      { status: "succeeded", image_url: "generated-b", selected: false },
      { status: "succeeded", image_url: "generated-c", selected: true }
    ] };
  return { service, record, task, snapshots, events };
}

test("normal confirmation retains both source images and appends selected outputs", /** Cover omitted and explicit false replace flags. */ async function () {
  for (const replaceAll of [undefined, false]) {
    const { service, record, task, snapshots, events } = productFixture();
    const result = await service.applyCarouselTask(task, [0, 3], "request-1", replaceAll);
    assert.deepEqual(record.gallery_image_urls, ["original-a", "original-b", "generated-a", "generated-c"]);
    assert.equal(record.main_image_url, "original-a");
    assert.equal(record.version, 4);
    assert.equal(result.undo_token, "undo-1");
    assert.deepEqual(snapshots[0].record.gallery_image_urls, ["original-a", "original-b"]);
    assert.equal(snapshots[0].record.version, 3);
    assert.equal(events[0].event.action, "carousel_applied");
    assert.equal(events[0].requestId, "request-1");
  }
});

test("confirmation preserves the live gallery even when saved source slots are stale", /** Prevent deleting unrelated images after reorder or insertion. */ async function () {
  const { service, record, task } = productFixture(["new-main", "original-b", "extra", "original-a"]);
  task.source_indices = [50, 99];
  delete task.temu_platform_id;
  await service.applyCarouselTask(task, [0], "request-1", false);
  assert.deepEqual(record.gallery_image_urls, ["new-main", "original-b", "extra", "original-a", "generated-a"]);
  assert.equal(record.main_image_url, "new-main");
});

test("explicit replace-all still replaces the entire gallery", /** Preserve the separate destructive button's existing semantics. */ async function () {
  const { service, record, task } = productFixture();
  await service.applyCarouselTask(task, [0, 2, 3], "request-1", true);
  assert.deepEqual(record.gallery_image_urls, ["generated-a", "generated-b", "generated-c"]);
  assert.equal(record.main_image_url, "generated-a");
});

test("confirmation skips duplicate selections, failed pages and missing outputs", /** Keep existing successful-output validation in append mode. */ async function () {
  const { service, record, task } = productFixture();
  await service.applyCarouselTask(task, [0, 0, 1, 9, 3], "request-1", false);
  assert.deepEqual(record.gallery_image_urls, ["original-a", "original-b", "generated-a", "generated-c"]);
});

test("no usable output leaves originals and undo history untouched", /** Reject empty output without any product mutation. */ async function () {
  const { service, record, task, snapshots, events } = productFixture();
  await assert.rejects(service.applyCarouselTask(task, [1, 9], "request-1", false), { code: "CAROUSEL_OUTPUT_EMPTY" });
  assert.deepEqual(record.gallery_image_urls, ["original-a", "original-b"]);
  assert.equal(record.version, 3);
  assert.equal(snapshots.length, 0);
  assert.equal(events.length, 0);
});

/** Load the actual UI options without a browser, DOM, lifecycle hooks or real requests. */
function frontendFixture(settings = {}) {
  let options;
  const requests = [];
  const savedProducts = [];
  const revealedIndices = [];
  const timers = new Map();
  let timerSequence = 0;
  const context = {
    window: {
      /** Capture auto-dismiss timers without waiting in tests. */ setTimeout(callback, delay) { timers.set(++timerSequence, { callback: callback, delay: delay }); return timerSequence; },
      /** Remove the previous notice timer when a new confirmation completes. */ clearTimeout(id) { timers.delete(id); }
    },
    document: {
      /** Return test thumbnails only; do not inspect a real browser. */
      querySelectorAll(selector) {
        assert.equal(selector, ".temu-render .gallery-thumbs .thumb-item");
        return Array.from({ length: 20 }, /** Record which saved gallery slot was revealed. */ function createThumbnail(value, index) {
          return { /** Capture scroll intent without touching the workbench. */ scrollIntoView() { revealedIndices.push(index); } };
        });
      }
    },
    Vue: {
      /** Capture the component definition without rendering the workbench. */
      createApp(value) {
        options = value;
        return {
          /** Suppress component registration because no DOM is mounted. */
          component() {},
          /** Suppress mounted hooks and all background polling. */
          mount() {}
        };
      }
    },
    /** Return a fixture apply response, never dispatching to the live backend. */
    async fetch(url, settings) {
      requests.push({ url, body: JSON.parse(settings.body) });
      return { ok: !fixtureSettings.failApply,
        /** Supply only the fields needed by the confirmation handler. */
        async json() {
          if (fixtureSettings.failApply) {
            return { ok: false, error: { message: "保存失败" } };
          }
          const body = JSON.parse(settings.body);
          const outputs = body.selected_indices.filter(/** Ignore unusable pages just like the backend. */ function validOutput(index) {
            return task.pages[index].status === "succeeded" && task.pages[index].image_url;
          }).map(/** Use persisted URLs to test post-cache position lookup. */ function savedUrl(index) { return "cached-" + task.pages[index].image_url; });
          const product = { platform: "temu", platform_id: "product-1", main_id: "main-1", product_name: "测试商品",
            gallery_image_urls: fixtureSettings.gallery || (body.replace_all ? outputs : ["original-a", "original-b"].concat(outputs)) };
          savedProducts.push(product);
          return { ok: true, data: { product: product, undo_token: "undo-1" } };
        }
      };
    }
  };
  const fixtureSettings = settings;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../../web/app.js"), "utf8"), context);
  const { task } = productFixture();
  const view = {
    imagePlacementNotice: null, records: [],
    imageCarouselTask: task, imageCarouselGenerationBusy: false, carouselUndoTokens: {},
    imageCarouselTasksByMainId: { "main-1": task },
    /** Use a completed task without starting generation. */
    isCarouselTaskGenerating() { return false; },
    /** Return a deterministic product cache key. */
    productCacheEventKey() { return "product-1"; },
    /** Avoid touching real browser storage. */
    persistCarouselUndoTokens() {},
    /** Avoid reading or changing real workbench products. */
    async reloadWorkbenchAfterCarousel() {
      if (fixtureSettings.failRefresh) { throw new Error("刷新失败"); }
      this.records = savedProducts.slice();
    },
    /** Capture the user-visible completion message. */
    setStatus(message) { this.status = message; },
    /** Track successful modal closure. */
    closeGalleryImageEditor() { this.closed = true; },
    /** Select only the fixture product without changing saved images. */
    selectTemuRecord(record) { this.selectedTemuMainId = record.main_id; },
    /** Run post-render assertions synchronously in the isolated fixture. */
    $nextTick(callback) { callback(); }
  };
  view.confirmCarouselReplacement = options.methods.confirmCarouselReplacement.bind(view);
  view.galleryImages = options.methods.galleryImages.bind(view);
  view.showCarouselPlacementNotice = options.methods.showCarouselPlacementNotice.bind(view);
  view.revealConfirmedCarouselImage = options.methods.revealConfirmedCarouselImage.bind(view);
  return { options, view, requests, revealedIndices, timers };
}

test("carousel button says confirm while direct edit and replace-all labels stay unchanged", /** Compile the real template offline and assert the scoped label. */ function () {
  const { options } = frontendFixture();
  assert.doesNotThrow(/** Check Vue template expressions without mounting UI. */ function compileTemplate() { compile(options.template); });
  assert.match(options.template, /@click="confirmGalleryImageEdit">\{\{ imageCarouselTask \? '确认' : '确认替换' \}\}/);
  assert.match(options.template, /@click="confirmCarouselReplacement\(true\)">替换所有主图/);
  assert.match(options.template, /class="image-placement-notice" role="status" aria-live="polite"/);
  assert.match(options.template, /@click="revealConfirmedCarouselImage">查看图片/);
  assert.doesNotMatch(options.template, />知道了<\/button>/);
  assert.match(options.template, /<Transition name="image-placement">/);
});

test("normal frontend confirmation submits only selected successes with replace_all false", /** Execute the actual button handler without modifying live products. */ async function () {
  const { options, view, requests } = frontendFixture();
  await options.methods.confirmGalleryImageEdit.call(view);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].body, { selected_indices: [0, 3], replace_all: false });
  assert.match(view.status, /追加到末尾，原图保持不变/);
  assert.equal(view.closed, true);
  assert.equal(view.imageCarouselGenerationBusy, false);
  assert.equal(view.imagePlacementNotice.message, "已追加到主图列表第 3–4 张（共 2 张），原图保持不变。");
  assert.equal(view.imagePlacementNotice.product_label, "测试商品 · product-1");
  assert.equal(view.imagePlacementNotice.image_url, "cached-generated-a");
});

test("replace-all frontend action still submits every successful output", /** Retain the adjacent button's existing selection behavior. */ async function () {
  const { view, requests } = frontendFixture();
  await view.confirmCarouselReplacement(true);
  assert.deepEqual(requests[0].body, { selected_indices: [0, 2, 3], replace_all: true });
  assert.equal(view.status, "全部主图已替换为本次轮播生成图。");
  assert.equal(view.imagePlacementNotice.message, "全部主图已替换，新图位于主图列表第 1–3 张（共 3 张）。");
});

test("placement message uses the returned gallery length, not the stale source slots", /** Describe concurrent gallery edits and single-output confirmation accurately. */ async function () {
  const { view } = frontendFixture({ gallery: ["a", "b", "c", "d", "e", "cached-generated-a"] });
  view.imageCarouselTask.source_indices = [50, 99];
  view.imageCarouselTask.pages[3].selected = false;
  await view.confirmCarouselReplacement(false);
  assert.equal(view.imagePlacementNotice.message, "已追加到主图列表第 6 张（共 1 张），原图保持不变。");
  assert.equal(view.imagePlacementNotice.gallery_index, 5);
});

test("view-image selects the saved product and follows its image after reordering", /** Never locate against the currently selected unrelated product or mutate the gallery. */ async function () {
  const { view, requests, revealedIndices } = frontendFixture();
  await view.confirmCarouselReplacement(false);
  view.selectedTemuMainId = "other-product";
  view.records[0].gallery_image_urls = ["cached-generated-c", "cached-generated-a", "original-a", "original-b"];
  const before = view.records[0].gallery_image_urls.slice();
  view.revealConfirmedCarouselImage();
  assert.equal(view.selectedTemuMainId, "main-1");
  assert.equal(view.selectedTemuGalleryIndex, 1);
  assert.equal(view.selectedGalleryIndex, 1);
  assert.deepEqual(revealedIndices, [1]);
  assert.deepEqual(view.records[0].gallery_image_urls, before);
  assert.equal(requests.length, 1);
});

test("removed output or deleted product cannot navigate to an unrelated image", /** Keep a stale notice honest after user edits or undo. */ async function () {
  for (const deleteProduct of [true, false]) {
    const { view, revealedIndices } = frontendFixture();
    await view.confirmCarouselReplacement(false);
    if (deleteProduct) { view.records = []; } else { view.records[0].gallery_image_urls = ["original-a"]; }
    view.revealConfirmedCarouselImage();
    assert.equal(view.imagePlacementNotice.unavailable, true);
    assert.match(view.imagePlacementNotice.message, /无法定位/);
    assert.equal(revealedIndices.length, 0);
  }
});

test("failed apply does not show success or close the editing dialog", /** Only a confirmed backend mutation may publish a placement notice. */ async function () {
  const { view } = frontendFixture({ failApply: true });
  await view.confirmCarouselReplacement(false);
  assert.equal(view.imagePlacementNotice, null);
  assert.equal(view.closed, undefined);
  assert.equal(view.imageEditorError, "保存失败");
  assert.ok(view.imageCarouselTasksByMainId["main-1"]);
});

test("successful save with failed refresh still reports saved location without inviting reapply", /** Separate persistence success from local view refresh failure. */ async function () {
  const { view, requests } = frontendFixture({ failRefresh: true });
  await view.confirmCarouselReplacement(false);
  assert.equal(view.closed, true);
  assert.equal(view.imagePlacementNotice.unavailable, true);
  assert.match(view.imagePlacementNotice.message, /第 3–4 张/);
  assert.match(view.imagePlacementNotice.message, /工作台刷新失败.*无需再次确认/);
  assert.equal(view.imageCarouselTasksByMainId["main-1"], undefined);
  assert.equal(requests.length, 1);
});

test("placement notice starts fading at 1.7 seconds and replaces earlier dismissal timers", /** Allow two seconds total including the CSS fade without leaking timers. */ async function () {
  const { view, timers } = frontendFixture();
  await view.confirmCarouselReplacement(false);
  const firstId = view.imagePlacementNoticeTimer;
  assert.equal(timers.get(firstId).delay, 1700);
  await view.confirmCarouselReplacement(false);
  assert.equal(timers.has(firstId), false);
  assert.equal(timers.size, 1);
  timers.get(view.imagePlacementNoticeTimer).callback();
  assert.equal(view.imagePlacementNotice, null);
  assert.equal(view.imagePlacementNoticeTimer, null);
  const css = fs.readFileSync(path.join(__dirname, "../../web/styles.css"), "utf8");
  assert.match(css, /\.image-placement-leave-active\s*\{[^}]*transition: opacity \.3s ease/);
  assert.match(css, /\.image-placement-leave-to\s*\{\s*opacity: 0;/);
});
