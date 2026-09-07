const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { setImmediate: nextTurn } = require("node:timers/promises");
const { ImageTaskHistoryService, RETENTION_MS } = require("../services/image-task-history.service");
const { ImageTaskQueue } = require("../services/image-task-queue");
const { ProviderService } = require("../services/provider.service");
const { ImageCacheService } = require("../services/image-cache.service");
const { DirectImageRuntimeService } = require("../services/direct-image-runtime.service");
const { CarouselRuntimeService } = require("../services/carousel-runtime.service");
const { createWorkflowService } = require("../workflow-service");
const { DiagnosticsController } = require("../controllers/diagnostics.controller");
const { attachRequestContext } = require("../middleware/request-context");

/** Isolate all fixtures from the user's real cache and validate cleanup boundaries. */
function tempDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "image-history-test-"));
  t.after(/** Remove only this test-created temporary directory. */ function cleanup() {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("image-history-test-"));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

/** Create a deterministic gate for observing in-flight work. */
function deferred() {
  let resolve;
  const promise = new Promise(/** Retain the resolver for the test. */ function executor(done) { resolve = done; });
  return { promise, resolve };
}

/** Assemble a real ledger and shared queue with no HTTP server. */
function fixture(t) {
  const directory = tempDirectory(t);
  const history = new ImageTaskHistoryService({ cacheDirectory: directory });
  const queue = new ImageTaskQueue({ history, /** Serialize fixture image executions. */ getConcurrency: function one() { return 1; } });
  return { directory, history, queue };
}

/** Supply non-secret configuration for a transport that cannot access the internet. */
function config() {
  return { baseurl: "https://tuba.invalid", endpoint: "/v1/images/edits", generation_endpoint: "/v1/images/generations", apikey: "fixture-key", mask_prompt: "只改遮罩透明区域" };
}

/** Stub only upstream transport while exercising real provider/queue observers. */
function protocol() {
  return {
    calls: 0,
    /** Emit the actual async-client state contract without performing POST or GET. */
    generate: async function generate(settings) {
      this.calls += 1;
      const taskId = "provider-" + this.calls;
      for (const status of ["submitting", "queued", "running", "completed"]) {
        await settings.onState({ provider_task_id: status === "submitting" ? "" : taskId, provider_status: status, provider_submitted_at: new Date().toISOString(), provider_image_url: "https://private.invalid/image?secret=1" });
      }
      return "https://private.invalid/result.png";
    }
  };
}

test("metadata excludes image/prompt/credential content and keeps one immutable task ID", /** Verify the persistence allowlist and terminal immutability. */ function (t) {
  const { history } = fixture(t);
  history.begin({ execution_id: "local-a", source: "single-edit", prompt: "PRIVATE PROMPT", apikey: "SECRET", sku_index: -1 });
  history.update("local-a", { provider_task_id: "remote-a", phase: "upstream_running", provider_image_url: "PRIVATE URL", error: "PRIVATE BODY" });
  history.update("local-a", { provider_task_id: "remote-b" });
  history.update("local-a", { phase: "succeeded" });
  history.update("local-a", { phase: "failed" });
  history.begin({ execution_id: "local-a", source: "carousel" });
  const task = history.getSnapshot().tasks[0];
  assert.equal(task.provider_task_id, "remote-a");
  assert.equal(task.phase, "succeeded");
  assert.equal(task.sku_index, undefined);
  assert.equal(history.getSnapshot().tasks.length, 1);
  assert.doesNotMatch(fs.readFileSync(history.file, "utf8"), /PRIVATE|SECRET|apikey|prompt|image_url/);
  task.phase = "failed";
  assert.equal(history.getSnapshot().tasks[0].phase, "succeeded");
});

test("restart interrupts unfinished local tracking and retains finished history without recovery", /** Load a ledger only, never instantiate network work. */ function (t) {
  const { history, directory } = fixture(t);
  history.begin({ execution_id: "active" });
  history.update("active", { provider_task_id: "upstream-active", phase: "upstream_running" });
  history.begin({ execution_id: "finished" });
  history.update("finished", { phase: "succeeded" });
  const restarted = new ImageTaskHistoryService({ cacheDirectory: directory });
  const [active, finished] = restarted.getSnapshot().tasks;
  assert.equal(active.phase, "interrupted");
  assert.equal(active.error_code, "SERVER_RESTARTED");
  assert.equal(active.provider_task_id, "upstream-active");
  assert.equal(finished.phase, "succeeded");
  const again = new ImageTaskHistoryService({ cacheDirectory: directory });
  assert.deepEqual(again.getSnapshot().tasks, restarted.getSnapshot().tasks);
});

test("retention keeps three days and at most 1000 finished executions, never pruning active ones", /** Advance a virtual clock without waiting or touching business files. */ function (t) {
  let now = Date.now();
  const directory = tempDirectory(t);
  const history = new ImageTaskHistoryService({ cacheDirectory: directory, /** Return the deterministic retention clock. */ now: function clock() { return now; } });
  history.begin({ execution_id: "old-active" });
  history.begin({ execution_id: "old-finished" });
  history.update("old-finished", { phase: "failed" });
  now += RETENTION_MS + 1;
  assert.deepEqual(history.getSnapshot().tasks.map(/** Compare only execution identities. */ function id(task) { return task.execution_id; }), ["old-active"]);
  for (let index = 0; index < 1005; index += 1) {
    history.records.set("finished-" + index, { execution_id: "finished-" + index, phase: "succeeded", created_at: new Date(now).toISOString(), updated_at: new Date(now + index).toISOString(), finished_at: new Date(now + index).toISOString() });
  }
  const snapshot = history.getSnapshot();
  assert.equal(snapshot.tasks.length, 1001);
  assert.ok(history.records.has("old-active"));
  assert.ok(history.records.has("finished-1004"));
  assert.ok(!history.records.has("finished-4"));
  assert.equal(JSON.parse(fs.readFileSync(history.file, "utf8")).tasks.length, 1001);
});

test("monitor storage failures never fail or repeat paid work and preserve corrupt history", /** Exercise disk write and read failures with ordinary fixture paths. */ async function (t) {
  const directory = tempDirectory(t);
  const blocked = path.join(directory, "not-a-directory");
  fs.writeFileSync(blocked, "keep");
  const history = new ImageTaskHistoryService({ cacheDirectory: blocked });
  const queue = new ImageTaskQueue({ history });
  let calls = 0;
  await queue.run(/** Count one paid execution despite monitoring persistence failure. */ async function paid() { calls += 1; return "ok"; }, { execution_id: "once" });
  assert.equal(calls, 1);
  assert.equal(history.getSnapshot().tasks[0].phase, "succeeded");
  assert.ok(history.getSnapshot().storage_warning);
  const file = path.join(directory, "runtime", "image-task-history.json");
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, "BROKEN HISTORY");
  const corrupt = new ImageTaskHistoryService({ cacheDirectory: directory });
  corrupt.begin({ execution_id: "new" });
  assert.equal(fs.readFileSync(file, "utf8"), "BROKEN HISTORY");
  assert.match(corrupt.getSnapshot().storage_warning, /读取失败/);
});

