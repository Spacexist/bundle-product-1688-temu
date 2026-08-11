const path = require("path");
const express = require("express");
const cors = require("cors");
const configModule = require("./config/config-loader");
const cacheModule = require("./repositories/cache.repository");
const eventModule = require("./events/event-hub");
const diagnosticsModule = require("./services/diagnostics.service");
const imageQueueModule = require("./services/image-task-queue");
const viewModelModule = require("./services/view-model.service");
const productModule = require("./services/product.service");
const collectionModule = require("./services/collection.service");
const providerServiceModule = require("./services/provider.service");
const workflowServiceModule = require("./workflow-service");
const bindingServiceModule = require("./binding-service");
const productControllerModule = require("./controllers/product.controller");
const imageControllerModule = require("./controllers/image.controller");
const imageCacheModule = require("./services/image-cache.service");
const miaoshouExportModule = require("./services/miaoshou-export.service");
const imageSearchModule = require("./services/image-search.service");
const currencyModule = require("./services/currency.service");
const configControllerModule = require("./controllers/config.controller");
const currencyControllerModule = require("./controllers/currency.controller");
const providerControllerModule = require("./controllers/provider.controller");
const workflowControllerModule = require("./controllers/workflow.controller");
const diagnosticsControllerModule = require("./controllers/diagnostics.controller");
const routeModule = require("./routes/api.routes");
const providerRouteModule = require("./routes/provider.routes");
const requestContextModule = require("./middleware/request-context");
const errorModule = require("./middleware/error-handler");

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
  const diagnostics = new diagnosticsModule.DiagnosticsService();
  /** Read the current image queue concurrency from the private server config. */
  function getImageTaskConcurrency() {
    const currentConfig = configModule.readServerConfig();
    const queue = currentConfig.image_queue && typeof currentConfig.image_queue === "object"
      ? currentConfig.image_queue
      : {};
    const configured = Number(queue.concurrency || currentConfig.image_queue_concurrency || 4);
    if (!Number.isFinite(configured) || configured < 1) {
      return 4;
    }
    return Math.max(1, Math.min(32, Math.floor(configured)));
  }
  const imageTaskQueue = new imageQueueModule.ImageTaskQueue({
    getConcurrency: getImageTaskConcurrency,
    onChange: diagnostics.handleQueueChange.bind(diagnostics)
  });
  diagnostics.setImageTaskQueue(imageTaskQueue);
  const images = new imageCacheModule.ImageCacheService(config.storage);
  const providers = new providerServiceModule.ProviderService({
    readConfig: configModule.readServerConfig,
    images: images,
    imageTaskQueue: imageTaskQueue,
    diagnostics: diagnostics
  });
  const workflow = workflowServiceModule.createWorkflowService({
    cacheDirectory: path.resolve(__dirname, config.storage.cacheDirectory),
    readConfig: configModule.readServerConfig,
    getKimiEndpoint: providers.getKimiEndpoint.bind(providers),
    compactValue: providers.compactValue.bind(providers),
    readImageSource: providers.readImageSource.bind(providers),
    cacheGeneratedImage: function cacheWorkflowGeneratedImage(source) {
      return images.cacheImage(source, "transfer", "generated", true);
    },
    imageTaskQueue: imageTaskQueue,
    writeLog: diagnostics.write.bind(diagnostics),
    formatTime: diagnostics.formatTime.bind(diagnostics)
  });
  const binding = bindingServiceModule.createBindingService({
    cacheDirectory: path.resolve(__dirname, config.storage.cacheDirectory),
    formatTime: diagnostics.formatTime.bind(diagnostics)
  });
  const events = new eventModule.EventHub({ writeLog: diagnostics.write.bind(diagnostics) });
  const viewModels = new viewModelModule.ViewModelService();
  const imageSearch = new imageSearchModule.ImageSearchService({ images: images });
  const products = new productModule.ProductService({ repository: repository, viewModels: viewModels, events: events, images: images });
  const miaoshouExport = new miaoshouExportModule.MiaoshouExportService({ repository: repository, viewModels: viewModels, images: images });
  const currency = new currencyModule.CurrencyService({
    readConfig: configModule.readServerConfig,
    writeConfig: configModule.writeServerConfig
  });
  const collection = new collectionModule.CollectionService({
    repository: repository,
    viewModels: viewModels,
    events: events,
    workflow: workflow,
    images: images,
    currency: currency
  });
  const productController = new productControllerModule.ProductController({ products: products, collection: collection, miaoshouExport: miaoshouExport });
  const imageController = new imageControllerModule.ImageController({ images: images, imageSearch: imageSearch, workflow: workflow });
  const configController = new configControllerModule.ConfigController();
  const currencyController = new currencyControllerModule.CurrencyController({ currency: currency });
  const providerController = new providerControllerModule.ProviderController({ providers: providers });
  const workflowController = new workflowControllerModule.WorkflowController({ workflow: workflow, binding: binding });
  const diagnosticsController = new diagnosticsControllerModule.DiagnosticsController({ diagnostics: diagnostics });
  const app = express();
  app.locals.diagnostics = diagnostics;

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
  app.use(express.json({ limit: "80mb" }));
  app.use(requestContextModule.logParsedRequestBody);
  app.use("/api/v1/cache/image", express.static(images.imageDirectory, { immutable: true, maxAge: "365d" }));
  const providerRouter = providerRouteModule.createProviderRouter({
    providerController: providerController,
    workflowController: workflowController,
    diagnosticsController: diagnosticsController
  });
  app.use("/api/v1", providerRouter);
  const businessRouteOptions = {
    productController: productController,
    configController: configController,
    imageController: imageController,
    currencyController: currencyController,
    events: events
  };
  app.use("/api/v1", routeModule.createApiRouter(businessRouteOptions));

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
