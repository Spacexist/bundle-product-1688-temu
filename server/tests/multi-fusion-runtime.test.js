const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");

const { MultiFusionRuntimeService } = require("../services/multi-fusion-runtime.service");

/** Create one isolated runtime directory and remove it after the test. */
function createRuntimeDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "multi-fusion-runtime-"));
  t.after(/** Remove the isolated multi-fusion runtime files after assertions. */ function cleanupRuntimeDirectory() {
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

test("multi-fusion submits all selected source images and persists provider state", /** Exercise the new N-image runtime without calling the real provider. */ async function (t) {
  const directory = createRuntimeDirectory(t);
  const providerCalls = [];
  const runtime = new MultiFusionRuntimeService({
    cacheDirectory: directory,
    images: { localUrlExists: /** Treat retained generated images as locally available. */ function localUrlExists() { return true; } },
    providers: {
      editImages: /** Capture multi-fusion provider metadata and return a generated local URL. */ async function editImages(input, mode) {
        providerCalls.push({ input: input, mode: mode });
        input.on_provider_state({ provider_task_id: "provider-" + providerCalls.length, provider_status: "running" });
        return { image_url: "/api/v1/cache/image/transfer/generated/" + providerCalls.length + ".png" };
      },
      cancelImageTasks: /** Keep deletion compatible with the shared provider interface. */ function cancelImageTasks() { return 0; }
    }
  });
  const created = runtime.createTask({
    temu_main_id: "main-a",
    temu_platform_id: "platform-a",
    image_urls: ["img-a", "img-b", "img-c"],
    source_indices: [0, 1, 2],
    gallery_snapshot: ["img-a", "img-b", "img-c"],
    count: 2,
    prompt: "把三张图自然融合",
    size: "1024x1024"
  });
  await runtime.generatePage(created.task.id, 0, "request-a");
  const task = runtime.readTask(created.task.id);
  assert.equal(providerCalls.length, 1);
  assert.equal(providerCalls[0].mode, "fusion");
  assert.equal(providerCalls[0].input.task_scope, "multi-fusion");
  assert.deepEqual(providerCalls[0].input.image_urls, ["img-a", "img-b", "img-c"]);
  assert.equal(task.type, "multi-fusion");
  assert.equal(task.pages[0].provider_task_id, "provider-1");
  assert.equal(task.pages[0].status, "succeeded");
  assert.equal(task.pages[1].status, "pending");
});

test("multi-fusion blocks a second active task for the same product", /** Enforce the one-active-parent rule independently from carousel tasks. */ function (t) {
  const directory = createRuntimeDirectory(t);
  const runtime = new MultiFusionRuntimeService({
    cacheDirectory: directory,
    images: {},
    providers: { editImages: async function editImages() { return { image_url: "unused" }; } }
  });
  runtime.createTask({
    temu_main_id: "main-a",
    image_urls: ["img-a", "img-b", "img-c"],
    source_indices: [0, 1, 2],
    gallery_snapshot: [],
    count: 1,
    prompt: "第一次"
  });
  assert.throws(/** Submit a different active source set for the same product. */ function createConflictingTask() {
    runtime.createTask({
      temu_main_id: "main-a",
      image_urls: ["img-a", "img-b", "img-d"],
      source_indices: [0, 1, 3],
      gallery_snapshot: [],
      count: 1,
      prompt: "第二次"
    });
  }, /已有未完成多图融合任务/);
});
