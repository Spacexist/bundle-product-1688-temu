const appModule = require("./app");
const configModule = require("./config/config-loader");

/** Allow legacy local HTTP clients to wait for 600s of polling plus bounded image downloads. */
const HTTP_REQUEST_TIMEOUT_MS = 660000;

/** Allow request headers to arrive slightly beyond the provider timeout boundary. */
const HTTP_HEADERS_TIMEOUT_MS = 665000;

/** Start the standalone Express API process on its configured local port. */
function startServer() {
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

startServer();
