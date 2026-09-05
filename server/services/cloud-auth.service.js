const crypto = require("crypto");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const tls = require("tls");
const configModule = require("../config/config-loader");

const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const SERVER_ROOT = path.join(PROJECT_ROOT, "server");
const RUNTIME_ROOT = path.join(PROJECT_ROOT, "runtime");
const CREDENTIAL_PATH = path.join(RUNTIME_ROOT, "cloud-auth-credential.dat");
const CONFIG_STATE_PATH = path.join(RUNTIME_ROOT, "cloud-config-state.json");
const CONFIG_PATH = path.join(SERVER_ROOT, "config.json");
const DEFAULT_WORKER_URL = "https://bundle-1688-temu-auth.changkaishen7788.workers.dev";
const CLOUD_REQUEST_TIMEOUT_MS = 30000;
const LOCAL_PROXY_FALLBACK_URL = "http://127.0.0.1:7897";
let runtimeAuthorizedStatus = null;

/** Return a short Windows device label for the Cloudflare audit page. */
function deviceName() {
  return String(process.env.COMPUTERNAME || os.hostname() || "Windows 设备").trim() || "Windows 设备";
}

/** Normalize the configured Worker URL and reject non-HTTPS endpoints. */
function normalizeWorkerUrl(value) {
  const url = String(value || "").trim().replace(/\/+$/, "");
  if (!url) {
    throw new Error("请填写 Cloudflare Worker 地址。");
  }
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") {
    throw new Error("Cloudflare Worker 地址必须使用 HTTPS。");
  }
  return parsed.origin + parsed.pathname.replace(/\/+$/, "");
}

/** Read the Worker URL from environment variables, local config, or the prototype default. */
function configuredWorkerUrl() {
  const environmentUrl = String(process.env.BUNDLE_1688_TEMU_AUTH_URL || "").trim();
  if (environmentUrl) {
    return normalizeWorkerUrl(environmentUrl);
  }
  try {
    const config = configModule.readServerConfig();
    const cloudAuth = config.cloudAuth && typeof config.cloudAuth === "object" ? config.cloudAuth : {};
    if (cloudAuth.workerUrl) {
      return normalizeWorkerUrl(cloudAuth.workerUrl);
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn("[cloud-auth] 读取 Worker 地址失败：" + error.message);
    }
  }
  return DEFAULT_WORKER_URL;
}

/** Run Windows DPAPI through PowerShell without placing plaintext credentials on disk. */
function runDpapi(mode, value) {
  if (process.platform !== "win32") {
    throw new Error("本机凭据保存仅支持 Windows DPAPI。");
  }
  const protect = mode === "protect";
  const script = [
    "$ErrorActionPreference='Stop'",
    "Add-Type -AssemblyName System.Security",
    "$raw=[Console]::In.ReadToEnd().Trim()",
    protect
      ? "$bytes=[Text.Encoding]::UTF8.GetBytes($raw); $out=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($out))"
      : "$bytes=[Convert]::FromBase64String($raw); $out=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Text.Encoding]::UTF8.GetString($out))"
  ].join("; ");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    input: String(value || ""),
    encoding: "utf8",
    windowsHide: true,
    timeout: 15000
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const error = new Error(String(result.stderr || "Windows DPAPI 操作失败。").trim());
    error.code = protect ? "DPAPI_PROTECT_FAILED" : "DPAPI_UNPROTECT_FAILED";
    throw error;
  }
  return String(result.stdout || "").trim();
}

/** Replace one file atomically on Windows and fall back to rename when the target is new. */
function replaceFileAtomic(temporaryPath, targetPath) {
  if (!fs.existsSync(targetPath)) {
    fs.renameSync(temporaryPath, targetPath);
    return;
  }
  const backupPath = targetPath + "." + process.pid + "." + Date.now() + ".bak";
  const script = "[IO.File]::Replace($env:BUNDLE_AUTH_SOURCE,$env:BUNDLE_AUTH_TARGET,$env:BUNDLE_AUTH_BACKUP,$true)";
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      BUNDLE_AUTH_SOURCE: temporaryPath,
      BUNDLE_AUTH_TARGET: targetPath,
      BUNDLE_AUTH_BACKUP: backupPath
    },
    windowsHide: true,
    timeout: 15000
  });
  try {
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      throw new Error(String(result.stderr || "原子替换文件失败。").trim());
    }
  } finally {
    if (fs.existsSync(backupPath)) {
      fs.unlinkSync(backupPath);
    }
  }
}

