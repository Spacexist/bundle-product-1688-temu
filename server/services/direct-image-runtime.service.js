const fs = require("fs");
const path = require("path");

/** Create one direct-image task error with a stable HTTP status and code. */
function createDirectImageError(message, statusCode, code) {
  const error = new Error(String(message || "单结果图片任务处理失败。"));
  error.statusCode = Number(statusCode || 500);
  error.code = String(code || "DIRECT_IMAGE_TASK_ERROR");
  return error;
}

/** Persist and recover one-result Edits and Fusion tasks independently from browser requests. */
class DirectImageRuntimeService {
  /** Store runtime dependencies and recover tasks interrupted by a server restart. */
  constructor(options) {
    const settings = options || {};
    const runtimeName = settings.runtimeName === "sku-blend" ? "sku-blend" : "direct-image";
    this.runtimeDirectory = path.join(settings.cacheDirectory, "runtime", runtimeName);
    this.taskScope = settings.taskScope === "sku" ? "sku" : "product";
    this.providers = settings.providers;
    fs.mkdirSync(this.runtimeDirectory, { recursive: true });
    this.recoverInterruptedTasks();
  }

  /** Return one filesystem-safe direct-image task identifier. */
  normalizeTaskId(taskId) {
    return String(taskId || "").replace(/[^a-zA-Z0-9-]/g, "");
  }

  /** Return the JSON path for one direct-image task. */
  getTaskPath(taskId) {
    return path.join(this.runtimeDirectory, this.normalizeTaskId(taskId) + ".json");
  }

