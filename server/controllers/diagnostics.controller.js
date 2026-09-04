const configModule = require("../config/config-loader");
const cloudAuthModule = require("../services/cloud-auth.service");

/** Diagnostics HTTP controller for the local log and image queue pages. */
class DiagnosticsController {
  /** Store the shared diagnostics service. */
  constructor(options) {
    const settings = options || {};
    this.diagnostics = settings.diagnostics;
    this.clipWorker = settings.clipWorker;
  }

  /** Return the latest real CLIP loading stage for the workbench progress bar. */
  getClipStatus(request, response) {
    response.json({
      ok: true,
      data: { status: this.clipWorker.getLoadingStatus() },
      error: null,
      meta: { request_id: request.requestId || "" }
    });
  }

  /** Start CLIP loading in the background without delaying the HTTP response. */
  warmClip(request, response) {
    this.clipWorker.warmup().catch(function retainClipWarmupFailureInServiceLog() {
      return;
    });
    response.status(202).json({
      ok: true,
      data: { status: this.clipWorker.getLoadingStatus() },
      error: null,
      meta: { request_id: request.requestId || "" }
    });
  }

  /** Return the bounded in-memory server log history. */
  getLogs(request, response) {
    response.json({
      ok: true,
      data: {
        logs: this.diagnostics.getLogs(),
        last_event_id: this.diagnostics.serverLogSequence
      },
      error: null,
      meta: { request_id: request.requestId }
    });
  }

  /** Open the server log SSE stream. */
  connectLogs(request, response) {
    this.diagnostics.connectLogs(request, response);
  }

  /** Return the current image task queue snapshot. */
  getQueue(request, response) {
    response.json({
      ok: true,
      data: { queue: this.diagnostics.getQueueSnapshot() },
      error: null,
      meta: { request_id: request.requestId }
    });
  }

  /** Return retained image execution metadata without polling the provider. */
  getImageTasks(request, response) {
    response.setHeader("Cache-Control", "no-store");
    response.json({
      ok: true,
      data: this.diagnostics.imageTaskQueue.getTaskHistory(),
      error: null,
      meta: { request_id: request.requestId || "" }
    });
  }

  /** Open the image task queue SSE stream. */
  connectQueue(request, response) {
    this.diagnostics.connectQueue(request, response);
  }

  /** Return the complete local effective configuration with every secret masked. */
  getServerConfig(request, response) {
    const config = configModule.readServerConfig();
    const publicConfig = configModule.createPublicServerConfig(config);
    const sync = cloudAuthModule.getConfigSyncStatus();
    response.setHeader("Cache-Control", "no-store");
    response.json({
      ok: true,
      data: {
        effective: {
          quality: publicConfig.image.quality,
          model: publicConfig.image.model,
          config_version: sync.configVersion
        },
        sync: sync,
        config: configModule.createRedactedServerConfig(config)
      },
      error: null,
      meta: { request_id: request.requestId || "" }
    });
  }

  /** Return masked summaries of independently retained final image failures. */
  getImageFailures(request, response) {
    response.setHeader("Cache-Control", "no-store");
    response.json({ ok: true, data: this.diagnostics.imageTaskQueue.getFailures(), error: null, meta: { request_id: request.requestId || "" } });
  }

  /** Return one failure's full-URL detail only when explicitly expanded locally. */
  getImageFailureDetail(request, response) {
    const task = this.diagnostics.imageTaskQueue.getFailureDetail(String(request.params.executionId || ""));
    response.setHeader("Cache-Control", "no-store");
    response.status(task ? 200 : 404).json({
      ok: Boolean(task), data: task ? { task: task } : null,
      error: task ? null : { code: "IMAGE_FAILURE_NOT_FOUND", message: "失败记录不存在或已超过保留期限。" },
      meta: { request_id: request.requestId || "" }
    });
  }
}

module.exports = { DiagnosticsController: DiagnosticsController };
