const fs = require("fs");
const path = require("path");

const CURRENT_IMAGE_EDIT_PREFIX = "以唯一输入图片为基础继续编辑。严格保留现有商品身份、结构、数量、颜色、材质、比例和已正确内容，不要重新设计商品；仅按以下要求修改：";

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
    this.images = settings.images;
    this.activeControllers = Object.create(null);
    this.cancelledTaskIds = Object.create(null);
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

  /** Return whether one direct-image task was abandoned during this server process. */
  isTaskCancelled(taskId) {
    return Boolean(this.cancelledTaskIds[this.normalizeTaskId(taskId)])
      || fs.existsSync(this.getTaskPath(taskId) + ".cancelled");
  }

  /** Stop direct-image processing when the task no longer owns its result. */
  assertTaskAvailable(taskId) {
    if (this.isTaskCancelled(taskId) || !this.readTask(taskId)) {
      throw createDirectImageError("单结果图片任务已被放弃。", 409, "DIRECT_IMAGE_TASK_CANCELLED");
    }
  }

  /** Read one persisted direct-image task without exposing malformed JSON. */
  readTask(taskId) {
    const safeTaskId = this.normalizeTaskId(taskId);
    const filePath = this.getTaskPath(safeTaskId);
    if (!safeTaskId || this.isTaskCancelled(safeTaskId) || !fs.existsSync(filePath)) {
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
    if (this.isTaskCancelled(target.id)) {
      throw createDirectImageError("单结果图片任务已被放弃。", 409, "DIRECT_IMAGE_TASK_CANCELLED");
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

  /** Return at most two distinct retained image versions for one task. */
  normalizeImageVersions(task) {
    const item = task && typeof task === "object" ? task : {};
    const source = Array.isArray(item.image_versions) ? item.image_versions : [];
    const versions = [];
    for (let index = 0; index < source.length; index += 1) {
      const url = String(source[index] || "").trim();
      if (url && versions.indexOf(url) < 0) {
        versions.push(url);
      }
    }
    const current = String(item.image_url || "").trim();
    if (current && versions.indexOf(current) < 0) {
      versions.push(current);
    }
    return versions.slice(-2);
  }

  /** Persist one active direct-image version without submitting new provider work. */
  selectTaskVersion(taskId, versionIndex) {
    const task = this.readTask(taskId);
    if (!task) {
      throw createDirectImageError("单图编辑任务不存在。", 404, "DIRECT_IMAGE_TASK_NOT_FOUND");
    }
    if (task.status === "queued" || task.status === "generating") {
      throw createDirectImageError("图片生成期间不能切换版本。", 409, "DIRECT_IMAGE_VERSION_BUSY");
    }
    const versions = this.normalizeImageVersions(task);
    const index = Number(versionIndex);
    if (!Number.isInteger(index) || !versions[index]) {
      throw createDirectImageError("图片版本不存在。", 400, "DIRECT_IMAGE_VERSION_INVALID");
    }
    task.image_versions = versions;
    task.active_image_version = index;
    task.image_url = versions[index];
    task.image_ready = this.isGeneratedImageReady(task.image_url)
      || task.source_image_urls.indexOf(task.image_url) >= 0;
    return this.writeTask(task);
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

  /** Return the one queued or generating direct-image task already owned by a product. */
  findActiveTaskByTemuMainId(temuMainId) {
    const key = String(temuMainId || "");
    const tasks = this.readTasks();
    for (let index = 0; index < tasks.length; index += 1) {
      const status = String(tasks[index].status || "");
      if (String(tasks[index].temu_main_id || "") === key
        && (status === "queued" || status === "generating")) {
        return tasks[index];
      }
    }
    return null;
  }

  /** Validate one direct-image request and create an idempotent persisted task. */
  createTask(input) {
    const source = input && typeof input === "object" ? input : {};
    const taskId = this.normalizeTaskId(source.client_task_id);
    if (taskId && this.isTaskCancelled(taskId)) {
      throw createDirectImageError("此任务已终止，重试必须使用新的本地任务 ID。", 409, "DIRECT_IMAGE_TASK_CANCELLED");
    }
    const existing = this.readTask(taskId);
    if (existing) {
      return { task: existing, existing: true };
    }
    const activeTask = this.taskScope === "sku" ? null : this.findActiveTaskByTemuMainId(source.temu_main_id);
    if (activeTask) {
      throw createDirectImageError("该商品已有单图编辑任务正在排队或生成，请等待完成后再提交。", 409, "DIRECT_IMAGE_TASK_ACTIVE");
    }
    const mode = source.mode === "edit" ? "edit" : "fusion";
    const useCurrentImage = this.taskScope !== "sku" && source.reference_mode === "current";
    const parentTask = useCurrentImage ? this.readTask(source.parent_task_id) : null;
    if (useCurrentImage && !parentTask) {
      throw createDirectImageError("当前图片版本已失效，请重新打开后再试。", 409, "DIRECT_IMAGE_PARENT_NOT_FOUND");
    }
    if (parentTask && String(parentTask.temu_main_id || "") !== String(source.temu_main_id || "")) {
      throw createDirectImageError("当前图片版本不属于这个商品。", 409, "DIRECT_IMAGE_PARENT_MISMATCH");
    }
    const imageUrls = parentTask && Array.isArray(parentTask.source_image_urls)
      ? parentTask.source_image_urls.slice()
      : Array.isArray(source.image_urls) ? source.image_urls.slice() : [];
    const expectedCount = mode === "edit" ? 1 : 2;
    if (!taskId || imageUrls.length !== expectedCount) {
      throw createDirectImageError(mode === "edit" ? "单图编辑必须提交一张图片。" : "双图溶图必须提交两张图片。", 400, "DIRECT_IMAGE_SOURCE_INVALID");
    }
    const editImageUrl = parentTask ? String(parentTask.image_url || "").trim() : String(imageUrls[0] || "").trim();
    const editsOriginalSource = Boolean(parentTask && parentTask.source_image_urls.indexOf(editImageUrl) >= 0);
    if (parentTask && (!editImageUrl || (!editsOriginalSource && !this.isGeneratedImageReady(editImageUrl)))) {
      throw createDirectImageError("当前图片未写入本地缓存，不能继续编辑。", 409, "DIRECT_IMAGE_CURRENT_NOT_READY");
    }
    const inheritedVersions = parentTask ? this.normalizeImageVersions(parentTask) : [];
    const task = {
      id: taskId,
      temu_main_id: String(source.temu_main_id || ""),
      temu_platform_id: String(source.temu_platform_id || ""),
      mode: mode,
      source_image_urls: imageUrls,
      edit_image_url: editImageUrl,
      reference_mode: parentTask ? "current" : "original",
      parent_task_id: parentTask ? String(parentTask.id || "") : "",
      source_type: parentTask ? String(parentTask.source_type || "gallery") : source.source_type === "sku" ? "sku" : source.source_type === "detail" ? "detail" : "gallery",
      source_indices: parentTask && Array.isArray(parentTask.source_indices) ? parentTask.source_indices.slice() : Array.isArray(source.source_indices) ? source.source_indices.slice() : [],
      detail_index: Number(parentTask ? parentTask.detail_index : source.detail_index === undefined ? -1 : source.detail_index),
      sku_id: String(source.sku_id || ""),
      sku_index: Number(source.sku_index === undefined ? -1 : source.sku_index),
      prompt: String(source.prompt || ""),
      size: String(source.size || "1024x1024"),
      status: "queued",
      provider_status: "",
      provider_task_id: "",
      provider_image_url: "",
      image_url: parentTask ? editImageUrl : "",
      image_versions: inheritedVersions,
      active_image_version: parentTask ? Math.max(0, inheritedVersions.indexOf(editImageUrl)) : -1,
      image_ready: Boolean(parentTask),
      undo_token: "",
      error: "",
      error_code: "",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    this.writeTask(task);
    this.deleteConflictingTasks(source, task.id, Boolean(parentTask));
    return { task: task, existing: false };
  }

  /** Return whether one generated task image is available from the local cache. */
  isGeneratedImageReady(imageUrl) {
    const value = String(imageUrl || "").trim();
    if (!value) {
      return false;
    }
    if (this.images && typeof this.images.localUrlExists === "function") {
      if (typeof this.images.isLocalImageUrl === "function" && !this.images.isLocalImageUrl(value)) {
        return false;
      }
      return this.images.localUrlExists(value);
    }
    return value.indexOf("/api/v1/cache/image/") === 0;
  }

  /** Start one persisted direct-image task and retain its eventual provider result. */
  async startTask(taskId, requestId) {
    const task = this.readTask(taskId);
    if (!task || this.isTaskCancelled(taskId) || task.status !== "queued" || task.provider_status || task.provider_task_id) {
      return task;
    }
    task.status = "generating";
    task.image_ready = Boolean(task.image_url);
    task.error = "";
    task.error_code = "";
    this.writeTask(task);
    const controller = new AbortController();
    this.activeControllers[task.id] = controller;
    try {
      const service = this;
      const result = await this.providers.editImages({
        direct_task_id: task.id,
        task_scope: this.taskScope,
        temu_main_id: task.temu_main_id,
        temu_platform_id: task.temu_platform_id,
        sku_id: task.sku_id,
        sku_index: task.sku_index,
        image_urls: task.mode === "edit"
          ? [String(task.edit_image_url || task.source_image_urls[0] || "")]
          : task.source_image_urls,
        prompt: task.reference_mode === "current" ? CURRENT_IMAGE_EDIT_PREFIX + "\n\n" + task.prompt : task.prompt,
        size: task.size,
        cancel_signal: controller.signal,
        /** Persist exactly one upstream ID for this local execution, without resurrecting deleted work. */
        on_provider_state: function persistDirectProviderState(state) {
          service.assertTaskAvailable(task.id);
          const current = service.readTask(task.id);
          if (current.provider_task_id && state.provider_task_id !== current.provider_task_id) {
            throw createDirectImageError("本地任务不能替换上游 task_id。", 409, "PROVIDER_TASK_ID_CONFLICT");
          }
          Object.assign(current, state);
          service.writeTask(current);
        },
        /** Return whether the owning direct-image task has been abandoned. */
        is_cancelled: function isDirectImageTaskCancelled() {
          return service.isTaskCancelled(task.id) || !service.readTask(task.id);
        }
      }, task.mode, requestId);
      this.assertTaskAvailable(task.id);
      const currentTask = this.readTask(task.id);
      if (!currentTask) {
        this.deleteGeneratedImage(result.image_url);
        return null;
      }
      if (!this.isGeneratedImageReady(result.image_url)) {
        this.deleteGeneratedImage(result.image_url);
        throw createDirectImageError("图片生成完成，但本地缓存尚未写入，请重新生成。", 502, "DIRECT_IMAGE_CACHE_NOT_READY");
      }
      if (this.taskScope === "sku") {
        currentTask.status = "succeeded";
        currentTask.image_url = String(result.image_url || "");
        currentTask.image_ready = true;
        currentTask.undo_token = String(result.undo_token || "");
        currentTask.error = "";
        currentTask.error_code = "";
        return this.writeTask(currentTask);
      }
      const previousVersions = this.normalizeImageVersions(currentTask);
      const retainedInputUrl = String(currentTask.edit_image_url || currentTask.image_url || "").trim();
      const nextImageUrl = String(result.image_url || "");
      const requestedIndex = Number(currentTask.active_image_version);
      const replacesExistingSlot = previousVersions.length >= 2
        && Number.isInteger(requestedIndex)
        && Boolean(previousVersions[requestedIndex]);
      const nextVersions = replacesExistingSlot ? previousVersions.slice(0, 2) : [];
      if (replacesExistingSlot) {
        nextVersions[requestedIndex] = nextImageUrl;
      } else {
        [retainedInputUrl, nextImageUrl].forEach(/** Append the initial input and result as the first two slots. */ function appendUniqueVersion(url) {
          if (url && nextVersions.indexOf(url) < 0) {
            nextVersions.push(url);
          }
        });
      }
      currentTask.status = "succeeded";
      currentTask.image_url = nextImageUrl;
      currentTask.image_versions = nextVersions;
      currentTask.active_image_version = replacesExistingSlot ? requestedIndex : Math.max(0, nextVersions.indexOf(nextImageUrl));
      currentTask.image_ready = true;
      currentTask.undo_token = String(result.undo_token || "");
      currentTask.error = "";
      currentTask.error_code = "";
      const savedTask = this.writeTask(currentTask);
      for (let versionIndex = 0; versionIndex < previousVersions.length; versionIndex += 1) {
        if (nextVersions.indexOf(previousVersions[versionIndex]) < 0
          && currentTask.source_image_urls.indexOf(previousVersions[versionIndex]) < 0) {
          this.deleteGeneratedImage(previousVersions[versionIndex]);
        }
      }
      return savedTask;
    } catch (error) {
      const failedTask = this.readTask(task.id);
      if (!failedTask || this.isTaskCancelled(task.id)) {
        return null;
      }
      failedTask.status = "failed";
      failedTask.image_ready = Boolean(failedTask.image_url);
      failedTask.error = String(error && error.message || "图片生成失败。");
      failedTask.error_code = String(error && error.code || "DIRECT_IMAGE_GENERATION_FAILED");
      return this.writeTask(failedTask);
    } finally {
      if (this.activeControllers[task.id] === controller) {
        delete this.activeControllers[task.id];
      }
    }
  }

  /** Create one task and start it without tying completion to the HTTP response. */
  createAndStartTask(input, requestId) {
    const created = this.createTask(input);
    if (!created.existing) {
      /** Prevent one unexpected persistence failure from becoming an unhandled Promise rejection. */
      function ignoreDirectImageStartFailure() {
        return;
      }
      this.startTask(created.task.id, requestId).catch(ignoreDirectImageStartFailure);
    }
    return this.readTask(created.task.id) || created.task;
  }

  /** Delete only the retained task that conflicts with the incoming product or SKU target. */
  deleteConflictingTasks(source, retainedTaskId, preserveImages) {
    const input = source && typeof source === "object" ? source : {};
    if (this.taskScope !== "sku") {
      this.deleteTasksForProduct(input.temu_main_id, !preserveImages, retainedTaskId);
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
      if (sameProduct && sameSku && String(task.id || "") !== String(retainedTaskId || "")) {
        this.deleteTask(task.id, true);
      }
    }
  }

  /** Delete every retained task for one Temu product before starting a replacement. */
  deleteTasksForProduct(temuMainId, removeImages, retainedTaskId) {
    const key = String(temuMainId || "");
    const tasks = this.readTasks();
    for (let index = 0; index < tasks.length; index += 1) {
      if (String(tasks[index].temu_main_id || "") === key
        && String(tasks[index].id || "") !== String(retainedTaskId || "")) {
        this.deleteTask(tasks[index].id, removeImages);
      }
    }
  }

  /** Delete one retained task and optionally remove its unreferenced generated image. */
  deleteTask(taskId, cleanupMode) {
    const safeTaskId = this.normalizeTaskId(taskId);
    const task = this.readTask(safeTaskId);
    const filePath = this.getTaskPath(safeTaskId);
    if (safeTaskId && !fs.existsSync(filePath + ".cancelled")) {
      // Retain only identifiers: deleting local work cannot cancel or refund the Tuba task.
      fs.writeFileSync(filePath + ".cancelled", JSON.stringify({
        id: safeTaskId,
        provider_task_id: String(task && task.provider_task_id || ""),
        cancelled_at: new Date().toISOString()
      }), "utf8");
    }
    this.cancelledTaskIds[safeTaskId] = true;
    const controller = this.activeControllers[safeTaskId];
    if (controller) {
      controller.abort();
      delete this.activeControllers[safeTaskId];
    }
    if (this.providers && typeof this.providers.cancelImageTasks === "function") {
      this.providers.cancelImageTasks(function matchDirectImageQueueTask(metadata) {
        return String(metadata && metadata.direct_task_id || "") === safeTaskId;
      });
    }
    if (task && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    const cleanup = cleanupMode === true ? "all" : String(cleanupMode || "none");
    if (task && (cleanup === "all" || cleanup === "alternates")) {
      const versions = this.normalizeImageVersions(task);
      for (let versionIndex = 0; versionIndex < versions.length; versionIndex += 1) {
        if (task.source_image_urls.indexOf(versions[versionIndex]) < 0
          && (cleanup === "all" || versions[versionIndex] !== String(task.image_url || ""))) {
          this.deleteGeneratedImage(versions[versionIndex]);
        }
      }
    }
    return task;
  }

  /** Delete one generated image only after persisted business references disappear. */
  deleteGeneratedImage(imageUrl) {
    if (this.images && typeof this.images.deleteUnreferencedGeneratedImage === "function") {
      return this.images.deleteUnreferencedGeneratedImage(imageUrl);
    }
    return false;
  }

  /** Mark tasks interrupted by a previous server process as failed and retryable. */
  recoverInterruptedTasks() {
    const tasks = this.readTasks();
    for (let index = 0; index < tasks.length; index += 1) {
      if (tasks[index].status !== "queued" && tasks[index].status !== "generating") {
        continue;
      }
      tasks[index].status = "interrupted";
      const uncertain = tasks[index].provider_status === "submitting";
      tasks[index].error = uncertain ? "服务器在提交时重启，提交结果不确定；请核查上游记录后手动重试。"
        : "服务器重启中断了图片任务，不会自动恢复；上游可能仍会完成并计费。";
      tasks[index].error_code = uncertain ? "PROVIDER_SUBMISSION_UNKNOWN" : "DIRECT_IMAGE_SERVER_RESTARTED";
      this.writeTask(tasks[index]);
    }
  }
}

module.exports = { DirectImageRuntimeService: DirectImageRuntimeService };
