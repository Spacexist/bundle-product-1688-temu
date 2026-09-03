const ConcurrencyController = require("./concurrency-controller").ConcurrencyController;
const crypto = require("crypto");

/** Named shared queue for image edits and image generation provider tasks. */
class ImageTaskQueue {
  /** Compose the image queue with the server-wide concurrency controller. */
  constructor(options) {
    this.controller = new ConcurrencyController(options);
    this.history = options && options.history;
    this.failures = options && options.failures;
  }

  /** Enqueue one image provider task behind the shared controller. */
  run(execute, metadata) {
    const details = Object.assign({}, metadata);
    details.execution_id = details.execution_id || crypto.randomUUID();
    if (this.history) { this.history.begin(details); }
    this.observeFailureHistory("begin", details);
    const queue = this;
    return this.controller.run(/** Observe lifecycle without changing queue scheduling or slot ownership. */ async function executeObservedTask() {
      queue.updateTask(details.execution_id, { phase: "preparing" });
      const result = await execute();
      queue.updateTask(details.execution_id, { phase: "succeeded" });
      queue.observeFailureHistory("finish", details.execution_id, "succeeded");
      return result;
    }, details).catch(/** Include cancellations while still waiting, when execute was never called. */ function recordTaskFailure(error) {
      const code = String(error && error.code || "IMAGE_TASK_FAILED");
      const phase = /CANCELLED/.test(code) ? "cancelled" : /TIMEOUT/.test(code) ? "timeout" : "failed";
      queue.updateTask(details.execution_id, { phase: phase, error_code: code });
      queue.observeFailureHistory("finish", details.execution_id, phase, error);
      throw error;
    });
  }

  /** Forward whitelisted progress into the optional independent history ledger. */
  updateTask(executionId, patch) {
    if (this.history) { this.history.update(executionId, patch); }
    this.observeFailureHistory("update", executionId, patch);
  }

  /** Isolate optional failure logging so no observer exception changes paid work. */
  observeFailureHistory(method, ...args) {
    try { if (this.failures) { this.failures[method](...args); } } catch (error) { /* Diagnostics must remain fail-open. */ }
  }

  /** Buffer one failed attempt; the ledger only persists it if the whole execution fails. */
  recordFailure(executionId, event) {
    this.observeFailureHistory("record", executionId, event);
  }

  /** Return compact failed-only summaries for local diagnostics. */
  getFailures() {
    return this.failures ? this.failures.getSnapshot() : { tasks: [], storage_warning: "" };
  }

  /** Return one retained failure's bounded detail without querying any upstream server. */
  getFailureDetail(executionId) {
    return this.failures ? this.failures.getDetail(executionId) : null;
  }

  /** Record provider progress without considering upstream completion a local success. */
  observeProviderState(executionId, state) {
    const phases = { submitting: "submitting", queued: "upstream_queued", running: "upstream_running", completed: "downloading" };
    this.updateTask(executionId, {
      provider_task_id: state.provider_task_id,
      provider_status: state.provider_status === "failed" && state.provider_error_code !== "PROVIDER_FAILED" ? "tracking_stopped" : state.provider_status,
      provider_submitted_at: state.provider_submitted_at,
      phase: phases[state.provider_status],
      error_code: state.provider_error_code
    });
  }

  /** Return only local metadata for the read-only image task dashboard. */
  getTaskHistory() {
    return this.history ? this.history.getSnapshot() : { tasks: [], retention_days: 3, max_finished: 1000, storage_warning: "" };
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