test("waiting cancellation stays unsubmitted and active work holds its slot through download", /** Observe both queue lanes with a download gate. */ async function (t) {
  const { history, queue } = fixture(t);
  const download = deferred();
  const active = queue.run(/** Simulate upstream completion before disk caching finishes. */ async function execute() {
    queue.observeProviderState("active", { provider_task_id: "remote", provider_status: "completed" });
    queue.updateTask("active", { download_attempt: 1 });
    return download.promise;
  }, { execution_id: "active" });
  const waiting = queue.run(/** This cancelled task must never reach the provider. */ function neverExecute() { assert.fail("submitted cancelled work"); }, { execution_id: "waiting" });
  const rejected = assert.rejects(waiting, { code: "QUEUE_TASK_CANCELLED" });
  await nextTurn();
  assert.equal(history.records.get("active").phase, "downloading");
  assert.equal(history.records.get("waiting").phase, "queued");
  assert.equal(queue.getSnapshot().active, 1);
  assert.equal(queue.getSnapshot().pending_tasks[0].execution_id, "waiting");
  queue.cancelWhere(/** Match exactly the queued execution. */ function waitingOnly(meta) { return meta.execution_id === "waiting"; });
  await rejected;
  assert.equal(history.records.get("waiting").phase, "cancelled");
  assert.equal(history.records.get("waiting").started_at, "");
  assert.equal(history.records.get("waiting").provider_task_id, "");
  download.resolve("local-image");
  await active;
  assert.equal(history.records.get("active").phase, "succeeded");
  assert.equal(queue.getSnapshot().active, 0);
});

test("timeout and unknown submission do not falsely report an upstream failure", /** Separate a stopped observer from a confirmed provider failure. */ async function (t) {
  const { history, queue } = fixture(t);
  for (const code of ["PROVIDER_TIMEOUT", "PROVIDER_SUBMISSION_UNKNOWN", "PROVIDER_FAILED", "IMAGE_TASK_CANCELLED"]) {
    await assert.rejects(queue.run(/** Emit the client error state and then fail once. */ async function fail() {
      queue.observeProviderState(code, { provider_task_id: "remote-" + code, provider_status: "failed", provider_error_code: code });
      throw Object.assign(new Error("private provider body"), { code });
    }, { execution_id: code }), { code });
  }
  assert.equal(history.records.get("PROVIDER_TIMEOUT").phase, "timeout");
  assert.equal(history.records.get("PROVIDER_TIMEOUT").provider_status, "tracking_stopped");
  assert.equal(history.records.get("PROVIDER_FAILED").provider_status, "failed");
  assert.equal(history.records.get("IMAGE_TASK_CANCELLED").phase, "cancelled");
  assert.doesNotMatch(fs.readFileSync(history.file, "utf8"), /private provider body/);
});

