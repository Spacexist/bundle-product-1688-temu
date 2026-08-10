const defineConfig = require("vitest/config").defineConfig;

/** Limit unit and integration discovery to backend tests. */
function createVitestConfiguration() {
  return {
    test: {
      include: ["server/tests/**/*.test.js"],
      testTimeout: 10000,
      globals: true
    }
  };
}

module.exports = defineConfig(createVitestConfiguration());
