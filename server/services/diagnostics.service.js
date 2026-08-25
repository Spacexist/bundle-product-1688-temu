/** Format one date for the local diagnostics page. */
function formatDiagnosticsTime(date) {
  const value = new Date(date);
  /** Pad one date or time segment to two characters. */
  function padTimePart(number) {
    return String(number).padStart(2, "0");
  }
  return value.getFullYear() + "-"
    + padTimePart(value.getMonth() + 1) + "-"
    + padTimePart(value.getDate()) + " "
    + padTimePart(value.getHours()) + ":"
    + padTimePart(value.getMinutes()) + ":"
    + padTimePart(value.getSeconds());
}

/** Remove credentials, base64 bodies, and oversized values from diagnostics. */
function createSafeDiagnosticsValue(value, keyName) {
  const normalizedKey = String(keyName || "").toLowerCase();
  if (normalizedKey.indexOf("apikey") >= 0
    || normalizedKey.indexOf("api_key") >= 0
    || normalizedKey.indexOf("authorization") >= 0
    || normalizedKey === "token") {
    return "[REDACTED]";
  }
  if (typeof value === "string") {
    if (normalizedKey.indexOf("base64") >= 0) {
      return "[BASE64 DATA, " + value.length + " chars]";
    }
    if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(value)) {
      const commaIndex = value.indexOf(",");
      const mimeType = value.slice(5, value.indexOf(";", 5));
      const base64Length = commaIndex >= 0 ? value.length - commaIndex - 1 : value.length;
      return "[BASE64 IMAGE " + mimeType + ", " + base64Length + " chars]";
    }
    if (value.length > 2000) {
      return value.slice(0, 500) + "... [TRUNCATED, " + value.length + " chars]";
    }
    return value;
  }
  if (Array.isArray(value)) {
    const safeArray = [];
    const arrayLimit = Math.min(value.length, 20);
    for (let index = 0; index < arrayLimit; index += 1) {
      safeArray.push(createSafeDiagnosticsValue(value[index], keyName));
    }
    if (value.length > arrayLimit) {
      safeArray.push("... [" + (value.length - arrayLimit) + " items omitted]");
    }
    return safeArray;
  }
  if (value && typeof value === "object") {
    const safeObject = {};
    const keys = Object.keys(value);
    const objectLimit = Math.min(keys.length, 50);
    for (let index = 0; index < objectLimit; index += 1) {
      const childKey = keys[index];
      safeObject[childKey] = createSafeDiagnosticsValue(value[childKey], childKey);
    }
    if (keys.length > objectLimit) {
      safeObject.__omitted_keys__ = keys.length - objectLimit;
    }
    return safeObject;
  }
  return value;
}

/** Map one lifecycle direction to the flow shown by the diagnostics page. */
function resolveDiagnosticsFlow(direction) {
  const normalizedDirection = String(direction || "INFO").toUpperCase();
  if (normalizedDirection === "RECEIVE" || normalizedDirection === "RECEIVE BODY") {
    return { key: "frontend_request", label: "前端 → 后端" };
  }
  if (normalizedDirection === "BROADCAST") {
    return { key: "backend_broadcast", label: "后端 → 前端广播" };
  }
  if (normalizedDirection === "OUTBOUND") {
    return { key: "backend_outbound", label: "后端 → 上游/Worker" };
  }
  if (normalizedDirection === "UPSTREAM") {
    return { key: "upstream_response", label: "上游/Worker → 后端" };
  }
  if (normalizedDirection === "SEND" || normalizedDirection === "DONE") {
    return { key: "backend_response", label: "后端 → 前端响应" };
  }
  return { key: "system", label: "服务器内部" };
}

/** Own server logs and image queue streams without exposing HTTP details to services. */
class DiagnosticsService {
  /** Initialize bounded log and diagnostics subscriber state. */
  constructor(options) {
    const settings = options || {};
    this.maxLogEntries = Number(settings.maxLogEntries || 300);
    this.serverLogEntries = [];
    this.serverLogClients = [];
    this.queueClients = [];
    this.serverLogSequence = 0;
    this.queueSequence = 0;
    this.sseRetryMs = 5000;
    this.sseHeartbeatMs = 15000;
    this.imageTaskQueue = null;
  }