/** Write one JSON file through a same-directory temporary file. */
function writeJsonAtomic(targetPath, value) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const temporaryPath = targetPath + "." + process.pid + "." + Date.now() + ".tmp";
  fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2) + "\n", "utf8");
  try {
    replaceFileAtomic(temporaryPath, targetPath);
  } finally {
    if (fs.existsSync(temporaryPath)) {
      fs.unlinkSync(temporaryPath);
    }
  }
}

/** Read local cloud configuration state used for version comparisons. */
function readConfigState() {
  try {
    const state = JSON.parse(fs.readFileSync(CONFIG_STATE_PATH, "utf8"));
    return {
      version: Math.max(0, Math.floor(Number(state.version) || 0)),
      updatedAt: String(state.updatedAt || ""),
      lastSyncAt: String(state.lastSyncAt || "")
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { version: 0, updatedAt: "", lastSyncAt: "" };
    }
    throw new Error("本机云配置状态损坏：" + error.message);
  }
}

/** Save the local cloud configuration state after a successful Cloudflare check. */
function writeConfigState(version, updatedAt) {
  const state = {
    version: Math.max(0, Math.floor(Number(version) || 0)),
    updatedAt: String(updatedAt || ""),
    lastSyncAt: new Date().toISOString()
  };
  writeJsonAtomic(CONFIG_STATE_PATH, state);
  return state;
}

/** Return the in-memory authorization result for this server process. */
function readRuntimeAuthorizedStatus() {
  if (!runtimeAuthorizedStatus) {
    return null;
  }
  return Object.assign({}, runtimeAuthorizedStatus);
}

/** Store one successful cloud authorization for refreshes in the same startup. */
function rememberRuntimeAuthorizedStatus(status, hasCredential) {
  const source = status && typeof status === "object" ? status : {};
  runtimeAuthorizedStatus = Object.assign({}, source, {
    authorized: true,
    hasCredential: Boolean(hasCredential),
    runtimeAuthorized: true
  });
  return readRuntimeAuthorizedStatus();
}

/** Forget the in-memory authorization state after the user clears credentials. */
function clearRuntimeAuthorizedStatus() {
  runtimeAuthorizedStatus = null;
}

/** Return the first physical-looking MAC address that Node can read. */
function readPrimaryMacAddress() {
  const interfaces = os.networkInterfaces();
  const names = Object.keys(interfaces);
  for (let nameIndex = 0; nameIndex < names.length; nameIndex += 1) {
    const entries = interfaces[names[nameIndex]] || [];
    for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
      const entry = entries[entryIndex] || {};
      const mac = String(entry.mac || "").trim().toLocaleLowerCase();
      if (!entry.internal && mac && mac !== "00:00:00:00:00:00") {
        return mac;
      }
    }
  }
  return "";
}

/** Hash one MAC address before it leaves the local backend. */
function hashMacAddress(macAddress) {
  const normalized = String(macAddress || "").replace(/[^a-fA-F0-9]/g, "").toLocaleLowerCase();
  if (!normalized) {
    return "";
  }
  return crypto.createHash("sha256").update("mac:" + normalized).digest("hex");
}

/** Read a saved encrypted credential from the local runtime directory. */
function readCredential() {
  try {
    const credential = JSON.parse(fs.readFileSync(CREDENTIAL_PATH, "utf8"));
    return {
      version: Number(credential.version || 1),
      workerUrl: normalizeWorkerUrl(credential.workerUrl || configuredWorkerUrl()),
      encryptedAccessHash: String(credential.encryptedAccessHash || ""),
      accountName: String(credential.accountName || ""),
      updatedAt: String(credential.updatedAt || "")
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw new Error("本机授权凭据损坏：" + error.message);
  }
}

/** Persist the encrypted access hash and the Worker URL for future startups. */
function saveCredential(workerUrl, accessHash, accountName) {
  const credential = {
    version: 1,
    workerUrl: normalizeWorkerUrl(workerUrl),
    encryptedAccessHash: runDpapi("protect", accessHash),
    accountName: String(accountName || ""),
    updatedAt: new Date().toISOString()
  };
  writeJsonAtomic(CREDENTIAL_PATH, credential);
  return credential;
}

/** Validate that a cloud-supplied config is a JSON object. */
function validateConfigPayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("云端返回的 config.json 必须是 JSON 对象。");
  }
  return value;
}

