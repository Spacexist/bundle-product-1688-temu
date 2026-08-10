/** In-memory SSE hub that publishes lightweight invalidation events. */
class EventHub {
  /** Create an empty subscriber collection. */
  constructor() {
    this.clients = [];
  }

  /** Attach one browser to the event stream. */
  connect(request, response) {
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive"
    });
    response.write("data: " + JSON.stringify({ resource: "system", action: "connected", ids: [], version: 1 }) + "\n\n");
    this.clients.push(response);
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
  publish(event) {
    const message = "data: " + JSON.stringify(event) + "\n\n";
    for (let index = this.clients.length - 1; index >= 0; index -= 1) {
      try {
        this.clients[index].write(message);
      } catch (error) {
        this.clients.splice(index, 1);
      }
    }
  }
}

module.exports = { EventHub: EventHub };