  /** Read one persisted direct-image task without exposing malformed JSON. */
  readTask(taskId) {
    const safeTaskId = this.normalizeTaskId(taskId);
    const filePath = this.getTaskPath(safeTaskId);
    if (!safeTaskId || !fs.existsSync(filePath)) {
      return null;
    }
    try {
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (error) {
      return null;
    }
  }

  /** Atomically persist one direct-image task. */
  writeTask(task) {
    const target = task && typeof task === "object" ? task : null;
    if (!target || !target.id) {
      throw createDirectImageError("单结果图片任务缺少 ID。", 500, "DIRECT_IMAGE_TASK_INVALID");
    }
    fs.mkdirSync(this.runtimeDirectory, { recursive: true });
    target.updated_at = new Date().toISOString();
    const filePath = this.getTaskPath(target.id);
    const temporaryPath = filePath + "." + process.pid + "." + Date.now() + ".tmp";
    fs.writeFileSync(temporaryPath, JSON.stringify(target, null, 2), "utf8");
    try {
      fs.renameSync(temporaryPath, filePath);
    } catch (error) {
      if (error.code !== "EPERM" && error.code !== "EEXIST") {
        throw error;
      }
      fs.copyFileSync(temporaryPath, filePath);
      fs.unlinkSync(temporaryPath);
    }
    return target;
  }

  /** Return every valid direct-image task currently stored on disk. */
  readTasks() {
    const tasks = [];
    const names = fs.existsSync(this.runtimeDirectory) ? fs.readdirSync(this.runtimeDirectory) : [];
    for (let index = 0; index < names.length; index += 1) {
      if (!names[index].endsWith(".json")) {
        continue;
      }
      const task = this.readTask(names[index].slice(0, -5));
      if (task) {
        tasks.push(task);
      }
    }
    return tasks;
  }

  /** Find the newest retained direct-image task for one Temu product. */
  findTaskByTemuMainId(temuMainId) {
    const key = String(temuMainId || "");
    const tasks = this.readTasks();
    let selectedTask = null;
    for (let index = 0; index < tasks.length; index += 1) {
      if (String(tasks[index].temu_main_id || "") !== key) {
        continue;
      }
      if (!selectedTask || String(tasks[index].updated_at || "") > String(selectedTask.updated_at || "")) {
        selectedTask = tasks[index];
      }
    }
    return selectedTask;
  }

  /** Validate one direct-image request and create an idempotent persisted task. */
  createTask(input) {
    const source = input && typeof input === "object" ? input : {};
    const taskId = this.normalizeTaskId(source.client_task_id);
    const existing = this.readTask(taskId);
    if (existing) {
      return { task: existing, existing: true };
    }
    const mode = source.mode === "edit" ? "edit" : "fusion";
    const imageUrls = Array.isArray(source.image_urls) ? source.image_urls.slice() : [];
    const expectedCount = mode === "edit" ? 1 : 2;
    if (!taskId || imageUrls.length !== expectedCount) {
      throw createDirectImageError(mode === "edit" ? "单图编辑必须提交一张图片。" : "双图溶图必须提交两张图片。", 400, "DIRECT_IMAGE_SOURCE_INVALID");
    }
    this.deleteConflictingTasks(source);
    const task = {
      id: taskId,
      temu_main_id: String(source.temu_main_id || ""),
      temu_platform_id: String(source.temu_platform_id || ""),
      mode: mode,
      source_image_urls: imageUrls,
      source_type: source.source_type === "sku" ? "sku" : source.source_type === "detail" ? "detail" : "gallery",
      source_indices: Array.isArray(source.source_indices) ? source.source_indices.slice() : [],
      detail_index: Number(source.detail_index === undefined ? -1 : source.detail_index),
      sku_id: String(source.sku_id || ""),
      sku_index: Number(source.sku_index === undefined ? -1 : source.sku_index),
      prompt: String(source.prompt || ""),
      size: String(source.size || "1k"),
      status: "queued",
      image_url: "",
      undo_token: "",
      error: "",
      error_code: "",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    this.writeTask(task);
    return { task: task, existing: false };
  }

  /** Start one persisted direct-image task and retain its eventual provider result. */
  async startTask(taskId, requestId) {
    const task = this.readTask(taskId);
    if (!task || task.status === "generating" || task.status === "succeeded") {
      return task;
    }
    task.status = "generating";
    task.error = "";
    task.error_code = "";
    this.writeTask(task);
    try {
      const result = await this.providers.editImages({
        image_urls: task.source_image_urls,
        prompt: task.prompt,
        size: task.size
      }, task.mode, requestId);
      const currentTask = this.readTask(task.id);
      if (!currentTask) {
        return null;
      }
      currentTask.status = "succeeded";
      currentTask.image_url = String(result.image_url || "");
      currentTask.undo_token = String(result.undo_token || "");
      currentTask.error = "";
      currentTask.error_code = "";
      return this.writeTask(currentTask);
    } catch (error) {
      const failedTask = this.readTask(task.id);
      if (!failedTask) {
        return null;
      }
      failedTask.status = "failed";
      failedTask.error = String(error && error.message || "图片生成失败。");
      failedTask.error_code = String(error && error.code || "DIRECT_IMAGE_GENERATION_FAILED");
      return this.writeTask(failedTask);
    }
  }

  /** Create one task and start it without tying completion to the HTTP response. */
  createAndStartTask(input, requestId) {
    const created = this.createTask(input);
    if (!created.existing || created.task.status === "failed" || created.task.status === "interrupted") {
      /** Prevent one unexpected persistence failure from becoming an unhandled Promise rejection. */
      function ignoreDirectImageStartFailure() {
        return;
      }
      this.startTask(created.task.id, requestId).catch(ignoreDirectImageStartFailure);
    }
    return this.readTask(created.task.id) || created.task;
  }

  /** Delete only the retained task that conflicts with the incoming product or SKU target. */
  deleteConflictingTasks(source) {
    const input = source && typeof source === "object" ? source : {};
    if (this.taskScope !== "sku") {
      this.deleteTasksForProduct(input.temu_main_id);
      return;
    }
    const mainId = String(input.temu_main_id || "");
    const skuId = String(input.sku_id || "");
    const skuIndex = Number(input.sku_index === undefined ? -1 : input.sku_index);
    const tasks = this.readTasks();
    for (let index = 0; index < tasks.length; index += 1) {
      const task = tasks[index] || {};
      const sameProduct = String(task.temu_main_id || "") === mainId;
      const sameSku = skuId
        ? String(task.sku_id || "") === skuId
        : Number(task.sku_index === undefined ? -1 : task.sku_index) === skuIndex;
      if (sameProduct && sameSku) {
        this.deleteTask(task.id);
      }
    }
  }

  /** Delete every retained task for one Temu product before starting a replacement. */
  deleteTasksForProduct(temuMainId) {
    const key = String(temuMainId || "");
    const tasks = this.readTasks();
    for (let index = 0; index < tasks.length; index += 1) {
      if (String(tasks[index].temu_main_id || "") === key) {
        this.deleteTask(tasks[index].id);
      }
    }
  }

  /** Delete one retained task record without deleting its cached generated image. */
  deleteTask(taskId) {
    const task = this.readTask(taskId);
    const filePath = this.getTaskPath(taskId);
    if (task && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    return task;
  }

  /** Mark tasks interrupted by a previous server process as failed and retryable. */
  recoverInterruptedTasks() {
    const tasks = this.readTasks();
    for (let index = 0; index < tasks.length; index += 1) {
      if (tasks[index].status !== "queued" && tasks[index].status !== "generating") {
        continue;
      }
      tasks[index].status = "interrupted";
      tasks[index].error = "服务器重启中断了图片任务，请重新生成。";
      tasks[index].error_code = "DIRECT_IMAGE_SERVER_RESTARTED";
      this.writeTask(tasks[index]);
    }
  }
}

module.exports = { DirectImageRuntimeService: DirectImageRuntimeService };
