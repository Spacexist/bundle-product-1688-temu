const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { compile } = require("@vue/compiler-dom");
const {
  DEFAULT_PROMPT_PATH,
  DEFAULT_STORYBOARD_SYSTEM_PROMPT,
  normalizeDefaultPromptConfig,
  readDefaultPromptConfig,
  writeDefaultPromptConfig
} = require("../controllers/config.controller");
const { CarouselRuntimeService } = require("../services/carousel-runtime.service");

/** Create and safely remove one isolated template-config fixture. */
function tempDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "default-prompt-test-"));
  t.after(/** Delete only this test-created fixture. */ function cleanupDefaultPromptFixture() {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("default-prompt-test-"));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

/** Return one valid named template payload for normalization tests. */
function templateConfig() {
  return {
    system_prompt: DEFAULT_STORYBOARD_SYSTEM_PROMPT,
    default_template_id: "template-a",
    templates: [
      { id: "template-a", name: "产品卖点", pages: [{ purpose: "卖点", prompt: "画面 A" }, { purpose: "细节", prompt: "画面 B" }] },
      { id: "template-b", name: "场景展示", pages: [{ purpose: "场景", prompt: "画面 C" }] }
    ]
  };
}

test("legacy page-only file migrates in place without losing its prompt", /** Verify the user's existing single template survives the upgrade. */ function (t) {
  const directory = tempDirectory(t);
  const file = path.join(directory, "default.prompt.json");
  fs.writeFileSync(file, JSON.stringify({ pages: [{ purpose: "旧分镜", prompt: "保留这条提示词" }] }), "utf8");
  const config = readDefaultPromptConfig(file, []);
  assert.equal(config.version, 2);
  assert.equal(config.default_template_id, "template-default");
  assert.equal(config.templates[0].name, "默认模板");
  assert.equal(config.templates[0].pages[0].prompt, "保留这条提示词");
  assert.equal(config.system_prompt, DEFAULT_STORYBOARD_SYSTEM_PROMPT);
  assert.match(config.system_prompt, /必须全部使用英文，不得出现中文或其他语言/);
  assert.match(config.system_prompt, /英文约束优先于分镜中的其他语言要求/);
  assert.match(config.system_prompt, /【负面提示词】禁止产品扭曲、拉伸变形、比例失真/);
  assert.match(config.system_prompt, /两件商品自然融入同一场景，保持各自结构独立/);
  assert.match(config.system_prompt, /避免生硬拼贴、明显接缝、抠图白边和不合理遮挡/);
  const persisted = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(persisted.pages, undefined);
  assert.equal(persisted.templates[0].pages[0].purpose, "旧分镜");
});

test("the shared template document lives under the external D drive data root", /** Keep templates outside replaceable application files. */ function () {
  assert.equal(path.normalize(DEFAULT_PROMPT_PATH), path.normalize("D:/自动组货/default.prompt.json"));
});

test("multi-template config preserves order, default selection and page order", /** Exercise the atomic persistence boundary in an isolated directory. */ function (t) {
  const directory = tempDirectory(t);
  const file = path.join(directory, "default.prompt.json");
  const saved = writeDefaultPromptConfig(templateConfig(), file);
  assert.equal(saved.default_template_id, "template-a");
  assert.deepEqual(saved.templates.map(/** List stable template IDs in order. */ function selectTemplateId(item) { return item.id; }), ["template-a", "template-b"]);
  assert.deepEqual(saved.templates[0].pages.map(/** List storyboard purposes in order. */ function selectPagePurpose(item) { return item.purpose; }), ["卖点", "细节"]);
  assert.deepEqual(readDefaultPromptConfig(file, []).templates, saved.templates);
  assert.deepEqual(fs.readdirSync(directory), ["default.prompt.json"]);
});

test("invalid names, prompts and defaults are rejected instead of silently repaired", /** Enforce the configuration rules agreed during grilling. */ function () {
  const duplicate = templateConfig();
  duplicate.templates[1].name = "产品卖点";
  assert.throws(/** Normalize duplicate names case-insensitively. */ function rejectDuplicateName() { normalizeDefaultPromptConfig(duplicate); }, { code: "DEFAULT_TEMPLATE_NAME_INVALID" });
  const blank = templateConfig();
  blank.templates[0].pages[1].prompt = "  ";
  assert.throws(/** Preserve row positions by rejecting blank prompts. */ function rejectBlankPrompt() { normalizeDefaultPromptConfig(blank); }, { code: "DEFAULT_PROMPT_EMPTY" });
  const missingDefault = templateConfig();
  missingDefault.default_template_id = "missing";
  assert.throws(/** Reject a dangling default template reference. */ function rejectMissingDefault() { normalizeDefaultPromptConfig(missingDefault); }, { code: "DEFAULT_TEMPLATE_NOT_FOUND" });
  const blankSystemPrompt = templateConfig();
  blankSystemPrompt.system_prompt = "  ";
  assert.equal(normalizeDefaultPromptConfig(blankSystemPrompt).system_prompt, DEFAULT_STORYBOARD_SYSTEM_PROMPT);
});

/** Load the actual Vue options without mounting, timers, or network requests. */
function frontendOptions(fetchImplementation) {
  let options;
  const context = {
    window: {},
    Vue: {
      /** Capture the root component and suppress all browser lifecycle work. */
      createApp(value) {
        options = value;
        return { /** Ignore global component registration. */ component() {}, /** Never mount the workbench. */ mount() {} };
      }
    },
    /** Route requests only through the test-supplied offline transport. */
    fetch: fetchImplementation || function rejectUnexpectedFetch() { throw new Error("unexpected fetch"); }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../../web/app.js"), "utf8"), context);
  return options;
}

/** Bind template methods onto a minimal reactive-looking view object. */
function templateEditorFixture(fetchImplementation) {
  const options = frontendOptions(fetchImplementation);
  const view = {
    defaultPromptTemplates: [], defaultPromptDefaultTemplateId: "", defaultPromptSelectedTemplateId: "",
    defaultPromptGenerationTemplateId: "",
    defaultPromptSystemPrompt: "",
    defaultPromptSavedConfig: "", defaultPromptPendingAction: null, defaultPromptConfigLoaded: false,
    defaultPromptDialogBusy: false, defaultPromptDialogLoading: false, defaultPromptDialogOpen: true,
    defaultPromptDialogError: "", defaultPromptSavedText: "", defaultPromptBackdropPressed: false,
    imageEditorBusy: false, imageCarouselTask: null,
    /** Ignore global toast rendering in this isolated editor fixture. */
    setStatus() {},
    /** Ignore browser persistence while retaining calls made by production methods. */
    persistViewState() {}
  };
  const methodNames = [
    "createDefaultPromptPageDraft", "createDefaultPromptTemplateDraft", "defaultPromptConfigSnapshot",
    "hasDefaultPromptUnsavedChanges", "applyDefaultPromptConfig", "currentDefaultPromptTemplate",
    "activeDefaultPromptTemplate", "collectDefaultPromptConfig", "uniqueDefaultPromptTemplateName",
    "addDefaultPromptTemplate", "duplicateDefaultPromptTemplate", "deleteDefaultPromptTemplate",
    "selectDefaultPromptGenerationTemplate", "scrollDefaultPromptTemplates", "addDefaultPromptPage", "duplicateDefaultPromptPage",
    "moveDefaultPromptPage", "removeDefaultPromptPage", "requestDefaultPromptAction",
    "requestSelectDefaultPromptTemplate", "performDefaultPromptAction", "resolveDefaultPromptPendingAction",
    "closeDefaultPromptDialog", "requestSaveDefaultPromptPages", "saveDefaultPromptPages",
    "defaultPromptButtonLabel", "resolveDefaultPromptGenerationPages"
  ];
  for (let index = 0; index < methodNames.length; index += 1) {
    view[methodNames[index]] = options.methods[methodNames[index]].bind(view);
  }
  view.applyDefaultPromptConfig(templateConfig());
  return { options, view };
}

test("template UI exposes configuration separately from one-click generation", /** Compile the real UI and verify its two distinct entry points. */ function () {
  const options = frontendOptions();
  assert.doesNotThrow(/** Compile all Vue expressions without calling MCP or mounting a browser. */ function compileTemplate() { compile(options.template); });
  assert.match(options.template, /@click="openDefaultPromptDialog">分镜模板<\/button>/);
  assert.match(options.template, /@click="generateDefaultPromptPages">\{\{ defaultPromptButtonLabel\(\) \}\}/);
  assert.match(options.template, /class="image-template-strip"/);
  assert.match(options.template, /<nav v-if="canUseDefaultPromptTemplatesDirect\(\)" class="image-template-strip"/);
  assert.doesNotMatch(options.template, /<nav v-if="isFusionPromptReviewSession\(\)" class="image-template-strip"/);
  assert.match(options.template, /@click="selectDefaultPromptGenerationTemplate\(template\.id\)"/);
  assert.doesNotMatch(options.template, /设为默认/);
  assert.doesNotMatch(options.template, /\? '默认' : '普通'/);
  assert.doesNotMatch(options.template, /v-model="defaultPromptSystemPrompt"/);
  assert.doesNotMatch(options.template, /全局系统提示词/);
  assert.doesNotMatch(options.template, /保存并生图/);
});

test("editor adds, copies, orders and deletes templates and pages", /** Exercise the confirmed template-management controls. */ function () {
  const { view } = templateEditorFixture();
  assert.equal(view.defaultPromptButtonLabel(), "模板生图 · 产品卖点（2张）");
  view.duplicateDefaultPromptPage(0);
  assert.deepEqual(Array.from(view.currentDefaultPromptTemplate().pages, /** Inspect copied page prompts. */ function selectPrompt(page) { return page.prompt; }), ["画面 A", "画面 A", "画面 B"]);
  view.moveDefaultPromptPage(2, -1);
  assert.deepEqual(Array.from(view.currentDefaultPromptTemplate().pages, /** Inspect reordered purposes. */ function selectPurpose(page) { return page.purpose; }), ["卖点", "细节", "卖点"]);
  view.duplicateDefaultPromptTemplate();
  assert.equal(view.defaultPromptTemplates.length, 3);
  assert.equal(view.currentDefaultPromptTemplate().name, "产品卖点 副本");
  view.deleteDefaultPromptTemplate();
  assert.equal(view.defaultPromptTemplates.length, 2);
  assert.ok(view.defaultPromptTemplates.some(/** Ensure deletion retains the existing default template. */ function retainsDefault(item) { return item.id === view.defaultPromptDefaultTemplateId; }));
});

test("generation template selection persists without changing the shared default", /** Keep local generation choice separate from configuration editing. */ function () {
  const { view } = templateEditorFixture();
  let persisted = 0;
  view.persistViewState = /** Count the local persistence boundary. */ function countPersistence() { persisted += 1; };
  assert.equal(view.selectDefaultPromptGenerationTemplate("template-b"), true);
  assert.equal(view.defaultPromptGenerationTemplateId, "template-b");
  assert.equal(view.defaultPromptDefaultTemplateId, "template-a");
  assert.equal(view.defaultPromptSelectedTemplateId, "template-a");
  assert.equal(view.defaultPromptButtonLabel(), "模板生图 · 场景展示（1张）");
  assert.equal(persisted, 1);
});

test("a removed browser selection falls back to the first available template", /** Avoid retaining a dangling paid-generation choice. */ function () {
  const { view } = templateEditorFixture();
  view.defaultPromptGenerationTemplateId = "removed-template";
  const config = templateConfig();
  config.default_template_id = "template-b";
  view.applyDefaultPromptConfig(config);
  assert.equal(view.defaultPromptGenerationTemplateId, "template-a");
});

test("switching a dirty template waits for save, discard or cancel", /** Verify no draft changes disappear during template switching. */ async function () {
  const { view } = templateEditorFixture();
  const firstId = view.defaultPromptSelectedTemplateId;
  const secondId = view.defaultPromptTemplates[1].id;
  view.currentDefaultPromptTemplate().pages[0].prompt = "未保存内容";
  view.requestSelectDefaultPromptTemplate(secondId);
  assert.equal(view.defaultPromptSelectedTemplateId, firstId);
  assert.equal(view.defaultPromptPendingAction.type, "select");
  await view.resolveDefaultPromptPendingAction("cancel");
  assert.equal(view.defaultPromptSelectedTemplateId, firstId);
  view.requestSelectDefaultPromptTemplate(secondId);
  await view.resolveDefaultPromptPendingAction("discard");
  assert.equal(view.defaultPromptSelectedTemplateId, secondId);
  assert.equal(view.defaultPromptTemplates[0].pages[0].prompt, "画面 A");
});

test("closing a dirty editor is immediate and restores the saved templates", /** Prevent an off-screen confirmation from trapping the modal. */ function () {
  const { view } = templateEditorFixture();
  view.defaultPromptDialogBusy = true;
  view.currentDefaultPromptTemplate().pages[0].prompt = "未保存内容";
  view.closeDefaultPromptDialog();
  assert.equal(view.defaultPromptDialogOpen, false);
  assert.equal(view.defaultPromptPendingAction, null);
  assert.equal(view.defaultPromptTemplates[0].pages[0].prompt, "画面 A");
});

test("saving templates submits the hidden system prompt and clears the busy state", /** Exercise the real save method through an offline PUT response. */ async function () {
  let savedBody = null;
  const { view } = templateEditorFixture(/** Echo a deterministic backend save without using the network. */ async function fakeSave(url, settings) {
    assert.match(String(url), /\/config\/default-prompts$/);
    assert.equal(settings.method, "PUT");
    savedBody = JSON.parse(settings.body);
    return { ok: true, /** Return the normalized config shape expected by the editor. */ async json() { return { ok: true, data: savedBody }; } };
  });
  view.currentDefaultPromptTemplate().pages[0].prompt = "保存后的内容";
  assert.equal(await view.saveDefaultPromptPages(), true);
  assert.equal(savedBody.system_prompt, DEFAULT_STORYBOARD_SYSTEM_PROMPT);
  assert.equal(savedBody.templates[0].pages[0].prompt, "保存后的内容");
  assert.equal(view.defaultPromptDialogBusy, false);
  assert.equal(view.defaultPromptDialogError, "");
  assert.equal(view.defaultPromptSavedText, "全部分镜模板已保存。");
  assert.equal(view.hasDefaultPromptUnsavedChanges(), false);
});

test("market language comes only from the existing image window field", /** Replace the supported placeholder without adding template-level settings. */ function () {
  const { view } = templateEditorFixture();
  view.imageCarouselMarketLanguage = "德国 / Deutsch";
  view.currentDefaultPromptTemplate().pages[0].prompt = "使用 {market_language}，不要修改产品";
  const pages = view.resolveDefaultPromptGenerationPages(view.currentDefaultPromptTemplate());
  assert.equal(pages[0].prompt, "使用 德国 / Deutsch，不要修改产品");
  assert.equal(Object.prototype.hasOwnProperty.call(view.currentDefaultPromptTemplate(), "market_language"), false);
});

test("one-click generation loads the browser-selected template and bypasses Kimi planning", /** Execute the actual frontend chain with an offline transport. */ async function () {
  const requests = [];
  const config = templateConfig();
  config.templates[0].pages[0].prompt = "面向 {market_language} 的主图";
  const options = frontendOptions(/** Return deterministic local responses without contacting any service. */ async function fakeFetch(url, settings) {
    requests.push({ url: String(url), settings: settings || {} });
    if (String(url).endsWith("/config/default-prompts")) {
      return { ok: true, /** Return the saved multi-template document. */ async json() { return { ok: true, data: config }; } };
    }
    if (String(url).endsWith("/workflow/carousel/manual")) {
      return { ok: true, /** Return one ready manual task without Kimi. */ async json() { return { ok: true, data: { task: { id: "manual-1", count: 2, status: "ready", pages: [] } } }; } };
    }
    throw new Error("unexpected URL " + url);
  });
  const view = {
    selectedTemuRecord: { main_id: "main-1", platform_id: "product-1" },
    galleryEditSelection: [0, 1], imageCarouselMarketLanguage: "法国 / Français", imageEditSize: "1024x1024",
    imageEditorBusy: false, imageCarouselTask: null, imageEditorRequestId: 9, imageEditorRestoreMainId: "",
    imageCarouselReviewOnly: true, imageCarouselEstimatedTokens: 0, imageEditorError: "", imageCarouselCount: 1,
    defaultPromptGenerationBusy: false, defaultPromptTemplates: [], defaultPromptDefaultTemplateId: "",
    defaultPromptGenerationTemplateId: "template-b",
    defaultPromptSelectedTemplateId: "", defaultPromptSavedConfig: "", defaultPromptConfigLoaded: false,
    /** Return exactly the two already-selected source images. */
    galleryImageEditorSources() { return ["source-a", "source-b"]; },
    /** Return the unchanged gallery snapshot. */
    galleryImages() { return ["source-a", "source-b", "source-c"]; },
    /** Avoid writing browser state in this fixture. */
    persistViewState() {},
    /** Keep the editor request current through both local responses. */
    isImageEditorRequestCurrent(requestId) { return requestId === 9; },
    /** Capture the manually created task. */
    applyCarouselTaskSnapshot(task) { this.imageCarouselTask = task; },
    /** Record that existing Fusion generation was started. */
    async generateCarouselPages() { this.fusionStarted = true; }
  };
  const methodNames = ["createDefaultPromptPageDraft", "createDefaultPromptTemplateDraft", "defaultPromptConfigSnapshot",
    "applyDefaultPromptConfig", "activeDefaultPromptTemplate", "requestDefaultPromptConfig",
    "resolveDefaultPromptGenerationPages", "generateDefaultPromptPages"];
  for (let index = 0; index < methodNames.length; index += 1) {
    view[methodNames[index]] = options.methods[methodNames[index]].bind(view);
  }
  await view.generateDefaultPromptPages();
  assert.equal(requests.length, 2);
  assert.match(requests[0].url, /\/config\/default-prompts$/);
  assert.match(requests[1].url, /\/workflow\/carousel\/manual$/);
  assert.equal(requests.some(/** Detect forbidden Kimi planning calls. */ function isPlanRequest(item) { return item.url.includes("/plan"); }), false);
  const body = JSON.parse(requests[1].settings.body);
  assert.equal(body.pages[0].prompt, "画面 C");
  assert.equal(body.market_language, "法国 / Français");
  assert.equal(view.fusionStarted, true);
});

test("manual template pages prepend the latest dedicated system prompt without changing saved pages", /** Exercise initial generation and regeneration offline. */ async function (t) {
  const directory = tempDirectory(t);
  let systemPrompt = "专用系统约束一";
  const submittedPrompts = [];
  const runtime = new CarouselRuntimeService({
    cacheDirectory: directory,
    /** Prove the old generic Fusion fallback is no longer reused. */
    readConfig() { return { image: { fusion_prompt: "旧 Fusion 提示词不得使用" } }; },
    /** Return mutable dedicated configuration to prove each generation reads it again. */
    readDefaultPromptConfig() { return { system_prompt: systemPrompt }; },
    providers: {
      /** Capture the final provider prompt without making a paid or network request. */
      async editImages(input, mode) {
        assert.equal(mode, "fusion");
        submittedPrompts.push(input.prompt);
        return { image_url: "generated-" + submittedPrompts.length };
      }
    },
    images: {
      /** Avoid deleting synthetic fixture URLs. */
      deleteUnreferencedGeneratedImage() {}
    }
  });
  const task = runtime.createManualTask({
    temu_main_id: "main-1", image_urls: ["source-a", "source-b"], source_indices: [0, 1],
    gallery_snapshot: ["source-a", "source-b"], pages: [{ purpose: "卖点", prompt: "当前分镜要求" }]
  });
  await runtime.generatePage(task.id, 0, "request-1");
  assert.equal(submittedPrompts[0], "【全局商品约束】\n专用系统约束一\n\n【当前分镜要求】\n当前分镜要求");
  assert.equal(runtime.readTask(task.id).pages[0].prompt, "当前分镜要求");
  systemPrompt = "专用系统约束二";
  await runtime.generatePage(task.id, 0, "request-2");
  assert.equal(submittedPrompts[1], "【全局商品约束】\n专用系统约束二\n\n【当前分镜要求】\n当前分镜要求");
});

test("non-manual carousel pages do not receive the dedicated prefix", /** Keep Kimi and freeform carousel behavior unchanged. */ function (t) {
  const directory = tempDirectory(t);
  const runtime = new CarouselRuntimeService({
    cacheDirectory: directory,
    /** Supply a dedicated prefix that must remain unused outside manual mode. */
    readDefaultPromptConfig() { return { system_prompt: "不得拼接" }; }
  });
  assert.equal(runtime.buildCarouselPagePrompt({ mode: "basic" }, { prompt: "自由分镜" }), "自由分镜");
  assert.equal(runtime.buildCarouselPagePrompt({ mode: "advanced" }, { prompt: "Kimi 分镜" }), "Kimi 分镜");
});
