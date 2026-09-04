const z = require("zod");

const productIdentitySchema = z.object({
  platform: z.enum(["temu", "1688"]),
  platform_id: z.union([z.string(), z.number()]).transform(String)
});

const moduleSaveSchema = productIdentitySchema.extend({
  version: z.number().int().positive(),
  module: z.enum(["basic", "listing", "images", "skus", "binding"]),
  data: z.record(z.string(), z.unknown())
});

const collectionSchema = z.object({
  platform: z.enum(["temu", "1688"]),
  source_data: z.record(z.string(), z.unknown()),
  target_temu_platform_id: z.union([z.string(), z.number()]).optional(),
  target_temu_main_id: z.union([z.string(), z.number()]).optional()
});

const undoSchema = z.object({ token: z.string().min(1) });

const configUpdateSchema = z.object({
  image_apikey: z.string().optional(),
  kimi_apikey: z.string().optional()
});

const defaultPromptPageSchema = z.object({
  purpose: z.string().trim().max(500).optional(),
  prompt: z.string().trim().min(1).max(10000)
});

const defaultPromptTemplateSchema = z.object({
  id: z.string().trim().min(1).max(100),
  name: z.string().trim().min(1).max(100),
  pages: z.array(defaultPromptPageSchema).min(1).max(10)
});

const defaultPromptUpdateSchema = z.union([
  z.object({
    system_prompt: z.string().max(10000).optional(),
    default_template_id: z.string().trim().min(1).max(100),
    templates: z.array(defaultPromptTemplateSchema).min(1).max(50)
  }),
  z.object({ pages: z.array(defaultPromptPageSchema).min(1).max(10) })
]);

const jsonImportSchema = z.object({ json_text: z.string().min(2) });

const miaoshouImportSchema = z.object({
  cookie: z.string().trim().max(50000).optional(),
  auto_fetch: z.boolean().optional()
});

const miaoshouCookieSchema = z.object({
  cookie: z.string().trim().min(1).max(50000)
});

const imageCacheSchema = z.object({
  source: z.string().min(1),
  platform: z.enum(["temu", "1688", "transfer"]),
  kind: z.enum(["main", "detail", "sku", "generated"]),
  generated: z.boolean().optional()
});

const imageSearchSchema = z.union([
  z.object({ image_url: z.string().min(1), temu_main_id: z.union([z.string(), z.number()]).optional(), source_mode: z.enum(["clip", "legacy"]).optional() }),
  z.object({ source: z.string().min(1), temu_main_id: z.union([z.string(), z.number()]).optional(), source_mode: z.enum(["clip", "legacy"]).optional() })
]);

const replaceSkuSchema = z.object({
  target_temu_platform_id: z.union([z.string(), z.number()]).optional(),
  target_temu_main_id: z.union([z.string(), z.number()]).optional(),
  target_temu_version: z.number().int().positive(),
  target_sku_index: z.number().int().nonnegative().optional(),
  target_sku_id: z.union([z.string(), z.number()]).optional(),
  source_1688_platform_id: z.union([z.string(), z.number()]).optional(),
  source_1688_main_id: z.union([z.string(), z.number()]).optional(),
  source_sku_index: z.number().int().nonnegative().optional(),
  source_sku_id: z.union([z.string(), z.number()]).optional(),
  source_data: z.record(z.string(), z.unknown()).optional(),
  replace_all_skus: z.boolean().optional()
});

const copyFirstSkuAttributeSchema = z.object({
  version: z.number().int().positive(),
  attribute: z.enum(["price", "stock", "dimensions"])
});

const dollarTransferSchema = z.object({
  amount: z.union([z.string(), z.number()]),
  from: z.string().optional(),
  to: z.string().optional(),
  from_currency: z.string().optional(),
  to_currency: z.string().optional()
});

const listingMergeSchema = z.object({
  temu_listing: z.record(z.string(), z.unknown()),
  ali_listing: z.record(z.string(), z.unknown())
});

const operationUndoSchema = z.object({ undo_token: z.string().min(1) });