test("all edit entry points retain source associations and download progress", /** Use the real provider wrapper for direct, SKU, carousel and legacy fusion. */ async function (t) {
  const { history, queue } = fixture(t);
  const upstream = protocol();
  const images = {
    /** Read an in-memory source image. */ readDataUrl: function read() { return { buffer: Buffer.from("fixture"), mimeType: "image/png" }; },
    /** Complete the controlled local download after reporting two attempts. */ cacheGeneratedImage: async function cache(url, options) { options.onProgress({ attempt: 1 }); options.onProgress({ attempt: 2 }); return "/api/v1/cache/image/test.png"; }
  };
  const provider = new ProviderService({ readConfig: config, images, imageTaskQueue: queue, asyncImages: upstream });
  const inputs = [
    { direct_task_id: "single", mode: "edit", source: "single-edit" },
    { direct_task_id: "sku", task_scope: "sku", sku_id: "sku-a", sku_index: 0, mode: "fusion", source: "sku-fusion" },
    { carousel_task_id: "carousel-parent", carousel_page_index: 0, generation_id: "page-execution", mode: "fusion", source: "carousel" },
    { mode: "fusion", source: "fusion" }
  ];
  for (const input of inputs) {
    await provider.editImages({ ...input, temu_main_id: "product-a", prompt: "SECRET PROMPT", image_urls: Array(input.mode === "fusion" ? 2 : 1).fill("data:image/png;base64,YQ==") }, input.mode, "request-a");
  }
  assert.equal(upstream.calls, 4);
  const tasks = history.getSnapshot().tasks;
  assert.deepEqual(tasks.map(/** Extract the route classification. */ function source(task) { return task.source; }), inputs.map(/** Extract expected route classification. */ function source(input) { return input.source; }));
  for (const task of tasks) {
    assert.equal(task.phase, "succeeded");
    assert.equal(task.download_attempt, 2);
    assert.equal(task.temu_main_id, "product-a");
    assert.equal(task.request_id, "request-a");
    assert.ok(task.provider_task_id);
  }
  assert.equal(tasks[2].execution_id, "page-execution");
  assert.equal(tasks[2].carousel_page_index, 0);
  assert.doesNotMatch(fs.readFileSync(history.file, "utf8"), /SECRET|secret|private.invalid/);
});

test("provider mask prompt helper centralizes every masked edit prompt", /** Lock the mask prompt policy to one provider-layer function. */ function () {
  const provider = new ProviderService({ readConfig: config, images: {}, imageTaskQueue: {} });
  const imageConfig = { edit_prompt: "default edit", fusion_prompt: "default fusion", mask_prompt: "只改遮罩透明区域", mask_cutout_prompt: "第一张完整原图，第二张抠图区域" };
  assert.deepEqual(provider.buildImageEditPrompt(imageConfig, { prompt: "普通编辑" }, "edit", ""), { prompt: "普通编辑", mask_prompt: false, mask_cutout_prompt: false });
  assert.deepEqual(provider.buildImageEditPrompt(imageConfig, { prompt: "普通编辑" }, "edit", "data:image/png;base64,YQ=="), { prompt: "普通编辑\n\n只改遮罩透明区域", mask_prompt: true, mask_cutout_prompt: false });
  assert.deepEqual(provider.buildImageEditPrompt(imageConfig, { prompt: "普通编辑\n\n只改遮罩透明区域" }, "edit", "data:image/png;base64,YQ=="), { prompt: "普通编辑\n\n只改遮罩透明区域", mask_prompt: true, mask_cutout_prompt: false });
  assert.deepEqual(provider.buildImageEditPrompt(imageConfig, { prompt: "" }, "edit", "data:image/png;base64,YQ=="), { prompt: "default edit\n\n只改遮罩透明区域", mask_prompt: true, mask_cutout_prompt: false });
  assert.deepEqual(provider.buildImageEditPrompt({ mask_prompt: "只改遮罩透明区域" }, { prompt: "" }, "edit", "data:image/png;base64,YQ=="), { prompt: "只改遮罩透明区域", mask_prompt: true, mask_cutout_prompt: false });
  assert.deepEqual(provider.buildImageEditPrompt(imageConfig, { prompt: "普通编辑", mask_mode: "cutout" }, "edit", ""), { prompt: "普通编辑\n\n第一张完整原图，第二张抠图区域", mask_prompt: false, mask_cutout_prompt: true });
  assert.throws(function missingMaskPrompt() {
    provider.buildImageEditPrompt({ edit_prompt: "default edit" }, { prompt: "普通编辑" }, "edit", "data:image/png;base64,YQ==");
  }, { code: "IMAGE_MASK_PROMPT_MISSING" });
});

test("provider forwards an optional PNG mask on edit requests", /** Verify mask transport without performing provider or download network calls. */ async function (t) {
  const { queue } = fixture(t);
  let submittedBody = null;
  const upstream = {
    /** Capture the multipart body and finish like the async protocol. */
    generate: async function generate(settings) {
      submittedBody = settings.body;
      await settings.onState({ provider_task_id: "provider-mask", provider_status: "completed", provider_submitted_at: new Date().toISOString() });
      return "https://private.invalid/result.png";
    }
  };
  const images = {
    /** Decode source and mask fixtures as PNG files. */
    readDataUrl: function read() { return { buffer: Buffer.from("fixture"), mimeType: "image/png" }; },
    /** Finish the local cache write without network. */
    cacheGeneratedImage: async function cache() { return "/api/v1/cache/image/mask.png"; }
  };
  const provider = new ProviderService({ readConfig: config, images, imageTaskQueue: queue, asyncImages: upstream });
  await provider.editImages({ direct_task_id: "masked", temu_main_id: "product-a", prompt: "mask", image_urls: ["data:image/png;base64,YQ=="], mask_url: "data:image/png;base64,Yg==" }, "edit", "request-mask");
  assert.equal(submittedBody.getAll("image").length, 1);
  assert.equal(submittedBody.getAll("mask").length, 1);
  assert.equal(submittedBody.get("prompt"), "mask\n\n只改遮罩透明区域");
});


