const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { CarouselRuntimeService } = require("../services/carousel-runtime.service");
const schemas = require("../schemas/api.schemas");

/** Create and safely remove one isolated carousel runtime directory. */
function tempDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "carousel-current-edit-"));
  t.after(/** Remove only the test-owned temporary directory. */ function cleanup() {
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

/** Build local-image and provider fakes that capture edit inputs without network access. */
function runtimeFixture(t) {
  const existing = new Set(["local-old"]);
  const deleted = [];
  const calls = [];
  const images = {
    /** Report whether a retained fixture image still exists. */
    localUrlExists(url) { return existing.has(url); },
    /** Record cleanup after the runtime releases a retained version. */
    deleteUnreferencedGeneratedImage(url) { deleted.push(url); existing.delete(url); return true; }
  };
  const providers = {
    /** Return a fresh local result while capturing source count, mode and prompt. */
    async editImages(input, mode) {
      const imageUrl = "local-new-" + (calls.length + 1);
      calls.push({ input: input, mode: mode, imageUrl: imageUrl });
      existing.add(imageUrl);
      return { image_url: imageUrl };
    }
  };
  const runtime = new CarouselRuntimeService({ cacheDirectory: tempDirectory(t), images: images, providers: providers });
  const task = runtime.createManualTask({ temu_main_id: "1", source_indices: [0, 1], gallery_snapshot: ["source-a", "source-b"], image_urls: ["source-a", "source-b"], pages: [{ prompt: "保持当前场景并优化光线" }] });
  task.status = "generated";
  Object.assign(task.pages[0], { status: "succeeded", image_url: "local-old", image_versions: ["local-old"], active_image_version: 0 });
  runtime.writeTask(task);
  return { runtime: runtime, task: task, calls: calls, deleted: deleted, existing: existing, images: images };
}

test("current-image regeneration uses one-image Edit and replaces the selected slot", /** Verify current-only transport and two-slot replacement. */ async function (t) {
  const fixture = runtimeFixture(t);
  const first = await fixture.runtime.generatePage(fixture.task.id, 0, "request-1", "current");
  assert.equal(fixture.calls[0].mode, "edit");
  assert.deepEqual(fixture.calls[0].input.image_urls, ["local-old"]);
  assert.match(fixture.calls[0].input.prompt, /^以唯一输入图片为基础进行编辑/);
  assert.match(fixture.calls[0].input.prompt, /保持当前场景并优化光线$/);
  assert.deepEqual(first.pages[0].image_versions, ["local-old", "local-new-1"]);
  assert.equal(first.pages[0].active_image_version, 1);
  assert.equal(first.pages[0].image_url, "local-new-1");

  fixture.runtime.selectTaskPageVersion(fixture.task.id, 0, 0);
  const second = await fixture.runtime.generatePage(fixture.task.id, 0, "request-2", "current");
  assert.deepEqual(fixture.calls[1].input.image_urls, ["local-old"]);
  assert.deepEqual(second.pages[0].image_versions, ["local-new-2", "local-new-1"]);
  assert.equal(second.pages[0].active_image_version, 0);
  assert.equal(second.pages[0].image_url, "local-new-2");
  assert.deepEqual(fixture.deleted, ["local-old"]);

  fixture.runtime.selectTaskPageVersion(fixture.task.id, 0, 1);
  const third = await fixture.runtime.generatePage(fixture.task.id, 0, "request-3", "current");
  assert.deepEqual(fixture.calls[2].input.image_urls, ["local-new-1"]);
  assert.deepEqual(third.pages[0].image_versions, ["local-new-2", "local-new-3"]);
  assert.equal(third.pages[0].active_image_version, 1);
  assert.equal(third.pages[0].image_url, "local-new-3");
  assert.deepEqual(fixture.deleted, ["local-old", "local-new-1"]);
});

test("original regeneration remains a two-image Fusion request", /** Protect batch and first-generation behavior from current-image routing. */ async function (t) {
  const fixture = runtimeFixture(t);
  const result = await fixture.runtime.generatePage(fixture.task.id, 0, "request-original", "original");
  assert.equal(fixture.calls[0].mode, "fusion");
  assert.deepEqual(fixture.calls[0].input.image_urls, ["source-a", "source-b"]);
  assert.deepEqual(result.pages[0].image_versions, ["local-old", "local-new-1"]);
});

test("current mode rejects absent or missing local images before provider submission", /** Never silently fall back from current editing to original Fusion. */ function (t) {
  const fixture = runtimeFixture(t);
  const task = fixture.runtime.readTask(fixture.task.id);
  task.pages[0].image_url = "";
  task.pages[0].image_versions = [];
  fixture.runtime.writeTask(task);
  assert.throws(/** Reject a page with no successful result. */ function absent() {
    fixture.runtime.startGeneration(task.id, [0], "request", "current");
  }, { code: "CAROUSEL_CURRENT_IMAGE_REQUIRED" });
  task.pages[0].image_url = "local-missing";
  fixture.runtime.writeTask(task);
  assert.throws(/** Reject a persisted URL whose cache file disappeared. */ function missing() {
    fixture.runtime.startGeneration(task.id, [0], "request", "current");
  }, { code: "CAROUSEL_CURRENT_IMAGE_MISSING" });
  assert.equal(fixture.calls.length, 0);
});

test("version switching survives reload and creates no generation identity", /** Persist only image selection while retaining execution ownership fields. */ function (t) {
  const fixture = runtimeFixture(t);
  const task = fixture.runtime.readTask(fixture.task.id);
  fixture.existing.add("local-new-existing");
  Object.assign(task.pages[0], {
    image_versions: ["local-old", "local-new-existing"], active_image_version: 1,
    image_url: "local-new-existing", generation_id: "generation-kept", provider_task_id: "provider-kept"
  });
  fixture.runtime.writeTask(task);
  const switched = fixture.runtime.selectTaskPageVersion(task.id, 0, 0);
  assert.equal(switched.pages[0].image_url, "local-old");
  assert.equal(switched.pages[0].generation_id, "generation-kept");
  assert.equal(switched.pages[0].provider_task_id, "provider-kept");
  const reloaded = new CarouselRuntimeService({ cacheDirectory: path.dirname(path.dirname(fixture.runtime.runtimeDirectory)), images: fixture.images });
  assert.equal(reloaded.readTask(task.id).pages[0].active_image_version, 0);
  assert.equal(fixture.calls.length, 0);
});

test("confirmation drops only the alternate while abandonment drops both retained versions", /** Exercise the two distinct cleanup policies after runtime deletion. */ function (t) {
  const confirmed = runtimeFixture(t);
  confirmed.existing.add("local-new-confirmed");
  const confirmedTask = confirmed.runtime.readTask(confirmed.task.id);
  Object.assign(confirmedTask.pages[0], { image_versions: ["local-old", "local-new-confirmed"], active_image_version: 1, image_url: "local-new-confirmed" });
  confirmed.runtime.writeTask(confirmedTask);
  const deletedTask = confirmed.runtime.deleteTask(confirmedTask.id, false);
  confirmed.runtime.deleteRetainedAlternates(deletedTask);
  assert.deepEqual(confirmed.deleted, ["local-old"]);

  const abandoned = runtimeFixture(t);
  abandoned.existing.add("local-new-abandoned");
  const abandonedTask = abandoned.runtime.readTask(abandoned.task.id);
  Object.assign(abandonedTask.pages[0], { image_versions: ["local-old", "local-new-abandoned"], active_image_version: 1, image_url: "local-new-abandoned" });
  abandoned.runtime.writeTask(abandonedTask);
  abandoned.runtime.deleteTask(abandonedTask.id, true);
  assert.deepEqual(abandoned.deleted, ["local-old", "local-new-abandoned"]);
});

test("request schemas distinguish current editing and version selection", /** Reject implicit or out-of-range version commands at the API boundary. */ function () {
  assert.equal(schemas.carouselGenerationSchema.parse({ page_indices: [0], reference_mode: "current" }).reference_mode, "current");
  assert.throws(/** Reject unknown generation source modes. */ function invalidMode() {
    schemas.carouselGenerationSchema.parse({ page_indices: [0], reference_mode: "latest-ish" });
  });
  assert.equal(schemas.carouselVersionSelectSchema.parse({ version_index: 1 }).version_index, 1);
  assert.throws(/** Reject a third retained version. */ function thirdVersion() {
    schemas.carouselVersionSelectSchema.parse({ version_index: 2 });
  });
});
