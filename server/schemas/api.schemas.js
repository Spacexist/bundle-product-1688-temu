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

module.exports = {
  moduleSaveSchema: moduleSaveSchema,
  collectionSchema: collectionSchema,
  undoSchema: undoSchema,
  configUpdateSchema: configUpdateSchema,
  jsonImportSchema: jsonImportSchema,
  imageCacheSchema: imageCacheSchema
};
