const configModule = require("../config/config-loader");

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
}

module.exports = { ConfigController: ConfigController };