test("masked edit requires the server-configured mask prompt", /** Prevent any masked provider request from bypassing the guard prompt. */ async function (t) {
  const { queue } = fixture(t);
  const images = {
    /** Decode the source and mask without touching the network. */
    readDataUrl: function read() { return { buffer: Buffer.from("fixture"), mimeType: "image/png" }; }
  };
  const upstream = {
    /** Fail the test if a masked request without mask_prompt reaches transport. */
    generate: async function generate() { throw new Error("unexpected upstream submit"); }
  };
  const provider = new ProviderService({ readConfig: function readConfig() { return { baseurl: "https://tuba.invalid", endpoint: "/v1/images/edits", apikey: "fixture-key" }; }, images, imageTaskQueue: queue, asyncImages: upstream });
  await assert.rejects(provider.editImages({ direct_task_id: "missing-mask-prompt", temu_main_id: "product-a", prompt: "mask", image_urls: ["data:image/png;base64,YQ=="], mask_url: "data:image/png;base64,Yg==" }, "edit", "request-mask-missing"), { code: "IMAGE_MASK_PROMPT_MISSING" });
});

test("provider diagnostics include local image URLs without retaining base64", /** Verify image submit logs expose testable local URLs only. */ async function () {
  const events = [];
  const originalUrl = "/api/v1/cache/image/products/source.jpg";
  const cutoutUrl = "/api/v1/cache/image/transfer/masks/cutout.png";
  const maskUrl = "/api/v1/cache/image/transfer/masks/legacy-mask.png";
  const images = {
    publicPrefix: "/api/v1/cache/image",
    /** Decode data URLs in case a fixture accidentally submits browser bytes. */
    readDataUrl: function readDataUrl(source) { return /^data:image\/png;base64,/i.test(String(source || "")) ? { buffer: Buffer.from("data"), mimeType: "image/png" } : null; },
    /** Return deterministic bytes for any local cache image path. */
    readLocalImage: function readLocalImage(pathname) {
      return { buffer: Buffer.from("local-" + pathname), mimeType: pathname.indexOf(".jpg") >= 0 ? "image/jpeg" : "image/png" };
    },
    /** Finish generated image caching without touching disk. */
    cacheGeneratedImage: async function cacheGeneratedImage() { return "/api/v1/cache/image/generated/result.png"; }
  };
  const provider = new ProviderService({
    readConfig: function readConfig() { return Object.assign(config(), { mask_cutout_prompt: "第一张完整原图，第二张抠图区域" }); },
    images: images,
    asyncImages: { /** Capture provider submit metadata without performing HTTP. */ generate: async function generate() { return "https://provider.invalid/result.png"; } },
    diagnostics: { /** Retain sanitized provider events for assertions. */ write: function write(direction, label, payload) { events.push({ direction, label, payload }); } }
  });

  await provider.editImages({ prompt: "cutout", image_urls: [originalUrl, cutoutUrl], mask_mode: "cutout" }, "edit", "request-cutout-log");
  await provider.editImages({ prompt: "mask", image_urls: [originalUrl], mask_url: maskUrl }, "edit", "request-mask-log");
  await provider.editImages({ prompt: "data", image_urls: ["data:image/png;base64,YQ=="] }, "edit", "request-data-log");

  const outbound = events.filter(/** Keep only provider submit summaries. */ function isSubmitEvent(event) { return /Tuba async edit POST/.test(event.label); });
  assert.equal(outbound[0].payload.images[0].source_url, originalUrl);
  assert.equal(outbound[0].payload.images[1].source_url, cutoutUrl);
  assert.equal(outbound[1].payload.mask.source_url, maskUrl);
  assert.equal(outbound[2].payload.images[0].source_url, "data-url:image/png");
  assert.doesNotMatch(JSON.stringify(outbound), /YQ==/);
});

test("business deletion and manual carousel regeneration never erase or rebind old history", /** Exercise real runtime metadata wiring with a fake upstream. */ async function (t) {
  const { history, queue, directory } = fixture(t);
  const images = {
    /** Supply fixture source bytes. */ readDataUrl: function read() { return { buffer: Buffer.from("fixture"), mimeType: "image/png" }; },
    /** Complete fixture downloads while emitting the cache progress contract. */ cacheGeneratedImage: async function cache(url, options) { options.onProgress({ attempt: 1 }); return "/api/v1/cache/image/fixture.png"; },
    /** Avoid real filesystem cleanup for a synthetic image URL. */ deleteUnreferencedGeneratedImage: function removeFixture() {}
  };
  const provider = new ProviderService({ readConfig: config, images, imageTaskQueue: queue, asyncImages: protocol() });
  const sourceUrl = "data:image/png;base64,YQ==";
  const direct = new DirectImageRuntimeService({ cacheDirectory: directory, images, providers: provider, runtimeName: "sku-blend", taskScope: "sku" });
  direct.createTask({ client_task_id: "sku-runtime", temu_main_id: "main-sku", sku_id: "sku-0", sku_index: 0, mode: "fusion", image_urls: [sourceUrl, sourceUrl], prompt: "fixture" });
  await direct.startTask("sku-runtime", "request-sku");
  direct.deleteTask("sku-runtime");
  assert.equal(direct.readTask("sku-runtime"), null);
  assert.equal(history.records.get("sku-runtime").phase, "succeeded");
  assert.equal(history.records.get("sku-runtime").source, "sku-fusion");
  assert.equal(history.records.get("sku-runtime").sku_id, "sku-0");
  const carousel = new CarouselRuntimeService({ cacheDirectory: directory, images, providers: provider });
  const task = carousel.createManualTask({ temu_main_id: "main-carousel", source_indices: [0, 1], gallery_snapshot: [sourceUrl, sourceUrl], image_urls: [sourceUrl, sourceUrl], pages: [{ prompt: "fixture" }] });
  const first = await carousel.generatePage(task.id, 0, "request-page");
  const firstId = first.pages[0].generation_id;
  const firstProviderId = history.records.get(firstId).provider_task_id;
  const second = await carousel.generatePage(task.id, 0, "request-page-new");
  const secondId = second.pages[0].generation_id;
  assert.notEqual(firstId, secondId);
  assert.notEqual(history.records.get(secondId).provider_task_id, firstProviderId);
  assert.equal(history.records.get(firstId).provider_task_id, firstProviderId);
  assert.equal(history.records.get(secondId).temu_main_id, "main-carousel");
  carousel.deleteTask(task.id);
  assert.equal(history.getSnapshot().tasks.length, 3);
});

