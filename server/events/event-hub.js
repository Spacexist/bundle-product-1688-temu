/** In-memory SSE hub that publishes lightweight invalidation events. */
class EventHub {
  /** Create an empty subscriber collection. */
  constructor(options) {
    const settings = options || {};
    this.clients = [];
    this.history = [];
    this.sequence = 0;
    this.maxHistory = Number(settings.maxHistory || 100);
    this.heartbeatMs = Number(settings.heartbeatMs || 15000);
    this.retryMs = Number(settings.retryMs || 5000);
    this.writeLog = settings.writeLog;
  }

  /** Create one SSE frame with a browser-resumable event identifier. */
  createSseMessage(payload, eventId) {
    const idLine = eventId === undefined || eventId === null ? "" : "id: " + String(eventId) + "\n";
    return idLine + "data: " + JSON.stringify(payload) + "\n\n";
  }

  /** Read the last event cursor sent by a browser during an SSE reconnect. */
  getEventCursor(request) {
    const headers = request && request.headers ? request.headers : {};
    const query = request && request.query ? request.query : {};
    const headerValue = headers["last-event-id"] || headers["Last-Event-ID"];
    const queryValue = query.after || query.lastEventId || query.last_event_id;
    const cursor = Number(headerValue || queryValue || 0);
    return Number.isFinite(cursor) && cursor > 0 ? cursor : 0;
  }

  /** Remove one product SSE client and stop its heartbeat timer. */
  removeClient(client) {
    if (!client || client.closed) {
      return;
    }
    client.closed = true;
    if (client.heartbeat) {
      clearInterval(client.heartbeat);
      client.heartbeat = null;
    }
    const index = this.clients.indexOf(client);
    if (index >= 0) {
      this.clients.splice(index, 1);
    }
  }

  /** Write one event frame and evict a disconnected or backpressured client. */
  writeClient(client, message) {
    if (!client || client.closed) {
      return false;
    }
    try {
      const writable = client.response.write(message);
      if (writable === false) {
        this.removeClient(client);
        if (client.response && typeof client.response.destroy === "function") {
          client.response.destroy();
        }
        return false;
      }
      return true;
    } catch (error) {
      this.removeClient(client);
      return false;
    }
  }

  /** Start a bounded heartbeat that keeps one product stream observable. */
  startHeartbeat(client) {
    const hub = this;
    /** Write one heartbeat comment and remove an unresponsive client. */
    function writeHeartbeat() {
      hub.writeClient(client, ": heartbeat\n\n");
    }
    client.heartbeat = setInterval(writeHeartbeat, this.heartbeatMs);
    if (client.heartbeat && typeof client.heartbeat.unref === "function") {
      client.heartbeat.unref();
    }
  }

  /** Store one bounded product invalidation event for reconnect replay. */
  rememberEvent(event) {
    this.history.push(event);
    if (this.history.length > this.maxHistory) {
      this.history.splice(0, this.history.length - this.maxHistory);
    }
  }

  /** Attach one browser to the event stream. */
  connect(request, response) {
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
    const cursor = this.getEventCursor(request);
    this.clients.push(client);
    this.writeClient(client, "retry: " + this.retryMs + "\n\n");
    let replayedCount = 0;
    if (cursor > 0) {
      for (let index = 0; index < this.history.length; index += 1) {
        const event = this.history[index];
        if (Number(event.event_id) <= cursor) {
          continue;
        }
        if (!this.writeClient(client, this.createSseMessage(event, event.event_id))) {
          break;
        }
        replayedCount += 1;
      }
    }
    if (cursor === 0 || replayedCount === 0) {
      const initialEvent = { resource: "system", action: "connected", ids: [], version: 1 };
      this.writeClient(client, this.createSseMessage(initialEvent));
    }
    if (!client.closed) {
      this.startHeartbeat(client);
    }
    if (typeof this.writeLog === "function") {
      this.writeLog("BROADCAST", "Product SSE initial event", {
        stream: "product",
        subscriber_count: this.clients.length,
        delivered_count: client.closed ? 0 : 1,
        replayed_count: replayedCount,
        cursor: cursor
      }, request.requestId);
    }
    const hub = this;
    /** Remove the disconnected response from the subscriber list. */
    function removeDisconnectedClient() {
      hub.removeClient(client);
    }
    request.on("close", removeDisconnectedClient);
    if (typeof response.on === "function") {
      response.on("error", removeDisconnectedClient);
    }
  }

  /** Publish one lightweight refetch instruction to all clients. */
  publish(event, requestId) {
    const payload = event && typeof event === "object" ? Object.assign({}, event) : {};
    payload.event_id = ++this.sequence;
    this.rememberEvent(payload);
    const message = this.createSseMessage(payload, payload.event_id);
    const subscriberCount = this.clients.length;
    let deliveredCount = 0;
    for (let index = this.clients.length - 1; index >= 0; index -= 1) {
      if (this.writeClient(this.clients[index], message)) {
        deliveredCount += 1;
      }
    }
    if (typeof this.writeLog === "function") {
      this.writeLog("BROADCAST", "Product SSE broadcast", {
        stream: "product",
        subscriber_count: subscriberCount,
        delivered_count: deliveredCount,
        resource: event && event.resource,
        action: event && event.action,
        ids: event && event.ids,
        version: event && event.version,
        event_id: payload.event_id
      }, requestId);
    }
  }
}

module.exports = { EventHub: EventHub };
