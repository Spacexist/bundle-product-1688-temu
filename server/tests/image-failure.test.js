const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ImageFailureService, reportImageFailure, safeFailureUrl, MAX_EVENTS, MAX_EVENT_BYTES } = require("../services/image-failure.service");
const { RETENTION_MS } = require("../services/image-task-history.service");
const { ImageTaskQueue } = require("../services/image-task-queue");
const { TubaAsyncImageService } = require("../services/tuba-async-image.service");
const { ProviderService } = require("../services/provider.service");
const { ImageCacheService } = require("../services/image-cache.service");
const { createWorkflowService } = require("../workflow-service");
const { DiagnosticsController } = require("../controllers/diagnostics.controller");
const { attachRequestContext } = require("../middleware/request-context");

const IMAGE_URL = "https://cdn.invalid/result.png?signature=PRIVATE_IMAGE_SIGNATURE&expires=123";
const API_KEY = "fixture-private-api-key";
const PROMPT = "PRIVATE FULL PROMPT";

/** Allocate and validate an isolated temporary root for all fixture data. */
function directoryFor(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "image-failures-test-"));
  t.after(/** Remove only this newly created fixture directory. */ function cleanup() {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("image-failures-test-"));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

/** Compose the actual failure observer and queue without any external transport. */
function fixture(t, options) {
  const directory = directoryFor(t);
  const failures = new ImageFailureService({ cacheDirectory: directory, ...options });
  const queue = new ImageTaskQueue({ failures });
  return { directory, failures, queue };
}

/** Return a fresh HTTP JSON fixture, never a live server response. */
function response(payload, status) {
  return new Response(JSON.stringify(payload), { status: status || 200 });
}

/** Script provider responses and virtual four-second polling intervals. */
function protocol(script) {
  let now = 0;
  const calls = [];
  const client = new TubaAsyncImageService({
    /** Return virtual provider time. */ now: function clock() { return now; },
    /** Advance provider time without sleeping. */ wait: async function advance(ms) { now += ms; },
    /** Consume exactly the configured responses and prohibit real transport. */ fetch: async function fetchFixture(url, init) {
      calls.push({ url, method: init.method });
      assert.ok(script.length, "Unexpected provider call");
      const value = script.shift();
      if (value instanceof Error) { throw value; }
      return value;
    }
  });
  return { client, calls };
}

/** Execute the real protocol behind the observed queue with secret-bearing fixture inputs. */
function runProtocol(queue, client, executionId) {
  return queue.run(/** Keep the complete protocol within one queue slot. */ async function run() {
    return client.generate({ endpoint: "https://tuba.invalid/v1/images/generations", apiKey: API_KEY, body: { prompt: PROMPT },
      /** Mirror provider identities and stages into temporary metadata. */ onState: function state(value) { queue.observeProviderState(executionId, value); },
      /** Buffer sanitized transient/final errors until the task ends. */ onFailure: function failure(event) { queue.recordFailure(executionId, event); }
    });
  }, { execution_id: executionId, source: "text-to-image", temu_main_id: "product", request_id: "request" });
}

/** Configure image fixtures without reading private server settings. */
function config() { return { baseurl: "https://tuba.invalid", endpoint: "/v1/images/edits", generation_endpoint: "/v1/images/generations", apikey: API_KEY }; }

test("only terminal failures persist; successful, cancelled and interrupted buffers are discarded", /** Exercise the failed-only contract independently of normal task history. */ async function (t) {
  const { failures, queue } = fixture(t);
  await queue.run(/** Simulate a recovered transient failure. */ async function success() { queue.recordFailure("success", { code: "IMAGE_HTTP_503", stage: "result_download", url: IMAGE_URL }); }, { execution_id: "success" });
  assert.equal(failures.records.size, 0);
  assert.equal(failures.pending.size, 0);
  assert.equal(fs.existsSync(failures.file), false);
  await assert.rejects(queue.run(/** Simulate explicit local cancellation. */ async function cancel() { throw Object.assign(new Error("cancelled"), { code: "IMAGE_TASK_CANCELLED" }); }, { execution_id: "cancel" }));
  failures.begin({ execution_id: "interrupt" });
  failures.record("interrupt", { stage: "provider_poll", message: "transient" });
  failures.finish("interrupt", "interrupted");
  assert.equal(fs.existsSync(failures.file), false);
  await assert.rejects(queue.run(/** Produce one actual terminal error. */ async function fail() { throw Object.assign(new Error("final failure"), { code: "FINAL_FAILURE" }); }, { execution_id: "failed" }));
  assert.equal(failures.getSnapshot().tasks.length, 1);
  assert.equal(failures.getDetail("failed").events[0].message, "final failure");
});

test("submission HTTP errors retain upstream code/status but redact keys and echoed prompts", /** Verify the raw error is captured before protocol normalization. */ async function (t) {
  const { queue, failures } = fixture(t);
  const h = protocol([response({ error: { code: "BILLING_EMPTY", message: "rejected " + API_KEY + " " + PROMPT + " " + IMAGE_URL } }, 402)]);
  await assert.rejects(runProtocol(queue, h.client, "submit"), { code: "PROVIDER_HTTP_402" });
  assert.equal(h.calls.length, 1);
  const task = failures.getDetail("submit");
  assert.equal(task.events[0].http_status, 402);
  assert.equal(task.events[0].provider_code, "BILLING_EMPTY");
  assert.equal(task.events[0].stage, "provider_submit");
  assert.equal(task.provider_task_id, "");
  const disk = fs.readFileSync(failures.file, "utf8");
  assert.ok(!disk.includes(API_KEY));
  assert.ok(!disk.includes(PROMPT));
  assert.ok(!task.final_message.includes("PRIVATE_IMAGE_SIGNATURE"));
});

test("ambiguous submission retains original network cause without resubmission", /** Keep nested DNS/transport codes through both existing error wrappers. */ async function (t) {
  const { failures, queue } = fixture(t);
  const h = protocol([new TypeError("fetch failed", { cause: Object.assign(new Error("DNS failed"), { code: "ENOTFOUND" }) })]);
  await assert.rejects(runProtocol(queue, h.client, "network"), { code: "PROVIDER_SUBMISSION_UNKNOWN" });
  assert.equal(h.calls.length, 1);
  assert.match(failures.getDetail("network").events[0].cause, /ENOTFOUND/);
  assert.equal(failures.getDetail("network").events[0].http_status, 0);
});

test("retryable poll failures are discarded on success and kept when generation finally fails", /** Record only the failed execution, including its earlier retryable errors. */ async function (t) {
  const { queue, failures } = fixture(t);
  const good = protocol([response({ task_id: "good" }), response({ error: { code: "BUSY" } }, 429), response({ status: "completed", data: [{ url: IMAGE_URL }] })]);
  await runProtocol(queue, good.client, "success");
  assert.equal(failures.records.size, 0);
  const bad = protocol([response({ task_id: "bad" }), response({}, 503), response({ status: "failed", error: { code: "MODEL_REJECTED", message: "upstream refused" } })]);
  await assert.rejects(runProtocol(queue, bad.client, "failed"), { code: "PROVIDER_FAILED" });
  const task = failures.getDetail("failed");
  assert.equal(task.provider_task_id, "bad");
  assert.equal(task.events.length, 2);
  assert.equal(task.events[0].stage, "provider_poll");
  assert.equal(task.events[0].http_status, 503);
  assert.equal(task.events[1].stage, "provider_generation");
  assert.equal(task.events[1].provider_code, "MODEL_REJECTED");
  assert.deepEqual(bad.calls.map(/** Compare only the wire methods. */ function method(call) { return call.method; }), ["POST", "GET", "GET"]);
});

test("poll timeout is a local terminal failure, never a fabricated HTTP 504 response", /** Reach the existing 600-second limit using only virtual time. */ async function (t) {
  const { queue, failures } = fixture(t);
  const script = [response({ task_id: "timeout" })];
  for (let index = 0; index < 149; index += 1) { script.push(response({}, 503)); }
  const h = protocol(script);
  await assert.rejects(runProtocol(queue, h.client, "timeout"), { code: "PROVIDER_TIMEOUT" });
  const task = failures.getDetail("timeout");
  assert.equal(task.phase, "timeout");
  assert.equal(task.events.at(-1).http_status, 0);
  assert.equal(task.events.at(-1).code, "PROVIDER_TIMEOUT");
  assert.equal(task.events.length, 150);
});

test("three actual download failures retain URL, HTTP and causes but list summaries stay masked", /** Replace fetch only; use the real cache retry loop and real observed queue. */ async function (t) {
  const { directory, queue, failures } = fixture(t);
  const images = new ImageCacheService({ cacheDirectory: directory, imageDirectory: path.join(directory, "images") });
  let calls = 0;
  t.mock.method(globalThis, "fetch", /** Fail three network attempts with distinct evidence. */ async function fetchFixture() {
    calls += 1;
    if (calls === 1) { return response({}, 403); }
    if (calls === 2) { throw new DOMException("timed out", "TimeoutError"); }
    throw new TypeError("fetch failed", { cause: Object.assign(new Error("socket reset"), { code: "ECONNRESET" }) });
  });
  await assert.rejects(queue.run(/** Download under one bounded shared slot. */ async function download() {
    return images.cacheGeneratedImage(IMAGE_URL, { /** Forward each attempt into the temporary failure buffer. */ onFailure: function failure(event) { queue.recordFailure("download", event); } });
  }, { execution_id: "download" }), { code: "DOWNLOAD_FAILED" });
  const task = failures.getDetail("download");
  assert.equal(calls, 3);
  assert.equal(task.events.length, 3);
  assert.deepEqual(task.events.map(/** Read actual attempt numbers. */ function attempt(event) { return event.attempt; }), [1, 2, 3]);
  assert.equal(task.events[0].http_status, 403);
  assert.equal(task.events[1].code, "IMAGE_DOWNLOAD_TIMEOUT");
  assert.match(task.events[2].cause, /ECONNRESET/);
  assert.equal(task.events[2].url, IMAGE_URL);
  assert.equal(task.events[2].stage, "result_download");
  assert.ok(!JSON.stringify(failures.getSnapshot()).includes("PRIVATE_IMAGE_SIGNATURE"));
  assert.ok(!JSON.stringify(failures.getSnapshot()).includes('"events"'));
  assert.equal(queue.getSnapshot().active, 0);
  const restarted = new ImageFailureService({ cacheDirectory: directory });
  assert.equal(restarted.getDetail("download").events[0].url, IMAGE_URL);
});

test("reference image HTTP failures include input index and never submit a paid task", /** Exercise provider preprocessing with a fake allowed-CDN response. */ async function (t) {
  const { queue, failures, directory } = fixture(t);
  const images = new ImageCacheService({ cacheDirectory: directory, imageDirectory: path.join(directory, "images") });
  t.mock.method(globalThis, "fetch", /** Refuse the input image without contacting any CDN. */ async function fetchFixture() { return response({}, 403); });
  const provider = new ProviderService({ imageTaskQueue: queue, images, readConfig: config, asyncImages: { /** A failed reference must prevent submission entirely. */ generate: async function forbidden() { assert.fail("unexpected paid submission"); } } });
  const url = "https://fixture.alicdn.com/input.png?signature=input-signature";
  await assert.rejects(provider.editImages({ direct_task_id: "reference", temu_main_id: "main", image_urls: [url], prompt: PROMPT }, "edit", "request"));
  const task = failures.getDetail("reference");
  assert.equal(task.provider_task_id || "", "");
  assert.equal(task.events[0].source_index, 0);
  assert.equal(task.events[0].stage, "reference_download");
  assert.equal(task.events[0].http_status, 403);
  assert.equal(task.events[0].url, url);
});

test("non-image responses and cache write errors remain distinguishable", /** Use real MIME validation and disk-error classification in an isolated cache. */ async function (t) {
  const { queue, failures, directory } = fixture(t);
  const images = new ImageCacheService({ cacheDirectory: directory, imageDirectory: path.join(directory, "images") });
  const fetchMock = t.mock.method(globalThis, "fetch", /** Return an HTML error masquerading as HTTP success. */ async function html() { return new Response("not an image", { headers: { "Content-Type": "text/html" } }); });
  await assert.rejects(images.readRemoteUrl(IMAGE_URL), { code: "IMAGE_CONTENT_TYPE", image_stage: "result_download", http_status: 200 });
  fetchMock.mock.mockImplementation(/** Return valid fixture image bytes, never real image content. */ async function png() { return new Response("fixture-bytes", { headers: { "Content-Type": "image/png" } }); });
  t.mock.method(images, "rememberSourceCache", /** Simulate local disk exhaustion after downloading succeeds. */ function diskFull() { throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); });
  await assert.rejects(queue.run(/** Download succeeds but local cache metadata persistence fails. */ async function cache() {
    return images.cacheGeneratedImage(IMAGE_URL, { /** Forward cache write failures. */ onFailure: function failure(event) { queue.recordFailure("disk", event); } });
  }, { execution_id: "disk" }), { code: "DOWNLOAD_FAILED" });
  const task = failures.getDetail("disk");
  assert.equal(task.events.length, 3);
  assert.equal(task.events[0].stage, "cache_write");
  assert.equal(task.events[0].code, "ENOSPC");
  assert.equal(task.events[0].http_status, 0);
});

