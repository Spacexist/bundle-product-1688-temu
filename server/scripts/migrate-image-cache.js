const configModule = require("../config/config-loader");
const cacheModule = require("../repositories/cache.repository");
const imageModule = require("../services/image-cache.service");

/** Move every currently known product image into the filesystem cache. */
async function migrateImageCache() {
  const config = configModule.readServerConfig();
  const repository = new cacheModule.CacheRepository(config.storage);
  const images = new imageModule.ImageCacheService(config.storage);
  const payload = repository.read();
  for (let recordIndex = 0; recordIndex < payload.records.length; recordIndex += 1) {
    await images.cacheRecordImages(payload.records[recordIndex]);
    console.log("已缓存图片：" + (recordIndex + 1) + "/" + payload.records.length);
  }
  repository.write(payload);
  console.log("图片缓存迁移完成。");
}

migrateImageCache().catch(function handleMigrationError(error) {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
