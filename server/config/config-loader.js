const fs = require("fs");
const path = require("path");

const projectRoot = path.resolve(__dirname, "..", "..");
const configPath = path.resolve(__dirname, "..", "config.json");
const exampleConfigPath = path.resolve(__dirname, "..", "config.example.json");

/** Ensure first-run installs have a private config file before the server reads it. */
function ensureServerConfigFile() {
  if (fs.existsSync(configPath)) {
    return;
  }
  if (!fs.existsSync(exampleConfigPath)) {
    return;
  }
  fs.copyFileSync(exampleConfigPath, configPath);
}

/** Return whether one absolute Windows drive root exists on this machine. */
function hasUsableDriveRoot(filePath) {
  if (process.platform !== "win32") {
    return true;
  }
  const resolved = path.resolve(String(filePath || ""));
  const root = path.parse(resolved).root;
  return !/^[a-z]:\\$/i.test(root) || fs.existsSync(root);
}

/** Return storage paths that fall back to a project-local cache when a drive is missing. */
function normalizeStorage(storage) {
  const source = storage && typeof storage === "object" ? storage : {};
  const configuredCacheDirectory = String(source.cacheDirectory || "D:/自动组货/cache");
  const configuredImageDirectory = String(source.imageDirectory || "D:/自动组货/cache/image");
  const configuredHistoryDirectory = String(source.historyDirectory || "D:/自动组货/cache/history");
  if (hasUsableDriveRoot(configuredCacheDirectory)) {
    return {
      cacheDirectory: configuredCacheDirectory,
      imageDirectory: configuredImageDirectory,
      historyDirectory: configuredHistoryDirectory,
      historyLimit: Number(source.historyLimit || 200)
    };
  }
  const fallbackCacheDirectory = path.join(projectRoot, "runtime", "cache");
  return {
    cacheDirectory: fallbackCacheDirectory,
    imageDirectory: path.join(fallbackCacheDirectory, "image"),
    historyDirectory: path.join(fallbackCacheDirectory, "history"),
    historyLimit: Number(source.historyLimit || 200)
  };
}

/** Read the private server configuration and apply local-only defaults. */
function readServerConfig() {
  ensureServerConfigFile();
  let source = {};
  if (fs.existsSync(configPath)) {
    source = JSON.parse(fs.readFileSync(configPath, "utf8"));
  }
  const server = source.server && typeof source.server === "object" ? source.server : {};
  const storage = source.storage && typeof source.storage === "object" ? source.storage : {};
  const workflow = source.workflow && typeof source.workflow === "object" ? source.workflow : {};
  const clipTranslation = workflow.clip_translation && typeof workflow.clip_translation === "object" ? workflow.clip_translation : {};
  source.server = {
    host: String(server.host || "127.0.0.1"),
    port: Number(server.port || 3000),
    corsOrigins: Array.isArray(server.corsOrigins)
      ? server.corsOrigins
      : ["http://127.0.0.1:5173", "http://localhost:5173", "chrome-extension://*"]
  };
  source.storage = normalizeStorage(storage);
  source.workflow = {
    default_mode: String(workflow.default_mode || "clip") === "legacy" ? "legacy" : "clip",
    clip_project_directory: String(workflow.clip_project_directory || "bundle/clip"),
    clip_python_command: String(workflow.clip_python_command || "bundle/python-runtime/python.exe"),
    clip_candidate_count: Math.max(1, Math.min(Number(workflow.clip_candidate_count || 10), 40)),
    legacy_candidate_count: Math.max(1, Math.min(Number(workflow.legacy_candidate_count || 4), 10)),
    clip_kimi_system_prompt: String(workflow.clip_kimi_system_prompt || ""),
    clip_kimi_prompt: String(workflow.clip_kimi_prompt || ""),
    clip_translation: {
      provider: String(clipTranslation.provider || "baidu"),
      baidu_appid: String(clipTranslation.baidu_appid || clipTranslation.appid || ""),
      baidu_secret_key: String(clipTranslation.baidu_secret_key || clipTranslation.secret_key || ""),
      timeout_ms: Math.max(800, Number(clipTranslation.timeout_ms || 1500)),
      google_timeout_ms: Math.max(1000, Number(clipTranslation.google_timeout_ms || 3500))
    }
  };
  return source;
}