test("workflow forwards detailed failures to the same independent ledger", /** Use real workflow wiring with only the async provider transport mocked. */ async function (t) {
  const { queue, failures, directory } = fixture(t);
  const h = protocol([response({ task_id: "workflow" }), response({ status: "failed", error: { code: "WORKFLOW_POLICY", message: "refused" } })]);
  const workflow = createWorkflowService({ cacheDirectory: directory, imageTaskQueue: queue, asyncImages: h.client,
    /** Keep fixture logs quiet. */ writeLog: function log() {},
    /** Format valid fixture dates. */ formatTime: function time(date) { return date.toISOString(); }
  });
  await assert.rejects(workflow.generateOneImage(config(), PROMPT, "r", { generation_id: "candidate", candidate_index: 2, temu_main_id: "main" }), { code: "PROVIDER_FAILED" });
  assert.equal(failures.getDetail("candidate").candidate_index, 2);
  assert.equal(failures.getDetail("candidate").events[0].provider_code, "WORKFLOW_POLICY");
});

test("retention and event byte/count caps are independent of successful task history", /** Exercise both bounds with a virtual clock and without creating paid work. */ function (t) {
  let now = Date.now();
  const { failures } = fixture(t, { /** Return the injected retention clock. */ now: function clock() { return now; } });
  failures.begin({ execution_id: "bounded" });
  for (let index = 0; index < MAX_EVENTS + 5; index += 1) { failures.record("bounded", { stage: "provider_poll", attempt: index + 1, code: "RETRY", message: "transient" }); }
  assert.equal(failures.pending.get("bounded").events.length, MAX_EVENTS);
  assert.equal(failures.pending.get("bounded").omitted_events, 5);
  for (let index = 0; index < 60; index += 1) { failures.record("bounded", { stage: "result_download", message: "x".repeat(3000), url: "https://cdn.invalid/image?signature=" + "x".repeat(6000) }); }
  assert.ok(failures.pending.get("bounded").event_bytes <= MAX_EVENT_BYTES);
  failures.finish("bounded", "failed", new Error("final"));
  for (let index = 0; index < 1005; index += 1) {
    failures.records.set("row-" + index, { execution_id: "row-" + index, phase: "failed", finished_at: new Date(now + index).toISOString(), final_message: "error", events: [] });
  }
  assert.equal(failures.getSnapshot().tasks.length, 1000);
  now += RETENTION_MS + 2000;
  assert.equal(failures.getSnapshot().tasks.length, 0);
});

