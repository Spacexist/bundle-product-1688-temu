const fs = require("fs");
const path = require("path");

const RETENTION_MS = 3 * 24 * 60 * 60 * 1000;
const MAX_FINISHED = 1000;
const TERMINAL = new Set(["succeeded", "failed", "timeout", "cancelled", "interrupted"]);
const PHASES = new Set(["queued", "preparing", "submitting", "upstream_queued", "upstream_running", "downloading", ...TERMINAL]);
const TEXT_FIELDS = ["execution_id", "source", "request_id", "direct_task_id", "carousel_task_id", "generation_id", "temu_main_id", "temu_platform_id", "sku_id", "provider_task_id", "provider_status", "provider_submitted_at", "error_code"];
const NUMBER_FIELDS = ["carousel_page_index", "candidate_index", "sku_index", "download_attempt"];
const TIME_FIELDS = ["created_at", "updated_at", "started_at", "finished_at"];

/** Select only short identity/status metadata; never persist prompts, credentials, images or URLs. */
function selectMetadata(input) {
  const value = input || {};
  const result = {};
  for (const key of TEXT_FIELDS) {
    if (value[key] !== undefined) {
      result[key] = String(value[key] || "").slice(0, 200);
    }
  }
  for (const key of NUMBER_FIELDS) {
    if (value[key] !== undefined && value[key] !== "" && value[key] !== null && Number.isFinite(Number(value[key])) && Number(value[key]) >= 0) {
      result[key] = Math.max(0, Math.floor(Number(value[key])));
    }
  }
  if (PHASES.has(value.phase)) { result.phase = value.phase; }
  return result;
}

/** Persist a bounded read-only ledger independent of disposable business runtime records. */
class ImageTaskHistoryService {
  /** Load existing metadata and end unfinished local tracking without resuming upstream work. */
  constructor(options) {
    const settings = options || {};
    this.now = settings.now || Date.now;
    this.file = path.join(settings.cacheDirectory, "runtime", "image-task-history.json");
    this.records = new Map();
    this.storageWarning = "";
    try {
      const payload = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (!payload || !Array.isArray(payload.tasks)) { throw new Error("Invalid task history"); }
      const timestamp = this.timestamp();
      for (const stored of payload.tasks) {
        const record = selectMetadata(stored);
        if (!record.execution_id || !record.phase || !Number.isFinite(Date.parse(stored.created_at))) { continue; }
        for (const key of TIME_FIELDS) {
          record[key] = Number.isFinite(Date.parse(stored[key])) ? new Date(stored[key]).toISOString() : "";
        }
        if (!TERMINAL.has(record.phase)) {
          record.phase = "interrupted";
          record.error_code = "SERVER_RESTARTED";
          record.finished_at = timestamp;
          record.updated_at = timestamp;
        }
        this.records.set(record.execution_id, record);
      }
      this.prune();
      this.persist();
    } catch (error) {
      if (error.code !== "ENOENT") {
        this.storageWarning = "任务历史读取失败；原文件已保留，本次任务仍可在内存查看。";
        this.readFailed = true;
      }
    }
  }

  /** Return the injected clock as an ISO timestamp. */
  timestamp() {
    return new Date(this.now()).toISOString();
  }

  /** Register one execution before it waits for the shared concurrency slot. */
  begin(metadata) {
    const record = selectMetadata(metadata);
    if (!record.execution_id || this.records.has(record.execution_id)) { return; }
    const timestamp = this.timestamp();
    Object.assign(record, {
      phase: "queued", created_at: timestamp, updated_at: timestamp, started_at: "", finished_at: "",
      provider_task_id: "", provider_status: "", download_attempt: 0, error_code: ""
    });
    this.records.set(record.execution_id, record);
    this.prune();
    this.persist();
  }

  /** Apply observer transitions without ever rebinding an execution to another provider task. */
  update(executionId, patch) {
    const record = this.records.get(executionId);
    if (!record || TERMINAL.has(record.phase)) { return; }
    const updates = selectMetadata(patch);
    delete updates.execution_id;
    if (record.provider_task_id && updates.provider_task_id !== record.provider_task_id) {
      delete updates.provider_task_id;
    }
    Object.assign(record, updates, { updated_at: this.timestamp() });
    if (!record.started_at && record.phase === "preparing") { record.started_at = record.updated_at; }
    if (TERMINAL.has(record.phase)) { record.finished_at = record.updated_at; }
    this.prune();
    this.persist();
  }

  /** Remove only expired/excess finished monitoring records, never active work or business files. */
  prune() {
    const cutoff = this.now() - RETENTION_MS;
    const finished = [];
    for (const record of this.records.values()) {
      if (!TERMINAL.has(record.phase)) { continue; }
      if (Date.parse(record.finished_at || record.updated_at) < cutoff) {
        this.records.delete(record.execution_id);
      } else {
        finished.push(record);
      }
    }
    finished.sort(/** Retain the most recently finished executions first. */ function newest(a, b) {
      return Date.parse(b.finished_at || b.updated_at) - Date.parse(a.finished_at || a.updated_at);
    });
    for (const record of finished.slice(MAX_FINISHED)) { this.records.delete(record.execution_id); }
  }

  /** Atomically replace metadata; monitoring storage failures must not fail or repeat a paid request. */
  persist() {
    if (this.readFailed) { return; }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file + ".tmp", JSON.stringify({ version: 1, tasks: Array.from(this.records.values()) }), "utf8");
      fs.renameSync(this.file + ".tmp", this.file);
      this.storageWarning = "";
    } catch (error) {
      this.storageWarning = "任务历史写入失败；当前状态仅在内存中，重启后可能丢失。";
    }
  }

  /** Return detached records for local polling without issuing provider requests. */
  getSnapshot() {
    const previousSize = this.records.size;
    this.prune();
    if (previousSize !== this.records.size) { this.persist(); }
    return {
      tasks: Array.from(this.records.values(), /** Keep HTTP consumers from mutating the ledger. */ function copy(record) { return { ...record }; }),
      retention_days: 3, max_finished: MAX_FINISHED, storage_warning: this.storageWarning,
      server_time: this.timestamp()
    };
  }
}

module.exports = { ImageTaskHistoryService, RETENTION_MS, MAX_FINISHED, selectMetadata };
