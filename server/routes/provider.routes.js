const express = require("express");
const schemaModule = require("../schemas/api.schemas");
const validationModule = require("../middleware/validate");

/** Create explicit v1 integration, workflow, and diagnostics routes. */
function createProviderRouter(options) {
  const settings = options || {};
  const router = express.Router();
  const providers = settings.providerController;
  const workflow = settings.workflowController;
  const diagnostics = settings.diagnosticsController;

  router.post("/listing/merge", validationModule.validate(schemaModule.listingMergeSchema, "body"), providers.mergeListing.bind(providers));
  router.post("/listing/undo", validationModule.validate(schemaModule.operationUndoSchema, "body"), providers.undoListing.bind(providers));
  router.post("/images/edits", validationModule.validate(schemaModule.imageEditSchema, "body"), providers.editImage.bind(providers));
  router.post("/images/fusion", validationModule.validate(schemaModule.imageEditSchema, "body"), providers.fuseImages.bind(providers));
  router.post("/images/fusion/undo", validationModule.validate(schemaModule.operationUndoSchema, "body"), providers.undoFusion.bind(providers));
  router.post("/images/direct-tasks", validationModule.validate(schemaModule.directImageTaskSchema, "body"), providers.createDirectImageTask.bind(providers));
  router.get("/images/direct-tasks", providers.getDirectImageTasks.bind(providers));
  router.get("/images/direct-tasks/product/:temuMainId", providers.getDirectImageTaskForProduct.bind(providers));
  router.get("/images/direct-tasks/:taskId", providers.getDirectImageTask.bind(providers));
  router.delete("/images/direct-tasks/:taskId", providers.deleteDirectImageTask.bind(providers));
  router.post("/images/sku-blend-tasks", validationModule.validate(schemaModule.skuBlendTaskSchema, "body"), providers.createSkuBlendTask.bind(providers));
  router.get("/images/sku-blend-tasks", providers.getSkuBlendTasks.bind(providers));
  router.delete("/images/sku-blend-tasks/:taskId", providers.deleteSkuBlendTask.bind(providers));
  router.get("/images/details", validationModule.validate(schemaModule.detailImagesQuerySchema, "query"), providers.getDetailImages.bind(providers));

  router.get("/workflow", workflow.getWorkflow.bind(workflow));
  router.get("/workflow/active", workflow.getActive.bind(workflow));
  router.post("/workflow/clip/assemble", validationModule.validate(schemaModule.clipWorkflowAssembleSchema, "body"), workflow.assembleClip.bind(workflow));
  router.post("/workflow/clip/search", validationModule.validate(schemaModule.clipWorkflowSearchSchema, "body"), workflow.searchClip.bind(workflow));
  router.post("/workflow/clip/top10", validationModule.validate(schemaModule.clipWorkflowTop10Schema, "body"), workflow.searchClipTop10.bind(workflow));
  router.post("/workflow/prompts", validationModule.validate(schemaModule.workflowPromptSchema, "body"), workflow.generatePrompts.bind(workflow));
  router.get("/workflow/carousel", workflow.getCarouselTasks.bind(workflow));
  router.post("/workflow/carousel/plan", validationModule.validate(schemaModule.carouselWorkflowPromptSchema, "body"), workflow.startCarouselPlan.bind(workflow));
  router.post("/workflow/carousel/manual", validationModule.validate(schemaModule.carouselManualPromptSchema, "body"), workflow.startManualCarouselPlan.bind(workflow));
  router.get("/workflow/carousel/product/:temuMainId", workflow.getCarouselTask.bind(workflow));
  router.patch("/workflow/carousel/:taskId", validationModule.validate(schemaModule.carouselPlanUpdateSchema, "body"), workflow.updateCarouselTask.bind(workflow));
  router.patch("/workflow/carousel/:taskId/pages/:pageIndex", validationModule.validate(schemaModule.carouselPageUpdateSchema, "body"), workflow.updateCarouselPage.bind(workflow));
  router.post("/workflow/carousel/:taskId/generate", validationModule.validate(schemaModule.carouselGenerationSchema, "body"), workflow.generateCarouselTask.bind(workflow));
  router.post("/workflow/carousel/:taskId/apply", validationModule.validate(schemaModule.carouselApplySchema, "body"), workflow.applyCarouselTask.bind(workflow));
  router.delete("/workflow/carousel/:taskId", workflow.deleteCarouselTask.bind(workflow));
  router.post("/workflow/generate", validationModule.validate(schemaModule.workflowGenerateSchema, "body"), workflow.generateImages.bind(workflow));
  router.post("/workflow/complete", validationModule.validate(schemaModule.workflowCompleteSchema, "body"), workflow.complete.bind(workflow));

  router.get("/logs", diagnostics.getLogs.bind(diagnostics));
  router.get("/logs/events", diagnostics.connectLogs.bind(diagnostics));
  router.get("/clip/status", diagnostics.getClipStatus.bind(diagnostics));
  router.post("/clip/warmup", diagnostics.warmClip.bind(diagnostics));
  router.get("/queue", diagnostics.getQueue.bind(diagnostics));
  router.get("/image-tasks", diagnostics.getImageTasks.bind(diagnostics));
  router.get("/image-failures", diagnostics.getImageFailures.bind(diagnostics));
  router.get("/image-failures/:executionId", diagnostics.getImageFailureDetail.bind(diagnostics));
  router.get("/queue/events", diagnostics.connectQueue.bind(diagnostics));
  return router;
}

module.exports = { createProviderRouter: createProviderRouter };