/** Parse a raw HTTP response received through a manually created CONNECT tunnel. */
function parseHttpResponse(raw) {
  const separator = raw.indexOf("\r\n\r\n");
  if (separator < 0) {
    throw new Error("本地代理返回了不完整的 HTTP 响应。");
  }
  const headerText = raw.slice(0, separator).toString("utf8");
  const lines = headerText.split(/\r\n/);
  const statusMatch = /^HTTP\/\d(?:\.\d)?\s+(\d+)/.exec(lines[0] || "");
  if (!statusMatch) {
    throw new Error("本地代理返回了无法识别的 HTTP 状态。");
  }
  const headers = {};
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    const splitAt = line.indexOf(":");
    if (splitAt > 0) {
      headers[line.slice(0, splitAt).trim().toLocaleLowerCase()] = line.slice(splitAt + 1).trim();
    }
  }
  let body = raw.slice(separator + 4);
  if (String(headers["transfer-encoding"] || "").toLocaleLowerCase().includes("chunked")) {
    body = decodeChunkedBody(body);
  }
  return { status: Number(statusMatch[1]), headers: headers, text: body.toString("utf8") };
}

/** Decode one HTTP chunked body returned by Cloudflare through the proxy tunnel. */
function decodeChunkedBody(body) {
  const chunks = [];
  let offset = 0;
  while (offset < body.length) {
    const lineEnd = body.indexOf("\r\n", offset, "utf8");
    if (lineEnd < 0) {
      throw new Error("本地代理返回了不完整的 chunked 响应。");
    }
    const sizeText = body.slice(offset, lineEnd).toString("ascii").split(";")[0].trim();
    const size = parseInt(sizeText, 16);
    if (!Number.isFinite(size)) {
      throw new Error("本地代理返回了无效的 chunked 响应。");
    }
    offset = lineEnd + 2;
    if (size === 0) {
      break;
    }
    chunks.push(body.slice(offset, offset + size));
    offset += size + 2;
  }
  return Buffer.concat(chunks);
}

/** Convert one Worker HTTP response into the shared data object shape. */
function parseWorkerJsonResponse(status, text) {
  const body = text ? JSON.parse(text) : {};
  if (status < 200 || status >= 300 || body.ok === false) {
    throw new Error(body.error || body.message || "云端授权失败。");
  }
  if (body && Object.prototype.hasOwnProperty.call(body, "data")) {
    return body.data || {};
  }
  return body;
}

/** Return whether a failed direct request is worth retrying through the local proxy. */
function isCloudTransportFailure(error) {
  const code = error && String(error.code || "");
  const causeCode = error && error.cause && String(error.cause.code || "");
  return error && (error.name === "AbortError" || error.name === "TypeError" || code === "CLOUD_AUTH_TIMEOUT" || /^(ECONNRESET|ENOTFOUND|ETIMEDOUT|UND_ERR_)/.test(causeCode));
}

