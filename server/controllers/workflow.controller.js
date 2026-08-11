/** Intelligent-packing HTTP controller backed by the workflow domain service. */
class WorkflowController {
  /** Store workflow and optional binding services. */
  constructor(options) {
    const settings = options || {};
    this.workflow = settings.workflow;
    this.binding = settings.binding;
  }

  /** Return the persisted intelligent-packing state. */
  getWorkflow(request, response, next) {
    try {
      response.json({ ok: true, data: this.workflow.readPayload(), error: null, meta: { request_id: request.requestId } });
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
          task: active.task || null
        },
        error: null,
        meta: { request_id: request.requestId }
      });
    } catch (error) {
      next(error);
    }
  }

  /** Connect one browser or extension to the workflow SSE stream. */
  connectEvents(request, response, next) {
    try {
      this.workflow.handleEvents(request, response);
    } catch (error) {
      next(error);
    }
  }

  /** Generate four intelligent-packing prompts for one Temu product. */
  async generatePrompts(request, response, next) {
    try {
      const result = await this.workflow.generatePrompts(request.validatedBody, request.requestId);
      response.json({ ok: true, data: { task: result.task }, error: null, meta: { request_id: request.requestId } });
    } catch (error) {
      next(error);
    }
  }

  /** Schedule all or one intelligent-packing candidate image for generation. */
  async generateImages(request, response, next) {
    try {
      const result = await this.workflow.generateImages(request.validatedBody, request.requestId);
      response.json({ ok: true, data: { task: result.task }, error: null, meta: { request_id: request.requestId } });
    } catch (error) {
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
