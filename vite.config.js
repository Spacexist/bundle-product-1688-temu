const path = require("path");
const vue = require("@vitejs/plugin-vue");
const defineConfig = require("vite").defineConfig;

/** Create the development-only clean URL rewrite for the workflow page. */
function createWorkflowRewritePlugin() {
  return {
    name: "workflow-clean-url",
    /** Register one small middleware before Vite's HTML fallback. */
    configureServer: function configureWorkflowRewrite(server) {
      /** Rewrite only the exact workflow URL to its standalone HTML entry. */
      function rewriteWorkflowUrl(request, response, next) {
        if (request.url === "/workflow" || request.url.indexOf("/workflow?") === 0) {
          request.url = "/workflow.html" + request.url.slice("/workflow".length);
        }
        next();
      }
      server.middlewares.use(rewriteWorkflowUrl);
    }
  };
}

/** Create the standalone Vue development-server configuration. */
function createViteConfiguration() {
  return {
    root: path.resolve(__dirname, "web"),
    plugins: [vue(), createWorkflowRewritePlugin()],
    server: {
      host: "127.0.0.1",
      port: 5173,
      strictPort: true,
      proxy: {
        "/server/logs": "http://127.0.0.1:3000",
        "/api/v1": "http://127.0.0.1:3000"
      }
    }
  };
}

module.exports = defineConfig(createViteConfiguration());