/** Send one JSON request with Node's native fetch path. */
async function requestWorkerDirect(workerUrl, pathname, payload) {
  const controller = new AbortController();
  const timer = setTimeout(function abortCloudRequest() {
    controller.abort();
  }, CLOUD_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(normalizeWorkerUrl(workerUrl) + pathname, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {}),
      signal: controller.signal
    });
    const text = await response.text();
    return parseWorkerJsonResponse(response.status, text);
  } catch (error) {
    if (error.name === "AbortError") {
      const timeoutError = new Error("云端授权超时，请检查网络后重试。");
      timeoutError.code = "CLOUD_AUTH_TIMEOUT";
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** Send one HTTPS JSON request through the local Clash mixed proxy without external dependencies. */
function requestWorkerViaLocalProxy(workerUrl, pathname, payload) {
  const target = new URL(normalizeWorkerUrl(workerUrl) + pathname);
  const proxy = new URL(LOCAL_PROXY_FALLBACK_URL);
  const body = JSON.stringify(payload || {});
  return new Promise(function requestViaProxy(resolve, reject) {
    let settled = false;
    const socket = net.connect(Number(proxy.port), proxy.hostname);
    const chunks = [];
    const timeout = setTimeout(function abortProxyRequest() {
      finish(new Error("本地代理授权请求超时。"));
    }, CLOUD_REQUEST_TIMEOUT_MS);

    /** Finish the proxied request exactly once and close every open handle. */
    function finish(error, value) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      if (error) {
        reject(error);
        return;
      }
      resolve(value);
    }

    /** Upgrade the proxy tunnel to TLS and issue the actual Worker request. */
    function startTlsTunnel(initialBuffer) {
      const secure = tls.connect({ socket: socket, servername: target.hostname });
      if (initialBuffer && initialBuffer.length) {
        chunks.push(initialBuffer);
      }
      secure.on("secureConnect", function sendWorkerRequest() {
        const request = [
          "POST " + target.pathname + target.search + " HTTP/1.1",
          "Host: " + target.host,
          "Content-Type: application/json",
          "Accept: application/json",
          "Content-Length: " + Buffer.byteLength(body),
          "Connection: close",
          "",
          body
        ].join("\r\n");
        secure.write(request);
      });
      secure.on("data", function collectResponse(chunk) {
        chunks.push(chunk);
      });
      secure.on("end", function parseResponse() {
        try {
          const parsed = parseHttpResponse(Buffer.concat(chunks));
          finish(null, parseWorkerJsonResponse(parsed.status, parsed.text));
        } catch (error) {
          finish(error);
        }
      });
      secure.on("error", finish);
    }

    socket.on("connect", function connectProxy() {
      socket.write("CONNECT " + target.hostname + ":443 HTTP/1.1\r\nHost: " + target.hostname + ":443\r\n\r\n");
    });
    let proxyBuffer = Buffer.alloc(0);
    socket.on("data", function readProxyHandshake(chunk) {
      proxyBuffer = Buffer.concat([proxyBuffer, chunk]);
      const headerEnd = proxyBuffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        return;
      }
      const header = proxyBuffer.slice(0, headerEnd).toString("utf8");
      if (!/^HTTP\/1\.[01]\s+200\b/.test(header)) {
        finish(new Error("本地代理 CONNECT 失败：" + header.split(/\r\n/)[0]));
        return;
      }
      socket.removeAllListeners("data");
      startTlsTunnel(proxyBuffer.slice(headerEnd + 4));
    });
    socket.on("error", finish);
  });
}

/** Send one JSON request to the configured Cloudflare Worker. */
async function requestWorker(workerUrl, pathname, payload) {
  try {
    return await requestWorkerDirect(workerUrl, pathname, payload);
  } catch (error) {
    if (!isCloudTransportFailure(error)) {
      throw error;
    }
    try {
      const result = await requestWorkerViaLocalProxy(workerUrl, pathname, payload);
      console.warn("[cloud-auth] 直连云端失败，已通过本地代理完成同步：" + String(error.message || error));
      return result;
    } catch (proxyError) {
      proxyError.message = "云端授权请求失败：" + String(error.message || error) + "；本地代理失败：" + String(proxyError.message || proxyError);
      throw proxyError;
    }
  }
}

/** Apply the authoritative startup config even when a reused version number matches locally. */
function applyCloudConfigResponse(response, localState) {
  const cloudVersion = Math.max(0, Math.floor(Number(response.configVersion) || 0));
  const currentState = localState || readConfigState();
  if (!Object.prototype.hasOwnProperty.call(response, "config")) {
    throw new Error("云端未返回完整 config.json，启动同步已中止。");
  }
  const config = validateConfigPayload(response.config);
  writeJsonAtomic(CONFIG_PATH, config);
  const nextState = writeConfigState(cloudVersion, response.updatedAt);
  return {
    updated: true,
    localVersion: nextState.version,
    cloudVersion: cloudVersion,
    updatedAt: nextState.updatedAt
  };
}

/** Build the local identity values sent with every cloud authorization check. */
function buildClientIdentity() {
  const macAddress = readPrimaryMacAddress();
  const macHash = hashMacAddress(macAddress);
  return {
    deviceName: deviceName(),
    macHash: macHash,
    macMissing: !macHash
  };
}

