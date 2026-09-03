const fs = require("fs");
const path = require("path");
const { RETENTION_MS, MAX_FINISHED, selectMetadata } = require("./image-task-history.service");

const MAX_EVENTS = 200;
const MAX_EVENT_BYTES = 256 * 1024;
const STAGES = new Set(["preparing", "reference_download", "provider_submit", "provider_poll", "provider_generation", "result_validation", "result_download", "cache_write", "cache_validation", "state_persistence"]);

/** Remove credentials, echoed prompts, inline images and signed URLs from human-readable error text. */
function safeFailureText(value, secrets, limit) {
  let text = String(value === undefined || value === null ? "" : value);
  for (const secret of secrets || []) {
    if (secret) { text = text.split(String(secret)).join("[REDACTED]"); }
  }
  return text.replace(/data:image\/[^\s"']+/gi, "[IMAGE OMITTED]")
    .replace(/Bearer\s+[^\s"',}]+/gi, "Bearer [REDACTED]")
    .replace(/((?:api[_-]?key|authorization|access[_-]?token)\s*["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, "$1[REDACTED]")
    .replace(/\bsk-[a-zA-Z0-9_-]+/g, "[REDACTED]")
    .replace(/https?:\/\/[^\s<>"']+/gi, maskFailureUrl)
    .slice(0, limit || 2048);
}

/** Keep approved signed image URLs, but never inline images, URL passwords or explicit API credentials. */
function safeFailureUrl(value, secrets) {
  let text = String(value || "");
  if (text.startsWith("/api/v1/cache/image/")) { return text.split(/[?#]/)[0].slice(0, 8192); }
  try {
    const url = new URL(text);
    if (!/^https?:$/.test(url.protocol)) { return ""; }
    url.username = "";
    url.password = "";
    for (const key of Array.from(url.searchParams.keys())) {
      if (/^(api[_-]?key|authorization)$/i.test(key)) { url.searchParams.set(key, "[REDACTED]"); }
    }
    text = url.toString();
    for (const secret of secrets || []) {
      if (secret) { text = text.split(String(secret)).join("[REDACTED]").split(encodeURIComponent(String(secret))).join("[REDACTED]"); }
    }
    return text.length <= 8192 ? text : "";
  } catch (error) { return ""; }
}

/** Hide all URL query and fragment values in lists and error prose; full URLs are detail-only. */
function maskFailureUrl(value) {
  try {
    const url = new URL(String(value));
    return url.origin + url.pathname + (url.search || url.hash ? "?[参数已隐藏]" : "");
  } catch (error) { return String(value || "").split(/[?#]/)[0].slice(0, 8192); }
}

/** Convert an error into bounded, serializable fields without capturing request bodies or headers. */
function createFailureEvent(error, details, secrets) {
  const failure = error || {};
  const info = details || {};
  const stage = failure.image_stage || info.stage;
  const url = safeFailureUrl(failure.failure_url || info.url, secrets);
  const causes = [];
  let cause = failure.cause;
  for (let depth = 0; cause && depth < 3; depth += 1) {
    causes.push(safeFailureText([cause.name, cause.code, cause.message || cause].filter(Boolean).join(" · "), secrets, 512));
    cause = cause.cause;
  }
  const event = {
    time: Number.isFinite(Date.parse(info.time)) ? new Date(info.time).toISOString() : new Date().toISOString(),
    stage: STAGES.has(stage) ? stage : "preparing",
    code: safeFailureText(failure.code || info.code || "IMAGE_ERROR", secrets, 160),
    provider_code: safeFailureText(failure.provider_code || info.provider_code, secrets, 160),
    message: safeFailureText(failure.message || info.message || "图片执行失败。", secrets),
    cause: safeFailureText(causes.join(" → ") || info.cause, secrets),
    error_name: safeFailureText(failure.name || info.error_name, secrets, 80),
    http_status: Number(failure.http_status || info.http_status) || 0,
    method: /^(GET|POST)$/.test(info.method) ? info.method : "",
    url: url,
    url_display: maskFailureUrl(url)
  };
  for (const key of ["attempt", "source_index"]) {
    if (info[key] !== undefined && Number.isFinite(Number(info[key])) && Number(info[key]) >= 0) { event[key] = Math.floor(Number(info[key])); }
  }
  return event;
}

/** Emit one sanitized observation without letting diagnostics alter retries, cancellation or billing. */
function reportImageFailure(options, error, details) {
  const settings = options || {};
  try {
    const event = createFailureEvent(error, details, settings.sensitiveValues || []);
    if (error && typeof error === "object") { error.image_failure_event = event; }
    if (typeof settings.onFailure === "function") { settings.onFailure(event); }
  } catch (observerError) { /* Failure diagnostics are intentionally fail-open. */ }
}

/** Retain only final failures on disk; intermediate attempts for successful work live only in memory. */
class ImageFailureService {
  /** Load a dedicated failure ledger without recovering any unfinished work. */
  constructor(options) {
    const settings = options || {};
    this.now = settings.now || Date.now;
    this.file = path.join(settings.cacheDirectory, "runtime", "image-failures.json");
    this.records = new Map();
    this.pending = new Map();
    this.storageWarning = "";
    try {
      const payload = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (!payload || !Array.isArray(payload.tasks)) { throw new Error("Invalid failure history"); }
      for (const stored of payload.tasks) {
        if (!stored || !["failed", "timeout"].includes(stored.phase) || !Number.isFinite(Date.parse(stored.finished_at))) { continue; }
        const task = Object.assign(selectMetadata(stored), {
          created_at: stored.created_at, finished_at: stored.finished_at,
          final_message: safeFailureText(stored.final_message), events: [], event_bytes: 0,
          omitted_events: Math.max(0, Number(stored.omitted_events) || 0)
        });
        if (!task.execution_id) { continue; }
        for (const event of Array.isArray(stored.events) ? stored.events : []) { this.append(task, createFailureEvent(null, event)); }
        this.records.set(task.execution_id, task);
      }
      this.prune();
      this.persist();
    } catch (error) {
      if (error.code !== "ENOENT") { this.readFailed = true; this.storageWarning = "失败日志读取失败，原文件已保留；新增失败仅在内存查看。"; }
    }
  }

  /** Allocate temporary metadata; nothing is written until the execution finally fails. */
  begin(metadata) {
    const task = Object.assign(selectMetadata(metadata), { created_at: new Date(this.now()).toISOString(), events: [], event_bytes: 0, omitted_events: 0 });
    if (task.execution_id) { this.pending.set(task.execution_id, task); }
  }

  /** Mirror identity/progress without persisting temporary or successful executions. */
  update(executionId, patch) {
    const task = this.pending.get(executionId);
    if (!task) { return; }
    const value = selectMetadata(patch);
    delete value.execution_id;
    if (task.provider_task_id && value.provider_task_id !== task.provider_task_id) { delete value.provider_task_id; }
    Object.assign(task, value);
  }

  /** Bound per-task detail count and bytes, preserving the most recent evidence. */
  append(task, event) {
    task.events.push(event);
    task.event_bytes += Buffer.byteLength(JSON.stringify(event));
    while (task.events.length > MAX_EVENTS || task.event_bytes > MAX_EVENT_BYTES) {
      task.event_bytes -= Buffer.byteLength(JSON.stringify(task.events.shift()));
      task.omitted_events += 1;
    }
  }

  /** Keep a sanitized attempt only while its owning execution is still running. */
  record(executionId, event) {
    const task = this.pending.get(executionId);
    if (task) { this.append(task, createFailureEvent(null, event)); }
  }

  /** Discard successful/cancelled/interrupted buffers, or atomically retain one terminal failure. */
  finish(executionId, phase, error) {
    const task = this.pending.get(executionId);
    this.pending.delete(executionId);
    if (!task || !["failed", "timeout"].includes(phase)) { return; }
    const finalEvent = error && error.image_failure_event;
    const fallback = finalEvent || createFailureEvent(error, { stage: error && error.code === "DOWNLOAD_FAILED" ? "cache_write" : "preparing" });
    if (!task.events.length || !finalEvent) { this.append(task, fallback); }
    task.phase = phase;
    task.error_code = safeFailureText(error && error.code || "IMAGE_TASK_FAILED", [], 160);
    task.final_message = fallback.message;
    task.finished_at = new Date(this.now()).toISOString();
    this.records.set(task.execution_id, task);
    this.prune();
    this.persist();
  }

  /** Remove only expired or excess failure records, independent of the all-task history limit. */
  prune() {
    const tasks = Array.from(this.records.values()).sort(/** Retain newest final failures first. */ function newest(a, b) { return Date.parse(b.finished_at) - Date.parse(a.finished_at); });
    for (let index = 0; index < tasks.length; index += 1) {
      if (index >= MAX_FINISHED || Date.parse(tasks[index].finished_at) < this.now() - RETENTION_MS) { this.records.delete(tasks[index].execution_id); }
    }
  }

  /** Write only final failures; inability to persist must never fail or resubmit image generation. */
  persist() {
    if (this.readFailed) { return; }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file + ".tmp", JSON.stringify({ version: 1, tasks: Array.from(this.records.values()) }), "utf8");
      fs.renameSync(this.file + ".tmp", this.file);
      this.storageWarning = "";
    } catch (error) { this.storageWarning = "失败日志写入失败，当前仅在内存查看；不影响生图。"; }
  }

  /** Return masked summaries, never full URLs or all attempt details in the once-per-second list. */
  getSnapshot() {
    const size = this.records.size;
    this.prune();
    if (size !== this.records.size) { this.persist(); }
    const tasks = Array.from(this.records.values(), /** Project compact list fields from one failure. */ function summary(task) {
      const last = task.events[task.events.length - 1] || {};
      return Object.assign(selectMetadata(task), {
        created_at: task.created_at, finished_at: task.finished_at, final_message: task.final_message.slice(0, 300),
        stage: last.stage, http_status: last.http_status, provider_code: last.provider_code,
        url_display: last.url_display, event_count: task.events.length, omitted_events: task.omitted_events
      });
    });
    return { tasks, storage_warning: this.storageWarning, retention_days: 3, max_failed: MAX_FINISHED, max_events: MAX_EVENTS };
  }

  /** Reveal a detached full-URL detail only when explicitly requested from the local failure page. */
  getDetail(executionId) {
    this.getSnapshot();
    const task = this.records.get(executionId);
    return task ? JSON.parse(JSON.stringify(task)) : null;
  }
}

module.exports = { ImageFailureService, reportImageFailure, createFailureEvent, safeFailureText, safeFailureUrl, maskFailureUrl, MAX_EVENTS, MAX_EVENT_BYTES };
