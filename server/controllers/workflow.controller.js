/** Keep one synchronous workflow generation request bounded to five minutes. */
const WORKFLOW_GENERATION_TIMEOUT_MS = 300000;

/** Intelligent-packing HTTP controller backed by the workflow domain service. */
class WorkflowController {
  /** Store workflow and optional binding services. */
  constructor(options) {
    const settings = options || {};
    this.workflow = settings.workflow;
    this.binding = settings.binding;
    this.carousel = settings.carousel;
    this.directImages = settings.directImages;
    this.products = settings.products;
  }

  /** Return the persisted intelligent-packing state. */
  getWorkflow(request, response, next) {
    try {
      response.json({ ok: true, data: this.workflow.readWorkflowSnapshot(), error: null, meta: { request_id: request.requestId } });
    } catch (error) {
      next(error);
    }
  }

  /** Return the active workflow task used by the browser extension. */
  getActive(request, response, next) {
    try {
      const active = this.workflow.getActivePayload();
      response.json({
        ok: true,
        data: {
          active_temu_main_id: String(active.active_temu_main_id || ""),
          active_source_mode: String(active.active_source_mode || ""),
          task: active.task || null
        },
        error: null,
        meta: { request_id: request.requestId }
      });
    } catch (error) {
      next(error);
    }
  }

  /** Generate four intelligent-packing prompts for one Temu product. */
  async generatePrompts(request, response, next) {
    if (request.validatedBody.mode === "carousel") {
      await this.generateCarouselPrompts(request, response);
      return;
    }
    const temuMainId = String(request.validatedBody.temu_main_id || "");
    try {
      this.workflow.setTemporaryState(temuMainId, "analyzing", "", "", request.requestId, "legacy");
      const result = await this.workflow.generatePrompts(request.validatedBody, request.requestId);
      this.workflow.setTemporaryState(temuMainId, "prompts_ready", "", "", request.requestId, "legacy");
      response.json({ ok: true, data: { task: result.task }, error: null, meta: { request_id: request.requestId } });
    } catch (error) {
      this.workflow.setTemporaryState(temuMainId, "error", error.message, error.code, request.requestId, "legacy");
      next(error);
    }
  }

  /** Generate CLIP-backed real-product candidates through the local listing service. */
  async assembleClip(request, response, next) {
    const temuMainId = String(request.validatedBody.temu_main_id || "");
    try {
      this.workflow.setTemporaryState(temuMainId, "analyzing", "", "", request.requestId, "clip");
      const result = await this.workflow.assembleClip(request.validatedBody, request.requestId);
      this.workflow.setTemporaryState(temuMainId, "ready", "", "", request.requestId, "clip");
      response.json({ ok: true, data: { task: result.task }, error: null, meta: { request_id: request.requestId } });
    } catch (error) {
      this.workflow.setTemporaryState(temuMainId, "error", error.message, error.code, request.requestId, "clip");
      next(error);
    }
  }

  /** Search CLIP directly with one user-entered keyword and persist two candidates. */
  async searchClip(request, response, next) {
    const temuMainId = String(request.validatedBody.temu_main_id || "");
    try {
      this.workflow.setTemporaryState(temuMainId, "analyzing", "", "", request.requestId, "clip");
      const result = await this.workflow.searchClip(request.validatedBody, request.requestId);
      this.workflow.setTemporaryState(temuMainId, "ready", "", "", request.requestId, "clip");
      response.json({ ok: true, data: { task: result.task }, error: null, meta: { request_id: request.requestId } });
    } catch (error) {
      this.workflow.setTemporaryState(temuMainId, "error", error.message, error.code, request.requestId, "clip");
      next(error);
    }
  }

  /** Search CLIP top 10 directly from one English candidate keyword. */
  async searchClipTop10(request, response, next) {
    try {
      const result = await this.workflow.searchClipTop10(request.validatedBody, request.requestId);
      response.json({ ok: true, data: result, error: null, meta: { request_id: request.requestId } });
    } catch (error) {
      next(error);
    }
  }

  /** Write one named SSE event without exposing hidden reasoning content. */
  writeCarouselEvent(response, eventName, payload) {
    if (!response || response.destroyed || response.writableEnded) {
      return;
    }
    response.write("event: " + eventName + "\n");
    response.write("data: " + JSON.stringify(payload) + "\n\n");
  }

  /** Stream Kimi carousel planning progress and the final runtime task. */
  async generateCarouselPrompts(request, response) {
    response.status(200);
    response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    response.setHeader("Cache-Control", "no-cache, no-transform");
    response.setHeader("Connection", "keep-alive");
    response.flushHeaders();
    const controller = this;
    /** Forward a safe task snapshot as planning progress. */
    function reportCarouselProgress(task, eventName) {
      controller.writeCarouselEvent(response, eventName === "complete" ? "complete" : "progress", {
        task: task,
        estimated_tokens: Number(task.estimated_tokens || 0)
      });
    }
    try {
      await this.carousel.planTask(request.validatedBody, request.requestId, reportCarouselProgress);
    } catch (error) {
      this.writeCarouselEvent(response, "error", {
        code: String(error.code || "CAROUSEL_PLAN_FAILED"),
        message: String(error.message || "轮播规划失败。"),
        details: error.details || null
      });
    }
    if (!response.destroyed && !response.writableEnded) {
      response.end();
    }
  }

