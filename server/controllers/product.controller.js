/** Product HTTP controller with no persistence or transformation logic. */
class ProductController {
  /** Store the product and collection application services. */
  constructor(options) {
    const settings = options || {};
    this.products = settings.products;
    this.collection = settings.collection;
    this.miaoshouExport = settings.miaoshouExport;
  }

  /** Return the current ready-to-render workbench ViewModel. */
  getWorkbench(request, response, next) {
    try {
      response.json({ ok: true, data: this.products.getWorkbench(), error: null, meta: { request_id: request.requestId } });
    } catch (error) {
      next(error);
    }
  }

  /** Clear every persisted entry from the complete backend cache directory. */
  async clearAll(request, response, next) {
    try {
      const result = await this.products.clearAll(request.requestId);
      response.json({ ok: true, data: result, error: null, meta: { request_id: request.requestId } });
    } catch (error) {
      next(error);
    }
  }

  /** Delete one cached product selected by platform and platform identifier. */
  async deleteOne(request, response, next) {
    try {
      const result = await this.products.deleteOne(request.params.platform, request.params.platformId, request.requestId);
      response.json({ ok: true, data: result, error: null, meta: { request_id: request.requestId } });
    } catch (error) {
      next(error);
    }
  }

  /** Clear only the cached products that belong to one platform. */
  async clearPlatform(request, response, next) {
    try {
      const result = await this.products.clearPlatform(request.params.platform, request.requestId);
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
      const result = await this.products.saveModule(input, request.requestId);
      response.json({ ok: true, data: result, error: null, meta: { request_id: request.requestId } });
    } catch (error) {
      next(error);
    }
  }

  /** Replace one Temu SKU with the selected 1688 SKU and return the fresh row. */
  async replaceSku(request, response, next) {
    try {
      const result = await this.products.replaceSku(request.validatedBody, request.requestId);
      response.json({ ok: true, data: result, error: null, meta: { request_id: request.requestId } });
    } catch (error) {
      next(error);
    }
  }

  /** Copy one editable SKU1 attribute to all SKU rows. */
  async copyFirstSkuAttribute(request, response, next) {
    try {
      const input = request.validatedBody;
      input.platform = request.params.platform;
      input.platform_id = request.params.platformId;
      const result = await this.products.copyFirstSkuAttribute(input, request.requestId);
      response.json({ ok: true, data: result, error: null, meta: { request_id: request.requestId } });
    } catch (error) {
      next(error);
    }
  }

  /** Restore one previous module snapshot. */
  async undo(request, response, next) {
    try {
      const result = await this.products.undo(request.validatedBody, request.requestId);
      response.json({ ok: true, data: result, error: null, meta: { request_id: request.requestId } });
    } catch (error) {
      next(error);
    }
  }

  /** Accept a raw browser-extension capture for backend normalization. */
  async collect(request, response, next) {
    try {
      const result = await this.collection.collect(request.validatedBody, request.requestId);
      response.json({ ok: true, data: result, error: null, meta: { request_id: request.requestId } });
    } catch (error) {
      next(error);
    }
  }

  /** Import one JSON document and return the refreshed ViewModel. */
  async importJson(request, response, next) {
    try {
      const result = await this.products.importJson(request.validatedBody, request.requestId);
      response.json({ ok: true, data: result, error: null, meta: { request_id: request.requestId } });
    } catch (error) {
      next(error);
    }
  }

  /** Restore one extension-exported JSON batch through the backend API. */
  async restoreJson(request, response, next) {
    try {
      const result = await this.products.restoreJson(request.validatedBody, request.requestId);
      response.json({ ok: true, data: result, error: null, meta: { request_id: request.requestId } });
    } catch (error) {
      next(error);
    }
  }

  /** Restore one extension-exported JSON batch through sequential text chunks. */
  async restoreJsonChunk(request, response, next) {
    try {
      const result = await this.products.restoreJsonChunk({
        upload_id: request.get("X-Restore-Upload-Id"),
        file_name: request.get("X-Restore-File-Name"),
        chunk_index: Number(request.get("X-Restore-Chunk-Index")),
        total_chunks: Number(request.get("X-Restore-Total-Chunks")),
        chunk_base64: String(request.body || "")
      }, request.requestId);
      response.json({ ok: true, data: result, error: null, meta: { request_id: request.requestId } });
    } catch (error) {
      next(error);
    }
  }

  /** Restore the next prepared backup record batch and report progress. */
  async restoreJsonBatch(request, response, next) {
    try {
      const input = request.body && typeof request.body === "object" ? request.body : {};
      const result = await this.products.restoreJsonBatch(input, request.requestId);
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

  /** Generate and download the current Temu-only 妙手 ZIP on the server. */
  async exportMiaoshouZip(request, response, next) {
    try {
      const exportService = this.miaoshouExport;
      const packageFile = await exportService.createTemuZipFile();
      response.setHeader("Access-Control-Expose-Headers", "Content-Disposition, X-Miaoshou-Image-Failures, X-Miaoshou-Product-Count");
      response.setHeader("X-Miaoshou-Image-Failures", String(packageFile.result.failureCount || 0));
      response.setHeader("X-Miaoshou-Product-Count", String(packageFile.result.productCount || 0));
      /** Clean up the completed temporary ZIP after Express finishes sending it. */
      function finishMiaoshouZipDownload(error) {
        exportService.cleanupTemuZipFile(packageFile.filePath);
        if (error && !response.headersSent) {
          next(error);
        }
      }
      response.download(packageFile.filePath, packageFile.result.fileName, finishMiaoshouZipDownload);
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      next(error);
    }
  }

  /** Upload the current Temu-only 妙手 ZIP directly into Miaoshou's import flow. */
  async importMiaoshouOnline(request, response, next) {
    try {
      const input = request.validatedBody || {};
      const result = await this.miaoshouExport.importTemuOnline({
        cookie: input.cookie,
        autoFetch: input.auto_fetch !== false
      });
      response.json({ ok: true, data: result, error: null, meta: { request_id: request.requestId } });
    } catch (error) {
      next(error);
    }
  }

  /** Return whether server/cookie.json contains a reusable Miaoshou Cookie. */
  getMiaoshouCookieStatus(request, response, next) {
    try {
      const result = this.miaoshouExport.getSavedMiaoshouCookieStatus();
      response.json({ ok: true, data: result, error: null, meta: { request_id: request.requestId } });
    } catch (error) {
      next(error);
    }
  }

  /** Save one Miaoshou Cookie header without running an online import. */
  saveMiaoshouCookie(request, response, next) {
    try {
      const input = request.validatedBody || {};
      this.miaoshouExport.saveMiaoshouCookie(input.cookie);
      const result = this.miaoshouExport.getSavedMiaoshouCookieStatus();
      response.json({ ok: true, data: result, error: null, meta: { request_id: request.requestId } });
    } catch (error) {
      next(error);
    }
  }
}

module.exports = { ProductController: ProductController };
