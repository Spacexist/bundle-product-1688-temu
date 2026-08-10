const appModule = require("./app");
const configModule = require("./config/config-loader");

/** Start the standalone Express API process on its configured local port. */
function startServer() {
  const config = configModule.readServerConfig();
  const app = appModule.createApp();
  /** Report both API and log addresses after the server starts. */
  function reportServerAddress() {
    console.log("Express API：http://" + config.server.host + ":" + config.server.port);
    console.log("Server logs：http://" + config.server.host + ":" + config.server.port + "/server/logs");
  }
  app.listen(config.server.port, config.server.host, reportServerAddress);
}

startServer();