test("storage and observer exceptions cannot fail a successful image or repeat execution", /** Test read failure, write failure and arbitrary observer faults fail-open. */ async function (t) {
  const { queue, failures, directory } = fixture(t);
  const forbiddenFile = path.join(directory, "blocker");
  fs.writeFileSync(forbiddenFile, "keep");
  failures.file = path.join(forbiddenFile, "failure.json");
  await assert.rejects(queue.run(/** Produce a failure whose log cannot be saved. */ async function fail() { throw new Error("business failure"); }, { execution_id: "fail" }), { message: "business failure" });
  assert.match(failures.getSnapshot().storage_warning, /写入失败/);
  let calls = 0;
  const broken = new ImageTaskQueue({ failures: { /** Simulate a broken optional observer. */ begin: function begin() { throw new Error("observer"); } } });
  await broken.run(/** Finish exactly one execution despite logger faults. */ async function success() { calls += 1; return "ok"; });
  assert.equal(calls, 1);
  assert.doesNotThrow(/** Ignore failures thrown by attempt callbacks too. */ function report() { reportImageFailure({ /** Throw from a synthetic observer. */ onFailure: function brokenObserver() { throw new Error("observer"); } }, new Error("source"), {}); });
});

test("signed detail URLs exclude API keys and data URLs; failure endpoints never echo details into service logs", /** Verify explicit full-URL access stays isolated from ordinary polling and logging. */ function (t) {
  const { failures, queue } = fixture(t);
  assert.equal(safeFailureUrl("data:image/png;base64,PRIVATE"), "");
  assert.ok(!safeFailureUrl("https://user:password@cdn.invalid/a?api_key=SECRET&signature=allowed").includes("SECRET"));
  assert.ok(!safeFailureUrl("https://user:password@cdn.invalid/a").includes("password"));
  failures.begin({ execution_id: "detail" });
  const error = new Error("final");
  reportImageFailure({ /** Record only this final failure's detail. */ onFailure: function observe(event) { failures.record("detail", event); } }, error, { stage: "result_download", url: IMAGE_URL });
  failures.finish("detail", "failed", error);
  const controller = new DiagnosticsController({ diagnostics: { imageTaskQueue: queue } });
  let payload;
  let code;
  const reply = { /** Capture cache policy without starting HTTP. */ setHeader: function header(name, value) { assert.equal(value, "no-store"); },
    /** Capture detail HTTP status. */ status: function status(value) { code = value; return this; },
    /** Capture the result envelope. */ json: function json(value) { payload = value; }
  };
  controller.getImageFailures({}, reply);
  assert.ok(!JSON.stringify(payload).includes("PRIVATE_IMAGE_SIGNATURE"));
  controller.getImageFailureDetail({ params: { executionId: "detail" } }, reply);
  assert.equal(code, 200);
  assert.equal(payload.data.task.events[0].url, IMAGE_URL);
  controller.getImageFailureDetail({ params: { executionId: "absent" } }, reply);
  assert.equal(code, 404);
  for (const url of ["/api/v1/image-failures", "/api/v1/image-failures/detail"]) {
    let called = false;
    attachRequestContext({ method: "GET", originalUrl: url }, {}, /** Observe the logging bypass. */ function next() { called = true; });
    assert.equal(called, true);
  }
});

