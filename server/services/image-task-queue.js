const ConcurrencyController = require("./concurrency-controller").ConcurrencyController;

/** Named shared queue for image edits and image generation provider tasks. */
class ImageTaskQueue {
  /** Compose the image queue with the server-wide concurrency controller. */
  constructor(options) {
    this.controller = new ConcurrencyController(options);
  }

  /** Enqueue one image provider task behind the shared controller. */
  run(execute, metadata) {
    return this.controller.run(execute, metadata);
  }

  /** Cancel queued image tasks that match one metadata predicate. */
  cancelWhere(predicate, reason) {
    return this.controller.cancelWhere(predicate, reason);
  }

  /** Return image queue state for diagnostics. */
  getSnapshot() {
    return this.controller.getSnapshot();
  }
}

module.exports = { ImageTaskQueue: ImageTaskQueue };
