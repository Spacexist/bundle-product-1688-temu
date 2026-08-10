/** Generic bounded asynchronous task controller shared by server workloads. */
class ConcurrencyController {
  /** Store the dynamic concurrency reader and initialize controller state. */
  constructor(options) {
    const settings = options || {};
    this.getConfiguredConcurrency = typeof settings.getConcurrency === "function"
      ? settings.getConcurrency
      : null;
    this.pendingTasks = [];
    this.activeCount = 0;
    this.taskSequence = 0;
  }

  /** Return a safe positive concurrency limit from the configured reader. */
  getConcurrency() {
    const configured = this.getConfiguredConcurrency ? Number(this.getConfiguredConcurrency()) : 3;
    if (!Number.isFinite(configured) || configured < 1) {
      return 3;
    }
    return Math.max(1, Math.min(32, Math.floor(configured)));
  }

  /** Enqueue one task and resolve it after its turn completes. */
  run(execute, metadata) {
    const controller = this;
    return new Promise(function createQueuedTaskPromise(resolve, reject) {
      controller.taskSequence += 1;
      controller.pendingTasks.push({
        id: controller.taskSequence,
        execute: execute,
        metadata: metadata || {},
        resolve: resolve,
        reject: reject
      });
      controller.pump();
    });
  }

  /** Start queued tasks until the configured limit is reached. */
  pump() {
    const concurrency = this.getConcurrency();
    while (this.activeCount < concurrency && this.pendingTasks.length) {
      const task = this.pendingTasks.shift();
      this.activeCount += 1;
      this.startTask(task);
    }
  }

  /** Run one queued task and release its slot on success or failure. */
  startTask(task) {
    const controller = this;
    Promise.resolve().then(function executeQueuedTask() {
      if (typeof task.execute !== "function") {
        throw new Error("并发控制任务不是有效函数。");
      }
      return task.execute();
    }).then(function resolveQueuedTask(result) {
      task.resolve(result);
      controller.finishTask();
    }, function rejectQueuedTask(error) {
      task.reject(error);
      controller.finishTask();
    });
  }

  /** Release one active slot and continue draining the shared queue. */
  finishTask() {
    this.activeCount = Math.max(0, this.activeCount - 1);
    this.pump();
  }

  /** Return controller state without exposing queued task payloads. */
  getSnapshot() {
    return {
      concurrency: this.getConcurrency(),
      active: this.activeCount,
      pending: this.pendingTasks.length
    };
  }
}

module.exports = { ConcurrencyController: ConcurrencyController };
