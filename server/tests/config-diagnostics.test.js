const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const configModule = require("../config/config-loader");
const cloudAuthModule = require("../services/cloud-auth.service");
const { DiagnosticsController } = require("../controllers/diagnostics.controller");

const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

/** Build a minimal response recorder for controller-level diagnostics tests. */
function responseRecorder() {
  return {
    headers: {},
    body: null,
    /** Record one response header without opening a real HTTP listener. */
    setHeader(name, value) { this.headers[name] = value; },
    /** Capture the JSON body returned by the controller. */
    json(value) { this.body = value; return this; }
  };
}

test("full diagnostics config masks credentials without mutating safe values", /** Protect every nested credential-shaped field. */ function () {
  const source = {
    quality: "low",
    apikey: "sk-sensitive-value",
    nested: { password: "private-password", baidu_appid: "private-app-id", safe: "visible", entries: [{ token: "private-token" }] }
  };
  const redacted = configModule.createRedactedServerConfig(source);
  assert.equal(redacted.quality, "low");
  assert.equal(redacted.nested.safe, "visible");
  assert.notEqual(redacted.apikey, source.apikey);
  assert.notEqual(redacted.nested.password, source.nested.password);
  assert.notEqual(redacted.nested.baidu_appid, source.nested.baidu_appid);
  assert.notEqual(redacted.nested.entries[0].token, source.nested.entries[0].token);
  assert.equal(source.apikey, "sk-sensitive-value");
});

test("server config endpoint reports the same effective quality shown in its redacted JSON", /** Keep the diagnostic highlight tied to the runtime config reader. */ function (t) {
  const fixture = { quality: "low", model: "gpt-image-2", apikey: "secret", server: {}, storage: {}, workflow: { clip_translation: {} } };
  t.mock.method(configModule, "readServerConfig", /** Return a deterministic local config without touching disk. */ function readFixture() { return fixture; });
  t.mock.method(cloudAuthModule, "getConfigSyncStatus", /** Return one startup-only sync snapshot. */ function syncFixture() {
    return { authorized: true, configChannel: "current", configVersion: 7, configUpdatedAt: "cloud-time", lastSyncAt: "startup-time" };
  });
  const response = responseRecorder();
  new DiagnosticsController({ diagnostics: {} }).getServerConfig({ requestId: "test" }, response);
  assert.equal(response.headers["Cache-Control"], "no-store");
  assert.equal(response.body.data.effective.quality, "low");
  assert.equal(response.body.data.effective.model, "gpt-image-2");
  assert.equal(response.body.data.effective.config_version, 7);
  assert.equal(response.body.data.config.quality, "low");
  assert.notEqual(response.body.data.config.apikey, fixture.apikey);
});

test("service config UI remains inside server logs and never enters the user workbench", /** Enforce the requested diagnostics-only placement. */ function () {
  const logsPage = fs.readFileSync(path.join(PROJECT_ROOT, "server", "logs.html"), "utf8");
  const workbench = fs.readFileSync(path.join(PROJECT_ROOT, "web", "app.js"), "utf8");
  assert.match(logsPage, /id="serverConfigTab"/);
  assert.match(logsPage, /fetch\("\/api\/v1\/server-config"/);
  assert.doesNotMatch(workbench, /serverConfigTab|\/server-config/);
});

test("startup sync precedes app creation and worker always returns the authoritative config", /** Guard the same-version cloud replacement path. */ function () {
  const serverSource = fs.readFileSync(path.join(PROJECT_ROOT, "server", "server.js"), "utf8");
  const workerSource = fs.readFileSync(path.join(PROJECT_ROOT, "cloudflare", "src", "worker.js"), "utf8");
  assert.ok(serverSource.indexOf("await synchronizeStartupConfig()") < serverSource.indexOf("appModule.createApp()"));
  assert.match(workerSource, /configChanged:\s*true,\s*\n\s*config:\s*current\.config/);
  assert.match(workerSource, /version:\s*Math\.max\(0, Math\.floor\(Number\(current\.version\)/);
});

test("a copied DPAPI credential opens the login screen instead of crashing startup", /** Keep cross-user startup recoverable without changing normal authorization checks. */ function () {
  const serverSource = fs.readFileSync(path.join(PROJECT_ROOT, "server", "server.js"), "utf8");
  const authSource = fs.readFileSync(path.join(PROJECT_ROOT, "server", "services", "cloud-auth.service.js"), "utf8");
  assert.match(authSource, /error\.code\s*=\s*protect\s*\?\s*"DPAPI_PROTECT_FAILED"\s*:\s*"DPAPI_UNPROTECT_FAILED"/);
  assert.match(authSource, /credentialUnreadable:\s*true/);
  assert.match(authSource, /loginRequired:\s*true/);
  assert.match(serverSource, /status\.loginRequired\s*===\s*true/);
});

test("distribution packaging excludes machine-bound cloud credentials", /** Prevent a release ZIP from carrying another Windows user's DPAPI ciphertext. */ function () {
  const packagingSource = fs.readFileSync(path.join(PROJECT_ROOT, "create_distribution.py"), "utf8");
  const zipIgnoreSource = fs.readFileSync(path.join(PROJECT_ROOT, ".zipignore"), "utf8");
  assert.match(packagingSource, /runtime\/\*credential\*/);
  assert.match(packagingSource, /runtime\/cloud-config-state\.json/);
  assert.match(zipIgnoreSource, /runtime\/\*credential\*/);
  assert.match(zipIgnoreSource, /runtime\/cloud-config-state\.json/);
});
