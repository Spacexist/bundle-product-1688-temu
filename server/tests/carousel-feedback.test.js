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
  assert.equal(fixture.requests[1].body.reference_mode, "current");
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
  const { view, requests, timers } = frontendFixture(/** Save current page text before accepting every requested page as a fresh execution. */ async function transport(request) {
    return responseFixture(request.method === "PATCH" ? original : runningTask(original, request.body.page_indices));
  });
  view.imageCarouselTask.pages[1].prompt = "edited prompt without removed copy";
  const pending = view.regenerateAllCarouselPages();
  assert.match(view.carouselRunFeedbackText(), /完成 0\/3/);
  assert.equal(view.carouselPageFeedback().title, "正在提交…");
  await view.regenerateAllCarouselPages();
  assert.equal(requests.length, 1);
  await pending;
  assert.equal(requests.length, 2);
  assert.equal(requests[0].method, "PATCH");
  assert.equal(requests[0].body.pages[1].prompt, "edited prompt without removed copy");
  assert.equal(requests[1].body.reference_mode, "original");
  assert.equal(view.imageCarouselTask.pages[1].prompt, "edited prompt without removed copy");
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

test("polling preserves deleted prompt text on another editable page", /** Do not flash stale server text back while a sibling page is generating. */ function () {
  const { view } = frontendFixture();
  const running = runningTask(view.imageCarouselTask, [0]);
  view.applyCarouselTaskSnapshot(running);
  view.imageCarouselPageIndex = 1;
  view.currentCarouselPage().purpose = "";
  view.currentCarouselPage().prompt = "";
  const polled = structuredClone(running);
  polled.pages[0].provider_status = "running";
  polled.pages[1].purpose = "stale purpose";
  polled.pages[1].prompt = "stale prompt";
  view.applyCarouselTaskSnapshot(polled);
  assert.equal(view.imageCarouselTask.pages[0].provider_status, "running");
  assert.equal(view.currentCarouselPage().purpose, "");
  assert.equal(view.currentCarouselPage().prompt, "");
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
  assert.match(options.template, /<span v-if="!carouselPageFeedback\(\)\.title \|\| carouselPageFeedback\(\)\.error">/);
  assert.doesNotMatch(options.template, /v-else class="carousel-result-placeholder"/);
  const footer = options.template.match(/<footer class="image-editor-actions" :class=[\s\S]*?<\/footer>/)[0];
  assert.doesNotMatch(footer, /@click="regenerateAllCarouselPages">全部重生<\/button>/);
  assert.doesNotMatch(footer, /@click="closeGalleryImageEditor">关闭<\/button>/);
  assert.match(footer, /@click="regenerateCurrentCarouselPage">\{\{ hasImageMaskStrokes\(\) \? '修改涂抹区域' : '基于当前图重生' \}\}<\/button>/);
  assert.match(footer, /!currentCarouselPage\(\)\.image_url/);
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
  assert.match(css, /\.image-editor-actions\.is-carousel-results > button \{[^}]*min-width: 104px/);
  assert.match(css, /\.carousel-feedback-leave-active \{ transition: opacity \.3s ease/);
  assert.match(options.template, /class="carousel-version-dots"/);
  assert.match(options.template, /@wheel="handleImageVersionWheel\(\$event, 'carousel'\)"/);
  assert.match(options.template, /@wheel="handleImageVersionWheel\(\$event, 'direct'\)"/);
  assert.match(css, /\.carousel-version-dots \{[^}]*top: 50%; left: -42px/);
  assert.match(css, /\.carousel-version-dots \{[^}]*flex-direction: column/);
  assert.match(css, /\.image-mask-controls \{[^}]*right: -54px/);
  assert.match(css, /\.image-mask-frame \{[^}]*display: inline-block/);
  assert.match(css, /\.image-mask-frame \.image-mask-layer \{[^}]*position: absolute/);
});

test("version dots select a retained image without starting generation", /** Exercise the persisted version-selection endpoint only. */ async function () {
  const fixture = frontendFixture(/** Return the selected older version from the fake backend. */ async function transport(request) {
    const task = structuredClone(fixture.view.imageCarouselTask);
    task.pages[0].active_image_version = request.body.version_index;
    task.pages[0].image_url = task.pages[0].image_versions[request.body.version_index];
    return responseFixture(task);
  });
  const page = fixture.view.imageCarouselTask.pages[0];
  page.image_versions = ["old-0", "new-0"];
  page.active_image_version = 1;
  page.image_url = "new-0";
  assert.deepEqual(fixture.view.carouselPageVersions(), ["old-0", "new-0"]);
  assert.equal(fixture.view.activeCarouselPageVersionIndex(), 1);
  await fixture.view.selectCarouselPageVersion(0);
  assert.equal(fixture.requests.length, 1);
  assert.match(fixture.requests[0].url, /\/pages\/0\/version$/);
  assert.deepEqual(fixture.requests[0].body, { version_index: 0 });
  assert.equal(fixture.view.currentCarouselPage().image_url, "old-0");
});

test("direct status prefers the active child task over a stale completed parent", /** Prevent the green star from appearing before the current edit finishes downloading. */ function () {
  const { view } = frontendFixture();
  const record = { main_id: "temu-direct" };
  view.imageEditorOpen = false;
  view.imageCarouselTask = null;
  view.imageDirectTasksByMainId[record.main_id] = {
    id: "parent", temu_main_id: record.main_id, status: "succeeded", image_url: "old-result", image_ready: true,
    created_at: "2026-09-04T01:00:00.000Z", updated_at: "2026-09-04T01:00:01.000Z"
  };
  view.imageDirectTask = {
    id: "child", temu_main_id: record.main_id, status: "generating", image_url: "old-result", image_ready: true
  };
  assert.equal(view.hasOpenableDirectImageTask(record), true);
  assert.equal(view.isDirectImageTaskComplete(record), false);

  Object.assign(view.imageDirectTask, { status: "succeeded", image_url: "new-result", image_ready: true });
  assert.equal(view.isDirectImageTaskComplete(record), true);
});

test("vertical wheel switches both carousel and direct image slots", /** Keep wheel navigation bounded to the two retained versions. */ function () {
  const { view } = frontendFixture();
  let prevented = 0;
  const event = { deltaY: 80, cancelable: true, /** Record image-area scroll capture. */ preventDefault() { prevented += 1; } };
  Object.assign(view.imageCarouselTask.pages[0], { image_versions: ["old", "new"], active_image_version: 0, image_url: "old" });
  view.imageCarouselPageIndex = 0;
  view.selectCarouselPageVersion = /** Capture the wheel-selected carousel slot. */ function selectCarousel(index) { this.wheelCarouselIndex = index; };
  view.handleImageVersionWheel(event, "carousel");
  assert.equal(view.wheelCarouselIndex, 1);

  view.imageCarouselTask = null;
  view.imageEditorBusy = false;
  view.imageDirectTask = { id: "direct", image_versions: ["old", "new"], active_image_version: 1, image_url: "new" };
  view.selectDirectImageVersion = /** Capture the wheel-selected direct slot. */ function selectDirect(index) { this.wheelDirectIndex = index; };
  view.handleImageVersionWheel(Object.assign({}, event, { deltaY: -80 }), "direct");
  assert.equal(view.wheelDirectIndex, 0);
  assert.equal(prevented, 2);
});

test("a never-successful failed page retries from the original pair", /** Keep the failure retry distinct from current-image editing. */ async function () {
  const original = taskFixture();
  original.pages[0].status = "failed";
  original.pages[0].image_url = "";
  const fixture = frontendFixture(/** Echo save then accept one original-source retry. */ async function transport(request) {
    return responseFixture(request.method === "PATCH" ? original : runningTask(original, request.body.page_indices));
  });
  fixture.view.imageCarouselTask = original;
  await fixture.view.retryCarouselPage(0);
  assert.equal(fixture.requests[1].body.reference_mode, "original");
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




