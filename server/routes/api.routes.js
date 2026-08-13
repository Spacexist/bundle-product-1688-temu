const express = require("express");
const schemaModule = require("../schemas/api.schemas");
const validationModule = require("../middleware/validate");

/** Build all business API routes from injected controllers and event hubs. */
function createApiRouter(options) {
  const settings = options || {};
  const router = express.Router();
  const products = settings.productController;
  const config = settings.configController;
  const images = settings.imageController;
  const currency = settings.currencyController;

  /** Return API health without touching persistence. */
  function getHealth(request, response) {
    response.json({ ok: true, data: { service: "temu-1688-api", status: "ok" }, error: null, meta: { request_id: request.requestId } });
  }

  /** Connect one frontend to lightweight invalidation events. */
  function connectEvents(request, response) {
    settings.events.connect(request, response);
  }

  router.get("/health", getHealth);
  router.get("/workbench", products.getWorkbench.bind(products));
  router.delete("/products", products.clearAll.bind(products));
  router.delete("/products/platform/:platform", products.clearPlatform.bind(products));
  router.delete("/products/:platform/:platformId", products.deleteOne.bind(products));
  router.post("/imports/json", validationModule.validate(schemaModule.jsonImportSchema, "body"), products.importJson.bind(products));
  router.post("/restore", validationModule.validate(schemaModule.jsonImportSchema, "body"), products.restoreJson.bind(products));
  router.get("/exports/json", products.exportJson.bind(products));
  router.get("/zip", products.exportMiaoshouZip.bind(products));
  router.post("/products/collect", validationModule.validate(schemaModule.collectionSchema, "body"), products.collect.bind(products));
  router.patch(
    "/products/:platform/:platformId/modules/:module",
    validationModule.validate(schemaModule.moduleSaveSchema.omit({ platform: true, platform_id: true, module: true }), "body"),
    products.saveModule.bind(products)
  );
  router.post("/replaceSku", validationModule.validate(schemaModule.replaceSkuSchema, "body"), products.replaceSku.bind(products));
  router.post(
    "/products/:platform/:platformId/skus/copy-first",
    validationModule.validate(schemaModule.copyFirstSkuAttributeSchema, "body"),
    products.copyFirstSkuAttribute.bind(products)
  );
  router.post("/products/undo", validationModule.validate(schemaModule.undoSchema, "body"), products.undo.bind(products));
  router.get("/events", connectEvents);
  router.get("/config", config.getPublicConfig.bind(config));
  router.put("/config/secrets", validationModule.validate(schemaModule.configUpdateSchema, "body"), config.updateSecrets.bind(config));
  router.post("/DollarTransfer", validationModule.validate(schemaModule.dollarTransferSchema, "body"), currency.convert.bind(currency));
  router.post("/cache/images", validationModule.validate(schemaModule.imageCacheSchema, "body"), images.cacheImage.bind(images));
  router.post("/images/search-1688", validationModule.validate(schemaModule.imageSearchSchema, "body"), images.search1688.bind(images));
  return router;
}

module.exports = { createApiRouter: createApiRouter };