const workbenchFocusSchema = z.object({
  temu_main_id: z.union([z.string(), z.number()]).transform(String),
  temu_platform_id: z.union([z.string(), z.number()]).transform(String).optional(),
  mode: z.literal("realtime").optional()
});

const imageEditSchema = z.object({
  image_urls: z.array(z.string().min(1)).min(1).max(2),
  prompt: z.string().optional(),
  size: z.string().optional(),
  carousel_task_id: z.string().min(1).optional(),
  carousel_page_index: z.number().int().min(0).max(9).optional()
});

const directImageTaskSchema = z.object({
  client_task_id: z.string().regex(/^direct-[a-zA-Z0-9-]+$/),
  temu_main_id: z.union([z.string(), z.number()]).transform(String),
  temu_platform_id: z.union([z.string(), z.number()]).transform(String).optional(),
  mode: z.literal("edit"),
  image_urls: z.array(z.string().min(1)).length(1),
  source_type: z.enum(["gallery", "detail"]),
  source_indices: z.array(z.number().int().nonnegative()).max(1).optional(),
  detail_index: z.number().int().min(-1).optional(),
  reference_mode: z.enum(["original", "current"]).optional(),
  parent_task_id: z.string().regex(/^direct-[a-zA-Z0-9-]+$/).optional(),
  prompt: z.string().min(1),
  size: z.string().optional()
});

const directImageVersionSelectSchema = z.object({
  version_index: z.number().int().min(0).max(1)
});

const skuBlendTaskSchema = z.object({
  client_task_id: z.string().regex(/^sku-blend-[a-zA-Z0-9-]+$/),
  temu_main_id: z.union([z.string(), z.number()]).transform(String),
  temu_platform_id: z.union([z.string(), z.number()]).transform(String).optional(),
  sku_id: z.union([z.string(), z.number()]).transform(String).optional(),
  sku_index: z.number().int().nonnegative(),
  image_urls: z.array(z.string().min(1)).length(2),
  prompt: z.string().min(1),
  size: z.string().optional()
});

const packingWorkflowPromptSchema = z.object({
  temu_main_id: z.union([z.string(), z.number()]),
  image_url: z.string().min(1),
  custom_prompt: z.string().trim().min(1).max(10000),
  product: z.record(z.string(), z.unknown())
});

const clipWorkflowAssembleSchema = z.object({
  temu_main_id: z.union([z.string(), z.number()]),
  image_url: z.string().min(1),
  custom_prompt: z.string().trim().max(10000).optional(),
  product: z.record(z.string(), z.unknown()).optional(),
  min_price: z.union([z.string(), z.number()]).optional(),
  max_price: z.union([z.string(), z.number()]).optional()
});

const clipWorkflowSearchSchema = z.object({
  temu_main_id: z.union([z.string(), z.number()]),
  image_url: z.string().optional(),
  keyword: z.string().trim().min(1).max(500),
  min_price: z.union([z.string(), z.number()]).optional(),
  max_price: z.union([z.string(), z.number()]).optional()
});

const clipWorkflowTop10Schema = z.object({
  keyword: z.string().trim().min(1).max(500),
  min_price: z.union([z.string(), z.number()]).optional(),
  max_price: z.union([z.string(), z.number()]).optional()
});

const carouselWorkflowPromptSchema = z.object({
  mode: z.literal("carousel"),
  temu_main_id: z.union([z.string(), z.number()]),
  temu_platform_id: z.union([z.string(), z.number()]),
  image_urls: z.array(z.string().min(1)).length(2),
  source_indices: z.array(z.number().int().nonnegative()).length(2),
  gallery_snapshot: z.array(z.string()),
  count: z.number().int().min(1).max(10),
  market_language: z.string().min(1).max(100),
  prompt: z.string().max(5000).optional(),
  advanced: z.boolean().optional(),
  reasoning_enabled: z.boolean().optional(),
  size: z.string().optional()
});

