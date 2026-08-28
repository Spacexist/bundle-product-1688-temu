const fs = require("fs");
const path = require("path");
const readline = require("readline");
const childProcess = require("child_process");

const CLIP_WARMUP_TIMEOUT_MS = 600000;
const CLIP_ASSEMBLE_TIMEOUT_MS = 300000;

/** JSON-line client for the Python CLIP worker hosted by the 3000 server. */
class ClipWorkerService {
  /** Store config readers and initialize lazy worker state. */
  constructor(options) {
    const settings = options || {};
    this.readConfig = settings.readConfig;
    this.writeLog = settings.writeLog;
    this.appRoot = settings.appRoot;
    this.child = null;
    this.reader = null;
    this.pending = {};
    this.sequence = 0;
    this.startPromise = null;
    this.stderrBuffer = "";
    this.loadingLogPath = path.join(this.appRoot, "server", "logs", "clip-loading.log");
    this.loadingStatus = {
      status: "waiting",
      stage: "waiting",
      progress: 0,
      message: "网页已优先启动，等待加载 CLIP。",
      error: "",
      started_at: "",
      updated_at: new Date().toISOString()
    };
    this.persistLoadingProgress(this.loadingStatus);
  }

  /** Return the latest CLIP startup stage for the workbench progress bar. */
  getLoadingStatus() {
    return Object.assign({}, this.loadingStatus);
  }

  /** Append one reviewable CLIP startup snapshot to the dedicated disk log. */
  persistLoadingProgress(status) {
    try {
      fs.mkdirSync(path.dirname(this.loadingLogPath), { recursive: true });
      fs.appendFileSync(this.loadingLogPath, JSON.stringify(status) + "\r\n", "utf8");
    } catch (error) {
      // A log write failure must not prevent CLIP from loading.
    }
  }

  /** Update, persist, and publish one real CLIP startup stage. */
  reportLoadingProgress(stage, progress, message, status, error) {
    const nextProgress = Math.max(0, Math.min(100, Math.round(Number(progress) || 0)));
    const now = new Date().toISOString();
    this.loadingStatus = {
      status: String(status || (nextProgress >= 100 ? "ready" : "loading")),
      stage: String(stage || "loading"),
      progress: nextProgress,
      message: String(message || "正在加载 CLIP。"),
      error: String(error || ""),
      started_at: this.loadingStatus.started_at || now,
      updated_at: now
    };
    this.persistLoadingProgress(this.loadingStatus);
    this.writeBundleLog("CLIP", "CLIP load progress", this.loadingStatus, "");
    return this.getLoadingStatus();
  }

