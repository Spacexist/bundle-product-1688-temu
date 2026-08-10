/** Image HTTP controller that delegates every cache mutation to the backend service. */
class ImageController {
  /** Store the image cache dependency. */
  constructor(options) {
    const settings = options || {};
    this.images = settings.images;
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
}

module.exports = { ImageController: ImageController };