test("workflow generation uses candidate execution identity in the same ledger", /** Verify text-to-image wiring without starting model or CLIP jobs. */ async function (t) {
  const { history, queue, directory } = fixture(t);
  const workflow = createWorkflowService({ cacheDirectory: directory, imageTaskQueue: queue, asyncImages: protocol(),
    /** Observe a real candidate download callback. */ cacheGeneratedImage: async function cache(url, options) { options.onProgress({ attempt: 1 }); return "local"; },
    /** Silence fixture business logs. */ writeLog: function log() {},
    /** Format fixture business timestamps. */ formatTime: function format(date) { return date.toISOString(); }
  });
  await workflow.generateOneImage(config(), "PRIVATE PROMPT", "request-workflow", { generation_id: "candidate-a", temu_main_id: "main-a", candidate_index: 2 });
  const task = history.records.get("candidate-a");
  assert.equal(task.source, "text-to-image");
  assert.equal(task.temu_main_id, "main-a");
  assert.equal(task.candidate_index, 2);
  assert.equal(task.download_attempt, 1);
  assert.equal(task.phase, "succeeded");
});

test("real cache reports attempts 1, 2, 3 then releases the slot with DOWNLOAD_FAILED", /** Fail only fixture downloads; no internet or real cache is involved. */ async function (t) {
  const { history, queue, directory } = fixture(t);
  const images = new ImageCacheService({ cacheDirectory: directory });
  const attempts = [];
  images.cacheImage = /** Simulate a bounded download failure. */ async function failDownload() { throw new Error("fixture download failed"); };
  await assert.rejects(queue.run(/** Hold the queue for the whole download retry loop. */ async function download() {
    return images.cacheGeneratedImage("https://never-fetched.invalid/a.png", { /** Persist the current actual download attempt. */ onProgress: function progress(value) { attempts.push(value.attempt); queue.updateTask("download", { phase: "downloading", download_attempt: value.attempt }); } });
  }, { execution_id: "download" }), { code: "DOWNLOAD_FAILED" });
  assert.deepEqual(attempts, [1, 2, 3]);
  assert.equal(history.records.get("download").download_attempt, 3);
  assert.equal(history.records.get("download").phase, "failed");
  assert.equal(queue.getSnapshot().active, 0);
});

test("read-only endpoint is excluded from request logging and exposes detached local data", /** Exercise HTTP controller methods without listening on any port. */ function (t) {
  const { queue, history } = fixture(t);
  history.begin({ execution_id: "visible" });
  const controller = new DiagnosticsController({ diagnostics: { imageTaskQueue: queue } });
  let responsePayload;
  controller.getImageTasks({}, {
    /** Assert that browsers do not cache task snapshots. */ setHeader: function header(name, value) { assert.equal(name, "Cache-Control"); assert.equal(value, "no-store"); },
    /** Capture the local controller response. */ json: function json(payload) { responsePayload = payload; }
  });
  assert.equal(responsePayload.ok, true);
  assert.equal(responsePayload.data.tasks[0].execution_id, "visible");
  let nextCalls = 0;
  attachRequestContext({ originalUrl: "/api/v1/image-tasks?test=1", method: "GET" }, {}, /** Confirm short-circuiting before any logging dependency is needed. */ function next() { nextCalls += 1; });
  assert.equal(nextCalls, 1);
});

/** Minimal text-only DOM used for offline script and rendering tests, not browser/MCP inspection. */
class TestNode {
  /** Initialize a fake DOM node and its observable state. */
  constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.value = ""; this.hidden = false; this.attributes = {}; this.style = { /** Ignore existing log styling in the offline harness. */ setProperty: function set() {} }; }
  /** Replace children just like assigning DOM textContent. */
  set textContent(text) { this.text = String(text); this.children = []; }
  /** Flatten text for assertions without interpreting HTML markup. */
  get textContent() { return (this.text || "") + this.children.map(/** Read each child text recursively. */ function childText(child) { return child.textContent; }).join(""); }
  /** Append one node and return it. */
  appendChild(node) { this.children.push(node); return node; }
  /** Retain attributes used by accessible controls. */
  setAttribute(key, value) { this.attributes[key] = value; }
  /** Suppress automatic event dispatch in the deterministic harness. */
  addEventListener() {}
  /** Select duration cells recursively for the in-place clock refresh. */
  querySelectorAll(selector) {
    const result = [];
    for (const child of this.children) {
      if (selector === ".task-elapsed" && child.className === "task-elapsed") { result.push(child); }
      result.push(...child.querySelectorAll(selector));
    }
    return result;
  }
}

