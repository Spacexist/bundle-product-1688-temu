const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setImmediate: nextTurn } = require("node:timers/promises");
const { TubaAsyncImageService, PROVIDER_TIMEOUT_MS } = require("../services/tuba-async-image.service");
const { ImageCacheService } = require("../services/image-cache.service");
const { ImageTaskQueue } = require("../services/image-task-queue");
const { ProviderService } = require("../services/provider.service");
const { DirectImageRuntimeService } = require("../services/direct-image-runtime.service");
const { CarouselRuntimeService } = require("../services/carousel-runtime.service");
const { createWorkflowService } = require("../workflow-service");

const ENDPOINT = "https://api.tuba.invalid/v1/images/generations";
const URL_RESULT = "https://images.tuba.invalid/result.png";
const LOCAL_RESULT = "/api/v1/cache/image/transfer/generated/test.png";

/** Build an HTTP response without making any network connection. */
function reply(payload, status) {
  return new Response(JSON.stringify(payload), { status: status || 200 });
}

/** Create a documented completed result. */
function completed() {
  return reply({ task_id: "task_test", status: "completed", data: [{ url: URL_RESULT }] });
}

/** Script transport and advance virtual time so even ten-minute timeout tests finish offline. */
function harness(responses) {
  const calls = [];
  const waits = [];
  const states = [];
  let clock = 0;
  const client = new TubaAsyncImageService({
    /** Return virtual milliseconds. */
    now: function now() { return clock; },
    /** Advance time without sleeping. */
    wait: async function wait(ms) { waits.push(ms); clock += ms; },
    /** Consume exactly the declared fixture sequence; never fall back to live fetch. */
    fetch: async function fetchFixture(url, init) {
      calls.push({ url, init });
      assert.ok(responses.length, "Unexpected network call: " + init.method + " " + url);
      const item = responses.shift();
      if (item instanceof Error) { throw item; }
      return typeof item === "function" ? item(url, init) : item;
    }
  });
  const options = {
    endpoint: ENDPOINT, apiKey: "test-only", body: { prompt: "test", n: 1 },
    /** Record persisted protocol transitions. */
    onState: function onState(state) { states.push(state); }
  };
  return { client, options, calls, waits, states };
}

/** Provide a success-only protocol fixture for one generation execution. */
function successHarness() {
  return harness([reply({ task_id: "task_test", status: "queued" }), completed()]);
}

/** Create a deferred result for proving ownership across asynchronous boundaries. */
function deferred() {
  let resolve;
  const promise = new Promise(/** Capture the resolver without performing work. */ function executor(done) { resolve = done; });
  return { promise, resolve };
}