test("a recovered real download drops its temporary failures rather than writing failure history", /** Fail one download and then successfully cache fixture bytes with the normal retry policy. */ async function (t) {
  const { directory, queue, failures } = fixture(t);
  const images = new ImageCacheService({ cacheDirectory: directory, imageDirectory: path.join(directory, "images") });
  let calls = 0;
  let observations = 0;
  t.mock.method(globalThis, "fetch", /** Recover from one transient CDN error. */ async function recovering() {
    calls += 1;
    return calls === 1 ? response({}, 503) : new Response("fixture-image", { headers: { "Content-Type": "image/png" } });
  });
  const url = await queue.run(/** Keep retry and eventual cache completion under one slot. */ async function download() {
    return images.cacheGeneratedImage(IMAGE_URL, { /** Observe the transient error without persisting it yet. */ onFailure: function failure(event) { observations += 1; queue.recordFailure("recovered", event); } });
  }, { execution_id: "recovered" });
  assert.ok(images.localUrlExists(url));
  assert.equal(calls, 2);
  assert.equal(observations, 1);
  assert.equal(failures.pending.size, 0);
  assert.equal(failures.records.size, 0);
  assert.equal(fs.existsSync(failures.file), false);
});

test("corrupt failure history is preserved and no unfinished task is recovered on restart", /** Restart only the independent ledger, without creating any network service. */ function (t) {
  const { failures, directory } = fixture(t);
  failures.begin({ execution_id: "unfinished" });
  failures.record("unfinished", { stage: "provider_poll", message: "temporary failure" });
  const restarted = new ImageFailureService({ cacheDirectory: directory });
  assert.equal(restarted.pending.size, 0);
  assert.equal(restarted.records.size, 0);
  fs.mkdirSync(path.dirname(failures.file), { recursive: true });
  fs.writeFileSync(failures.file, "BROKEN ORIGINAL");
  const corrupt = new ImageFailureService({ cacheDirectory: directory });
  corrupt.begin({ execution_id: "new-failure" });
  corrupt.finish("new-failure", "failed", new Error("fail"));
  assert.equal(fs.readFileSync(failures.file, "utf8"), "BROKEN ORIGINAL");
  assert.match(corrupt.getSnapshot().storage_warning, /读取失败/);
  assert.equal(corrupt.getSnapshot().tasks.length, 1);
});

test("runtime persistence failures are not mislabeled as CDN download failures", /** Fail the business state callback immediately after the provider ID is received. */ async function (t) {
  const { queue, failures } = fixture(t);
  const h = protocol([response({ task_id: "acknowledged" })]);
  await assert.rejects(queue.run(/** Execute one submission whose runtime write fails. */ async function submit() {
    return h.client.generate({ endpoint: "https://tuba.invalid/v1/images/generations", apiKey: API_KEY, body: { prompt: PROMPT },
      /** Retain provider identity before simulating a runtime filesystem failure. */ onState: function state(value) { queue.observeProviderState("runtime", value); if (value.provider_status === "queued") { throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); } },
      /** Buffer the final persistence failure. */ onFailure: function failure(event) { queue.recordFailure("runtime", event); }
    });
  }, { execution_id: "runtime" }), { code: "ENOSPC" });
  assert.equal(h.calls.length, 1);
  assert.equal(failures.getDetail("runtime").events[0].stage, "state_persistence");
  assert.equal(failures.getDetail("runtime").provider_task_id, "acknowledged");
});