  /** Return the active carousel task for one Temu product. */
  getCarouselTask(request, response, next) {
    try {
      const task = this.carousel.findTaskByTemuMainId(request.params.temuMainId);
      response.json({ ok: true, data: { task: task }, error: null, meta: { request_id: request.requestId } });
    } catch (error) {
      next(error);
    }
  }

  /** Return every retained carousel task so the workbench can render reopen indicators. */
  getCarouselTasks(request, response, next) {
    try {
      response.json({ ok: true, data: { tasks: this.carousel.readTasks() }, error: null, meta: { request_id: request.requestId } });
    } catch (error) {
      next(error);
    }
  }

  /** Start one server-owned Kimi plus Fusion pipeline and return its persisted task immediately. */
  startCarouselPlan(request, response, next) {
    try {
      const task = this.carousel.startPlanning(request.validatedBody, request.requestId);
      response.status(202).json({ ok: true, data: { task: task }, error: null, meta: { request_id: request.requestId } });
    } catch (error) {
      next(error);
    }
  }

  /** Create one ready carousel task from manually configured storyboard prompts. */
  startManualCarouselPlan(request, response, next) {
    try {
      const task = this.carousel.createManualTask(request.validatedBody);
      response.status(202).json({ ok: true, data: { task: task }, error: null, meta: { request_id: request.requestId } });
    } catch (error) {
      next(error);
    }
  }

  /** Save advanced-mode page edits and release the task for generation. */
  updateCarouselTask(request, response, next) {
    try {
      const task = this.carousel.updateTaskPlan(request.params.taskId, request.validatedBody);
      response.json({ ok: true, data: { task: task }, error: null, meta: { request_id: request.requestId } });
    } catch (error) {
      next(error);
    }
  }

  /** Save one non-running carousel page without resetting the remaining task. */
  updateCarouselPage(request, response, next) {
    try {
      const task = this.carousel.updateTaskPage(request.params.taskId, request.params.pageIndex, request.validatedBody);
      response.json({ ok: true, data: { task: task }, error: null, meta: { request_id: request.requestId } });
    } catch (error) {
      next(error);
    }
  }

  /** Start selected carousel pages in the background and return without waiting for Fusion completion. */
  generateCarouselTask(request, response, next) {
    try {
      const task = this.carousel.startGeneration(request.params.taskId, request.validatedBody.page_indices, request.requestId);
      response.status(202).json({ ok: true, data: { task: task }, error: null, meta: { request_id: request.requestId } });
    } catch (error) {
      next(error);
    }
  }

  /** Apply selected successful pages as one durable product image mutation. */
  async applyCarouselTask(request, response, next) {
    try {
      const task = this.carousel.readTask(request.params.taskId);
      if (!task) {
        const error = new Error("轮播任务不存在。");
        error.statusCode = 404;
        error.code = "CAROUSEL_TASK_NOT_FOUND";
        throw error;
      }
      const result = await this.products.applyCarouselTask(task, request.validatedBody.selected_indices, request.requestId, Boolean(request.validatedBody.replace_all));
      this.carousel.deleteTask(task.id, false);
      response.json({ ok: true, data: result, error: null, meta: { request_id: request.requestId } });
    } catch (error) {
      next(error);
    }
  }

  /** Abandon one runtime task and remove its un-applied generated images. */
  deleteCarouselTask(request, response, next) {
    try {
      const task = this.carousel.deleteTask(request.params.taskId, true);
      response.json({ ok: true, data: { deleted: Boolean(task) }, error: null, meta: { request_id: request.requestId } });
    } catch (error) {
      next(error);
    }
  }

  /** Generate all or one intelligent-packing candidate image and wait for its result. */
  async generateImages(request, response, next) {
    const temuMainId = String(request.validatedBody.temu_main_id || "");
    try {
      if (request && typeof request.setTimeout === "function") {
        request.setTimeout(WORKFLOW_GENERATION_TIMEOUT_MS);
      }
      if (response && typeof response.setTimeout === "function") {
        response.setTimeout(WORKFLOW_GENERATION_TIMEOUT_MS);
      }
      const result = await this.workflow.generateImages(request.validatedBody, request.requestId);
      response.json({ ok: true, data: { task: result.task }, error: null, meta: { request_id: request.requestId } });
    } catch (error) {
      this.workflow.setTemporaryState(temuMainId, "error", error.message, error.code, request.requestId, "legacy");
      next(error);
    }
  }

  /** Persist one Temu-to-1688 binding and complete its workflow task. */
  complete(request, response, next) {
    try {
      if (!this.binding) {
        const error = new Error("绑定服务未初始化。");
        error.statusCode = 500;
        throw error;
      }
      const binding = this.binding.bindTemuTo1688(request.validatedBody);
      const workflowPayload = this.workflow.complete(request.validatedBody, request.requestId);
      response.json({
        ok: true,
        data: { binding: binding, task: workflowPayload.task },
        error: null,
        meta: { request_id: request.requestId }
      });
    } catch (error) {
      next(error);
    }
  }
}

module.exports = { WorkflowController: WorkflowController };