/** Evaluate the actual inline page script with no browser and no permitted network. */
function pageFixture() {
  const html = fs.readFileSync(path.join(__dirname, "..", "logs.html"), "utf8");
  const nodes = new Map();
  const context = vm.createContext({
    document: {
      /** Return stable fake nodes for the real page's IDs. */ getElementById: function byId(id) { if (!nodes.has(id)) { nodes.set(id, new TestNode("div")); } return nodes.get(id); },
      /** Create text-only elements. */ createElement: function element(tag) { return new TestNode(tag); },
      /** Group rendered rows in a fragment. */ createDocumentFragment: function fragment() { return new TestNode("fragment"); }
    },
    window: { /** Prevent page load from starting network timers. */ addEventListener: function listen() {} },
    Date, AbortSignal,
    /** Any unexpected fetch is a failing test, never a real request. */ fetch: async function forbidden() { assert.fail("unexpected network access"); }
  });
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], context, { filename: "logs.html" });
  return { context, nodes, html };
}

test("dashboard filters, history priority, pagination and safe detail rendering work offline", /** Execute the actual frontend functions on a minimal DOM. */ function () {
  const { context: page, nodes, html } = pageFixture();
  assert.ok(html.includes('id="imageTasksPanel"'));
  const created = "2026-09-03T00:00:00.000Z";
  page.imageTasks = [
    { execution_id: "active", phase: "downloading", source: "text-to-image", provider_task_id: "<img onerror=evil()>", created_at: created, download_attempt: 2 },
    { execution_id: "finished", phase: "succeeded", source: "carousel", created_at: created, finished_at: created, temu_main_id: "main-a", carousel_page_index: 0 }
  ];
  assert.equal(page.filteredImageTasks()[0].execution_id, "active");
  page.imageTaskOrder.value = "history";
  assert.equal(page.filteredImageTasks()[0].execution_id, "finished");
  page.imageTaskSearch.value = "main-A";
  assert.equal(page.filteredImageTasks().length, 1);
  page.imageTaskSearch.value = "";
  page.imageTaskPhase.value = "active";
  assert.equal(page.filteredImageTasks().length, 1);
  page.imageTaskPhase.value = "";
  page.imageTaskSource.value = "carousel";
  assert.equal(page.filteredImageTasks().length, 1);
  page.imageTaskSource.value = "";
  page.imageTaskOpenId = "active";
  page.renderImageTasks();
  assert.match(nodes.get("imageTaskRows").textContent, /<img onerror=evil\(\)>/);
  assert.match(nodes.get("imageTaskRows").textContent, /2 \/ 3/);
  const fragment = nodes.get("imageTaskRows").children[0];
  page.renderImageTasks();
  assert.equal(nodes.get("imageTaskRows").children[0], fragment, "unchanged polls must preserve DOM selection and expanded details");
  for (let index = 0; index < 55; index += 1) { page.imageTasks.push({ execution_id: "extra-" + index, source: "carousel", phase: "failed", created_at: created, finished_at: created }); }
  page.imageTaskPage = 1;
  page.renderImageTasks();
  assert.equal(nodes.get("imageTaskPage").textContent, "2 / 2 页");
  assert.equal(nodes.get("imageTaskRows").children[0].children.length, 8);
  page.imageTaskSearch.value = "nonexistent";
  page.renderImageTasks();
  assert.equal(page.imageTaskPage, 0);
  assert.match(nodes.get("imageTaskRows").textContent, /没有匹配/);
});

test("dashboard polling only fetches local metadata and retains its last snapshot on errors", /** Stub local HTTP responses while running the actual frontend loader. */ async function () {
  const { context: page, nodes } = pageFixture();
  const calls = [];
  page.fetch = /** Return a local-ledger fixture only. */ async function local(url) {
    calls.push(url);
    return { ok: true, /** Decode the fixture envelope. */ json: async function json() { return { ok: true, data: { tasks: [{ execution_id: "kept", phase: "queued", created_at: new Date().toISOString() }], storage_warning: "disk warning", server_time: new Date().toISOString() } }; } };
  };
  await page.loadImageTasks();
  assert.deepEqual(calls, ["/api/v1/image-tasks"]);
  assert.equal(nodes.get("imageTaskWarning").hidden, false);
  page.fetch = /** Simulate an unavailable local server. */ async function fail() { throw new Error("offline"); };
  await page.loadImageTasks();
  assert.equal(page.imageTasks[0].execution_id, "kept");
  assert.match(nodes.get("imageTasksStatus").textContent, /读取失败/);
});

