/** Product HTTP controller with no persistence or transformation logic. */
class ProductController {
  /** Store the product and collection application services. */
  constructor(options) {
    const settings = options || {};
    this.products = settings.products;
    this.collection = settings.collection;
  }

  /** Return the current ready-to-render workbench ViewModel. */
  getWorkbench(request, response, next) {
    try {
      response.json({ ok: true, data: this.products.getWorkbench(), error: null, meta: { request_id: request.requestId } });
    } catch (error) {
      next(error);
    }
  }

  /** Clear the complete product cache via the backend repository. */
  clearAll(request, response, next) {
    try {
      response.json({ ok: true, data: this.products.clearAll(), error: null, meta: { request_id: request.requestId } });
    } catch (error) {
      next(error);
    }
  }

  /** Delete one cached product selected by platform and platform identifier. */
  deleteOne(request, response, next) {
    try {
      const result = this.products.deleteOne(request.params.platform, request.params.platformId);
      response.json({ ok: true, data: result, error: null, meta: { request_id: request.requestId } });
    } catch (error) {
      next(error);
    }
  }

  /** Clear only the cached products that belong to one platform. */
  clearPlatform(request, response, next) {
    try {
      const result = this.products.clearPlatform(request.params.platform);
      response.json({ ok: true, data: result, error: null, meta: { request_id: request.requestId } });
    } catch (error) {
      next(error);
    }
  }

  /** Save one independently versioned product module. */
  async saveModule(request, response, next) {
    try {
      const input = request.validatedBody;
      input.platform = request.params.platform;
      input.platform_id = request.params.platformId;
      input.module = request.params.module;
      const result = await this.products.saveModule(input);
      response.json({ ok: true, data: result, error: null, meta: { request_id: request.requestId } });
    } catch (error) {
      next(error);
    }
  }

  /** Restore one previous module snapshot. */
  undo(request, response, next) {
    try {
      const result = this.products.undo(request.validatedBody);
      response.json({ ok: true, data: result, error: null, meta: { request_id: request.requestId } });
    } catch (error) {
      next(error);
    }
  }

  /** Accept a raw browser-extension capture for backend normalization. */
  async collect(request, response, next) {
    try {
      const result = await this.collection.collect(request.validatedBody);
      response.json({ ok: true, data: result, error: null, meta: { request_id: request.requestId } });
    } catch (error) {
      next(error);
    }
  }

  /** Import one JSON document and return the refreshed ViewModel. */
  async importJson(request, response, next) {
    try {
      const result = await this.products.importJson(request.validatedBody);
      response.json({ ok: true, data: result, error: null, meta: { request_id: request.requestId } });
    } catch (error) {
      next(error);
    }
  }

  /** Restore one extension-exported JSON batch through the backend API. */
  async restoreJson(request, response, next) {
    try {
      const result = await this.products.restoreJson(request.validatedBody);
      response.json({ ok: true, data: result, error: null, meta: { request_id: request.requestId } });
    } catch (error) {
      next(error);
    }
  }

  /** Download the current backend-produced ViewModel as JSON. */
  exportJson(request, response, next) {
    try {
      const payload = this.products.getWorkbench();
      response.setHeader("Content-Disposition", "attachment; filename=temu-1688-export-" + Date.now() + ".json");
      response.type("application/json").send(JSON.stringify(payload, null, 2));
    } catch (error) {
      next(error);
    }
  }
}

module.exports = { ProductController: ProductController };
