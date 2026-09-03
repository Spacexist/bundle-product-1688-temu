const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { compile } = require("@vue/compiler-dom");

/** Build a completed task with old previews, matching the regeneration UI's starting state. */
function taskFixture(id = "task-a") {
  return { id: id, status: "generated", mode: "manual", pages: [0, 1, 2].map(/** Give each old image its own execution identity. */ function oldPage(index) {
    return { status: "succeeded", image_url: "old-" + index, prompt: "prompt-" + index, selected: true, generation_id: "old-generation-" + index };
  }) };
}

/** Capture the actual Vue methods without a DOM, browser, live service, or paid request. */
function frontendFixture(transport) {
  let options;
  let sequence = 0;
  const timers = new Map();
  const requests = [];
  const window = { location: { search: "" },
    /** Store timers for deterministic expiry assertions. */ setTimeout(callback, delay) { timers.set(++sequence, { callback: callback, delay: delay }); return sequence; },
    /** Record cancellation of stale success timers. */ clearTimeout(id) { timers.delete(id); },
    /** Ignore unrelated browser listener cleanup. */ removeEventListener() {},
    /** Ignore unrelated drag animation cleanup. */ cancelAnimationFrame() {}
  };
  const context = { window: window, URL: URL, URLSearchParams: URLSearchParams,
    document: { /** Ignore unrelated click cleanup. */ removeEventListener() {} },
    Vue: { /** Capture component options only. */ createApp(value) { options = value; return { /** Suppress registration. */ component() {}, /** Suppress all lifecycle work. */ mount() {} }; } },
    /** Only the test-supplied fake transport may handle HTTP-shaped requests. */ async fetch(url, settings) {
      const request = { url: url, method: settings.method, body: JSON.parse(settings.body) };
      requests.push(request);
      if (!transport) { throw new Error("Unexpected offline request"); }
      return transport(request);
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../../web/app.js"), "utf8"), context);
  const view = options.data();
  for (const [name, method] of Object.entries(options.methods)) { view[name] = method.bind(view); }
  view.imageEditorOpen = true;
  view.imageCarouselTask = taskFixture();
  view.galleryImageEditorSources = /** Supply source images without inspecting workbench data. */ function sources() { return ["source-a", "source-b"]; };
  view.rememberCarouselTask = /** Ignore persistence outside the tested UI state. */ function rememberTask() {};
  view.isIgnoredCarouselTask = /** Keep the fixture task active. */ function notIgnored() { return false; };
  view.scheduleCarouselTaskPoll = /** Count scheduled local polls without starting them. */ function schedulePoll() { this.polls = (this.polls || 0) + 1; };
  view.stopRealtimeCache = /** Do not access browser subscriptions. */ function stopRealtime() {};
  return { options: options, view: view, timers: timers, requests: requests };
}

/** Return one successful backend snapshot from the fake transport. */
function responseFixture(task) {
  return { ok: true, /** Return detached data like a real JSON response. */ async json() { return { ok: true, data: { task: structuredClone(task) } }; } };
}

/** Transition selected pages to a new accepted execution without touching their previous images. */
function runningTask(task, indices) {
  const running = structuredClone(task);
  running.status = "generating";
  for (const index of indices) { Object.assign(running.pages[index], { status: "generating", generation_id: "new-generation-" + index, provider_status: "queued" }); }
  return running;
}

test("single regenerate shows immediate submission, then queue/generation/download over the old preview", /** Exercise the real PATCH/POST path with no live requests. */ async function () {
  const original = taskFixture();
  let releaseSave;
  const fixture = frontendFixture(/** Delay saving the prompt to inspect immediate feedback. */ async function transport(request) {
    if (request.method === "PATCH") { await new Promise(/** Wait until the test releases saving. */ function holdSave(resolve) { releaseSave = resolve; }); return responseFixture(original); }
    return responseFixture(runningTask(original, request.body.page_indices));
  });
  const view = fixture.view;
  view.imageCarouselPageIndex = 1;
  view.imageEditorError = "上一次错误";
  const pending = view.regenerateCurrentCarouselPage();
  assert.equal(view.carouselPageFeedback().title, "正在提交…");
  assert.equal(view.imageEditorError, "");
  assert.equal(view.currentCarouselPage().image_url, "old-1");
  assert.match(view.carouselRunFeedbackText(), /完成 0\/1/);
  assert.equal(view.canApplyCarouselReplacement(true), false);
  await view.regenerateCurrentCarouselPage();
  assert.equal(fixture.requests.length, 1);
  releaseSave();
  await pending;
  assert.equal(fixture.requests.length, 2);
  assert.deepEqual(fixture.requests[1].body.page_indices, [1]);
  assert.equal(view.carouselPageFeedback().title, "排队中…");
  for (const [state, title] of [["submitting", "正在提交生图…"], ["running", "生成中…"], ["completed", "图片下载中…"]]) {
    view.currentCarouselPage().provider_status = state;
    assert.equal(view.carouselPageFeedback().title, title);
  }
  assert.match(view.carouselRunFeedbackText(), /完成 0\/1/);
  view.imageCarouselPageIndex = 0;
  assert.equal(view.carouselPageFeedback().title, "");
  assert.equal(view.isCarouselPageBusy(0), false);
  assert.equal(view.isCarouselPageBusy(1), true);
});

test("batch regeneration starts at zero and only counts fresh downloaded results", /** Old successful images and stale polling snapshots must never inflate this run. */ async function () {
  const original = taskFixture();
  const { view, requests, timers } = frontendFixture(/** Accept every requested page as a fresh execution. */ async function transport(request) { return responseFixture(runningTask(original, request.body.page_indices)); });
  const pending = view.regenerateAllCarouselPages();
  assert.match(view.carouselRunFeedbackText(), /完成 0\/3/);
  assert.equal(view.carouselPageFeedback().title, "正在提交…");
  await view.regenerateAllCarouselPages();
  assert.equal(requests.length, 1);
  await pending;
  view.updateCarouselFeedback(original);
  assert.match(view.carouselRunFeedbackText(), /完成 0\/3/);
  const snapshot = structuredClone(view.imageCarouselTask);
  snapshot.pages[0].status = "succeeded";
  snapshot.pages[0].image_url = "downloaded-new-0";
  view.applyCarouselTaskSnapshot(snapshot);
  assert.match(view.carouselRunFeedbackText(), /完成 1\/3.*成功 1/);
  assert.equal(timers.size, 0);
  snapshot.pages[1].status = "failed";
  snapshot.pages[1].error_code = "DOWNLOAD_FAILED";
  snapshot.pages[1].error = "三次下载失败";
  snapshot.pages[2].status = "succeeded";
  snapshot.status = "generated";
  view.applyCarouselTaskSnapshot(snapshot);
  assert.match(view.carouselRunFeedbackText(), /完成 3\/3.*成功 2.*失败 1/);
  view.imageCarouselPageIndex = 1;
  assert.match(view.carouselPageFeedback().error, /DOWNLOAD_FAILED.*三次下载失败/);
  assert.equal(view.currentCarouselPage().image_url, "old-1");
  assert.equal(timers.size, 0);
});

test("successful completion fades within two seconds and cannot clear a newer retry", /** Keep completion feedback scoped to the task/run that produced it. */ function () {
  const { view, timers } = frontendFixture();
  const original = structuredClone(view.imageCarouselTask);
  view.beginCarouselFeedback(original, [1]);
  const task = runningTask(original, [1]);
  view.updateCarouselFeedback(task, [1]);
  task.pages[1].status = "succeeded";
  task.status = "generated";
  view.applyCarouselTaskSnapshot(task);
  assert.match(view.carouselRunFeedbackText(), /完成 1\/1.*成功 1/);
  const timerId = view.imageCarouselFeedback[task.id].timer;
  const timer = timers.get(timerId);
  assert.equal(timer.delay, 1700);
  timer.callback();
  assert.equal(view.carouselRunFeedbackText(), "");
  view.beginCarouselFeedback(task, [0]);
  timer.callback();
  assert.match(view.carouselRunFeedbackText(), /完成 0\/1/);
  assert.equal(view.carouselPageFeedback().title, "正在提交…");
});

test("single save failure stays visible over old image and clears on retry", /** No generation is submitted when saving the prompt fails. */ async function () {
  const { view, requests, timers } = frontendFixture(/** Reject the prompt save without contacting a server. */ async function transport() { throw new Error("保存提示词失败"); });
  await view.regenerateCurrentCarouselPage();
  assert.equal(requests.length, 1);
  assert.match(view.carouselPageFeedback().error, /保存提示词失败/);
  assert.equal(view.currentCarouselPage().image_url, "old-0");
  assert.equal(view.isCarouselPageBusy(0), false);
  assert.equal(timers.size, 0);
  view.beginCarouselFeedback(view.imageCarouselTask, [0]);
  assert.equal(view.carouselPageFeedback().title, "正在提交…");
  assert.equal(view.carouselPageFeedback().error, "");
});

test("feedback remains task-scoped when switching products during a failed batch submission", /** A late old-task failure must not overwrite the new task's UI. */ async function () {
  let rejectRequest;
  const { view } = frontendFixture(/** Hold a batch submission until the selected task changes. */ function transport() { return new Promise(/** Capture rejection. */ function holdRequest(resolve, reject) { rejectRequest = reject; }); });
  const pending = view.regenerateAllCarouselPages();
  view.imageCarouselTask = taskFixture("task-b");
  view.imageEditorError = "task-b-message";
  rejectRequest(new Error("task-a-failed"));
  await pending;
  assert.equal(view.carouselRunFeedbackText(), "");
  assert.equal(view.carouselPageFeedback().title, "");
  assert.equal(view.imageEditorError, "task-b-message");
  assert.match(view.imageCarouselFeedback["task-a"].pages[0].error, /task-a-failed/);
});

test("reopened generating task shows provider stage without starting new generation", /** A retained task needs no local submission record to display progress. */ function () {
  const { view, requests } = frontendFixture();
  const task = runningTask(view.imageCarouselTask, [0, 1, 2]);
  task.pages[0].provider_status = "completed";
  view.applyCarouselTaskSnapshot(task);
  assert.equal(view.carouselPageFeedback().title, "图片下载中…");
  assert.match(view.carouselRunFeedbackText(), /^任务进度：完成 0\/3/);
  assert.equal(requests.length, 0);
});

test("button positions and labels stay stable from results to submission and running states", /** Compile Vue offline and verify visibility differs from action eligibility. */ function () {
  const { view, options } = frontendFixture();
  compile(options.template);
  assert.match(options.template, /v-if="!currentCarouselPage\(\)\.image_url" class="carousel-result-placeholder"/);
  assert.doesNotMatch(options.template, /v-else class="carousel-result-placeholder"/);
  const footer = options.template.match(/<footer class="image-editor-actions" :class=[\s\S]*?<\/footer>/)[0];
  assert.match(footer, /@click="regenerateAllCarouselPages">全部重生<\/button>/);
  assert.match(footer, /@click="regenerateCurrentCarouselPage">单独重生<\/button>/);
  assert.doesNotMatch(footer, /全部生成中|单张生成中/);
  assert.match(footer, /v-if="canRegenerateCarouselPages\(\) \|\| canApplyCarouselReplacement\(true\)"/);
  assert.match(footer, /:disabled="!canApplyCarouselReplacement\(true\)"/);
  assert.equal(view.canShowImageEditorConfirm(), true);
  view.beginCarouselFeedback(view.imageCarouselTask, [0]);
  assert.equal(view.canShowImageEditorConfirm(), true);
  assert.equal(view.canApplyCarouselReplacement(true), false);
  view.applyCarouselTaskSnapshot(runningTask(view.imageCarouselTask, [0]));
  assert.equal(view.canShowImageEditorConfirm(), true);
  assert.equal(view.canRegenerateCarouselPages(), true);
  const css = fs.readFileSync(path.join(__dirname, "../../web/styles.css"), "utf8");
  assert.match(css, /\.image-editor-actions\.is-carousel-results > button \{[^}]*width: 104px/);
  assert.match(css, /\.carousel-feedback-leave-active \{ transition: opacity \.3s ease/);
});

test("unmount cancels every completion timer", /** Prevent delayed state writes after destroying the component. */ function () {
  const { view, options, timers } = frontendFixture();
  view.beginCarouselFeedback(view.imageCarouselTask, [0]);
  const task = runningTask(view.imageCarouselTask, [0]);
  task.pages[0].status = "succeeded";
  view.updateCarouselFeedback(task, [0]);
  assert.equal(timers.size, 1);
  options.beforeUnmount.call(view);
  assert.equal(timers.size, 0);
});
