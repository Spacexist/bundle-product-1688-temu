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

const jsonImportSchema = z.object({ json_text: z.string().min(2) });

const imageCacheSchema = z.object({
  source: z.string().min(1),
  platform: z.enum(["temu", "1688", "transfer"]),
  kind: z.enum(["main", "detail", "sku", "generated"]),
  generated: z.boolean().optional()
});

const imageSearchSchema = z.union([
  z.object({ image_url: z.string().min(1) }),
  z.object({ source: z.string().min(1) })
]);

const replaceSkuSchema = z.object({
  target_temu_platform_id: z.union([z.string(), z.number()]).optional(),
  target_temu_main_id: z.union([z.string(), z.number()]).optional(),
  target_sku_index: z.number().int().nonnegative().optional(),
  target_sku_id: z.union([z.string(), z.number()]).optional(),
  source_1688_platform_id: z.union([z.string(), z.number()]).optional(),
  source_1688_main_id: z.union([z.string(), z.number()]).optional(),
  source_sku_index: z.number().int().nonnegative().optional(),
  source_sku_id: z.union([z.string(), z.number()]).optional(),
  source_data: z.record(z.string(), z.unknown()).optional(),
  replace_all_skus: z.boolean().optional()
});

const dollarTransferSchema = z.object({
  amount: z.union([z.string(), z.number()]),
  from: z.string().optional(),
  to: z.string().optional(),
  from_currency: z.string().optional(),
  to_currency: z.string().optional()
});

module.exports = {
  moduleSaveSchema: moduleSaveSchema,
  collectionSchema: collectionSchema,
  undoSchema: undoSchema,
  configUpdateSchema: configUpdateSchema,
  jsonImportSchema: jsonImportSchema,
  imageCacheSchema: imageCacheSchema,
  imageSearchSchema: imageSearchSchema,
  dollarTransferSchema: dollarTransferSchema,
  replaceSkuSchema: replaceSkuSchema
};
