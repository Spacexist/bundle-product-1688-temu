const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { compile } = require("@vue/compiler-dom");
const { ImageCacheService } = require("../services/image-cache.service");
const { ImageController } = require("../controllers/image.controller");
const { ProductService } = require("../services/product.service");
const { candidateImageQuerySchema } = require("../schemas/api.schemas");

/** Build an isolated cache; never read or mutate the user's real image directory. */
function cacheFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "candidate-cache-test-"));
  t.after(/** Delete only the verified test-created directory. */ function cleanupFixture() {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("candidate-cache-test-"));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return new ImageCacheService({ cacheDirectory: directory, imageDirectory: path.join(directory, "image") });
}

/** Return deterministic offline image bytes suitable for the ordinary image cache. */
function imageFixture() {
  return { mimeType: "image/png", buffer: Buffer.from("offline-image-fixture") };
}

/** Expose promise completion to tests that simulate a slow remote server. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise(/** Capture completion without starting a timer or a request. */ function captureCompletion(done, fail) {
    resolve = done;
    reject = fail;
  });
  return { promise: promise, resolve: resolve, reject: reject };
}

test("candidate cache coalesces URLs, deduplicates bytes and survives restart/product deletion", /** Verify shared disk caching without paid generation or real HTTP. */ async function (t) {
  const images = cacheFixture(t);
  let calls = 0;
  const pending = deferred();
  images.readSource = /** Simulate one slow ordinary CDN download. */ async function readFixture() {
    calls += 1;
    await pending.promise;
    return imageFixture();
  };
  const first = images.cacheCandidateImage("https://cdn.example/a.png");
  const second = images.cacheCandidateImage("https://cdn.example/a.png");
  assert.equal(first, second);
  assert.equal(calls, 1);
  pending.resolve();
  const local = await first;
  assert.match(local, /^\/api\/v1\/cache\/image\/temu\/main\//);
  assert.ok(images.localUrlExists(local));
  assert.equal(await images.cacheCandidateImage("https://cdn.example/a.png"), local);
  assert.equal(calls, 1);
  assert.equal(await images.cacheCandidateImage("https://cdn.example/same-content.png"), local);
  assert.equal(calls, 2);
  images.deleteProductCache({ platform: "temu", platform_id: "42" });
  assert.ok(images.localUrlExists(local));
  const restarted = new ImageCacheService({ cacheDirectory: images.cacheDirectory, imageDirectory: images.imageDirectory });
  restarted.readSource = /** Reject accidental network access after restart. */ function unexpectedDownload() { throw new Error("cache miss after restart"); };
  assert.equal(await restarted.cacheCandidateImage("https://cdn.example/a.png"), local);
  assert.equal(fs.readdirSync(path.dirname(images.resolveLocalImagePath(local))).length, 1);
});

test("candidate downloads are bounded and failure releases its slot", /** Exercise queue release and retry without changing generation concurrency. */ async function (t) {
  const images = cacheFixture(t);
  images.readSource = /** Seed a disk cache hit before saturating the network queue. */ async function seedImage() { return imageFixture(); };
  const cachedUrl = await images.cacheCandidateImage("https://cdn.example/already-cached.png");
  const pending = [];
  images.readSource = /** Hold downloads until the test explicitly resolves them. */ function downloadFixture() {
    const item = deferred();
    pending.push(item);
    return item.promise;
  };
  const results = [];
  for (let index = 0; index < 6; index += 1) {
    results.push(images.cacheCandidateImage("https://cdn.example/" + index + ".png"));
  }
  const finished = Promise.allSettled(results);
  assert.equal(pending.length, 4);
  assert.equal(images.candidateActiveCount, 4);
  assert.equal(await images.cacheCandidateImage("https://cdn.example/already-cached.png"), cachedUrl);
  assert.equal(pending.length, 4);
  pending[0].reject(new Error("offline simulated failure"));
  await results[0].catch(/** Consume the expected failure. */ function expectedFailure() {});
  assert.equal(pending.length, 5);
  pending[1].resolve(imageFixture());
  await results[1];
  assert.equal(pending.length, 6);
  for (let index = 2; index < pending.length; index += 1) {
    pending[index].resolve(imageFixture());
  }
  const settled = await finished;
  assert.equal(settled[0].status, "rejected");
  assert.equal(images.candidateActiveCount, 0);
  assert.equal(images.candidateRequests.size, 0);
  assert.equal(images.findSourceCache("https://cdn.example/0.png"), "");
});

test("clear-all rejects active and queued downloads and prevents late cache resurrection", /** Exercise the production clear hook with a late response that ignores abort. */ async function (t) {
  const images = cacheFixture(t);
  const pending = deferred();
  images.readSource = /** Simulate a late transport result even after cancellation. */ function slowRead() { return pending.promise; };
  const results = [];
  for (let index = 0; index < 6; index += 1) {
    results.push(images.cacheCandidateImage("https://cdn.example/late-" + index));
  }
  const settled = Promise.allSettled(results);
  const clearing = deferred();
  const products = new ProductService({
    repository: { cacheDirectory: images.cacheDirectory,
      /** Hold the repository queue without deleting anything outside the fixture. */ clearDirectory() { return clearing.promise; } },
    viewModels: { /** Return the supplied empty workbench. */ createWorkbench(payload) { return payload; } },
    events: { /** Ignore the isolated clear event. */ publish() {} },
    images: images
  });
  const clearResult = products.clearAll("test-clear");
  await assert.rejects(images.cacheCandidateImage("https://cdn.example/new"), { code: "CACHE_CLEARING" });
  assert.equal((await settled).filter(/** Count cancelled requests. */ function rejected(item) { return item.status === "rejected"; }).length, 6);
  clearing.resolve({ records: [] });
  await clearResult;
  pending.resolve(imageFixture());
  await new Promise(/** Flush late download continuations. */ function nextTurn(resolve) { setImmediate(resolve); });
  assert.equal(images.candidateActiveCount, 0);
  assert.equal(fs.existsSync(images.sourceIndexPath), false);
  assert.equal(fs.readdirSync(path.join(images.imageDirectory, "temu", "main")).length, 0);
  assert.match(await images.cacheCandidateImage("https://cdn.example/new"), /^\/api\/v1\/cache\/image\//);
});

/** Create a minimal HTTP response recorder without a browser or TCP listener. */
function responseFixture() {
  return {
    headers: {},
    /** Capture cache policy. */ setHeader(name, value) { this.headers[name] = value; },
    /** Remove the provisional no-store header only for a successful file response. */ removeHeader(name) { delete this.headers[name]; },
    /** Capture the stable file and immutable browser cache options. */ sendFile(file, options) { this.file = file; this.options = options; },
    /** Capture the existing remote-image fallback. */ redirect(status, url) { this.redirected = { status: status, url: url }; }
  };
}

test("candidate endpoint serves disk images and preserves original failure display", /** Ensure proxy loading does not alter workflows or error UI. */ async function (t) {
  const images = cacheFixture(t);
  images.readSource = /** Supply an ordinary local fixture. */ async function readFixture() { return imageFixture(); };
  const controller = new ImageController({ images: images });
  const request = { validatedQuery: { source: "https://cdn.example/old-result.png" } };
  const response = responseFixture();
  /** Surface unexpected controller errors in the test. */
  function next(error) { throw error; }
  await controller.getCandidateImage(request, response, next);
  assert.ok(fs.existsSync(response.file));
  assert.equal(response.options.immutable, true);
  assert.equal(response.options.maxAge, "365d");
  images.readSource = /** Emulate a failed CDN request without poisoning the disk index. */ async function failedDownload() { throw new Error("HTTP 403"); };
  const failed = responseFixture();
  await controller.getCandidateImage({ validatedQuery: { source: "https://cdn.example/failed.png" } }, failed, next);
  assert.equal(failed.redirected.url, "https://cdn.example/failed.png");
  assert.equal(failed.headers["Cache-Control"], "no-store");
  assert.equal(candidateImageQuerySchema.safeParse({ source: "file:///private.png" }).success, false);
  assert.equal(candidateImageQuerySchema.safeParse({ source: "javascript:alert(1)" }).success, false);
  assert.equal(candidateImageQuerySchema.safeParse(request.validatedQuery).success, true);
});

/** Capture real Vue methods in an offline browser stub; never mount or run API calls. */
function frontendFixture() {
  let options;
  let sequence = 0;
  const frames = new Map();
  const scrolls = [];
  const listeners = new Map();
  const window = {
    innerWidth: 1280, innerHeight: 800,
    location: { search: "" },
    /** Queue a frame for explicit test execution. */ requestAnimationFrame(callback) { frames.set(++sequence, callback); return sequence; },
    /** Cancel the actual pending frame. */ cancelAnimationFrame(id) { frames.delete(id); },
    /** Record requested page movement without a browser. */ scrollBy(value) { scrolls.push(value); },
    /** Record global listener capture mode. */ addEventListener(name, handler, settings) { listeners.set(name + String(settings === true || settings && settings.capture || false), handler); },
    /** Record lifecycle cleanup. */ removeEventListener(name, handler, settings) { listeners.delete(name + String(settings === true || settings && settings.capture || false)); }
  };
  const document = { documentElement: {},
    /** Ignore unrelated click listeners. */ addEventListener() {},
    /** Ignore unrelated click cleanup. */ removeEventListener() {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../../web/app.js"), "utf8"), {
    URL: URL, URLSearchParams: URLSearchParams, window: window, document: document,
    Vue: { /** Capture options and suppress every browser lifecycle action. */ createApp(value) {
      options = value;
      return { /** Ignore registration. */ component() {}, /** Do not mount. */ mount() {} };
    } }
  });
  const view = options.data();
  for (const [name, method] of Object.entries(options.methods)) {
    view[name] = method.bind(view);
  }
  return { options: options, view: view, window: window, document: document, frames: frames, scrolls: scrolls, listeners: listeners,
    /** Run one scheduled animation frame at a controlled timestamp. */ tick(timestamp) {
      const [id, callback] = frames.entries().next().value;
      frames.delete(id);
      callback(timestamp);
    } };
}

test("all CLIP candidate types use cache on display; local and legacy images remain unchanged", /** Verify old, automatic, keyword and Top10 candidates share the same display pipeline. */ function () {
  const { view, options } = frontendFixture();
  compile(options.template);
  assert.match(options.template, /:src="workflowCandidateImageSource\(item\)"/);
  for (const item of [
    { source_mode: "clip", image_url: "https://cdn.example/old.png" },
    { source_mode: "clip", image_url: "https://cdn.example/auto.png" },
    { source_mode: "clip", image_url: "https://cdn.example/keyword.png" },
    { source_mode: "clip", image_url: "https://cdn.example/top.png", clip_top10: true }
  ]) {
    assert.equal(new URL(view.workflowCandidateImageSource(item)).searchParams.get("source"), item.image_url);
  }
  assert.equal(view.workflowCandidateImageSource({ source_mode: "legacy", image_url: "https://cdn.example/legacy.png" }), "https://cdn.example/legacy.png");
  assert.equal(view.workflowCandidateImageSource({ source_mode: "clip", image_url: "/api/v1/cache/image/temu/main/a.png" }), "http://127.0.0.1:3000/api/v1/cache/image/temu/main/a.png");
});

test("image edge scrolling moves both ways, accelerates, and stops in the middle", /** Exercise actual drag methods with no MCP/browser automation. */ function () {
  const fixture = frontendFixture();
  const view = fixture.view;
  view.handleImageDragScroll({ clientX: 600, clientY: 10 });
  assert.equal(fixture.frames.size, 0);
  view.dragImageReference = { source_type: "workflow", image_url: "candidate" };
  view.handleImageDragScroll({ clientX: 600, clientY: 60 });
  fixture.tick(100);
  const gentle = fixture.scrolls[0].top;
  assert.ok(gentle < 0);
  view.handleImageDragScroll({ clientX: 600, clientY: 5 });
  fixture.tick(116);
  assert.ok(fixture.scrolls[1].top < gentle);
  assert.equal(fixture.frames.size, 1);
  view.handleImageDragScroll({ clientX: 600, clientY: 795 });
  fixture.tick(132);
  assert.ok(fixture.scrolls[2].top > 0);
  view.handleImageDragScroll({ clientX: 600, clientY: 400 });
  assert.equal(fixture.frames.size, 0);
  view.dragImageReference = null;
  view.imageReorderReference = { image_type: "detail" };
  view.handleImageDragScroll({ clientX: 600, clientY: 10 });
  assert.equal(fixture.frames.size, 1);
  view.endImageReorder();
  assert.equal(fixture.frames.size, 0);
});

test("drop capture stops scrolling but preserves the payload; cancellation and leaving stop it too", /** Keep existing drop handlers safe even when propagation is stopped. */ function () {
  const fixture = frontendFixture();
  const view = fixture.view;
  for (const action of ["drop", "dragend", "blur", "leave"]) {
    view.dragImageReference = { source_type: "sku", image_url: "sku" };
    view.handleImageDragScroll({ clientX: 600, clientY: 5 });
    if (action === "drop") {
      view.stopImageDragScroll();
      assert.equal(view.dragImageReference.image_url, "sku");
    } else if (action === "leave") {
      view.handleImageDragLeave({ relatedTarget: null, target: fixture.document.documentElement });
    } else {
      view.clearImageDragState({ type: action });
      assert.equal(view.dragImageReference, null);
    }
    assert.equal(fixture.frames.size, 0);
  }
  let prevented = false;
  view.handleImageDragWheel({ deltaY: -2, deltaMode: 1,
    /** Track wheel ownership during image drag only. */ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(fixture.scrolls.at(-1).top, -32);
  view.endAliImageDrag();
  prevented = false;
  view.handleImageDragWheel({ deltaY: 1, /** Ordinary page scrolling must not be intercepted. */ preventDefault() { prevented = true; } });
  assert.equal(prevented, false);
});

test("drag listener lifecycle uses capture and removes every new listener on unmount", /** Verify .stop drop zones cannot suppress scrolling or cleanup. */ function () {
  const fixture = frontendFixture();
  const view = fixture.view;
  view.initializeCloudAuth = /** Avoid authentication and network work. */ function noAuth() {};
  view.stopRealtimeCache = /** Avoid unrelated subscriptions. */ function noRealtime() {};
  fixture.options.mounted.call(view);
  assert.equal(fixture.listeners.get("dragovertrue"), view.handleImageDragScroll);
  assert.equal(fixture.listeners.get("droptrue"), view.stopImageDragScroll);
  view.dragImageReference = { image_url: "candidate" };
  view.handleImageDragScroll({ clientX: 600, clientY: 5 });
  fixture.options.beforeUnmount.call(view);
  assert.equal(fixture.frames.size, 0);
  assert.equal(fixture.listeners.size, 0);
});
