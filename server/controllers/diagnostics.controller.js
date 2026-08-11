/** Diagnostics HTTP controller for the local log and image queue pages. */
class DiagnosticsController {
  /** Store the shared diagnostics service. */
  constructor(options) {
    const settings = options || {};
    this.diagnostics = settings.diagnostics;
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

  /** Open the image task queue SSE stream. */
  connectQueue(request, response) {
    this.diagnostics.connectQueue(request, response);
  }
}

module.exports = { DiagnosticsController: DiagnosticsController };
