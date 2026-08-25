const childProcess = require("child_process");
const fs = require("fs");
const http = require("http");
const path = require("path");

const STARTUP_WAIT_TIMEOUT_MS = 180000;

/** Return the project root from this script location. */
function resolveProjectRoot() {
  return path.resolve(__dirname, "..", "..");
}

/** Return the directory used for startup stdout/stderr logs. */
function resolveStartupLogDirectory(projectRoot) {
  return path.join(projectRoot, "server", "logs");
}

/** Resolve Vite's JavaScript entry so no npm.cmd console window is created. */
function resolveViteScript(projectRoot) {
  const viteScript = path.join(projectRoot, "node_modules", "vite", "bin", "vite.js");
  if (!fs.existsSync(viteScript)) {
    throw new Error("Missing Vite script: " + viteScript);
  }
  return viteScript;
}

/** Prepare one startup log file and return its path. */
function prepareStartupLog(logDirectory, fileName, label, command, args) {
  const logPath = path.join(logDirectory, fileName);
  const header = [
    "=== " + label + " startup ===",
    "time: " + new Date().toISOString(),
    "command: " + command + " " + args.join(" "),
    ""
  ].join("\r\n");
  fs.mkdirSync(logDirectory, { recursive: true });
  fs.writeFileSync(logPath, header, "utf8");
  return logPath;
}

/** Close one file descriptor without hiding the original startup failure. */
function closeDescriptorQuietly(descriptor) {
  try {
    fs.closeSync(descriptor);
  } catch (error) {
    // Startup logging should never replace the real process error.
  }
}

/** Start one long-running local service detached from this startup CLI and write its logs to disk. */
function startHiddenProcess(label, command, args, projectRoot, logPath) {
  const outputDescriptor = fs.openSync(logPath, "a");
  const errorDescriptor = fs.openSync(logPath, "a");
  console.log("[Auto Bundle] Starting " + label + "...");
  console.log("[Auto Bundle] " + label + " log: " + logPath);
  const child = childProcess.spawn(command, args, {
    cwd: projectRoot,
    detached: true,
    stdio: ["ignore", outputDescriptor, errorDescriptor],
    windowsHide: true,
    shell: false
  });
  child.on("error", function handleChildStartError(error) {
    console.error("[Auto Bundle] Failed to start " + label + ": " + error.message);
  });
  child.unref();
  closeDescriptorQuietly(outputDescriptor);
  closeDescriptorQuietly(errorDescriptor);
}

/** Read the tail of one startup log so timeout errors explain what actually happened. */
function readLogTail(logPath, maxCharacters) {
  if (!fs.existsSync(logPath)) {
    return "";
  }
  const content = fs.readFileSync(logPath, "utf8");
  return content.slice(-Math.max(1, maxCharacters || 4000));
}

/** Print recent startup logs after one local service fails to become ready. */
function printStartupLogTails(logPaths) {
  const names = Object.keys(logPaths);
  for (let index = 0; index < names.length; index += 1) {
    const name = names[index];
    const logPath = logPaths[name];
    const tail = readLogTail(logPath, 5000).trim();
    console.error("");
    console.error("[Auto Bundle] Last log lines for " + name + ": " + logPath);
    console.error(tail || "(empty)");
  }
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
  const logDirectory = resolveStartupLogDirectory(projectRoot);
  const logPaths = {
    backend: prepareStartupLog(logDirectory, "startup-backend.log", "backend on 3000", process.execPath, ["server\\server.js"]),
    workbench: prepareStartupLog(logDirectory, "startup-workbench.log", "workbench on 5173", process.execPath, [viteScript, "--host", "127.0.0.1", "--port", "5173"])
  };
  try {
    startHiddenProcess("backend on 3000", process.execPath, ["server\\server.js"], projectRoot, logPaths.backend);
    startHiddenProcess("workbench on 5173", process.execPath, [viteScript, "--host", "127.0.0.1", "--port", "5173"], projectRoot, logPaths.workbench);
    console.log("[Auto Bundle] Waiting for http://127.0.0.1:3000/api/v1/config ...");
    await waitForHttpReady("http://127.0.0.1:3000/api/v1/config", STARTUP_WAIT_TIMEOUT_MS);
    console.log("[Auto Bundle] Waiting for http://127.0.0.1:5173 ...");
    await waitForHttpReady("http://127.0.0.1:5173", STARTUP_WAIT_TIMEOUT_MS);
    console.log("[Auto Bundle] Services are ready.");
  } catch (error) {
    printStartupLogTails(logPaths);
    throw error;
  }
}

main().catch(function handleStartupError(error) {
  console.error("[Auto Bundle] Startup failed: " + error.message);
  process.exit(1);
});
