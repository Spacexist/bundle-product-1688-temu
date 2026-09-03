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
function frontendFixture() {
  let options;
  const requests = [];
  const context = {
    window: {},
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
      return { ok: true,
        /** Supply only the fields needed by the confirmation handler. */
        async json() { return { ok: true, data: { product: { platform_id: "product-1" }, undo_token: "undo-1" } }; }
      };
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../../web/app.js"), "utf8"), context);
  const { task } = productFixture();
  const view = {
    imageCarouselTask: task, imageCarouselGenerationBusy: false, carouselUndoTokens: {},
    imageCarouselTasksByMainId: { "main-1": task },
    /** Use a completed task without starting generation. */
    isCarouselTaskGenerating() { return false; },
    /** Return a deterministic product cache key. */
    productCacheEventKey() { return "product-1"; },
    /** Avoid touching real browser storage. */
    persistCarouselUndoTokens() {},
    /** Avoid reading or changing real workbench products. */
    async reloadWorkbenchAfterCarousel() {},
    /** Capture the user-visible completion message. */
    setStatus(message) { this.status = message; },
    /** Track successful modal closure. */
    closeGalleryImageEditor() { this.closed = true; }
  };
  view.confirmCarouselReplacement = options.methods.confirmCarouselReplacement.bind(view);
  return { options, view, requests };
}

test("carousel button says confirm while direct edit and replace-all labels stay unchanged", /** Compile the real template offline and assert the scoped label. */ function () {
  const { options } = frontendFixture();
  assert.doesNotThrow(/** Check Vue template expressions without mounting UI. */ function compileTemplate() { compile(options.template); });
  assert.match(options.template, /@click="confirmGalleryImageEdit">\{\{ imageCarouselTask \? '确认' : '确认替换' \}\}/);
  assert.match(options.template, /@click="confirmCarouselReplacement\(true\)">替换所有主图/);
});

test("normal frontend confirmation submits only selected successes with replace_all false", /** Execute the actual button handler without modifying live products. */ async function () {
  const { options, view, requests } = frontendFixture();
  await options.methods.confirmGalleryImageEdit.call(view);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].body, { selected_indices: [0, 3], replace_all: false });
  assert.match(view.status, /追加到末尾，原图保持不变/);
  assert.equal(view.closed, true);
  assert.equal(view.imageCarouselGenerationBusy, false);
});

test("replace-all frontend action still submits every successful output", /** Retain the adjacent button's existing selection behavior. */ async function () {
  const { view, requests } = frontendFixture();
  await view.confirmCarouselReplacement(true);
  assert.deepEqual(requests[0].body, { selected_indices: [0, 2, 3], replace_all: true });
  assert.equal(view.status, "全部主图已替换为本次轮播生成图。");
});
