/** Provider HTTP controller for Listing, image, and detail integrations. */
class ProviderController {
  /** Store the provider integration service. */
  constructor(options) {
    const settings = options || {};
    this.providers = settings.providers;
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
    try {
      const result = await this.providers.editImages(request.validatedBody, "fusion", request.requestId);
      response.json({ ok: true, data: result, error: null, meta: { request_id: request.requestId } });
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