/** Persist provider settings while keeping them exclusively on the server. */
function writeServerConfig(nextConfig) {
  fs.writeFileSync(configPath, JSON.stringify(nextConfig, null, 2), "utf8");
  return readServerConfig();
}

/** Return a browser-safe configuration with every credential masked. */
function createPublicServerConfig(config) {
  const source = config || readServerConfig();
  const image = source.image && typeof source.image === "object" ? source.image : source;
  const kimi = source.kimi && typeof source.kimi === "object" ? source.kimi : {};
  return {
    server: source.server,
    image: {
      baseurl: image.baseurl || "",
      endpoint: image.endpoint || "",
      generation_endpoint: image.generation_endpoint || "",
      generation_size: image.generation_size || "1024x1024",
      image_timeout_ms: 600000,
      quality: ["low", "medium", "high"].includes(String(image.quality || "medium").toLowerCase())
        ? String(image.quality || "medium").toLowerCase()
        : "medium",
      model: image.model || "",
      price: image.price || {},
      edit_prompt: image.edit_prompt || "",
      fusion_prompt: image.fusion_prompt || "",
      multi_fusion_prompt: image.multi_fusion_prompt || "",
      apikey_masked: maskSecret(image.apikey)
    },
    kimi: {
      baseurl: kimi.baseurl || "",
      endpoint: kimi.endpoint || "",
      model: kimi.model || "",
      timeout_ms: kimi.timeout_ms || 60000,
      workflow_prompt: kimi.workflow_prompt || "",
      carousel_default_requirement: kimi.carousel_default_requirement || "",
      apikey_masked: maskSecret(kimi.apikey)
    },
    workflow: {
      default_mode: source.workflow.default_mode,
      clip_candidate_count: source.workflow.clip_candidate_count,
      legacy_candidate_count: source.workflow.legacy_candidate_count,
      clip_kimi_prompt: source.workflow.clip_kimi_prompt,
      clip_translation: {
        provider: source.workflow.clip_translation.provider,
        timeout_ms: source.workflow.clip_translation.timeout_ms,
        google_timeout_ms: source.workflow.clip_translation.google_timeout_ms,
        baidu_appid_masked: maskSecret(source.workflow.clip_translation.baidu_appid),
        baidu_secret_key_masked: maskSecret(source.workflow.clip_translation.baidu_secret_key)
      }
    }
  };
}

/** Return whether one configuration key must never expose its raw value. */
function isSensitiveConfigKey(key) {
  return /(?:api[_-]?key|app[_-]?id|private[_-]?key|secret|password|passwd|token|cookie|authorization|credential|access[_-]?(?:code|hash))/i.test(String(key || ""));
}

/** Fully hide one present diagnostic credential regardless of its original length. */
function maskConfigSecret(value) {
  return value === undefined || value === null || String(value) === "" ? "" : "••••••";
}

/** Recursively clone server configuration while masking every credential-shaped field. */
function redactServerConfigValue(value, key) {
  if (isSensitiveConfigKey(key)) {
    return maskConfigSecret(value);
  }
  if (Array.isArray(value)) {
    return value.map(/** Redact nested array values without mutating the live configuration. */ function redactArrayItem(item) {
      return redactServerConfigValue(item, "");
    });
  }
  if (value && typeof value === "object") {
    const result = {};
    for (const childKey of Object.keys(value)) {
      result[childKey] = redactServerConfigValue(value[childKey], childKey);
    }
    return result;
  }
  return value;
}

/** Return the complete local server configuration with secrets masked for diagnostics. */
function createRedactedServerConfig(config) {
  return redactServerConfigValue(config || readServerConfig(), "");
}

/** Mask a secret without revealing enough characters to reconstruct it. */
function maskSecret(value) {
  const text = String(value || "");
  if (!text) {
    return "";
  }
  return text.slice(0, 3) + "••••••" + text.slice(-4);
}

module.exports = {
  ensureServerConfigFile: ensureServerConfigFile,
  readServerConfig: readServerConfig,
  writeServerConfig: writeServerConfig,
  createPublicServerConfig: createPublicServerConfig,
  createRedactedServerConfig: createRedactedServerConfig
};
