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
