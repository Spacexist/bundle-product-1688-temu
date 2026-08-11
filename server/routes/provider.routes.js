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
  router.get("/images/details", validationModule.validate(schemaModule.detailImagesQuerySchema, "query"), providers.getDetailImages.bind(providers));

  router.get("/workflow", workflow.getWorkflow.bind(workflow));
  router.get("/workflow/events", workflow.connectEvents.bind(workflow));
  router.get("/workflow/active", workflow.getActive.bind(workflow));
  router.post("/workflow/prompts", validationModule.validate(schemaModule.workflowPromptSchema, "body"), workflow.generatePrompts.bind(workflow));
  router.post("/workflow/generate", validationModule.validate(schemaModule.workflowGenerateSchema, "body"), workflow.generateImages.bind(workflow));
  router.post("/workflow/complete", validationModule.validate(schemaModule.workflowCompleteSchema, "body"), workflow.complete.bind(workflow));

  router.get("/logs", diagnostics.getLogs.bind(diagnostics));
  router.get("/logs/events", diagnostics.connectLogs.bind(diagnostics));
  router.get("/queue", diagnostics.getQueue.bind(diagnostics));
  router.get("/queue/events", diagnostics.connectQueue.bind(diagnostics));
  return router;
}

module.exports = { createProviderRouter: createProviderRouter };
