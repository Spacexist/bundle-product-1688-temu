const fs = require("fs");
const path = require("path");
const configModule = require("../config/config-loader");

const DEFAULT_PROMPT_PATH = path.resolve(__dirname, "..", "default.prompt.json");

/** Create one config error with an HTTP status and stable code. */
function createConfigError(message, statusCode, code) {
  const error = new Error(String(message || "配置处理失败。"));
  error.statusCode = Number(statusCode || 500);
  error.code = String(code || "CONFIG_ERROR");
  return error;
}

/** Return bundled default storyboard prompts when default.prompt.json is missing. */
function createFallbackDefaultPromptPages() {
  const config = configModule.readServerConfig();
  const kimi = config.kimi && typeof config.kimi === "object" ? config.kimi : {};
  const prompt = String(kimi.carousel_default_requirement || "基于两张商品原图生成一张自然电商主图，保持商品真实外观、颜色、材质、比例和关键细节一致。").trim();
  return [
    { purpose: "分镜1", prompt: prompt },
    { purpose: "分镜2", prompt: prompt }
  ];
}

/** Normalize manually editable storyboard prompts before saving or generation. */
function normalizeDefaultPromptPages(pages) {
  const sourcePages = Array.isArray(pages) ? pages : [];
  const normalized = [];
  for (let index = 0; index < sourcePages.length; index += 1) {
    const item = sourcePages[index] && typeof sourcePages[index] === "object" ? sourcePages[index] : {};
    const prompt = String(item.prompt || "").trim();
    if (!prompt) {
      continue;
    }
    normalized.push({ purpose: String(item.purpose || "分镜" + (normalized.length + 1)).trim(), prompt: prompt });
  }
  if (!normalized.length || normalized.length > 10) {
    throw createConfigError("默认分镜数量必须为 1 到 10。", 400, "DEFAULT_PROMPT_COUNT_INVALID");
  }
  return normalized;
}

/** Read server/default.prompt.json or return fallback prompt pages. */
function readDefaultPromptConfig() {
  if (!fs.existsSync(DEFAULT_PROMPT_PATH)) {
    return { path: DEFAULT_PROMPT_PATH, pages: createFallbackDefaultPromptPages() };
  }
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(DEFAULT_PROMPT_PATH, "utf8"));
  } catch (error) {
    throw createConfigError("server/default.prompt.json 不是有效 JSON。", 400, "DEFAULT_PROMPT_JSON_INVALID");
  }
  return { path: DEFAULT_PROMPT_PATH, pages: normalizeDefaultPromptPages(payload && payload.pages) };
}

/** Persist default storyboard prompts beside server/cookie.json. */
function writeDefaultPromptConfig(pages) {
  const normalized = normalizeDefaultPromptPages(pages);
  fs.writeFileSync(DEFAULT_PROMPT_PATH, JSON.stringify({ pages: normalized }, null, 2), "utf8");
  return { path: DEFAULT_PROMPT_PATH, pages: normalized };
}

/** Server configuration controller that never returns plaintext credentials. */
class ConfigController {
  /** Return the public masked provider configuration. */
  getPublicConfig(request, response, next) {
    try {
      const data = configModule.createPublicServerConfig(configModule.readServerConfig());
      response.json({ ok: true, data: data, error: null, meta: { request_id: request.requestId } });
    } catch (error) {
      next(error);
    }
  }

  /** Save submitted provider keys on the backend only. */
  updateSecrets(request, response, next) {
    try {
      const input = request.validatedBody;
      const config = configModule.readServerConfig();
      if (input.image_apikey) {
        if (config.image && typeof config.image === "object") {
          config.image.apikey = input.image_apikey;
        } else {
          config.apikey = input.image_apikey;
        }
      }
      if (!config.kimi || typeof config.kimi !== "object") {
        config.kimi = {};
      }
      if (input.kimi_apikey) {
        config.kimi.apikey = input.kimi_apikey;
      }
      const saved = configModule.writeServerConfig(config);
      response.json({ ok: true, data: configModule.createPublicServerConfig(saved), error: null, meta: { request_id: request.requestId } });
    } catch (error) {
      next(error);
    }
  }

  /** Return the default storyboard prompt file used by the image editor. */
  getDefaultPrompts(request, response, next) {
    try {
      response.json({ ok: true, data: readDefaultPromptConfig(), error: null, meta: { request_id: request.requestId } });
    } catch (error) {
      next(error);
    }
  }

  /** Persist the default storyboard prompt file used by the image editor. */
  updateDefaultPrompts(request, response, next) {
    try {
      response.json({ ok: true, data: writeDefaultPromptConfig(request.validatedBody.pages), error: null, meta: { request_id: request.requestId } });
    } catch (error) {
      next(error);
    }
  }
}

module.exports = { ConfigController: ConfigController };