test("dashboard copies the exact ID and links logs by request without mutating task state", /** Exercise read-only click handlers on the actual page script. */ async function () {
  const { context: page, nodes } = pageFixture();
  const copied = [];
  page.navigator = { clipboard: { /** Capture clipboard text without invoking any OS integration. */ writeText: async function write(text) { copied.push(text); } } };
  const task = { execution_id: "local", provider_task_id: "provider_exact-id", request_id: "request-exact", phase: "succeeded", source: "carousel", created_at: new Date().toISOString(), finished_at: new Date().toISOString() };
  page.imageTasks = [task];
  const button = new TestNode("button");
  button.dataset = { executionId: "local", taskAction: "copy-provider" };
  const event = { target: { /** Resolve the delegated fixture click to its button. */ closest: function closest() { return button; } } };
  await page.handleImageTaskAction(event);
  assert.deepEqual(copied, ["provider_exact-id"]);
  button.dataset.taskAction = "logs";
  await page.handleImageTaskAction(event);
  assert.equal(page.logRequestFilter, "request-exact");
  assert.equal(nodes.get("logsPanel").hidden, false);
  assert.equal(nodes.get("imageTasksPanel").hidden, true);
  assert.match(nodes.get("requestLogFilterText").textContent, /request-exact/);
  assert.equal(task.phase, "succeeded");
});

test("uploaded review diagnostics groups Bundle API logs and highlights bad or missing fields", /** Exercise the Uploaded / Review tab without calling the backend or browser. */ function () {
  const { context: page, nodes, html } = pageFixture();
  assert.ok(html.includes('id="uploadReviewPanel"'));
  assert.ok(html.includes('id="uploadReviewTab"'));
  page.logEntries = [
    { request_id: "req-ok", time: "2026-09-05 12:00:00", direction: "OUTBOUND", label: "Bundle API POST /relay", payload: { target: "request relay", upload: { body_type: "json" } } },
    { request_id: "req-ok", time: "2026-09-05 12:00:01", direction: "UPSTREAM", label: "Bundle API response 200", payload: { status: 200, duration_ms: 1200, data: { uploaded: true, review: true } } },
    { request_id: "req-missing", time: "2026-09-05 12:01:00", direction: "UPSTREAM", label: "Bundle API response 200", payload: { status: 200, duration_ms: 300 } },
    { request_id: "req-bad", time: "2026-09-05 12:02:00", direction: "UPSTREAM", label: "Bundle API response 200", payload: { status: 200, duration_ms: 400, uploaded: false, review: null } }
  ];
  page.renderUploadReview();
  assert.match(nodes.get("uploadReviewRows").textContent, /req-ok/);
  assert.match(nodes.get("uploadReviewRows").textContent, /true/);
  assert.match(nodes.get("uploadReviewRows").textContent, /缺失/);
  assert.match(nodes.get("uploadReviewRows").textContent, /false/);
  assert.match(nodes.get("uploadReviewRows").textContent, /null/);
  assert.match(nodes.get("uploadReviewSummary").textContent, /正常 1/);
  assert.match(nodes.get("uploadReviewSummary").textContent, /缺字段 1/);
  assert.match(nodes.get("uploadReviewSummary").textContent, /异常 1/);
  page.selectDiagnosticsTab("upload-review");
  assert.equal(nodes.get("uploadReviewPanel").hidden, false);
  assert.equal(nodes.get("logsPanel").hidden, true);
  assert.equal(nodes.get("uploadReviewTab").attributes["aria-selected"], "true");
});

test("failed-only page filters and paginates without requesting full URL details", /** Run the actual failure renderer offline on text-only DOM nodes. */ function () {
  const { context: page, nodes, html } = pageFixture();
  assert.ok(html.includes('id="imageFailuresPanel"'));
  const finished = "2026-09-03T01:00:00.000Z";
  page.imageFailures = [{ execution_id: "download", provider_task_id: "remote", source: "carousel", phase: "failed", stage: "result_download", error_code: "DOWNLOAD_FAILED", http_status: 403, final_message: "<script>invalid</script>", url_display: "https://cdn.invalid/a?[参数已隐藏]", event_count: 3, finished_at: finished }];
  page.imageFailureSource.value = "text-to-image";
  assert.equal(page.filteredImageFailures().length, 0);
  page.imageFailureSource.value = "carousel";
  page.imageFailureStage.value = "result_download";
  page.imageFailureSearch.value = "download_failed";
  assert.equal(page.filteredImageFailures().length, 1);
  page.renderImageFailures();
  assert.match(nodes.get("imageFailureRows").textContent, /<script>invalid<\/script>/);
  assert.match(nodes.get("imageFailureRows").textContent, /403/);
  assert.equal(page.imageFailureDetails.size, 0);
  const fragment = nodes.get("imageFailureRows").children[0];
  page.renderImageFailures();
  assert.equal(nodes.get("imageFailureRows").children[0], fragment);
  page.imageFailureSearch.value = "";
  for (let index = 0; index < 51; index += 1) { page.imageFailures.push({ ...page.imageFailures[0], execution_id: "more-" + index }); }
  page.imageFailurePage = 1;
  page.renderImageFailures();
  assert.equal(nodes.get("imageFailurePage").textContent, "2 / 2 页");
  assert.equal(nodes.get("imageFailureRows").children[0].children.length, 2);
});