/** Sync one access hash against Cloudflare and force one complete config download for this startup. */
async function syncWithAccessHash(workerUrl, accessHash) {
  const normalizedUrl = normalizeWorkerUrl(workerUrl);
  const normalizedHash = String(accessHash || "").trim().toLocaleLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalizedHash)) {
    throw new Error("访问码摘要无效。");
  }
  const localState = readConfigState();
  const identity = buildClientIdentity();
  const response = await requestWorker(normalizedUrl, "/api/user/config", {
    accessHash: normalizedHash,
    localVersion: -1,
    deviceName: identity.deviceName,
    macHash: identity.macHash,
    macMissing: identity.macMissing
  });
  const configSync = applyCloudConfigResponse(response, localState);
  const account = response.account && typeof response.account === "object" ? response.account : {};
  return {
    authorized: true,
    accountName: String(account.name || ""),
    macBound: Boolean(account.macBound),
    macMissing: identity.macMissing,
    configChannel: String(response.configChannel || "current"),
    configUpdated: configSync.updated,
    configVersion: configSync.cloudVersion || configSync.localVersion,
    lastSyncAt: new Date().toISOString(),
    workerUrl: normalizedUrl
  };
}

/** Return the last startup sync metadata without contacting Cloudflare again. */
function getConfigSyncStatus() {
  const state = readConfigState();
  const runtime = readRuntimeAuthorizedStatus();
  return {
    authorized: Boolean(runtime && runtime.authorized),
    accountName: runtime ? String(runtime.accountName || "") : "",
    configChannel: runtime ? String(runtime.configChannel || "current") : "",
    configVersion: state.version,
    configUpdatedAt: state.updatedAt,
    lastSyncAt: state.lastSyncAt
  };
}

/** Login with a freshly supplied access hash and save it only after cloud authorization succeeds. */
async function loginAndSync(input) {
  const source = input && typeof input === "object" ? input : {};
  const workerUrl = normalizeWorkerUrl(source.workerUrl || configuredWorkerUrl());
  const accessHash = String(source.accessHash || "").trim().toLocaleLowerCase();
  const result = await syncWithAccessHash(workerUrl, accessHash);
  saveCredential(workerUrl, accessHash, result.accountName);
  return rememberRuntimeAuthorizedStatus(result, true);
}

/** Sync the saved DPAPI credential during startup status checks. */
async function syncSavedCredential() {
  const cachedStatus = readRuntimeAuthorizedStatus();
  if (cachedStatus) {
    return cachedStatus;
  }
  const credential = readCredential();
  if (!credential || !credential.encryptedAccessHash) {
    return {
      authorized: false,
      hasCredential: false,
      loginRequired: true,
      workerUrl: configuredWorkerUrl(),
      message: "尚未登录。"
    };
  }
  let accessHash = "";
  try {
    accessHash = runDpapi("unprotect", credential.encryptedAccessHash);
  } catch (error) {
    if (error && error.code === "DPAPI_UNPROTECT_FAILED") {
      return {
        authorized: false,
        hasCredential: false,
        loginRequired: true,
        credentialUnreadable: true,
        workerUrl: credential.workerUrl,
        message: "本机授权凭据属于其他 Windows 用户或设备，请重新输入访问码。"
      };
    }
    throw error;
  }
  const result = await syncWithAccessHash(credential.workerUrl, accessHash);
  saveCredential(credential.workerUrl, accessHash, result.accountName || credential.accountName);
  return rememberRuntimeAuthorizedStatus(result, true);
}

/** Return a lightweight local-only status when no cloud login can be attempted yet. */
function localStatus() {
  const credential = readCredential();
  const state = readConfigState();
  return {
    authorized: false,
    hasCredential: Boolean(credential && credential.encryptedAccessHash),
    accountName: credential ? credential.accountName : "",
    configVersion: state.version,
    lastSyncAt: state.lastSyncAt,
    workerUrl: credential ? credential.workerUrl : configuredWorkerUrl()
  };
}

/** Delete the encrypted local credential while leaving the last synced config intact. */
function clearCredential() {
  clearRuntimeAuthorizedStatus();
  try {
    fs.unlinkSync(CREDENTIAL_PATH);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
  return localStatus();
}

module.exports = {
  clearCredential: clearCredential,
  getConfigSyncStatus: getConfigSyncStatus,
  localStatus: localStatus,
  loginAndSync: loginAndSync,
  syncSavedCredential: syncSavedCredential
};
