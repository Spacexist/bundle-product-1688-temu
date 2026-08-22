const fs = require("fs");
const path = require("path");

const configPath = path.resolve(__dirname, "..", "config.json");

/** Read the private server configuration and apply local-only defaults. */
function readServerConfig() {
  let source = {};
  if (fs.existsSync(configPath)) {
    source = JSON.parse(fs.readFileSync(configPath, "utf8"));
  }
  const server = source.server && typeof source.server === "object" ? source.server : {};
  const storage = source.storage && typeof source.storage === "object" ? source.storage : {};
  const workflow = source.workflow && typeof source.workflow === "object" ? source.workflow : {};
  source.server = {
    host: String(server.host || "127.0.0.1"),
    port: Number(server.port || 3000),
    corsOrigins: Array.isArray(server.corsOrigins)
      ? server.corsOrigins
      : ["http://127.0.0.1:5173", "http://localhost:5173", "chrome-extension://*"]
  };
  source.storage = {
    cacheDirectory: String(storage.cacheDirectory || "D:/自动组货/cache"),
    imageDirectory: String(storage.imageDirectory || "D:/自动组货/cache/image"),
    historyDirectory: String(storage.historyDirectory || "D:/自动组货/cache/history"),
    historyLimit: Number(storage.historyLimit || 200)
  };
  source.workflow = {
    default_mode: String(workflow.default_mode || "clip") === "legacy" ? "legacy" : "clip",
    clip_candidate_count: Math.max(1, Math.min(Number(workflow.clip_candidate_count || 10), 40)),
    legacy_candidate_count: Math.max(1, Math.min(Number(workflow.legacy_candidate_count || 4), 10)),
    clip_kimi_system_prompt: String(workflow.clip_kimi_system_prompt || ""),
    clip_kimi_prompt: String(workflow.clip_kimi_prompt || "")
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
      image_timeout_ms: Number(image.image_timeout_ms || image.timeout_ms || 300000),
      quality: ["low", "medium", "high"].includes(String(image.quality || "medium").toLowerCase())
        ? String(image.quality || "medium").toLowerCase()
        : "medium",
      model: image.model || "",
      price: image.price || {},
      edit_prompt: image.edit_prompt || "",
      fusion_prompt: image.fusion_prompt || "",
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
      clip_kimi_prompt: source.workflow.clip_kimi_prompt
    }
  };
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
  readServerConfig: readServerConfig,
  writeServerConfig: writeServerConfig,
  createPublicServerConfig: createPublicServerConfig
};
