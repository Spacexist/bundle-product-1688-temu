const childProcess = require("child_process");
const fs = require("fs");
const http = require("http");
const path = require("path");

/** Return the project root from this script location. */
function resolveProjectRoot() {
  return path.resolve(__dirname, "..", "..");
}

/** Resolve Vite's JavaScript entry so no npm.cmd console window is created. */
function resolveViteScript(projectRoot) {
  const viteScript = path.join(projectRoot, "node_modules", "vite", "bin", "vite.js");
  if (!fs.existsSync(viteScript)) {
    throw new Error("Missing Vite script: " + viteScript);
  }
  return viteScript;
}

/** Start one long-running local service detached from this startup CLI. */
function startHiddenProcess(label, command, args, projectRoot) {
  console.log("[Auto Bundle] Starting " + label + "...");
  const child = childProcess.spawn(command, args, {
    cwd: projectRoot,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    shell: false
  });
  child.unref();
}

/** Poll one HTTP endpoint until it becomes ready or the timeout expires. */
function waitForHttpReady(url, timeoutMs) {
  const startedAt = Date.now();
  return new Promise(function waitForHttpReadyPromise(resolve, reject) {
    /** Try one HTTP request and reschedule until the service answers. */
    function attempt() {
      const request = http.get(url, function handleResponse(response) {
        response.resume();
        resolve();
      });
      request.setTimeout(2000, function handleTimeout() {
        request.destroy();
      });
      request.on("error", function handleError() {
        if (Date.now() - startedAt >= timeoutMs) {
          reject(new Error("Timed out waiting for " + url));
          return;
        }
        setTimeout(attempt, 500);
      });
    }
    attempt();
  });
}

/** Start backend and workbench services, then wait for both local ports. */
async function main() {
  const projectRoot = resolveProjectRoot();
  const viteScript = resolveViteScript(projectRoot);
  startHiddenProcess("backend on 3000", process.execPath, ["server\\server.js"], projectRoot);
  startHiddenProcess("workbench on 5173", process.execPath, [viteScript, "--host", "127.0.0.1", "--port", "5173"], projectRoot);
  console.log("[Auto Bundle] Waiting for http://127.0.0.1:3000/api/v1/config ...");
  await waitForHttpReady("http://127.0.0.1:3000/api/v1/config", 90000);
  console.log("[Auto Bundle] Waiting for http://127.0.0.1:5173 ...");
  await waitForHttpReady("http://127.0.0.1:5173", 90000);
  console.log("[Auto Bundle] Services are ready.");
}

main().catch(function handleStartupError(error) {
  console.error("[Auto Bundle] Startup failed: " + error.message);
  process.exit(1);
});
