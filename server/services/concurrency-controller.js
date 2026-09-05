/** Generic bounded asynchronous task controller shared by server workloads. */
class ConcurrencyController {
  /** Store the dynamic concurrency reader and initialize controller state. */
  constructor(options) {
    const settings = options || {};
    this.getConfiguredConcurrency = typeof settings.getConcurrency === "function"
      ? settings.getConcurrency
      : null;
    this.getConfiguredStartIntervalMs = typeof settings.getStartIntervalMs === "function"
      ? settings.getStartIntervalMs
      : null;
    this.onChange = typeof settings.onChange === "function" ? settings.onChange : null;
    this.pendingTasks = [];
    this.activeTasks = [];
    this.activeCount = 0;
    this.taskSequence = 0;
    this.nextStartAt = 0;
    this.startDelayTimer = null;
  }

  /** Return a safe positive concurrency limit from the configured reader. */
  getConcurrency() {
    const configured = this.getConfiguredConcurrency ? Number(this.getConfiguredConcurrency()) : 3;
    if (!Number.isFinite(configured) || configured < 1) {
      return 3;
    }
    return Math.max(1, Math.min(32, Math.floor(configured)));
  }

  /** Return the configured delay between starting queued tasks. */
  getStartIntervalMs() {
    const configured = this.getConfiguredStartIntervalMs ? Number(this.getConfiguredStartIntervalMs()) : 0;
    if (!Number.isFinite(configured) || configured <= 0) {
      return 0;
    }
    return Math.max(0, Math.min(60000, Math.floor(configured)));
  }

  /** Enqueue one task and resolve it after its turn completes. */
  run(execute, metadata) {
    const controller = this;
    return new Promise(function createQueuedTaskPromise(resolve, reject) {
      controller.taskSequence += 1;
      const task = {
        id: controller.taskSequence,
        execute: execute,
        metadata: metadata || {},
        resolve: resolve,
        reject: reject,
        state: "waiting",
        enqueued_at: new Date().toISOString(),
        started_at: "",
        finished_at: ""
      };
      controller.pendingTasks.push(task);
      controller.notifyChange("queued", task);
      controller.pump();
    });
  }

  /** Remove queued tasks that match one predicate before they acquire a worker slot. */
  cancelWhere(predicate, reason) {
    /** Reject every task when the caller did not provide a real matcher. */
    const matcher = typeof predicate === "function" ? predicate : function rejectEveryCancelCandidate() {
      return false;
    };
    let cancelled = 0;
    for (let index = this.pendingTasks.length - 1; index >= 0; index -= 1) {
      const task = this.pendingTasks[index];
      if (!matcher(task.metadata || {}, this.createTaskSnapshot(task))) {
        continue;
      }
      this.pendingTasks.splice(index, 1);
      task.state = "cancelled";
      task.finished_at = new Date().toISOString();
      const error = new Error(String(reason || "队列任务已取消。"));
      error.statusCode = 409;
      error.code = "QUEUE_TASK_CANCELLED";
      task.reject(error);
      cancelled += 1;
      this.notifyChange("cancelled", task);
    }
    return cancelled;
  }

  /** Start queued tasks until the configured limit is reached. */
  pump() {
    const concurrency = this.getConcurrency();
    if (this.activeCount >= concurrency || !this.pendingTasks.length || this.startDelayTimer) {
      return;
    }
    const intervalMs = this.getStartIntervalMs();
    const waitMs = intervalMs ? Math.max(0, this.nextStartAt - Date.now()) : 0;
    if (waitMs > 0) {
      const controller = this;
      this.startDelayTimer = setTimeout(/** Resume queue draining after the configured start gap. */ function resumeDelayedStart() {
        controller.startDelayTimer = null;
        controller.pump();
      }, waitMs);
      return;
    }
    const task = this.pendingTasks.shift();
    this.activeCount += 1;
    task.state = "running";
    task.started_at = new Date().toISOString();
    this.activeTasks.push(task);
    this.notifyChange("started", task);
    if (intervalMs) {
      this.nextStartAt = Date.now() + intervalMs;
    }
    this.startTask(task);
    this.pump();
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
      controller.finishTask(task, "completed");
    }, function rejectQueuedTask(error) {
      task.reject(error);
      controller.finishTask(task, "failed");
    });
  }

  /** Release one active slot, record its result, and continue draining the shared queue. */
  finishTask(task, state) {
    for (let index = this.activeTasks.length - 1; index >= 0; index -= 1) {
      if (this.activeTasks[index].id === task.id) {
        this.activeTasks.splice(index, 1);
        break;
      }
    }
    this.activeCount = Math.max(0, this.activeCount - 1);
    task.state = state;
    task.finished_at = new Date().toISOString();
    this.pump();
    this.notifyChange("finished", task);
  }

  /** Create a public task snapshot without exposing execution callbacks or Promise handlers. */
  createTaskSnapshot(task) {
    const metadata = task && task.metadata && typeof task.metadata === "object" ? task.metadata : {};
    return {
      id: task ? task.id : 0,
      type: String(metadata.type || "image"),
      execution_id: String(metadata.execution_id || ""),
      request_id: String(metadata.request_id || ""),
      state: String(task && task.state || "waiting"),
      enqueued_at: String(task && task.enqueued_at || ""),
      started_at: String(task && task.started_at || ""),
      finished_at: String(task && task.finished_at || "")
    };
  }

  /** Notify the optional queue observer after one queue state transition. */
  notifyChange(action, task) {
    if (!this.onChange) {
      return;
    }
    try {
      this.onChange(this.getSnapshot(), {
        action: String(action || "update"),
        task: this.createTaskSnapshot(task)
      });
    } catch (error) {
      return;
    }
  }

  /** Return controller state with safe active and waiting task details for diagnostics. */
  getSnapshot() {
    const activeTasks = [];
    const pendingTasks = [];
    for (let index = 0; index < this.activeTasks.length; index += 1) {
      activeTasks.push(this.createTaskSnapshot(this.activeTasks[index]));
    }
    for (let index = 0; index < this.pendingTasks.length; index += 1) {
      pendingTasks.push(this.createTaskSnapshot(this.pendingTasks[index]));
    }
    return {
      concurrency: this.getConcurrency(),
      active: this.activeCount,
      pending: this.pendingTasks.length,
      active_tasks: activeTasks,
      pending_tasks: pendingTasks
    };
  }
}

module.exports = { ConcurrencyController: ConcurrencyController };