const carouselManualPromptSchema = carouselWorkflowPromptSchema.omit({
  count: true,
  prompt: true,
  advanced: true,
  reasoning_enabled: true
}).extend({
  pages: z.array(defaultPromptPageSchema).min(1).max(10)
});

const workflowPromptSchema = z.union([packingWorkflowPromptSchema, carouselWorkflowPromptSchema]);

const carouselPlanUpdateSchema = z.object({
  pages: z.array(z.object({ purpose: z.string().max(500).optional(), prompt: z.string().min(1).max(10000) })).min(1).max(10)
});

const carouselPageUpdateSchema = z.object({
  purpose: z.string().max(500).optional(),
  prompt: z.string().trim().min(1).max(10000)
});

const carouselGenerationSchema = z.object({
  page_indices: z.array(z.number().int().min(0).max(9)).min(1).max(10),
  reference_mode: z.enum(["original", "current"]).optional()
});

const carouselVersionSelectSchema = z.object({
  version_index: z.number().int().min(0).max(1)
});

const carouselApplySchema = z.object({
  selected_indices: z.array(z.number().int().min(0).max(9)).min(1).max(10),
  replace_all: z.boolean().optional()
});

const workflowGenerateSchema = z.object({
  temu_main_id: z.union([z.string(), z.number()]),
  prompts: z.array(z.string()).length(4),
  index: z.number().int().min(0).max(3).optional()
});

const workflowCompleteSchema = z.object({
  temu_main_id: z.union([z.string(), z.number()]).optional(),
  temu_platform_id: z.union([z.string(), z.number()]).optional(),
  source_mode: z.enum(["clip", "legacy"]).optional(),
  ali_main_id: z.union([z.string(), z.number()]),
  ali_platform_id: z.union([z.string(), z.number()]).optional()
});

const detailImagesQuerySchema = z.object({ url: z.string().min(1) });

const candidateImageQuerySchema = z.object({ source: z.string().url().max(16000).regex(/^https?:\/\//i) });

module.exports = {
  moduleSaveSchema: moduleSaveSchema,
  collectionSchema: collectionSchema,
  undoSchema: undoSchema,
  configUpdateSchema: configUpdateSchema,
  defaultPromptUpdateSchema: defaultPromptUpdateSchema,
  jsonImportSchema: jsonImportSchema,
  miaoshouImportSchema: miaoshouImportSchema,
  miaoshouCookieSchema: miaoshouCookieSchema,
  imageCacheSchema: imageCacheSchema,
  candidateImageQuerySchema: candidateImageQuerySchema,
  imageSearchSchema: imageSearchSchema,
  dollarTransferSchema: dollarTransferSchema,
  replaceSkuSchema: replaceSkuSchema,
  copyFirstSkuAttributeSchema: copyFirstSkuAttributeSchema,
  listingMergeSchema: listingMergeSchema,
  operationUndoSchema: operationUndoSchema,
  workbenchFocusSchema: workbenchFocusSchema,
  imageEditSchema: imageEditSchema,
  directImageTaskSchema: directImageTaskSchema,
  directImageVersionSelectSchema: directImageVersionSelectSchema,
  skuBlendTaskSchema: skuBlendTaskSchema,
  workflowPromptSchema: workflowPromptSchema,
  clipWorkflowAssembleSchema: clipWorkflowAssembleSchema,
  clipWorkflowSearchSchema: clipWorkflowSearchSchema,
  clipWorkflowTop10Schema: clipWorkflowTop10Schema,
  carouselWorkflowPromptSchema: carouselWorkflowPromptSchema,
  carouselManualPromptSchema: carouselManualPromptSchema,
  carouselPlanUpdateSchema: carouselPlanUpdateSchema,
  carouselPageUpdateSchema: carouselPageUpdateSchema,
  carouselGenerationSchema: carouselGenerationSchema,
  carouselVersionSelectSchema: carouselVersionSelectSchema,
  carouselApplySchema: carouselApplySchema,
  workflowGenerateSchema: workflowGenerateSchema,
  workflowCompleteSchema: workflowCompleteSchema,
  detailImagesQuerySchema: detailImagesQuerySchema
};
