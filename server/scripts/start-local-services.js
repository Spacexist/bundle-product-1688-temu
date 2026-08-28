const childProcess = require("child_process");
const fs = require("fs");
const http = require("http");
const path = require("path");

const STARTUP_WAIT_TIMEOUT_MS = 180000;
const STARTUP_PROGRESS_INTERVAL_MS = 5000;

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

/** Start one long-running local service and retain it until readiness checks finish. */
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
  closeDescriptorQuietly(outputDescriptor);
  closeDescriptorQuietly(errorDescriptor);
  return { child: child, label: label, logPath: logPath };
}

/** Return whether one service process is still alive during startup. */
function isServiceRunning(service) {
  return Boolean(service && service.child && service.child.exitCode === null && !service.child.killed);
}

/** Release one ready service so it can outlive the startup CLI. */
function detachReadyService(service) {
  if (service && service.child) {
    service.child.unref();
  }
}

/** Stop one process that was started by the current failed startup attempt. */
function stopFailedService(service) {
  if (!isServiceRunning(service)) {
    return;
  }
  try {
    service.child.kill();
  } catch (error) {
    // Failure cleanup must not replace the original startup error.
  }
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

/** Poll one HTTP endpoint while reporting elapsed startup time and early process exits. */
function waitForHttpReady(url, timeoutMs, service) {
  const startedAt = Date.now();
  let nextProgressAt = STARTUP_PROGRESS_INTERVAL_MS;
  return new Promise(function waitForHttpReadyPromise(resolve, reject) {
    /** Try one HTTP request and reschedule until the service answers. */
    function attempt() {
      if (!isServiceRunning(service)) {
        reject(new Error(service.label + " exited before becoming ready."));
        return;
      }
      const request = http.get(url, function handleResponse(response) {
        response.resume();
        resolve();
      });
      request.setTimeout(2000, function handleTimeout() {
        request.destroy();
      });
      request.on("error", function handleError() {
        const elapsedMs = Date.now() - startedAt;
        if (elapsedMs >= timeoutMs) {
          reject(new Error("Timed out waiting for " + url));
          return;
        }
        if (elapsedMs >= nextProgressAt) {
          console.log("[Auto Bundle] " + service.label + " is still starting (" + Math.ceil(elapsedMs / 1000) + "s)...");
          nextProgressAt += STARTUP_PROGRESS_INTERVAL_MS;
        }
        setTimeout(attempt, 500);
      });
    }
    attempt();
  });
}

/** Check one local HTTP endpoint once without starting or stopping any process. */
function probeHttpReady(url, timeoutMs) {
  return new Promise(function probeHttpReadyPromise(resolve) {
    const request = http.get(url, function handleProbeResponse(response) {
      response.resume();
      resolve(Number(response.statusCode || 500) < 500);
    });
    request.setTimeout(Math.max(100, Number(timeoutMs || 700)), function handleProbeTimeout() {
      request.destroy();
    });
    request.on("error", function handleProbeError() {
      resolve(false);
    });
  });
}

/** Return whether both local services are already healthy enough to open immediately. */
async function probeExistingServices() {
  const results = await Promise.all([
    probeHttpReady("http://127.0.0.1:3000/api/v1/config", 700),
    probeHttpReady("http://127.0.0.1:5173", 700)
  ]);
  return results[0] && results[1];
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
  const backendService = startHiddenProcess("backend on 3000", process.execPath, ["server\\server.js"], projectRoot, logPaths.backend);
  const workbenchService = startHiddenProcess("workbench on 5173", process.execPath, [viteScript, "--host", "127.0.0.1", "--port", "5173"], projectRoot, logPaths.workbench);
  try {
    console.log("[Auto Bundle] Waiting for http://127.0.0.1:3000/api/v1/config ...");
    await waitForHttpReady("http://127.0.0.1:3000/api/v1/config", STARTUP_WAIT_TIMEOUT_MS, backendService);
    console.log("[Auto Bundle] Waiting for http://127.0.0.1:5173 ...");
    await waitForHttpReady("http://127.0.0.1:5173", STARTUP_WAIT_TIMEOUT_MS, workbenchService);
    detachReadyService(backendService);
    detachReadyService(workbenchService);
    console.log("[Auto Bundle] Services are ready.");
  } catch (error) {
    stopFailedService(backendService);
    stopFailedService(workbenchService);
    printStartupLogTails(logPaths);
    throw error;
  }
}

/** Run either the fast existing-service probe or the normal service startup. */
async function runCommand() {
  if (process.argv.indexOf("--probe") >= 0) {
    process.exitCode = await probeExistingServices() ? 0 : 1;
    return;
  }
  await main();
}

runCommand().catch(function handleStartupError(error) {
  console.error("[Auto Bundle] Startup failed: " + error.message);
  process.exit(1);
});
