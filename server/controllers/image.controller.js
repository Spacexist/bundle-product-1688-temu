/** Image HTTP controller that delegates every cache mutation to the backend service. */
class ImageController {
  /** Store the image cache dependency. */
  constructor(options) {
    const settings = options || {};
    this.images = settings.images;
    this.imageSearch = settings.imageSearch;
    this.workflow = settings.workflow || null;
  }

  /** Cache one uploaded data URL or remote image and return its local API URL. */
  async cacheImage(request, response, next) {
    try {
      const input = request.validatedBody;
      const imageUrl = await this.images.cacheImage(
        input.source,
        input.platform,
        input.kind,
        Boolean(input.generated)
      );
      response.json({
        ok: true,
        data: { image_url: imageUrl },
        error: null,
        meta: { request_id: request.requestId }
      });
    } catch (error) {
      next(error);
    }
  }

  /** Serve displayed candidates through persistent cache without changing workflow results or their loading UI. */
  async getCandidateImage(request, response, next) {
    const source = request.validatedQuery.source;
    response.setHeader("Cache-Control", "no-store");
    try {
      const localUrl = await this.images.cacheCandidateImage(source);
      if (!this.images.localUrlExists(localUrl)) {
        response.redirect(302, source);
        return;
      }
      response.removeHeader("Cache-Control");
      response.sendFile(this.images.resolveLocalImagePath(localUrl), { immutable: true, maxAge: "365d" });
    } catch (error) {
      if (error.code === "CACHE_CLEARING" || error.code === "IMAGE_TASK_CANCELLED") {
        next(error);
        return;
      }
      // Preserve the original browser loading/error behavior if this ordinary cache download fails.
      response.redirect(302, source);
    }
  }

  /** Search 1688 with one selected product image and return its search page. */
  async search1688(request, response, next) {
    try {
      const input = request.validatedBody;
      const result = await this.imageSearch.search1688(input);
      if (this.workflow && input.temu_main_id) {
        this.workflow.setActiveTemuMainId(input.temu_main_id, request.requestId, input.source_mode);
      }
      response.json({
        ok: true,
        data: result,
        error: null,
        meta: { request_id: request.requestId }
      });
    } catch (error) {
      next(error);
    }
  }
}

module.exports = { ImageController: ImageController };
