const fs = require("fs");
const os = require("os");
const path = require("path");
const createWorkflowService = require("../workflow-service").createWorkflowService;

/** Return one complete four-direction provider response for workflow tests. */
function createPromptProviderPayload() {
  const products = [];
  for (let index = 0; index < 4; index += 1) {
    products.push({
      product_intro: "商品简介" + (index + 1),
      image_prompt: "white background product " + (index + 1)
    });
  }
  return {
    choices: [{ message: { content: JSON.stringify({ products: products }) } }]
  };
}

/** Ignore workflow logs during isolated service tests. */
function ignoreWorkflowLog() {}

describe("WorkflowService", function describeWorkflowService() {
  /** Verify the local-image prompt flow without sending user data to an external provider. */
  it("creates four prompts from a locally read image", async function localPromptFlowTest() {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "temu-workflow-"));
    const originalFetch = global.fetch;

    /** Return a deterministic Kimi-compatible response without network access. */
    async function fakePromptFetch() {
      return new Response(JSON.stringify(createPromptProviderPayload()), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    /** Return the non-secret workflow configuration used by this test. */
    function readWorkflowConfig() {
      return {
        kimi: {
          apikey: "test-key",
          model: "test-model",
          workflow_system_prompt: "system",
          workflow_prompt: "task"
        }
      };
    }

    /** Return a small image source representing a local cache file. */
    async function readLocalImage() {
      return { buffer: Buffer.from([255, 216, 255, 217]), mimeType: "image/jpeg" };
    }

    /** Return the fake Kimi endpoint intercepted by the test fetch implementation. */
    function getKimiTestEndpoint() {
      return "https://kimi.test/chat/completions";
    }

    /** Keep the test product payload unchanged. */
    function compactTestValue(value) {
      return value;
    }

    /** Format a stable workflow timestamp for test persistence. */
    function formatTestTime() {
      return "2026-08-10 00:00:00";
    }

    global.fetch = fakePromptFetch;
    try {
      const service = createWorkflowService({
        cacheDirectory: temporaryRoot,
        readConfig: readWorkflowConfig,
        getKimiEndpoint: getKimiTestEndpoint,
        compactValue: compactTestValue,
        readImageSource: readLocalImage,
        writeLog: ignoreWorkflowLog,
        formatTime: formatTestTime
      });
      const result = await service.generatePrompts({
        temu_main_id: "1",
        image_url: "/api/v1/cache/image/temu/main/sample.jpg",
        product: { title: "测试商品" }
      }, "test-request");
      expect(result.ok).toBe(true);
      expect(result.task.prompts.length).toBe(4);
      expect(result.task.prompts[0].product_intro).toBe("商品简介1");
      expect(result.task.prompts[0].prompt).toBe("white background product 1");
    } finally {
      global.fetch = originalFetch;
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  /** Verify that generated provider URLs are cached before they enter the search workflow. */
  it("stores generated images through the cache dependency", async function generatedImageCacheTest() {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "temu-workflow-"));
    const originalFetch = global.fetch;
    let cachedSource = "";

    /** Return one deterministic image-generation provider response. */
    async function fakeGenerationFetch() {
      return new Response(JSON.stringify({ data: [{ url: "https://images.test/generated.png" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    /** Record the provider URL and return its stable local cache URL. */
    async function cacheGeneratedImage(source) {
      cachedSource = source;
      return "/api/v1/cache/image/transfer/generated/sample.png";
    }

    global.fetch = fakeGenerationFetch;
    try {
      const service = createWorkflowService({
        cacheDirectory: temporaryRoot,
        cacheGeneratedImage: cacheGeneratedImage,
        writeLog: ignoreWorkflowLog
      });
      const imageUrl = await service.generateOneImage({
        baseurl: "https://beeapi.test",
        generation_endpoint: "/v1/images/generations",
        apikey: "test-key",
        model: "test-model"
      }, "test prompt", "test-request");
      expect(cachedSource).toBe("https://images.test/generated.png");
      expect(imageUrl).toBe("/api/v1/cache/image/transfer/generated/sample.png");
    } finally {
      global.fetch = originalFetch;
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });
});
