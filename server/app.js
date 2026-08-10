const path = require("path");
const express = require("express");
const cors = require("cors");
const configModule = require("./config/config-loader");
const cacheModule = require("./repositories/cache.repository");
const eventModule = require("./events/event-hub");
const viewModelModule = require("./services/view-model.service");
const productModule = require("./services/product.service");
const collectionModule = require("./services/collection.service");
const productControllerModule = require("./controllers/product.controller");
const imageControllerModule = require("./controllers/image.controller");
const imageCacheModule = require("./services/image-cache.service");
const configControllerModule = require("./controllers/config.controller");
const routeModule = require("./routes/api.routes");
const providerRouteModule = require("./routes/provider.routes");
const requestContextModule = require("./middleware/request-context");
const errorModule = require("./middleware/error-handler");
const adapterModule = require("./adapters/legacy-api.adapter");
const legacyApi = require("./legacy-api");

/** Test whether one CORS origin is permitted by local server configuration. */
function isAllowedOrigin(origin, configuredOrigins) {
  if (!origin) {
    return true;
  }
  for (let index = 0; index < configuredOrigins.length; index += 1) {
    const allowed = String(configuredOrigins[index] || "");
    if (allowed === origin) {
      return true;
    }
    if (allowed.endsWith("*") && origin.indexOf(allowed.slice(0, -1)) === 0) {
      return true;
    }
  }
  return false;
}

/** Create the independently testable Express application. */
function createApp() {
  const config = configModule.readServerConfig();
  const repository = new cacheModule.CacheRepository(config.storage);
  const events = new eventModule.EventHub({ writeLog: legacyApi.writeServerLog });
  const viewModels = new viewModelModule.ViewModelService();
  const images = new imageCacheModule.ImageCacheService(config.storage);
  const products = new productModule.ProductService({ repository: repository, viewModels: viewModels, events: events, images: images });
  const collection = new collectionModule.CollectionService({
    repository: repository,
    viewModels: viewModels,
    events: events,
    workflow: legacyApi.getWorkflowService(),
    images: images
  });
  const productController = new productControllerModule.ProductController({ products: products, collection: collection });
  const imageController = new imageControllerModule.ImageController({ images: images });
  const configController = new configControllerModule.ConfigController();
  const app = express();

  /** Resolve each browser origin through the configured local allow list. */
  function resolveCorsOrigin(origin, callback) {
    if (isAllowedOrigin(origin, config.server.corsOrigins)) {
      callback(null, true);
      return;
    }
    callback(new Error("CORS origin is not allowed."));
  }

  app.use(cors({ origin: resolveCorsOrigin }));

  /** Serve the Network-style backend log page. */
  function serveLogPage(request, response) {
    response.sendFile(path.join(__dirname, "logs.html"));
  }
  app.get("/server/logs", serveLogPage);

  app.use(requestContextModule.attachRequestContext);

  const providerRouter = providerRouteModule.createProviderRouter();
  providerRouter.all("/logs", adapterModule.createLegacyApiAdapter("/api/debug/logs"));
  providerRouter.all("/logs/events", adapterModule.createLegacyApiAdapter("/api/debug/logs/events"));
  providerRouter.all("/queue", adapterModule.createLegacyApiAdapter("/api/debug/queue"));
  providerRouter.all("/queue/events", adapterModule.createLegacyApiAdapter("/api/debug/queue/events"));
  app.use("/api/v1", providerRouter);

  app.use(express.json({ limit: "80mb" }));
  app.use(requestContextModule.logParsedRequestBody);
  app.use("/api/v1/cache/image", express.static(images.imageDirectory, { immutable: true, maxAge: "365d" }));
  const businessRouteOptions = {
    productController: productController,
    configController: configController,
    imageController: imageController,
    events: events
  };
  app.use("/api/v1", routeModule.createApiRouter(businessRouteOptions));
  app.use("/v1/api", routeModule.createApiRouter(businessRouteOptions));

  /** Return the shared envelope for every unknown API path. */
  function handleMissingRoute(request, response) {
    response.status(404).json({
      ok: false,
      data: null,
      error: { code: "NOT_FOUND", message: "API 路径不存在。", details: null },
      meta: { request_id: request.requestId || "" }
    });
  }
  app.use(handleMissingRoute);
  app.use(errorModule.handleApiError);
  return app;
}

module.exports = { createApp: createApp };