  /** Read one JSON file without surfacing optional config parse errors. */
  readJsonFile(filePath) {
    if (!fs.existsSync(filePath)) {
      return {};
    }
    try {
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (error) {
      return {};
    }
  }

  /** Join the configured Kimi base URL and endpoint for the Python worker. */
  buildKimiEndpoint(kimi) {
    const source = kimi && typeof kimi === "object" ? kimi : {};
    const rawEndpoint = String(source.endpoint || "").trim();
    if (/^https?:\/\//i.test(rawEndpoint)) {
      return rawEndpoint;
    }
    const baseUrl = String(source.baseurl || source.baseUrl || "https://api.moonshot.cn").replace(/\/+$/, "");
    const endpoint = rawEndpoint || "/v1/chat/completions";
    return baseUrl + "/" + endpoint.replace(/^\/+/, "");
  }

  /** Resolve the bundled CLIP project directory unless config overrides it. */
  resolveClipProjectDirectory(config) {
    const workflow = config && config.workflow && typeof config.workflow === "object" ? config.workflow : {};
    const configured = String(workflow.clip_project_directory || "").trim();
    const bundledClipDirectory = path.resolve(this.appRoot, "bundle", "clip");
    if (configured) {
      const configuredDirectory = path.isAbsolute(configured) ? configured : path.resolve(this.appRoot, configured);
      if (fs.existsSync(configuredDirectory)) {
        return configuredDirectory;
      }
    }
    return bundledClipDirectory;
  }

  /** Return whether a configured Python command is a filesystem path instead of a shell command. */
  isPythonPathCommand(command) {
    const value = String(command || "").trim();
    return path.isAbsolute(value) || value.indexOf("/") >= 0 || value.indexOf("\\") >= 0 || /\.exe$/i.test(value);
  }

  /** Return whether a Python command points at the old venv launcher that is not safe as the primary runtime. */
  isLegacyVenvPythonCommand(command) {
    const value = String(command || "").replace(/\\/g, "/").toLowerCase();
    return value.endsWith("bundle/python-cpu/scripts/python.exe") || value.indexOf("/bundle/python-cpu/scripts/python.exe") >= 0;
  }

  /** Resolve the bundled Python executable, with system Python kept as a fallback. */
  resolvePythonCommand(config) {
    const workflow = config && config.workflow && typeof config.workflow === "object" ? config.workflow : {};
    const configured = String(workflow.clip_python_command || "").trim();
    const bundledRuntimePython = path.join(this.appRoot, "bundle", "python-runtime", "python.exe");
    const bundledCpuPython = path.join(this.appRoot, "bundle", "python-cpu", "Scripts", "python.exe");
    if (configured) {
      const configuredPython = path.isAbsolute(configured) ? configured : path.resolve(this.appRoot, configured);
      if (this.isPythonPathCommand(configured) && !this.isLegacyVenvPythonCommand(configured) && fs.existsSync(configuredPython)) {
        return configuredPython;
      }
      if (!this.isPythonPathCommand(configured) && !this.isLegacyVenvPythonCommand(configured)) {
        return configured;
      }
    }
    if (fs.existsSync(bundledRuntimePython)) {
      return bundledRuntimePython;
    }
    if (fs.existsSync(bundledCpuPython)) {
      return bundledCpuPython;
    }
    return "py";
  }

  /** Add the venv site-packages directory so the portable Python runtime can import bundled wheels. */
  applyBundledPythonPath(environment) {
    const sitePackages = path.join(this.appRoot, "bundle", "python-cpu", "Lib", "site-packages");
    if (!fs.existsSync(sitePackages)) {
      return;
    }
    const existing = String(environment.PYTHONPATH || "").trim();
    environment.PYTHONPATH = existing ? sitePackages + path.delimiter + existing : sitePackages;
  }

  /** Return whether one process error means Windows denied executing Python. */
  isWindowsAccessDeniedError(error) {
    const source = error || {};
    const message = String(source.message || "");
    return source.code === "EACCES"
      || source.code === "EPERM"
      || source.errno === 13
      || source.winerror === 5
      || /WinError 5|拒绝访问|access is denied/i.test(message);
  }

  /** Convert a raw Python spawn failure into an operator-friendly CLIP error. */
  createPythonStartError(pythonCommand, error) {
    if (!this.isWindowsAccessDeniedError(error)) {
      return error;
    }
    return new Error("CLIP Python 启动被 Windows 拒绝访问：" + String(pythonCommand || "")
      + "。请在解压后的项目目录运行 启动.bat 触发环境修复；如果仍失败，请用 7-Zip/WinRAR 重新解压，或在文件属性里解除阻止。");
  }

  /** Check a filesystem Python command before spawning so access errors stay readable. */
  assertPythonCommandAccessible(pythonCommand) {
    if (!this.isPythonPathCommand(pythonCommand)) {
      return;
    }
    try {
      fs.accessSync(pythonCommand, fs.constants.F_OK | fs.constants.X_OK);
    } catch (error) {
      throw this.createPythonStartError(pythonCommand, error);
    }
  }

  /** Return whether either slim or original CLIP metadata exists for index position lookup. */
  hasListingMetadata(clipDirectory) {
    return fs.existsSync(path.join(clipDirectory, "data", "full_listing_index", "products_listing_meta.runtime.json"))
      || fs.existsSync(path.join(clipDirectory, "data", "full_listing_index", "products_listing_meta.json"));
  }

  /** Validate the bundled CLIP files before spawning Python so launcher errors stay readable. */
  validateClipBundle(clipDirectory, workerScript) {
    const requiredFiles = [
      workerScript,
      path.join(clipDirectory, "work", "full_listing_server.py"),
      path.join(clipDirectory, "models", "open_clip_pytorch_model.bin"),
      path.join(clipDirectory, "data", "yunqi_clip_training", "last_checkpoint.pt"),
      path.join(clipDirectory, "data", "full_listing_index", "products_listing.index"),
      path.join(clipDirectory, "data", "full_listing_index", "progress.json"),
      path.join(clipDirectory, "data", "full_clip_index", "products_full_prices.json")
    ];
    const missing = [];
    for (let index = 0; index < requiredFiles.length; index += 1) {
      if (!fs.existsSync(requiredFiles[index])) {
        missing.push(requiredFiles[index]);
        continue;
      }
      if (fs.statSync(requiredFiles[index]).size <= 0) {
        missing.push(requiredFiles[index] + " (empty)");
      }
    }
    if (missing.length) {
      throw new Error("CLIP bundle missing files: " + missing.join(", "));
    }
    if (!this.hasListingMetadata(clipDirectory)) {
      throw new Error("CLIP bundle missing listing metadata runtime/original JSON.");
    }
    const progress = this.readJsonFile(path.join(clipDirectory, "data", "full_listing_index", "progress.json"));
    if (String(progress.status || "") !== "complete") {
      throw new Error("CLIP listing index is not complete: " + String(progress.completed || 0) + "/" + String(progress.total || 0));
    }
  }

  /** Build environment variables consumed by the Python CLIP worker. */
  buildEnvironment(config) {
    const kimi = config && config.kimi && typeof config.kimi === "object" ? config.kimi : {};
    const workflow = config && config.workflow && typeof config.workflow === "object" ? config.workflow : {};
    const environment = Object.assign({}, process.env);
    if (kimi.apikey) {
      environment.MOONSHOT_API_KEY = String(kimi.apikey);
    }
    environment.KIMI_ENDPOINT = this.buildKimiEndpoint(kimi);
    environment.KIMI_MODEL = String(kimi.model || "kimi-k2.6");
    environment.CLIP_WORKER_MODE = "stdio";
    environment.CLIP_WORKER_THREADS = String(Math.max(1, Math.min(Number(workflow.clip_worker_threads || 2), 4)));
    environment.PYTHONUTF8 = "1";
    environment.PYTHONIOENCODING = "utf-8:backslashreplace";
    this.applyBundledPythonPath(environment);
    return environment;
  }

  /** Reject and clear every pending request when the worker exits. */
  rejectPending(error) {
    const keys = Object.keys(this.pending);
    for (let index = 0; index < keys.length; index += 1) {
      this.pending[keys[index]].reject(error);
      delete this.pending[keys[index]];
    }
  }

  /** Write one CLIP bundle diagnostic entry when server logs are available. */
  writeBundleLog(direction, label, payload, requestId) {
    if (typeof this.writeLog === "function") {
      this.writeLog(direction, label, payload, requestId || "");
    }
  }

  /** Summarize a CLIP worker request without retaining base64 image content. */
  summarizeWorkerRequest(action, payload) {
    const source = payload && typeof payload === "object" ? payload : {};
    return {
      action: action,
      query: source.query || "",
      top_k: source.top_k || "",
      min_price: source.min_price || "",
      max_price: source.max_price || "",
      model: source.model || "",
      has_image_base64: Boolean(source.image_base64),
      image_base64_chars: source.image_base64 ? String(source.image_base64).length : 0
    };
  }

  /** Summarize a CLIP worker result for /server/logs display. */
  summarizeWorkerResult(action, result, durationMs) {
    const payload = result && typeof result === "object" ? result : {};
    return {
      action: action,
      duration_ms: durationMs,
      result_count: Array.isArray(payload.results) ? payload.results.length : 0,
      group_count: Array.isArray(payload.groups) ? payload.groups.length : 0,
      prompts_searched: payload.prompts_searched || 0,
      model: payload.model || payload.kimi_model || ""
    };
  }

  /** Handle one JSON-line response emitted by the Python worker. */
  handleLine(line) {
    let payload = {};
    try {
      payload = JSON.parse(String(line || ""));
    } catch (error) {
      return;
    }
    const id = String(payload.id || "");
    const entry = this.pending[id];
    if (!entry) {
      return;
    }
    clearTimeout(entry.timeout);
    delete this.pending[id];
    if (payload.ok) {
      entry.resolve(payload.result || {});
      return;
    }
    entry.reject(new Error(String(payload.error || "CLIP worker failed.")));
  }

  /** Lazily start the hidden Python worker owned by the 3000 server. */
  async ensureStarted() {
    if (this.child && !this.child.killed && this.child.exitCode === null) {
      return;
    }
    if (this.startPromise) {
      return this.startPromise;
    }
    const service = this;
    this.startPromise = new Promise(function startClipWorker(resolve, reject) {
      service.reportLoadingProgress("validating", 10, "正在校验 CLIP 文件。", "loading", "");
      const config = service.readConfig ? service.readConfig() : service.readJsonFile(path.join(service.appRoot, "server", "config.json"));
      const clipDirectory = service.resolveClipProjectDirectory(config);
      const workerScript = path.join(clipDirectory, "work", "stdio_listing_worker.py");
      const pythonCommand = service.resolvePythonCommand(config);
      try {
        service.validateClipBundle(clipDirectory, workerScript);
        service.assertPythonCommandAccessible(pythonCommand);
      } catch (error) {
        service.reportLoadingProgress("failed", service.loadingStatus.progress, "CLIP 文件校验失败。", "error", error.message);
        reject(error);
        return;
      }
      service.reportLoadingProgress("starting_python", 22, "正在启动 CLIP Python。", "loading", "");
      try {
        service.child = childProcess.spawn(pythonCommand, [workerScript], {
          cwd: clipDirectory,
          env: service.buildEnvironment(config),
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true
        });
      } catch (error) {
        const startError = service.createPythonStartError(pythonCommand, error);
        service.reportLoadingProgress("failed", service.loadingStatus.progress, "CLIP Python 启动失败。", "error", startError.message);
        reject(startError);
        return;
      }
      service.reader = readline.createInterface({ input: service.child.stdout });
      service.reader.on("line", service.handleLine.bind(service));
      service.child.stderr.on("data", function handleClipWorkerStderr(chunk) {
        if (service.writeLog) {
          service.writeStderrChunk(String(chunk || ""));
        }
      });
      service.child.on("error", function handleClipWorkerError(error) {
        const startError = service.createPythonStartError(pythonCommand, error);
        service.rejectPending(startError);
        service.child = null;
        service.reader = null;
        service.startPromise = null;
        service.reportLoadingProgress("failed", service.loadingStatus.progress, "CLIP Python 运行失败。", "error", startError.message);
        reject(startError);
      });
      service.child.on("exit", function handleClipWorkerExit(code) {
        const error = new Error("CLIP worker exited with code " + Number(code || 0));
        service.rejectPending(error);
        service.child = null;
        service.reader = null;
        service.startPromise = null;
        service.flushStderrBuffer();
        service.reportLoadingProgress("failed", service.loadingStatus.progress, "CLIP Python 已退出。", "error", error.message);
      });
      service.child.once("spawn", function handleClipWorkerSpawned() {
        service.reportLoadingProgress("importing", 32, "Python 已启动，正在导入 CLIP 依赖。", "loading", "");
        resolve();
      });
    });
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  /** Buffer Python stderr chunks so progress JSON split by Windows pipes remains readable. */
  writeStderrChunk(text) {
    this.stderrBuffer += String(text || "");
    const lines = this.stderrBuffer.split(/\r?\n/);
    this.stderrBuffer = lines.pop() || "";
    for (let index = 0; index < lines.length; index += 1) {
      this.writeStderrLine(lines[index]);
    }
  }

  /** Flush the final partial stderr line when Python exits. */
  flushStderrBuffer() {
    const text = this.stderrBuffer;
    this.stderrBuffer = "";
    this.writeStderrLine(text);
  }

  /** Convert one Python stderr line into a loading stage or regular diagnostic. */
  writeStderrLine(text) {
    const message = String(text || "").trim();
    if (!message) {
      return;
    }
    const prefix = "[BUNDLE API] ";
    if (message.indexOf(prefix) === 0) {
      try {
        const payload = JSON.parse(message.slice(prefix.length));
        if (String(payload.message || "") === "CLIP load progress") {
          const progress = payload.payload || {};
          this.reportLoadingProgress(progress.stage, progress.progress, progress.message, progress.status, progress.error);
          return;
        }
        this.writeBundleLog("UPSTREAM", "Bundle API " + String(payload.message || ""), payload.payload || {}, "");
        return;
      } catch (error) {
        this.writeBundleLog("CLIP", message, null, "");
        return;
      }
    }
    this.writeBundleLog("CLIP", message, null, "");
  }

  /** Send one action payload to the worker and await its matching response. */
  async request(action, payload, timeoutMs) {
    await this.ensureStarted();
    const service = this;
    const id = String(Date.now()) + "-" + String(this.sequence += 1);
    const body = Object.assign({}, payload || {}, { id: id, action: action });
    const requestId = String(body.request_id || "");
    const startedAt = Date.now();
    this.writeBundleLog("OUTBOUND", "Bundle CLIP worker " + action, this.summarizeWorkerRequest(action, body), requestId);
    return new Promise(function sendClipWorkerRequest(resolve, reject) {
      const timeout = setTimeout(function handleClipWorkerTimeout() {
        delete service.pending[id];
        service.writeBundleLog("UPSTREAM", "Bundle CLIP worker timeout " + action, {
          action: action,
          duration_ms: Date.now() - startedAt
        }, requestId);
        reject(new Error("CLIP worker request timed out."));
      }, Math.max(10000, Number(timeoutMs || 180000)));
      /** Resolve one CLIP worker request and mirror its response into diagnostics. */
      function resolveWithLog(result) {
        service.writeBundleLog("UPSTREAM", "Bundle CLIP worker response " + action, service.summarizeWorkerResult(action, result, Date.now() - startedAt), requestId);
        if (action === "warmup" || ((action === "search_text" || action === "assemble") && service.loadingStatus.status !== "ready")) {
          service.reportLoadingProgress("ready", 100, "CLIP 索引和模型已就绪。", "ready", "");
        }
        resolve(result);
      }
      /** Reject one CLIP worker request and mirror its failure into diagnostics. */
      function rejectWithLog(error) {
        service.writeBundleLog("UPSTREAM", "Bundle CLIP worker error " + action, {
          action: action,
          duration_ms: Date.now() - startedAt,
          error: error && error.message ? error.message : String(error || "")
        }, requestId);
        if (action === "warmup" && service.loadingStatus.status !== "ready") {
          service.reportLoadingProgress("failed", service.loadingStatus.progress, "CLIP 加载失败。", "error", error && error.message ? error.message : String(error || ""));
        }
        reject(error);
      }
      service.pending[id] = { resolve: resolveWithLog, reject: rejectWithLog, timeout: timeout };
      try {
        if (!service.child || !service.child.stdin || service.child.stdin.destroyed) {
          throw new Error("CLIP worker stdin is not writable.");
        }
        service.child.stdin.write(JSON.stringify(body) + "\n", "utf8");
      } catch (error) {
        clearTimeout(timeout);
        delete service.pending[id];
        rejectWithLog(error);
      }
    });
  }

  /** Ask the worker for index readiness information. */
  indexStatus() {
    return this.request("index_status", {}, 60000);
  }

  /** Load the CLIP index and model after the browser workbench is visible. */
  warmup() {
    if (this.loadingStatus.status === "ready") {
      return Promise.resolve(this.getLoadingStatus());
    }
    return this.request("warmup", {}, CLIP_WARMUP_TIMEOUT_MS);
  }

  /** Ask the worker to search text against the CLIP listing index. */
  searchText(payload) {
    const timeoutMs = this.loadingStatus.status === "ready" ? 60000 : CLIP_WARMUP_TIMEOUT_MS;
    return this.request("search_text", payload, timeoutMs);
  }

  /** Ask the worker to run Kimi prompt generation and CLIP assembly. */
  assemble(payload) {
    return this.request("assemble", payload, CLIP_ASSEMBLE_TIMEOUT_MS);
  }
}

module.exports = { ClipWorkerService: ClipWorkerService };