  /** Return a formatted timestamp for workflow and diagnostics persistence. */
  formatTime(date) {
    return formatDiagnosticsTime(date);
  }

  /** Write one redacted structured server event and broadcast it to log pages. */
  write(direction, label, payload, requestId) {
    const time = formatDiagnosticsTime(new Date());
    const normalizedRequestId = String(requestId || "-");
    const flow = resolveDiagnosticsFlow(direction);
    const safePayload = payload === undefined ? null : createSafeDiagnosticsValue(payload, "");
    const entry = {
      event_id: ++this.serverLogSequence,
      time: time,
      request_id: normalizedRequestId,
      direction: String(direction || "INFO"),
      flow: flow.key,
      flow_label: flow.label,
      label: String(label || ""),
      payload: safePayload
    };
    const prefix = "[" + time + "]"
      + " [" + normalizedRequestId + "]"
      + " [" + flow.label + "]"
      + " [" + direction + "] " + label;
    this.serverLogEntries.push(entry);
    if (this.serverLogEntries.length > this.maxLogEntries) {
      this.serverLogEntries.splice(0, this.serverLogEntries.length - this.maxLogEntries);
    }
    console.log(prefix);
    if (payload !== undefined) {
      const consolePayload = JSON.stringify(safePayload);
      if (consolePayload.length > 8000) {
        console.log(consolePayload.slice(0, 8000) + "... [TRUNCATED FOR CONSOLE, " + consolePayload.length + " chars]");
      } else {
        console.log(consolePayload);
      }
    }
    this.broadcastLogEntry(entry);
  }

  /** Return a copy of the current diagnostics history. */
  getLogs() {
    return this.serverLogEntries.slice();
  }

  /** Create one SSE frame with an optional resumable event identifier. */
  createSseMessage(payload, eventId) {
    const idLine = eventId === undefined || eventId === null ? "" : "id: " + String(eventId) + "\n";
    return idLine + "data: " + JSON.stringify(payload) + "\n\n";
  }

  /** Read the last event cursor sent by a browser during an SSE reconnect. */
  getSseCursor(request) {
    const headers = request && request.headers ? request.headers : {};
    const query = request && request.query ? request.query : {};
    const headerValue = headers["last-event-id"] || headers["Last-Event-ID"];
    const queryValue = query.after || query.lastEventId || query.last_event_id;
    const cursor = Number(headerValue || queryValue || 0);
    return Number.isFinite(cursor) && cursor > 0 ? cursor : 0;
  }

  /** Remove one SSE client and stop its heartbeat timer. */
  removeSseClient(clientList, client) {
    if (!client || client.closed) {
      return;
    }
    client.closed = true;
    if (client.heartbeat) {
      clearInterval(client.heartbeat);
      client.heartbeat = null;
    }
    const index = clientList.indexOf(client);
    if (index >= 0) {
      clientList.splice(index, 1);
    }
  }

  /** Write one SSE frame and evict a disconnected or backpressured browser. */
  writeSseClient(clientList, client, message) {
    if (!client || client.closed) {
      return false;
    }
    try {
      const writable = client.response.write(message);
      if (writable === false) {
        this.removeSseClient(clientList, client);
        if (client.response && typeof client.response.destroy === "function") {
          client.response.destroy();
        }
        return false;
      }
      return true;
    } catch (error) {
      this.removeSseClient(clientList, client);
      return false;
    }
  }

  /** Start a bounded heartbeat that keeps one SSE connection observable. */
  startSseHeartbeat(clientList, client) {
    const service = this;
    /** Write one heartbeat comment and remove an unresponsive client. */
    function writeHeartbeat() {
      service.writeSseClient(clientList, client, ": heartbeat\n\n");
    }
    client.heartbeat = setInterval(writeHeartbeat, this.sseHeartbeatMs);
    if (client.heartbeat && typeof client.heartbeat.unref === "function") {
      client.heartbeat.unref();
    }
  }

