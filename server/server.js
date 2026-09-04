const appModule = require("./app");
const configModule = require("./config/config-loader");
const cloudAuthModule = require("./services/cloud-auth.service");

/** Allow legacy local HTTP clients to wait for 600s of polling plus bounded image downloads. */
const HTTP_REQUEST_TIMEOUT_MS = 660000;

/** Allow request headers to arrive slightly beyond the provider timeout boundary. */
const HTTP_HEADERS_TIMEOUT_MS = 665000;

/** Synchronize the authoritative cloud config before creating any config-dependent service. */
async function synchronizeStartupConfig() {
  const status = await cloudAuthModule.syncSavedCredential();
  if (!status || !status.authorized) {
    if (status && status.loginRequired === true) {
      console.warn("[cloud-auth] " + String(status.message || "请在工作台重新登录。"));
      return status;
    }
    throw new Error(status && status.message || "云端鉴权失败，后端未启动。");
  }
  return status;
}

/** Start the standalone Express API process on its configured local port. */
async function startServer() {
  await synchronizeStartupConfig();
  const config = configModule.readServerConfig();
  const app = appModule.createApp();
  /** Report both API and log addresses after the server starts. */
  function reportServerAddress() {
    console.log("Express API：http://" + config.server.host + ":" + config.server.port);
    console.log("Server logs：http://" + config.server.host + ":" + config.server.port + "/server/logs");
  }
  const server = app.listen(config.server.port, config.server.host, reportServerAddress);
  server.requestTimeout = HTTP_REQUEST_TIMEOUT_MS;
  server.timeout = HTTP_REQUEST_TIMEOUT_MS;
  server.headersTimeout = HTTP_HEADERS_TIMEOUT_MS;
}

startServer().catch(/** Refuse to serve with stale configuration after startup synchronization fails. */ function handleStartupFailure(error) {
  console.error("后端启动失败：" + String(error && error.message || error));
  process.exitCode = 1;
});
