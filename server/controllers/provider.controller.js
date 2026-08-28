/** Provider HTTP controller for Listing, image, and detail integrations. */
class ProviderController {
  /** Store the provider integration service. */
  constructor(options) {
    const settings = options || {};
    this.providers = settings.providers;
    this.carousel = settings.carousel;
    this.directImages = settings.directImages;
    this.skuBlendTasks = settings.skuBlendTasks;
  }

  /** Merge the selected Temu and 1688 Listing values through Kimi. */
  async mergeListing(request, response, next) {
    try {
      const result = await this.providers.mergeListing(request.validatedBody, request.requestId);
      response.json({ ok: true, data: result, error: null, meta: { request_id: request.requestId } });
    } catch (error) {
      next(error);
    }
  }

  /** Restore one Listing snapshot from its one-time undo token. */
  undoListing(request, response, next) {
    try {
      const result = this.providers.undoListing(request.validatedBody);
      response.json({ ok: true, data: result, error: null, meta: { request_id: request.requestId } });
    } catch (error) {
      next(error);
    }
  }

  /** Edit one image through the configured BeeAPI endpoint. */
  async editImage(request, response, next) {
    try {
      const result = await this.providers.editImages(request.validatedBody, "edit", request.requestId);
      response.json({ ok: true, data: result, error: null, meta: { request_id: request.requestId } });
    } catch (error) {
      next(error);
    }
  }

  /** Fuse two images through the configured BeeAPI endpoint. */
  async fuseImages(request, response, next) {
    const input = request.validatedBody;
    const taskId = String(input.carousel_task_id || "");
    const pageIndex = Number(input.carousel_page_index);
    let generationId = "";
    let pageStarted = false;
    try {
      if (taskId && this.carousel) {
        const carouselTask = this.carousel.markPageGenerating(taskId, pageIndex);
        generationId = String(carouselTask.pages[pageIndex].generation_id || "");
        pageStarted = true;
        input.image_urls = carouselTask.source_image_urls.slice();
        input.prompt = String(carouselTask.pages[pageIndex].prompt || "");
        input.size = String(carouselTask.size || "1024x1024");
        input.generation_id = generationId;
      }
      const result = await this.providers.editImages(input, "fusion", request.requestId);
      if (taskId && this.carousel) {
        const task = this.carousel.markPageSucceeded(taskId, pageIndex, result.image_url, generationId);
        if (!task) {
          this.carousel.deleteGeneratedImage(result.image_url);
        }
      }
      response.json({ ok: true, data: result, error: null, meta: { request_id: request.requestId } });
    } catch (error) {
      if (taskId && this.carousel && pageStarted) {
        this.carousel.markPageFailed(taskId, pageIndex, error, generationId);
      }
      next(error);
    }
  }

  /** Create one persistent direct-image task and return before provider completion. */
  createDirectImageTask(request, response, next) {
    try {
      const task = this.directImages.createAndStartTask(request.validatedBody, request.requestId);
      response.status(202).json({ ok: true, data: { task: task }, error: null, meta: { request_id: request.requestId } });
    } catch (error) {
      next(error);
    }
  }

  /** Return every retained direct-image task used by Workbench reopen controls. */
  getDirectImageTasks(request, response, next) {
    try {
      response.json({ ok: true, data: { tasks: this.directImages.readTasks() }, error: null, meta: { request_id: request.requestId } });
    } catch (error) {
      next(error);
    }
  }

  /** Return the newest retained direct-image task for one Temu product. */
  getDirectImageTaskForProduct(request, response, next) {
    try {
      const task = this.directImages.findTaskByTemuMainId(request.params.temuMainId);
      response.json({ ok: true, data: { task: task }, error: null, meta: { request_id: request.requestId } });
    } catch (error) {
      next(error);
    }
  }

  /** Return one retained direct-image task by its stable identifier. */
  getDirectImageTask(request, response, next) {
    try {
      const task = this.directImages.readTask(request.params.taskId);
      if (!task) {
        const error = new Error("单结果图片任务不存在。");
        error.statusCode = 404;
        error.code = "DIRECT_IMAGE_TASK_NOT_FOUND";
        throw error;
      }
      response.json({ ok: true, data: { task: task }, error: null, meta: { request_id: request.requestId } });
    } catch (error) {
      next(error);
    }
  }

  /** Delete one retained direct-image task after apply or explicit abandonment. */
  deleteDirectImageTask(request, response, next) {
    try {
      const task = this.directImages.deleteTask(request.params.taskId);
      response.json({ ok: true, data: { deleted: Boolean(task) }, error: null, meta: { request_id: request.requestId } });
    } catch (error) {
      next(error);
    }
  }

  /** Create one persistent SKU fusion task and return before provider completion. */
  createSkuBlendTask(request, response, next) {
    try {
      const input = Object.assign({}, request.validatedBody, { mode: "fusion", source_type: "sku" });
      const task = this.skuBlendTasks.createAndStartTask(input, request.requestId);
      response.status(202).json({ ok: true, data: { task: task }, error: null, meta: { request_id: request.requestId } });
    } catch (error) {
      next(error);
    }
  }

  /** Return every retained SKU fusion task used by yellow Workbench indicators. */
  getSkuBlendTasks(request, response, next) {
    try {
      response.json({ ok: true, data: { tasks: this.skuBlendTasks.readTasks() }, error: null, meta: { request_id: request.requestId } });
    } catch (error) {
      next(error);
    }
  }

  /** Delete one retained SKU fusion task after undo or explicit replacement. */
  deleteSkuBlendTask(request, response, next) {
    try {
      const task = this.skuBlendTasks.deleteTask(request.params.taskId);
      response.json({ ok: true, data: { deleted: Boolean(task) }, error: null, meta: { request_id: request.requestId } });
    } catch (error) {
      next(error);
    }
  }

  /** Restore the two original images from a fusion undo token. */
  undoFusion(request, response, next) {
    try {
      const result = this.providers.undoImageFusion(request.validatedBody);
      response.json({ ok: true, data: result, error: null, meta: { request_id: request.requestId } });
    } catch (error) {
      next(error);
    }
  }

  /** Return image URLs parsed from one supported product detail description. */
  async getDetailImages(request, response, next) {
    try {
      const result = await this.providers.getDetailImages(request.validatedQuery.url, request.requestId);
      response.json({ ok: true, data: result, error: null, meta: { request_id: request.requestId } });
    } catch (error) {
      next(error);
    }
  }
}

module.exports = { ProviderController: ProviderController };
