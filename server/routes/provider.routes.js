const express = require("express");
const adapterModule = require("../adapters/legacy-api.adapter");

/** Create v1 provider routes backed by the existing tested integrations. */
function createProviderRouter() {
  const router = express.Router();
  router.all("/listing/merge", adapterModule.createLegacyApiAdapter("/api/listing/merge"));
  router.all("/listing/undo", adapterModule.createLegacyApiAdapter("/api/listing/undo"));
  router.all("/images/edits", adapterModule.createLegacyApiAdapter("/api/image/edits"));
  router.all("/images/fusion", adapterModule.createLegacyApiAdapter("/api/image/fusion"));
  router.all("/images/fusion/undo", adapterModule.createLegacyApiAdapter("/api/image/fusion/undo"));
  router.all("/images/details", adapterModule.createLegacyApiAdapter("/api/detail-images"));
  router.all("/workflow", adapterModule.createLegacyApiAdapter("/api/workflow"));
  router.all("/workflow/events", adapterModule.createLegacyApiAdapter("/api/workflow/events"));
  router.all("/workflow/active", adapterModule.createLegacyApiAdapter("/api/workflow/active"));
  router.all("/workflow/prompts", adapterModule.createLegacyApiAdapter("/api/workflow/prompts"));
  router.all("/workflow/generate", adapterModule.createLegacyApiAdapter("/api/workflow/generate"));
  router.all("/workflow/search", adapterModule.createLegacyApiAdapter("/api/workflow/search"));
  router.all("/workflow/complete", adapterModule.createLegacyApiAdapter("/api/workflow/complete"));
  return router;
}

module.exports = { createProviderRouter: createProviderRouter };