/** Isolate every persistence test from the application's actual cache. */
function tempDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tuba-image-test-"));
  t.after(/** Delete only the freshly created, verified test directory. */ function cleanup() {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("tuba-image-test-"));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

/** Return test provider configuration without reading private project settings. */
function imageConfig() {
  return { baseurl: "https://api.tuba.invalid", endpoint: "/v1/images/edits", generation_endpoint: "/v1/images/generations", apikey: "test-only", quality: "high", model: "gpt-image-2" };
}

/** Provide a source reader and controlled local-cache completion without outbound downloads. */
function imageStub(download) {
  return {
    /** Decode a source fixture. */
    readDataUrl: function readDataUrl() { return { buffer: Buffer.from("source"), mimeType: "image/png" }; },
    cacheGeneratedImage: download || (/** Finish fixture caching. */ async function cache() { return LOCAL_RESULT; }),
    /** Accept only our known local result. */
    isLocalImageUrl: function isLocal(url) { return url === LOCAL_RESULT; },
    /** Represent a completed local write. */
    localUrlExists: function exists(url) { return url === LOCAL_RESULT; }
  };
}

/** Build the real provider integration with a fake protocol transport. */
function providerFor(h, images, queue) {
  return new ProviderService({ readConfig: imageConfig, images, imageTaskQueue: queue, asyncImages: h.client });
}

/** Build a small direct execution request. */
function directInput(id) {
  return { client_task_id: id || "direct-test", temu_main_id: "1", mode: "edit", image_urls: ["data:image/png;base64,c291cmNl"], source_type: "gallery", prompt: "test" };
}

/** Build a persisted workflow service with no CLIP, model, or private-config connections. */
function workflowFor(directory, h, download) {
  return createWorkflowService({ cacheDirectory: directory, readConfig: imageConfig, asyncImages: h.client,
    cacheGeneratedImage: download || (/** Return an already written fixture image. */ async function cache() { return LOCAL_RESULT; }),
    /** Silence diagnostic output in the fixture. */
    writeLog: function log() {},
    /** Format deterministic valid timestamps. */
    formatTime: function time(value) { return value.toISOString(); }
  });
}

test("JSON submits once, polls every 4s and persists one ID through completion", /** Check the ordinary protocol. */ async function () {
  const h = harness([reply({ task_id: "task_test" }), reply({ status: "queued" }), reply({ status: "running" }), completed()]);
  assert.equal(await h.client.generate(h.options), URL_RESULT);
  assert.deepEqual(h.waits, [4000, 4000, 4000]);
  assert.equal(h.calls[0].init.method, "POST");
  const body = JSON.parse(h.calls[0].init.body);
  assert.equal(body.async, true);
  assert.equal(body.response_format, "url");
  assert.equal(h.states[0].provider_status, "submitting");
  for (const call of h.calls.slice(1)) {
    assert.equal(call.init.method, "GET");
    assert.equal(call.url, "https://api.tuba.invalid/v1/images/task_test");
  }
  assert.equal(h.states.at(-1).provider_image_url, URL_RESULT);
});

test("multipart retains both images and overwrites async/format fields", /** Check edits and fusion transport. */ async function () {
  const h = successHarness();
  h.options.endpoint = ENDPOINT.replace("generations", "edits");
  const form = new FormData();
  form.append("image", new Blob(["one"]), "one.png");
  form.append("image", new Blob(["two"]), "two.png");
  form.append("async", "false");
  form.append("response_format", "b64_json");
  h.options.body = form;
  await h.client.generate(h.options);
  assert.deepEqual(form.getAll("async"), ["true"]);
  assert.deepEqual(form.getAll("response_format"), ["url"]);
  assert.equal(form.getAll("image").length, 2);
  assert.equal(h.calls[0].init.headers["Content-Type"], undefined);
});

test("wrapped task responses are supported", /** Check a data-object envelope. */ async function () {
  const h = harness([reply({ data: { id: "task_test" } }), reply({ data: { status: "completed", data: [{ url: URL_RESULT }] } })]);
  assert.equal(await h.client.generate(h.options), URL_RESULT);
});

test("polling tolerates transient 404, 429, 5xx and network errors without a second POST", /** Check GET-only retries. */ async function () {
  const h = harness([reply({ task_id: "task_test" }), reply({}, 404), reply({}, 429), reply({}, 503), new Error("offline"), completed()]);
  assert.equal(await h.client.generate(h.options), URL_RESULT);
  assert.equal(h.calls.length, 6);
  for (const call of h.calls.slice(1)) { assert.equal(call.init.method, "GET"); }
});

for (const code of [400, 401, 403]) {
  test("poll HTTP " + code + " fails immediately", /** Check deterministic polling errors. */ async function () {
    const h = harness([reply({ task_id: "task_test" }), reply({}, code)]);
    await assert.rejects(h.client.generate(h.options), { code: "PROVIDER_HTTP_" + code });
    assert.equal(h.calls.length, 2);
  });
}

test("404 expires after its 30s visibility grace", /** Bound missing-task retries. */ async function () {
  const fixtures = [reply({ task_id: "task_test" })];
  for (let i = 0; i < 8; i += 1) { fixtures.push(reply({}, 404)); }
  const h = harness(fixtures);
  await assert.rejects(h.client.generate(h.options), { code: "PROVIDER_HTTP_404" });
  assert.equal(h.waits.length, 8);
});

test("continuous transient polling cannot extend the 600s deadline", /** Test the total rather than per-GET deadline. */ async function () {
  const fixtures = [reply({ task_id: "task_test" })];
  for (let i = 0; i < 149; i += 1) { fixtures.push(reply({}, 503)); }
  const h = harness(fixtures);
  await assert.rejects(h.client.generate(h.options), { code: "PROVIDER_TIMEOUT" });
  assert.equal(h.waits.length * 4000, PROVIDER_TIMEOUT_MS);
  assert.equal(h.calls.length, 150);
});

test("three consecutive unknown states fail", /** Reject malformed or unsupported task states. */ async function () {
  const h = harness([reply({ task_id: "task_test" }), reply({}), reply({ status: "mystery" }), reply({})]);
  await assert.rejects(h.client.generate(h.options), { code: "PROVIDER_UNKNOWN_STATUS" });
});

test("upstream failed and missing completed URLs are terminal", /** Preserve upstream failure and reject base64 fallback. */ async function () {
  const h = harness([reply({ task_id: "task_test" }), reply({ status: "failed", error: { message: "fixture rejected" } })]);
  await assert.rejects(h.client.generate(h.options), { code: "PROVIDER_FAILED", message: "fixture rejected" });
  const empty = harness([reply({ task_id: "task_test" }), reply({ status: "completed", data: [{ b64_json: "AAAA" }] })]);
  await assert.rejects(empty.client.generate(empty.options), { code: "PROVIDER_EMPTY_IMAGE" });
});

test("submission errors or missing IDs never cause a second POST", /** Protect against duplicate billing in ambiguous submissions. */ async function () {
  for (const fixture of [new Error("connection lost"), reply({ data: [{ url: URL_RESULT }] }), reply({}, 503), reply({}, 429)]) {
    const h = harness([fixture]);
    await assert.rejects(h.client.generate(h.options));
    assert.equal(h.calls.length, 1);
  }
});

test("cancel before POST sends nothing; cancel during waiting performs no GET", /** Stop local tracking promptly. */ async function () {
  const h = successHarness();
  const controller = new AbortController();
  controller.abort();
  h.options.signal = controller.signal;
  await assert.rejects(h.client.generate(h.options), { code: "IMAGE_TASK_CANCELLED" });
  assert.equal(h.calls.length, 0);
  const running = successHarness();
  const other = new AbortController();
  running.options.signal = other.signal;
  running.client.wait = /** Cancel while the next polling timer is pending. */ async function cancelWait() { other.abort(); };
  await assert.rejects(running.client.generate(running.options), { code: "IMAGE_TASK_CANCELLED" });
  assert.equal(running.calls.length, 1);
});

test("cache retries exactly three times and throws rather than returning the remote URL", /** Verify strict cache failure and interval. */ async function (t) {
  const directory = tempDirectory(t);
  const images = new ImageCacheService({ cacheDirectory: directory, imageDirectory: path.join(directory, "images") });
  let attempts = 0;
  images.cacheImage = /** Simulate a persistent CDN outage. */ async function failDownload() { attempts += 1; throw new Error("download failed"); };
  const started = Date.now();
  await assert.rejects(images.cacheGeneratedImage(URL_RESULT), { code: "DOWNLOAD_FAILED" });
  assert.equal(attempts, 3);
  assert.ok(Date.now() - started >= 3900);
});

test("a generated image is returned only after its local file exists", /** Verify actual local caching with mock bytes. */ async function (t) {
  const directory = tempDirectory(t);
  const images = new ImageCacheService({ cacheDirectory: directory, imageDirectory: path.join(directory, "images") });
  images.readSource = /** Supply valid PNG bytes without network. */ async function fixtureImage() {
    return { buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j+R8AAAAASUVORK5CYII=", "base64"), mimeType: "image/png" };
  };
  const local = await images.cacheGeneratedImage(URL_RESULT);
  assert.ok(images.isLocalImageUrl(local));
  assert.ok(images.localUrlExists(local));
});

test("a queue slot stays active after task_id and URL until local download resolves", /** Exercise the real provider and shared queue. */ async function () {
  const h = successHarness();
  const downloaded = deferred();
  const downloading = deferred();
  const images = imageStub(/** Hold the result until disk completion is simulated. */ async function download() { downloading.resolve(); return downloaded.promise; });
  const queue = new ImageTaskQueue({ /** Limit this proof to one in-flight image. */ getConcurrency: function limit() { return 1; } });
  const provider = providerFor(h, images, queue);
  const first = provider.editImages(directInput(), "edit", "request-test");
  await downloading.promise;
  let secondStarted = false;
  const second = queue.run(/** Observe when the next request is allowed to start. */ function secondJob() { secondStarted = true; });
  assert.equal(queue.getSnapshot().active, 1);
  assert.equal(queue.getSnapshot().pending, 1);
  assert.equal(secondStarted, false);
  downloaded.resolve(LOCAL_RESULT);
  assert.equal((await first).image_url, LOCAL_RESULT);
  await second;
  assert.equal(secondStarted, true);
  assert.equal(queue.getSnapshot().active, 0);
});

test("direct and SKU tasks persist a single provider ID and do not resubmit failed IDs", /** Check both runtime variants and explicit new-task retry. */ async function (t) {
  for (const runtimeName of ["direct-image", "sku-blend"]) {
    const directory = tempDirectory(t);
    const h = successHarness();
    const images = imageStub();
    const runtime = new DirectImageRuntimeService({ cacheDirectory: directory, runtimeName, taskScope: runtimeName === "sku-blend" ? "sku" : "product", images, providers: providerFor(h, images) });
    const input = directInput();
    if (runtimeName === "sku-blend") { input.mode = "fusion"; input.image_urls.push(input.image_urls[0]); }
    runtime.createTask(input);
    const done = await runtime.startTask(input.client_task_id, "r1");
    assert.equal(done.status, "succeeded");
    assert.equal(done.provider_task_id, "task_test");
    done.status = "failed";
    runtime.writeTask(done);
    runtime.createAndStartTask(input, "r2");
    await nextTurn();
    assert.equal(h.calls.length, 2);
    runtime.deleteTask(done.id);
    assert.ok(fs.existsSync(runtime.getTaskPath(done.id) + ".cancelled"));
    assert.throws(/** Reject reuse of a deleted execution ID. */ function reuse() { runtime.createTask(input); }, { code: "DIRECT_IMAGE_TASK_CANCELLED" });
    const next = runtime.createTask(directInput("direct-new"));
    assert.equal(next.task.provider_task_id, "");
  }
});

test("direct restart interrupts but never resumes a submitted or ambiguous task", /** Check startup recovery without any generation call. */ async function (t) {
  const directory = tempDirectory(t);
  const runtime = new DirectImageRuntimeService({ cacheDirectory: directory });
  const task = runtime.createTask(directInput()).task;
  task.status = "generating";
  task.provider_status = "submitting";
  runtime.writeTask(task);
  const restored = new DirectImageRuntimeService({ cacheDirectory: directory });
  const read = restored.readTask(task.id);
  assert.equal(read.status, "interrupted");
  assert.equal(read.error_code, "PROVIDER_SUBMISSION_UNKNOWN");
});

test("carousel binds provider ID to page execution and manual retry gets a new generation ID", /** Check one-to-one identity below the multi-page parent. */ async function (t) {
  const directory = tempDirectory(t);
  const h = successHarness();
  const images = imageStub();
  const runtime = new CarouselRuntimeService({ cacheDirectory: directory, images, providers: providerFor(h, images) });
  const task = runtime.createManualTask({ temu_main_id: "1", source_indices: [0, 1], gallery_snapshot: ["a", "b"], image_urls: ["a", "b"], pages: [{ prompt: "page" }] });
  const result = await runtime.generatePage(task.id, 0, "r");
  const page = result.pages[0];
  assert.equal(page.status, "succeeded");
  assert.equal(page.provider_task_id, "task_test");
  assert.ok(page.generation_id);
  const next = runtime.markPageGenerating(task.id, 0);
  assert.notEqual(next.pages[0].generation_id, page.generation_id);
  assert.equal(next.pages[0].provider_task_id, "");
  const restarted = new CarouselRuntimeService({ cacheDirectory: directory });
  assert.equal(restarted.readTask(task.id).pages[0].status, "failed");
  restarted.deleteTask(task.id);
  assert.ok(fs.existsSync(restarted.getTaskPath(task.id) + ".cancelled"));
});

test("workflow text-to-image uses the same async protocol and isolates candidate execution IDs", /** Check legacy generation persistence without front-end changes. */ async function (t) {
  const directory = tempDirectory(t);
  const h = successHarness();
  const workflow = workflowFor(directory, h);
  const payload = workflow.createEmptyPayload();
  const task = workflow.getOrCreateTask(payload, "1", "legacy");
  task.prompts = [{ prompt: "one", status: "prompt_ready" }];
  workflow.writePayload(payload, "r");
  await workflow.generateImagesAndPersist("1", 0, "r", ["one"]);
  const completedTask = workflow.findTask(workflow.readPayload(), "1", "legacy");
  assert.equal(completedTask.prompts[0].status, "generated");
  assert.equal(completedTask.prompts[0].provider_task_id, "task_test");
  assert.ok(completedTask.prompts[0].generation_id);
  assert.equal(JSON.parse(h.calls[0].init.body).async, true);
  const reloaded = workflowFor(directory, harness([]));
  assert.equal(reloaded.findTask(reloaded.readPayload(), "1", "legacy").prompts[0].provider_task_id, "task_test");
});

test("GET response must belong to the submitted task ID", /** Do not download another task's image. */ async function () {
  const h = harness([reply({ task_id: "task_test" }), reply({ task_id: "task_other", status: "completed", data: [{ url: URL_RESULT }] })]);
  await assert.rejects(h.client.generate(h.options), { code: "PROVIDER_TASK_ID_CONFLICT" });
});

test("unknown-state counter resets after a valid running state", /** Count consecutive rather than total anomalies. */ async function () {
  const h = harness([reply({ task_id: "task_test" }), reply({}), reply({}), reply({ status: "running" }), reply({}), completed()]);
  assert.equal(await h.client.generate(h.options), URL_RESULT);
});

test("task ID must be durably acknowledged before polling", /** Persistence failure cannot cause resubmission. */ async function () {
  const h = successHarness();
  h.options.onState = /** Simulate disk exhaustion after the submit response. */ function fullDisk(state) {
    if (state.provider_task_id) { throw new Error("disk full"); }
  };
  await assert.rejects(h.client.generate(h.options), { message: "disk full" });
  assert.equal(h.calls.length, 1);
});

test("runtime deletion after submission cancels polling and preserves its tombstone", /** No late response can recreate a deleted task. */ async function (t) {
  const directory = tempDirectory(t);
  const h = successHarness();
  const images = imageStub();
  const runtime = new DirectImageRuntimeService({ cacheDirectory: directory, images, providers: providerFor(h, images) });
  const input = directInput();
  runtime.createTask(input);
  h.client.wait = /** Delete after onState has stored the Tuba ID. */ async function removeDuringWait() { runtime.deleteTask(input.client_task_id); };
  assert.equal(await runtime.startTask(input.client_task_id, "r"), null);
  assert.equal(h.calls.length, 1);
  assert.equal(runtime.readTask(input.client_task_id), null);
  const marker = runtime.getTaskPath(input.client_task_id) + ".cancelled";
  assert.equal(JSON.parse(fs.readFileSync(marker, "utf8")).provider_task_id, "task_test");
  runtime.deleteTask(input.client_task_id);
  assert.equal(JSON.parse(fs.readFileSync(marker, "utf8")).provider_task_id, "task_test");
  const reloaded = new DirectImageRuntimeService({ cacheDirectory: directory });
  assert.equal(reloaded.readTasks().length, 0);
  assert.equal(reloaded.isTaskCancelled(input.client_task_id), true);
});

test("download failure releases the real queue slot and persists DOWNLOAD_FAILED without resubmission", /** End failed image work instead of indefinitely holding capacity. */ async function (t) {
  const directory = tempDirectory(t);
  const h = successHarness();
  const images = imageStub(/** Simulate the cache service's final failure. */ async function failedDownload() {
    const error = new Error("three downloads failed"); error.code = "DOWNLOAD_FAILED"; throw error;
  });
  const queue = new ImageTaskQueue({ /** Serialize work for queue accounting. */ getConcurrency: function one() { return 1; } });
  const runtime = new DirectImageRuntimeService({ cacheDirectory: directory, images, providers: providerFor(h, images, queue) });
  runtime.createTask(directInput());
  const result = await runtime.startTask("direct-test", "r");
  assert.equal(result.status, "failed");
  assert.equal(result.error_code, "DOWNLOAD_FAILED");
  assert.equal(result.provider_task_id, "task_test");
  assert.equal(result.provider_image_url, URL_RESULT);
  assert.equal(h.calls.length, 2);
  assert.equal(queue.getSnapshot().active, 0);
});

test("cancel during image download prevents local writes and further download retries", /** Check cancellation at the cache write boundary. */ async function (t) {
  const directory = tempDirectory(t);
  const images = new ImageCacheService({ cacheDirectory: directory, imageDirectory: path.join(directory, "images") });
  const controller = new AbortController();
  let reads = 0;
  images.readSource = /** Cancel while the bytes are being received. */ async function cancelSource() {
    reads += 1; controller.abort(); return { buffer: Buffer.from("bytes"), mimeType: "image/png" };
  };
  await assert.rejects(images.cacheGeneratedImage(URL_RESULT, { signal: controller.signal }), { code: "IMAGE_TASK_CANCELLED" });
  assert.equal(reads, 1);
  assert.equal(fs.readdirSync(path.join(directory, "images", "transfer", "generated")).length, 0);
});

test("a disappeared source cache cannot be reported as successful", /** A returned remote URL is not a valid local cache result. */ async function (t) {
  const directory = tempDirectory(t);
  const images = new ImageCacheService({ cacheDirectory: directory, imageDirectory: path.join(directory, "images") });
  let attempts = 0;
  images.cacheImage = /** Simulate the old permissive return path. */ async function remoteFallback() { attempts += 1; return URL_RESULT; };
  await assert.rejects(images.cacheGeneratedImage(URL_RESULT), { code: "DOWNLOAD_FAILED" });
  assert.equal(attempts, 3);
});

test("an active queued carousel page cannot be expired by the old local timer", /** Keep queue wait separate from provider polling duration. */ function (t) {
  const directory = tempDirectory(t);
  const runtime = new CarouselRuntimeService({ cacheDirectory: directory });
  const task = runtime.createManualTask({ temu_main_id: "1", source_indices: [0, 1], gallery_snapshot: [], image_urls: ["a", "b"], pages: [{ prompt: "page" }] });
  const running = runtime.markPageGenerating(task.id, 0, "generation-test");
  running.pages[0].generation_started_at = new Date(Date.now() - 900000).toISOString();
  runtime.writeTask(running);
  runtime.generationControllers[runtime.getGenerationControllerKey(task.id, 0, "generation-test")] = new AbortController();
  assert.equal(runtime.readTask(task.id).pages[0].status, "generating");
  const reloaded = new CarouselRuntimeService({ cacheDirectory: directory });
  assert.equal(reloaded.readTask(task.id).status, "interrupted");
  assert.equal(reloaded.readTask(task.id).pages[0].generation_id, "generation-test");
});

test("workflow restart retains IDs but never resumes incomplete candidates", /** Stop old and new task formats identically on restart. */ function (t) {
  const directory = tempDirectory(t);
  const h = harness([]);
  const workflow = workflowFor(directory, h);
  const payload = workflow.createEmptyPayload();
  const task = workflow.getOrCreateTask(payload, "1", "legacy");
  task.status = "generating";
  task.prompts = [{ status: "generating", provider_task_id: "task_saved", generation_id: "saved" }, { status: "queued" }];
  workflow.writePayload(payload, "r");
  const reloaded = workflowFor(directory, h);
  const result = reloaded.findTask(reloaded.readPayload(), "1", "legacy");
  assert.equal(result.status, "interrupted");
  assert.equal(result.prompts[0].provider_task_id, "task_saved");
  assert.equal(result.prompts[1].status, "interrupted");
  assert.equal(h.calls.length, 0);
});
