const fs = require("fs");
const path = require("path");
const configModule = require("../config/config-loader");

const DEFAULT_PROMPT_PATH = path.resolve(__dirname, "..", "default.prompt.json");
const DEFAULT_TEMPLATE_ID = "template-default";
const DEFAULT_STORYBOARD_SYSTEM_PROMPT = "你是电商商品图合成助手。两张输入图是商品外观的唯一依据，必须保持商品的款式、结构、颜色、材质、比例和关键细节真实一致，不得增删、替换或错误融合部件。\n\n构图、背景、视角、场景、排版和文案以当前分镜要求为准，不必沿用原图背景。画面中凡需生成的文字，必须全部使用英文，不得出现中文或其他语言；未要求文字时，不添加文字、Logo 或水印。\n\n确保两张图中的目标商品和必要配件完整、清晰、可识别，整体光线、透视、比例和阴影自然统一，不虚构商品功能。";

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

/** Normalize one template's storyboard prompts without silently dropping invalid rows. */
function normalizeDefaultPromptPages(pages, templateName) {
  const sourcePages = Array.isArray(pages) ? pages : [];
  if (!sourcePages.length || sourcePages.length > 10) {
    throw createConfigError("模板“" + String(templateName || "未命名") + "”的分镜数量必须为 1 到 10。", 400, "DEFAULT_PROMPT_COUNT_INVALID");
  }
  const normalized = [];
  for (let index = 0; index < sourcePages.length; index += 1) {
    const item = sourcePages[index] && typeof sourcePages[index] === "object" ? sourcePages[index] : {};
    const prompt = String(item.prompt || "").trim();
    if (!prompt) {
      throw createConfigError("模板“" + String(templateName || "未命名") + "”的分镜 " + (index + 1) + " 提示词不能为空。", 400, "DEFAULT_PROMPT_EMPTY");
    }
    if (prompt.length > 10000) {
      throw createConfigError("模板“" + String(templateName || "未命名") + "”的分镜 " + (index + 1) + " 提示词过长。", 400, "DEFAULT_PROMPT_TOO_LONG");
    }
    const purpose = String(item.purpose || "分镜" + (index + 1)).trim() || "分镜" + (index + 1);
    if (purpose.length > 500) {
      throw createConfigError("模板“" + String(templateName || "未命名") + "”的分镜 " + (index + 1) + "名称过长。", 400, "DEFAULT_PROMPT_PURPOSE_TOO_LONG");
    }
    normalized.push({ purpose: purpose, prompt: prompt });
  }
  return normalized;
}

/** Normalize a legacy page list or a complete multi-template configuration. */
function normalizeDefaultPromptConfig(payload) {
  const source = payload && typeof payload === "object" ? payload : {};
  const systemPrompt = String(source.system_prompt || DEFAULT_STORYBOARD_SYSTEM_PROMPT).trim() || DEFAULT_STORYBOARD_SYSTEM_PROMPT;
  if (systemPrompt.length > 10000) {
    throw createConfigError("默认分镜系统提示词不能超过 10000 个字符。", 400, "DEFAULT_SYSTEM_PROMPT_TOO_LONG");
  }
  const legacy = Array.isArray(source.pages);
  const sourceTemplates = legacy
    ? [{ id: DEFAULT_TEMPLATE_ID, name: "默认模板", pages: source.pages }]
    : Array.isArray(source.templates) ? source.templates : [];
  if (!sourceTemplates.length || sourceTemplates.length > 50) {
    throw createConfigError("分镜模板数量必须为 1 到 50。", 400, "DEFAULT_TEMPLATE_COUNT_INVALID");
  }
  const templates = [];
  const ids = new Set();
  const names = new Set();
  for (let index = 0; index < sourceTemplates.length; index += 1) {
    const item = sourceTemplates[index] && typeof sourceTemplates[index] === "object" ? sourceTemplates[index] : {};
    const id = String(item.id || (index === 0 ? DEFAULT_TEMPLATE_ID : "template-" + (index + 1))).trim();
    const name = String(item.name || (index === 0 ? "默认模板" : "模板 " + (index + 1))).trim();
    const normalizedName = name.toLocaleLowerCase("zh-CN");
    if (!id || id.length > 100 || ids.has(id)) {
      throw createConfigError("分镜模板 ID 不能为空、重复或超过 100 个字符。", 400, "DEFAULT_TEMPLATE_ID_INVALID");
    }
    if (!name || name.length > 100 || names.has(normalizedName)) {
      throw createConfigError("分镜模板名称不能为空、重复或超过 100 个字符。", 400, "DEFAULT_TEMPLATE_NAME_INVALID");
    }
    ids.add(id);
    names.add(normalizedName);
    templates.push({ id: id, name: name, pages: normalizeDefaultPromptPages(item.pages, name) });
  }
  const requestedDefaultId = String(source.default_template_id || "").trim();
  if (!legacy && (!requestedDefaultId || !ids.has(requestedDefaultId))) {
    throw createConfigError("默认分镜模板不存在。", 400, "DEFAULT_TEMPLATE_NOT_FOUND");
  }
  const defaultTemplateId = ids.has(requestedDefaultId) ? requestedDefaultId : templates[0].id;
  return { version: 2, system_prompt: systemPrompt, default_template_id: defaultTemplateId, templates: templates };
}

/** Replace one JSON file through a same-directory temporary file. */
function writeDefaultPromptFile(filePath, config) {
  const temporaryPath = filePath + ".tmp-" + process.pid + "-" + Date.now();
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify(config, null, 2) + "\n", "utf8");
    fs.renameSync(temporaryPath, filePath);
  } finally {
    if (fs.existsSync(temporaryPath)) {
      fs.unlinkSync(temporaryPath);
    }
  }
}

/** Read server/default.prompt.json, migrating its legacy page-only shape in place. */
function readDefaultPromptConfig(filePath, fallbackPages) {
  const targetPath = filePath || DEFAULT_PROMPT_PATH;
  if (!fs.existsSync(targetPath)) {
    const fallback = normalizeDefaultPromptConfig({ pages: fallbackPages || createFallbackDefaultPromptPages() });
    return Object.assign({ path: targetPath }, fallback);
  }
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(targetPath, "utf8"));
  } catch (error) {
    throw createConfigError("server/default.prompt.json 不是有效 JSON。", 400, "DEFAULT_PROMPT_JSON_INVALID");
  }
  const config = normalizeDefaultPromptConfig(payload);
  if (Array.isArray(payload && payload.pages) || !String(payload && payload.system_prompt || "").trim()) {
    writeDefaultPromptFile(targetPath, config);
  }
  return Object.assign({ path: targetPath }, config);
}

/** Persist all storyboard templates beside server/cookie.json. */
function writeDefaultPromptConfig(input, filePath) {
  const targetPath = filePath || DEFAULT_PROMPT_PATH;
  const config = normalizeDefaultPromptConfig(input);
  writeDefaultPromptFile(targetPath, config);
  return Object.assign({ path: targetPath }, config);
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
      response.json({ ok: true, data: writeDefaultPromptConfig(request.validatedBody), error: null, meta: { request_id: request.requestId } });
    } catch (error) {
      next(error);
    }
  }
}

module.exports = {
  ConfigController: ConfigController,
  DEFAULT_STORYBOARD_SYSTEM_PROMPT: DEFAULT_STORYBOARD_SYSTEM_PROMPT,
  normalizeDefaultPromptConfig: normalizeDefaultPromptConfig,
  readDefaultPromptConfig: readDefaultPromptConfig,
  writeDefaultPromptConfig: writeDefaultPromptConfig
};
