const cloudAuthModule = require("../services/cloud-auth.service");

/** Controller for Cloudflare-backed authorization and config synchronization. */
class CloudAuthController {
  /** Return a status envelope after trying the saved cloud credential. */
  async getStatus(request, response) {
    try {
      const data = await cloudAuthModule.syncSavedCredential();
      response.json({ ok: true, data: data, error: null, meta: { request_id: request.requestId } });
    } catch (error) {
      const data = cloudAuthModule.localStatus();
      response.status(401).json({
        ok: false,
        data: data,
        error: { code: "CLOUD_AUTH_REQUIRED", message: error.message || "云端授权失败。", details: null },
        meta: { request_id: request.requestId }
      });
    }
  }

  /** Login with a browser-submitted access-code digest and sync cloud config. */
  async login(request, response) {
    try {
      const data = await cloudAuthModule.loginAndSync(request.body || {});
      response.json({ ok: true, data: data, error: null, meta: { request_id: request.requestId } });
    } catch (error) {
      response.status(401).json({
        ok: false,
        data: cloudAuthModule.localStatus(),
        error: { code: "CLOUD_AUTH_LOGIN_FAILED", message: error.message || "授权登录失败。", details: null },
        meta: { request_id: request.requestId }
      });
    }
  }

  /** Remove the saved local credential so the next page load asks for a code. */
  clearCredential(request, response, next) {
    try {
      const data = cloudAuthModule.clearCredential();
      response.json({ ok: true, data: data, error: null, meta: { request_id: request.requestId } });
    } catch (error) {
      next(error);
    }
  }
}

module.exports = { CloudAuthController: CloudAuthController };
