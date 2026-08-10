const request = require("supertest");
const fs = require("fs");
const os = require("os");
const path = require("path");
const createApp = require("../app").createApp;
const readCachedImageSource = require("../legacy-api").readCachedImageSource;

describe("Express API", function describeExpressApi() {
  it("returns the v1 health envelope", async function healthEnvelopeTest() {
    const response = await request(createApp()).get("/api/v1/health");
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.data.service).toBe("temu-1688-api");
  });

  it("returns a ready-to-render workbench ViewModel", async function workbenchViewModelTest() {
    const response = await request(createApp()).get("/api/v1/workbench");
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(Array.isArray(response.body.data.records)).toBe(true);
  });

  /** Verify that frontend requests, backend responses, broadcasts and proxy calls have distinct flow labels. */
  it("separates server log transport flows", async function serverLogFlowTest() {
    const app = createApp();
    const legacyApi = require("../legacy-api");
    const eventModule = require("../events/event-hub");
    legacyApi.writeServerLog("RECEIVE", "test frontend request", { method: "GET" }, "test-front-flow");
    legacyApi.writeServerLog("SEND", "test backend response", { status: 200 }, "test-response-flow");
    legacyApi.writeServerLog("OUTBOUND", "test upstream request", { url: "https://upstream.test" }, "test-proxy-flow");
    const eventHub = new eventModule.EventHub({ writeLog: legacyApi.writeServerLog });
    eventHub.publish({ resource: "test", action: "refresh", ids: [] }, "test-broadcast-flow");
    const logsResponse = await request(app).get("/api/v1/logs");
    const logs = logsResponse.body.logs || [];
    /** Find one log entry by its synthetic test request identifier. */
    const findLog = function findLog(requestId) {
      for (let index = 0; index < logs.length; index += 1) {
        if (logs[index].request_id === requestId) {
          return logs[index];
        }
      }
      return null;
    };
    expect(findLog("test-front-flow").flow).toBe("frontend_request");
    expect(findLog("test-response-flow").flow).toBe("backend_response");
    expect(findLog("test-proxy-flow").flow).toBe("backend_proxy");
    expect(findLog("test-broadcast-flow").flow).toBe("backend_broadcast");
  });

  it("exposes both restore API path conventions", async function restoreRouteCompatibilityTest() {
    const canonical = await request(createApp()).post("/api/v1/restore").send({});
    const compatible = await request(createApp()).post("/v1/api/restore").send({});
    expect(canonical.status).toBe(400);
    expect(compatible.status).toBe(400);
  });

  /** Verify that unsupported methods fall through instead of leaving HTTP requests pending. */
  it("returns 404 for unsupported provider methods", async function providerMethodFallbackTest() {
    const response = await request(createApp()).post("/api/v1/images/details").send({});
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  /** Verify that workflow APIs can consume their own public image-cache URLs safely. */
  it("reads local cache image URLs without allowing path traversal", function localCacheImageTest() {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "temu-image-cache-"));
    const nestedDirectory = path.join(temporaryRoot, "temu", "main");
    const imagePath = path.join(nestedDirectory, "sample.jpg");
    fs.mkdirSync(nestedDirectory, { recursive: true });
    fs.writeFileSync(imagePath, Buffer.from([255, 216, 255, 217]));

    const relativeSource = readCachedImageSource("/api/v1/cache/image/temu/main/sample.jpg", temporaryRoot);
    const localUrlSource = readCachedImageSource("http://127.0.0.1:3000/api/v1/cache/image/temu/main/sample.jpg", temporaryRoot);
    const traversalSource = readCachedImageSource("/api/v1/cache/image/../../server/config.json", temporaryRoot);

    expect(relativeSource.mimeType).toBe("image/jpeg");
    expect(localUrlSource.buffer.length).toBe(4);
    expect(traversalSource).toBe(null);
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });
});
