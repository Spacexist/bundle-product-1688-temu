const defineConfig = require("@playwright/test").defineConfig;

/** Configure the key local workbench browser flow. */
function createPlaywrightConfiguration() {
  return {
    testDir: "./tests/e2e",
    timeout: 30000,
    use: {
      baseURL: "http://127.0.0.1:5173",
      headless: true,
      channel: "chrome"
    }
  };
}

module.exports = defineConfig(createPlaywrightConfiguration());
