/** In-memory SSE hub that publishes lightweight invalidation events. */
class EventHub {
  /** Create an empty subscriber collection. */
  constructor(options) {
    const settings = options || {};
    this.clients = [];
    this.writeLog = settings.writeLog;
  }

  /** Attach one browser to the event stream. */
  connect(request, response) {
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive"
    });
    const initialEvent = { resource: "system", action: "connected", ids: [], version: 1 };
    response.write("data: " + JSON.stringify(initialEvent) + "\n\n");
    this.clients.push(response);
    if (typeof this.writeLog === "function") {
      this.writeLog("BROADCAST", "Product SSE initial event", {
        stream: "product",
        subscriber_count: this.clients.length,
        delivered_count: 1,
        resource: initialEvent.resource,
        action: initialEvent.action,
        ids: initialEvent.ids,
        version: initialEvent.version
      }, request.requestId);
    }
    const hub = this;
    /** Remove the disconnected response from the subscriber list. */
    function removeDisconnectedClient() {
      const index = hub.clients.indexOf(response);
      if (index >= 0) {
        hub.clients.splice(index, 1);
      }
    }
    request.on("close", removeDisconnectedClient);
  }

  /** Publish one lightweight refetch instruction to all clients. */
  publish(event, requestId) {
    const message = "data: " + JSON.stringify(event) + "\n\n";
    const subscriberCount = this.clients.length;
    let deliveredCount = 0;
    for (let index = this.clients.length - 1; index >= 0; index -= 1) {
      try {
        this.clients[index].write(message);
        deliveredCount += 1;
      } catch (error) {
        this.clients.splice(index, 1);
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
        version: event && event.version
      }, requestId);
    }
  }
}

module.exports = { EventHub: EventHub };
