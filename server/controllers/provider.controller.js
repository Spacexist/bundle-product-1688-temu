/** Provider HTTP controller for Listing, image, and detail integrations. */
class ProviderController {
  /** Store the provider integration service. */
  constructor(options) {
    const settings = options || {};
    this.providers = settings.providers;
    this.carousel = settings.carousel;
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
    try {
      if (taskId && this.carousel) {
        const carouselTask = this.carousel.markPageGenerating(taskId, pageIndex);
        input.image_urls = carouselTask.source_image_urls.slice();
        input.prompt = String(carouselTask.pages[pageIndex].prompt || "");
        input.size = String(carouselTask.size || "1k");
      }
      const result = await this.providers.editImages(input, "fusion", request.requestId);
      if (taskId && this.carousel) {
        const task = this.carousel.markPageSucceeded(taskId, pageIndex, result.image_url);
        if (!task) {
          this.carousel.deleteGeneratedImage(result.image_url);
        }
      }
      response.json({ ok: true, data: result, error: null, meta: { request_id: request.requestId } });
    } catch (error) {
      if (taskId && this.carousel) {
        this.carousel.markPageFailed(taskId, pageIndex, error);
      }
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