  /** Attach one browser to the redacted server log stream. */
  connectLogs(request, response) {
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no"
    });
    if (typeof response.flushHeaders === "function") {
      response.flushHeaders();
    }
    const client = { response: response, heartbeat: null, closed: false };
    const cursor = this.getSseCursor(request);
    this.serverLogClients.push(client);
    this.writeSseClient(this.serverLogClients, client, "retry: " + this.sseRetryMs + "\n\n");
    for (let index = 0; index < this.serverLogEntries.length; index += 1) {
      const entry = this.serverLogEntries[index];
      if (Number(entry.event_id) > cursor) {
        if (!this.writeSseClient(this.serverLogClients, client, this.createSseMessage(entry, entry.event_id))) {
          break;
        }
      }
    }
    if (!client.closed) {
      this.startSseHeartbeat(this.serverLogClients, client);
    }
    const service = this;
    /** Remove one disconnected log page from the subscriber list. */
    function removeLogClient() {
      service.removeSseClient(service.serverLogClients, client);
    }
    request.on("close", removeLogClient);
    if (typeof response.on === "function") {
      response.on("error", removeLogClient);
    }
  }

  /** Register the shared image task queue used by provider and workflow services. */
  setImageTaskQueue(queue) {
    this.imageTaskQueue = queue;
  }

  /** Return the current image task queue snapshot for diagnostics. */
  getQueueSnapshot() {
    if (!this.imageTaskQueue) {
      return { concurrency: 3, active: 0, pending: 0, active_tasks: [], pending_tasks: [] };
    }
    return this.imageTaskQueue.getSnapshot();
  }

  /** Attach one browser to the shared image queue stream. */
  connectQueue(request, response) {
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no"
    });
    if (typeof response.flushHeaders === "function") {
      response.flushHeaders();
    }
    const client = { response: response, heartbeat: null, closed: false };
    this.queueClients.push(client);
    const initialPayload = {
      action: "connected",
      event_id: this.queueSequence,
      queue: this.getQueueSnapshot()
    };
    this.writeSseClient(this.queueClients, client, "retry: " + this.sseRetryMs + "\n\n");
    this.writeSseClient(this.queueClients, client, this.createSseMessage(initialPayload, this.queueSequence));
    if (!client.closed) {
      this.startSseHeartbeat(this.queueClients, client);
    }
    const service = this;
    /** Remove one disconnected queue page from the subscriber list. */
    function removeQueueClient() {
      service.removeSseClient(service.queueClients, client);
    }
    request.on("close", removeQueueClient);
    if (typeof response.on === "function") {
      response.on("error", removeQueueClient);
    }
  }

  /** Broadcast one queue transition to every diagnostics page. */
  handleQueueChange(snapshot, event) {
    this.queueSequence += 1;
    const payload = {
      action: "queue_snapshot",
      event_id: this.queueSequence,
      event: event || null,
      queue: snapshot || this.getQueueSnapshot()
    };
    const message = this.createSseMessage(payload, payload.event_id);
    for (let index = this.queueClients.length - 1; index >= 0; index -= 1) {
      this.writeSseClient(this.queueClients, this.queueClients[index], message);
    }
  }

  /** Broadcast one log entry and drop disconnected subscribers. */
  broadcastLogEntry(entry) {
    const message = this.createSseMessage(entry, entry.event_id);
    for (let index = this.serverLogClients.length - 1; index >= 0; index -= 1) {
      this.writeSseClient(this.serverLogClients, this.serverLogClients[index], message);
    }
  }
}

module.exports = {
  DiagnosticsService: DiagnosticsService,
  formatDiagnosticsTime: formatDiagnosticsTime,
  createSafeDiagnosticsValue: createSafeDiagnosticsValue
};