test("failure page fetches only local summaries/details and copies the exact signed URL on request", /** Verify no renderer follows or previews the remote image URL. */ async function () {
  const { context: page, nodes } = pageFixture();
  const calls = [];
  const copied = [];
  const task = { execution_id: "failed", source: "single-edit", phase: "failed", stage: "result_download", error_code: "DOWNLOAD_FAILED", final_message: "three downloads failed", event_count: 1, finished_at: new Date().toISOString() };
  const url = "https://cdn.invalid/a.png?signature=PRIVATE_SIGNED_URL";
  const detail = { ...task, events: [{ stage: "result_download", time: new Date().toISOString(), code: "IMAGE_HTTP_403", http_status: 403, message: "denied", url: url, url_display: "https://cdn.invalid/a.png?[参数已隐藏]", attempt: 3 }] };
  page.fetch = /** Respond only to the two explicitly allowed local endpoints. */ async function local(endpoint) {
    calls.push(endpoint);
    assert.ok(endpoint === "/api/v1/image-failures" || endpoint === "/api/v1/image-failures/failed");
    return { ok: true, /** Decode the fixture envelope. */ json: async function json() { return { ok: true, data: endpoint.endsWith("/failed") ? { task: detail } : { tasks: [task] } }; } };
  };
  page.navigator = { clipboard: { /** Capture explicit clipboard writes, never use the host clipboard. */ writeText: async function copy(text) { copied.push(text); } } };
  await page.loadImageFailures();
  assert.deepEqual(calls, ["/api/v1/image-failures"]);
  assert.ok(!nodes.get("imageFailureRows").textContent.includes("PRIVATE_SIGNED_URL"));
  const button = new TestNode("button");
  button.dataset = { failureAction: "expand", executionId: "failed" };
  const event = { target: { /** Resolve the delegated fixture button. */ closest: function closest() { return button; } } };
  await page.handleImageFailureAction(event);
  assert.deepEqual(calls, ["/api/v1/image-failures", "/api/v1/image-failures/failed"]);
  assert.equal(page.imageFailureDetails.get("failed").events[0].url, url);
  button.dataset.failureAction = "copy-url";
  button.dataset.eventIndex = "0";
  await page.handleImageFailureAction(event);
  assert.deepEqual(copied, [url]);
  const rendered = nodes.get("imageFailureRows").children[0];
  await page.loadImageFailures();
  assert.equal(nodes.get("imageFailureRows").children[0], rendered, "unchanged snapshots preserve expanded URL details");
  page.fetch = /** Simulate local snapshot downtime only. */ async function offline() { throw new Error("offline"); };
  await page.loadImageFailures();
  assert.equal(page.imageFailures.length, 1);
  assert.match(nodes.get("imageFailuresStatus").textContent, /读取失败/);
});

test("old backend 404 is shown as a version mismatch, never an empty task or failure history", /** Reproduce the user's old-process/new-page mismatch without a browser. */ async function () {
  const { context: page, nodes } = pageFixture();
  page.fetch = /** Return the real old server's missing-route HTTP status. */ async function missing() {
    return { ok: false, status: 404, /** A missing route need not even return valid JSON. */ json: async function invalidJson() { throw new Error("HTML 404"); } };
  };
  await page.loadImageTasks();
  await page.loadImageFailures();
  assert.match(nodes.get("imageTasksStatus").textContent, /后端未更新.*404/);
  assert.match(nodes.get("imageFailuresStatus").textContent, /后端未更新.*404/);
  assert.match(nodes.get("imageTaskWarning").textContent, /重新启动后端/);
  assert.match(nodes.get("imageFailureWarning").textContent, /\/api\/v1\/image-failures/);
  assert.match(nodes.get("imageTaskSummary").textContent, /数量未知/);
  assert.doesNotMatch(nodes.get("imageTaskRows").textContent, /暂无执行记录/);
  assert.doesNotMatch(nodes.get("imageFailureRows").textContent, /暂无最终失败记录/);
  assert.equal(page.imageTaskLoaded, false);
  page.fetch = /** Model successful reads after the backend is actually restarted. */ async function restored() {
    return { ok: true, status: 200, /** Return a valid genuinely empty ledger. */ json: async function json() { return { ok: true, data: { tasks: [] } }; } };
  };
  await page.loadImageTasks();
  await page.loadImageFailures();
  assert.equal(nodes.get("imageTaskWarning").hidden, true);
  assert.equal(nodes.get("imageFailureWarning").hidden, true);
  assert.match(nodes.get("imageTaskRows").textContent, /暂无执行记录/);
  assert.equal(page.imageTaskLoaded, true);
});

test("an HTTP 500 preserves previous task rows and exposes the failing status", /** Do not erase already observed task history on a transient backend failure. */ async function () {
  const { context: page, nodes } = pageFixture();
  page.imageTaskLoaded = true;
  page.imageTasks = [{ execution_id: "retained", phase: "succeeded", created_at: new Date().toISOString(), finished_at: new Date().toISOString() }];
  page.fetch = /** Return a failed local service response only. */ async function failed() { return { ok: false, status: 500 }; };
  await page.loadImageTasks();
  assert.equal(page.imageTasks[0].execution_id, "retained");
  assert.match(nodes.get("imageTaskRows").textContent, /retained/);
  assert.match(nodes.get("imageTaskWarning").textContent, /HTTP 500/);
  assert.match(nodes.get("imageTasksStatus").textContent, /上次快照/);
});

