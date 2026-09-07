const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DirectImageRuntimeService } = require("../services/direct-image-runtime.service");
const schemaModule = require("../schemas/api.schemas");

const ORIGINAL = "/api/v1/cache/image/product/original.png";
const RESULT_ONE = "/api/v1/cache/image/transfer/generated/result-one.png";
const RESULT_TWO = "/api/v1/cache/image/transfer/generated/result-two.png";
const MASK_CUTOUT = "/api/v1/cache/image/transfer/masks/direct-mask.png";

/** Create and safely remove one isolated runtime directory. */
function tempDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "direct-current-edit-"));
  t.after(/** Remove only the test-owned temporary directory. */ function cleanup() {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("direct-current-edit-"));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

/** Build a runtime whose provider and image cleanup calls remain observable. */
function createRuntime(t, results) {
  const calls = [];
  const deleted = [];
  const queue = Array.isArray(results) ? results.slice() : [];
  const runtime = new DirectImageRuntimeService({
    cacheDirectory: tempDirectory(t),
    images: {
      /** Treat fixture image URLs as locally readable. */
      isLocalImageUrl: function isLocalImageUrl(url) { return String(url || "").startsWith("/api/v1/cache/image/"); },
      /** Report every fixture image as fully written. */
      localUrlExists: function localUrlExists(url) { return Boolean(url); },
      /** Persist brush cutouts as local reusable mask images. */
      cacheMaskImage: function cacheMaskImage() { return MASK_CUTOUT; },
      /** Record generated-image cleanup without touching disk. */
      deleteUnreferencedGeneratedImage: function deleteImage(url) { deleted.push(url); return true; }
    },
    providers: {
      /** Record one Edits request and return the next fixture result. */
      editImages: async function editImages(input, mode) {
        calls.push({ input: input, mode: mode });
        const next = queue.shift();
        if (next instanceof Error) {
          throw next;
        }
        return { image_url: next, undo_token: "" };
      },
      /** Accept runtime cancellation checks in cleanup tests. */
      cancelImageTasks: function cancelImageTasks() {}
    }
  });
  return { runtime: runtime, calls: calls, deleted: deleted };
}

/** Create a promise whose completion is controlled by the uniqueness test. */
function deferred() {
  let resolve;
  const promise = new Promise(/** Capture one explicit resolver. */ function capture(done) { resolve = done; });
  return { promise: promise, resolve: resolve };
}

/** Return one first-generation direct-image request. */
function originalInput(taskId) {
  return {
    client_task_id: taskId,
    temu_main_id: "temu-1",
    mode: "edit",
    image_urls: [ORIGINAL],
    source_type: "gallery",
    source_indices: [0],
    detail_index: -1,
    prompt: "make it red"
  };
}

test("direct Edits retains input and result as two selectable versions", /** Verify first-generation version retention. */ async function (t) {
  const fixture = createRuntime(t, [RESULT_ONE]);
  fixture.runtime.createTask(originalInput("direct-first"));
  const task = await fixture.runtime.startTask("direct-first", "request-1");

  assert.equal(fixture.calls.length, 1);
  assert.deepEqual(fixture.calls[0].input.image_urls, [ORIGINAL]);
  assert.equal(fixture.calls[0].input.prompt, "make it red");
  assert.deepEqual(task.image_versions, [ORIGINAL, RESULT_ONE]);
  assert.equal(task.active_image_version, 1);
  assert.equal(task.image_url, RESULT_ONE);

  const selected = fixture.runtime.selectTaskVersion(task.id, 0);
  assert.equal(selected.image_url, ORIGINAL);
  assert.equal(selected.active_image_version, 0);
  assert.equal(fixture.calls.length, 1);
});

test("masked current-image Edits keeps the prompt clean for provider mask prompts", /** Ensure mask edits do not receive the non-mask current-image prefix. */ async function (t) {
  const fixture = createRuntime(t, [RESULT_ONE, RESULT_TWO]);
  fixture.runtime.createTask(originalInput("direct-mask-parent"));
  await fixture.runtime.startTask("direct-mask-parent", "request-1");

  const child = fixture.runtime.createTask(Object.assign({}, originalInput("direct-mask-child"), {
    reference_mode: "current",
    parent_task_id: "direct-mask-parent",
    mask_url: "data:image/png;base64,Yg==",
    prompt: "只改涂抹区域"
  })).task;
  await fixture.runtime.startTask(child.id, "request-2");

  assert.equal(fixture.calls.length, 2);
  assert.equal(fixture.calls[1].input.prompt, "只改涂抹区域");
  assert.equal(fixture.calls[1].input.mask_url, "data:image/png;base64,Yg==");
});

test("cutout mask Edits saves and submits the brush cutout as the only image", /** Verify cutout mode cannot degrade into a prompt-only edit. */ async function (t) {
  const fixture = createRuntime(t, [RESULT_ONE]);
  fixture.runtime.createTask(Object.assign({}, originalInput("direct-cutout"), {
    mask_mode: "cutout",
    mask_url: "data:image/png;base64,YQ=="
  }));
  const task = await fixture.runtime.startTask("direct-cutout", "request-cutout");

  assert.equal(task.mask_mode, "cutout");
  assert.equal(task.mask_image_url, MASK_CUTOUT);
  assert.deepEqual(fixture.calls[0].input.image_urls, [MASK_CUTOUT]);
  assert.equal(fixture.calls[0].input.mask_url, "");
  assert.equal(fixture.calls[0].input.mask_mode, "cutout");
});

test("current-image Edits replaces the selected slot and creates a new provider execution", /** Verify current-image lineage, provider input and two-slot replacement. */ async function (t) {
  const fixture = createRuntime(t, [RESULT_ONE, RESULT_TWO]);
  fixture.runtime.createTask(originalInput("direct-parent"));
  await fixture.runtime.startTask("direct-parent", "request-1");

  const childInput = Object.assign({}, originalInput("direct-child"), {
    reference_mode: "current",
    parent_task_id: "direct-parent",
    prompt: "change only the background"
  });
  const child = fixture.runtime.createTask(childInput).task;
  assert.equal(child.image_url, RESULT_ONE);
  assert.equal(child.edit_image_url, RESULT_ONE);
  assert.deepEqual(child.source_image_urls, [ORIGINAL]);
  assert.equal(fixture.runtime.readTask("direct-parent"), null);

  const completed = await fixture.runtime.startTask(child.id, "request-2");
  assert.equal(fixture.calls.length, 2);
  assert.deepEqual(fixture.calls[1].input.image_urls, [RESULT_ONE]);
  assert.match(fixture.calls[1].input.prompt, /唯一输入图片/);
  assert.match(fixture.calls[1].input.prompt, /change only the background/);
  assert.deepEqual(completed.image_versions, [ORIGINAL, RESULT_TWO]);
  assert.equal(completed.active_image_version, 1);
  assert.equal(completed.image_url, RESULT_TWO);
  assert.deepEqual(fixture.deleted, [RESULT_ONE]);
});

test("current-image Edits can replace slot zero without changing slot one", /** Verify both retained slots are equally editable. */ async function (t) {
  const fixture = createRuntime(t, [RESULT_ONE, RESULT_TWO]);
  fixture.runtime.createTask(originalInput("direct-slot-zero-parent"));
  const parent = await fixture.runtime.startTask("direct-slot-zero-parent", "request-1");
  fixture.runtime.selectTaskVersion(parent.id, 0);

  const child = fixture.runtime.createTask(Object.assign({}, originalInput("direct-slot-zero-child"), {
    reference_mode: "current",
    parent_task_id: parent.id,
    prompt: "change only the background"
  })).task;
  const completed = await fixture.runtime.startTask(child.id, "request-2");

  assert.deepEqual(fixture.calls[1].input.image_urls, [ORIGINAL]);
  assert.deepEqual(completed.image_versions, [RESULT_TWO, RESULT_ONE]);
  assert.equal(completed.active_image_version, 0);
  assert.equal(completed.image_url, RESULT_TWO);
});

test("failed current-image Edits preserves the previous visible versions", /** Verify failed edits do not replace the retained preview. */ async function (t) {
  const fixture = createRuntime(t, [RESULT_ONE, Object.assign(new Error("provider failed"), { code: "PROVIDER_FAILED" })]);
  fixture.runtime.createTask(originalInput("direct-parent-failed"));
  await fixture.runtime.startTask("direct-parent-failed", "request-1");
  const child = fixture.runtime.createTask(Object.assign({}, originalInput("direct-child-failed"), {
    reference_mode: "current",
    parent_task_id: "direct-parent-failed"
  })).task;

  const failed = await fixture.runtime.startTask(child.id, "request-2");
  assert.equal(failed.status, "failed");
  assert.equal(failed.image_url, RESULT_ONE);
  assert.equal(failed.image_ready, true);
  assert.deepEqual(failed.image_versions, [ORIGINAL, RESULT_ONE]);
});

test("direct cleanup preserves the original and obeys active-version scope", /** Verify confirm and abandon cleanup boundaries. */ async function (t) {
  const fixture = createRuntime(t, [RESULT_ONE, RESULT_TWO]);
  fixture.runtime.createTask(originalInput("direct-cleanup"));
  const task = await fixture.runtime.startTask("direct-cleanup", "request-1");
  fixture.runtime.selectTaskVersion(task.id, 0);
  fixture.runtime.deleteTask(task.id, "alternates");
  assert.deepEqual(fixture.deleted, [RESULT_ONE]);

  fixture.runtime.createTask(originalInput("direct-cleanup-all"));
  await fixture.runtime.startTask("direct-cleanup-all", "request-2");
  fixture.runtime.deleteTask("direct-cleanup-all", "all");
  assert.deepEqual(fixture.deleted, [RESULT_ONE, RESULT_TWO]);
});

test("current direct-edit schemas and UI expose version selection without touching SKU rows", /** Verify request and UI wiring statically. */ function () {
  const parsed = schemaModule.directImageTaskSchema.parse(Object.assign({}, originalInput("direct-schema"), {
    reference_mode: "current",
    parent_task_id: "direct-parent"
  }));
  assert.equal(parsed.reference_mode, "current");
  assert.equal(schemaModule.directImageVersionSelectSchema.parse({ version_index: 1 }).version_index, 1);

  const appSource = fs.readFileSync(path.join(__dirname, "..", "..", "web", "app.js"), "utf8");
  assert.match(appSource, /directImageVersions\(\)\.length > 1/);
  assert.match(appSource, /基于当前图编辑/);
  assert.match(appSource, /parent_task_id: directTask\.parent_task_id/);
  assert.match(appSource, /imageEditorGeneratedUrl \|\| this\.imageDirectTask \|\| this\.imageCarouselTask/);
  assert.match(appSource, /shouldForceReset && this\.imageDirectTask/);
  assert.match(appSource, /imageDirectTaskCheckPending \|\| this\.activeDirectImageTaskForRecord/);
  assert.match(appSource, /\[DIRECT_IMAGE_TASK_ACTIVE\] 该商品已有单图编辑任务正在进行/);
  assert.match(appSource, /return "已有任务进行中"/);
  assert.doesNotMatch(appSource, /source_type: "sku"[^\n]+parent_task_id/);
});

test("one product cannot create a second active direct Edits task", /** Verify backend uniqueness before a second provider submission. */ async function (t) {
  const pending = deferred();
  let providerCalls = 0;
  const runtime = new DirectImageRuntimeService({
    cacheDirectory: tempDirectory(t),
    images: {
      /** Treat fixture image URLs as local. */
      isLocalImageUrl: function isLocalImageUrl() { return true; },
      /** Report fixture image URLs as written. */
      localUrlExists: function localUrlExists() { return true; }
    },
    providers: {
      /** Hold the first provider operation so the second request overlaps it. */
      editImages: function editImages() { providerCalls += 1; return pending.promise; },
      /** Accept runtime cancellation checks. */
      cancelImageTasks: function cancelImageTasks() {}
    }
  });

  runtime.createAndStartTask(originalInput("direct-active-one"), "request-1");
  assert.equal(runtime.readTask("direct-active-one").status, "generating");
  assert.throws(/** Reject a different task ID for the same active product. */ function createDuplicate() {
    runtime.createAndStartTask(originalInput("direct-active-two"), "request-2");
  }, { code: "DIRECT_IMAGE_TASK_ACTIVE", statusCode: 409 });
  assert.equal(providerCalls, 1);
  assert.equal(runtime.readTask("direct-active-two"), null);

  runtime.deleteTask("direct-active-one", "all");
  pending.resolve({ image_url: RESULT_ONE, undo_token: "" });
});
