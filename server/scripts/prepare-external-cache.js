const fs = require("fs");
const path = require("path");

const DEFAULT_CONFIG_PATH = path.resolve(__dirname, "..", "config.json");
const DEFAULT_LEGACY_CACHE_DIRECTORY = path.resolve(__dirname, "..", "..", "cache");
const DEFAULT_REQUIRED_DRIVE = "D:\\";

/** Return whether one resolved path stays inside the configured cache root. */
function isPathInside(parentPath, childPath) {
  const relativePath = path.relative(parentPath, childPath);
  return relativePath === "" || (relativePath.indexOf("..") !== 0 && !path.isAbsolute(relativePath));
}

/** Read the storage object from one server config file. */
function readStorageConfig(configPath) {
  if (!fs.existsSync(configPath)) {
    throw new Error("找不到 server/config.json：" + configPath);
  }
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const storage = config.storage && typeof config.storage === "object" ? config.storage : null;
  if (!storage) {
    throw new Error("server/config.json 缺少 storage 配置。");
  }
  return storage;
}

/** Resolve and validate every external cache path before creating directories. */
function resolveStoragePaths(storage, configPath, requiredDrive) {
  const source = storage && typeof storage === "object" ? storage : {};
  const configDirectory = path.dirname(configPath);
  const configuredCacheDirectory = String(source.cacheDirectory || "").trim();
  const configuredImageDirectory = String(source.imageDirectory || "").trim();
  const configuredHistoryDirectory = String(source.historyDirectory || "").trim();
  if (!configuredCacheDirectory || !configuredImageDirectory || !configuredHistoryDirectory) {
    throw new Error("storage 必须完整配置 cacheDirectory、imageDirectory 和 historyDirectory。");
  }
  if (!path.isAbsolute(configuredCacheDirectory)
    || !path.isAbsolute(configuredImageDirectory)
    || !path.isAbsolute(configuredHistoryDirectory)) {
    throw new Error("storage 缓存路径必须使用绝对路径。");
  }
  const cacheDirectory = path.resolve(configDirectory, configuredCacheDirectory);
  const imageDirectory = path.resolve(configDirectory, configuredImageDirectory);
  const historyDirectory = path.resolve(configDirectory, configuredHistoryDirectory);
  const expectedDrive = String(requiredDrive || "").toUpperCase();
  if (expectedDrive && path.parse(cacheDirectory).root.toUpperCase() !== expectedDrive) {
    throw new Error("cacheDirectory 必须位于 " + expectedDrive + "，当前为：" + cacheDirectory);
  }
  if (!isPathInside(cacheDirectory, imageDirectory) || !isPathInside(cacheDirectory, historyDirectory)) {
    throw new Error("imageDirectory 和 historyDirectory 必须位于 cacheDirectory 内部。");
  }
  return {
    cacheDirectory: cacheDirectory,
    imageDirectory: imageDirectory,
    historyDirectory: historyDirectory
  };
}

/** Merge a legacy project cache into the external directory without overwriting destination files. */
function copyLegacyCache(legacyCacheDirectory, cacheDirectory) {
  const sourceDirectory = path.resolve(legacyCacheDirectory);
  if (!fs.existsSync(sourceDirectory) || sourceDirectory === cacheDirectory) {
    return false;
  }
  fs.cpSync(sourceDirectory, cacheDirectory, {
    recursive: true,
    force: false,
    errorOnExist: false
  });
  return true;
}

/** Prepare the configured D-drive cache and perform one non-destructive legacy migration. */
function prepareExternalCache(options) {
  const settings = options || {};
  const configPath = path.resolve(settings.configPath || DEFAULT_CONFIG_PATH);
  const storage = settings.storage || readStorageConfig(configPath);
  const requiredDrive = Object.prototype.hasOwnProperty.call(settings, "requiredDrive")
    ? settings.requiredDrive
    : DEFAULT_REQUIRED_DRIVE;
  const paths = resolveStoragePaths(storage, configPath, requiredDrive);
  fs.mkdirSync(paths.cacheDirectory, { recursive: true });
  fs.mkdirSync(paths.imageDirectory, { recursive: true });
  fs.mkdirSync(paths.historyDirectory, { recursive: true });
  const markerPath = path.join(path.dirname(paths.cacheDirectory), ".auto-bundle-cache-migrated-v1.json");
  let migrated = false;
  if (!fs.existsSync(markerPath)) {
    const legacyCacheDirectory = settings.legacyCacheDirectory || DEFAULT_LEGACY_CACHE_DIRECTORY;
    migrated = copyLegacyCache(legacyCacheDirectory, paths.cacheDirectory);
    fs.writeFileSync(markerPath, JSON.stringify({
      version: 1,
      migrated_at: new Date().toISOString(),
      source: path.resolve(legacyCacheDirectory),
      destination: paths.cacheDirectory,
      copied_legacy_cache: migrated
    }, null, 2), "utf8");
  }
  return {
    paths: paths,
    migrated: migrated,
    markerPath: markerPath
  };
}

/** Run external cache preparation for 启动.bat and print a concise result. */
function main() {
  try {
    const result = prepareExternalCache();
    process.stdout.write("[CACHE] Ready: " + result.paths.cacheDirectory + "\n");
    if (result.migrated) {
      process.stdout.write("[CACHE] Existing project cache copied without deleting the source.\n");
    }
  } catch (error) {
    process.stderr.write("[CACHE ERROR] " + String(error && error.message || error) + "\n");
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  copyLegacyCache: copyLegacyCache,
  prepareExternalCache: prepareExternalCache,
  resolveStoragePaths: resolveStoragePaths
};
