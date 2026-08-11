const fs = require("fs");
const path = require("path");

/** JSON repository that exclusively owns product cache and history persistence. */
class CacheRepository {
  /** Resolve cache and history paths from server configuration. */
  constructor(options) {
    const settings = options || {};
    this.cacheDirectory = path.resolve(__dirname, "..", settings.cacheDirectory || "../../cache");
    this.historyDirectory = path.resolve(__dirname, "..", settings.historyDirectory || "../../cache/history");
    this.cacheFilePath = path.join(this.cacheDirectory, "cache.json");
    this.historyLimit = Number(settings.historyLimit || 200);
    this.writeQueue = Promise.resolve();
    this.ensureDirectories();
  }

  /** Create the cache and history directories required by later writes. */
  ensureDirectories() {
    fs.mkdirSync(this.cacheDirectory, { recursive: true });
    fs.mkdirSync(this.historyDirectory, { recursive: true });
  }

  /** Return the canonical empty cache payload. */
  createEmptyPayload() {
    return { version: 1, updated_at: "", records: [] };
  }

  /** Read the cache without exposing filesystem details to services. */
  read() {
    if (!fs.existsSync(this.cacheFilePath)) {
      return this.createEmptyPayload();
    }
    try {
      const payload = JSON.parse(fs.readFileSync(this.cacheFilePath, "utf8"));
      if (!payload || typeof payload !== "object") {
        return this.createEmptyPayload();
      }
      if (!Array.isArray(payload.records)) {
        payload.records = [];
      }
      return payload;
    } catch (error) {
      return this.createEmptyPayload();
    }
  }

  /** Persist the complete cache payload through a temporary file replacement. */
  write(payload) {
    const target = payload && typeof payload === "object" ? payload : this.createEmptyPayload();
    target.version = Number(target.version || 0) + 1;
    target.updated_at = new Date().toISOString();
    const temporaryPath = this.cacheFilePath + "." + process.pid + "." + Date.now() + ".tmp";
    fs.writeFileSync(temporaryPath, JSON.stringify(target, null, 2), "utf8");
    try {
      fs.renameSync(temporaryPath, this.cacheFilePath);
    } catch (error) {
      if (error.code !== "EPERM" && error.code !== "EEXIST") {
        throw error;
      }
      fs.copyFileSync(temporaryPath, this.cacheFilePath);
      fs.unlinkSync(temporaryPath);
    }
    return target;
  }

  /** Serialize one complete cache mutation and persist only after the mutation succeeds. */
  mutate(mutator) {
    const repository = this;
    const queuedMutation = this.writeQueue.then(async function runQueuedCacheMutation() {
      const payload = repository.read();
      const result = await mutator(payload);
      const savedPayload = repository.write(payload);
      return { result: result, payload: savedPayload };
    });
    this.writeQueue = queuedMutation.then(function releaseSuccessfulCacheMutation() {
      return null;
    }, function releaseFailedCacheMutation() {
      return null;
    });
    return queuedMutation;
  }

  /** Delete every cache data entry while retaining the repository placeholder file. */
  clearDirectory() {
    const repository = this;
    const queuedClear = this.writeQueue.then(function runQueuedCacheDirectoryClear() {
      const names = fs.existsSync(repository.cacheDirectory)
        ? fs.readdirSync(repository.cacheDirectory)
        : [];
      for (let nameIndex = 0; nameIndex < names.length; nameIndex += 1) {
        if (names[nameIndex] === ".gitkeep") {
          continue;
        }
        fs.rmSync(path.join(repository.cacheDirectory, names[nameIndex]), { recursive: true, force: true });
      }
      repository.ensureDirectories();
      return repository.createEmptyPayload();
    });
    this.writeQueue = queuedClear.then(function releaseSuccessfulCacheDirectoryClear() {
      return null;
    }, function releaseFailedCacheDirectoryClear() {
      return null;
    });
    return queuedClear;
  }

  /** Save a pre-mutation product snapshot and return its undo token. */
  createHistorySnapshot(record, moduleName) {
    const token = Date.now() + "-" + Math.random().toString(36).slice(2, 10);
    const snapshot = {
      token: token,
      module: String(moduleName || "product"),
      created_at: new Date().toISOString(),
      record: record
    };
    fs.writeFileSync(path.join(this.historyDirectory, token + ".json"), JSON.stringify(snapshot, null, 2), "utf8");
    this.trimHistory();
    return token;
  }

  /** Read and consume one durable undo snapshot. */
  consumeHistorySnapshot(token) {
    const safeToken = String(token || "").replace(/[^a-zA-Z0-9-]/g, "");
    const filePath = path.join(this.historyDirectory, safeToken + ".json");
    if (!safeToken || !fs.existsSync(filePath)) {
      return null;
    }
    const snapshot = JSON.parse(fs.readFileSync(filePath, "utf8"));
    fs.unlinkSync(filePath);
    return snapshot;
  }

  /** Retain only the newest configured number of history snapshots. */
  trimHistory() {
    const names = fs.readdirSync(this.historyDirectory);
    const files = [];
    for (let nameIndex = 0; nameIndex < names.length; nameIndex += 1) {
      if (names[nameIndex].endsWith(".json")) {
        const filePath = path.join(this.historyDirectory, names[nameIndex]);
        files.push({ filePath: filePath, modified: fs.statSync(filePath).mtimeMs });
      }
    }
    for (let leftIndex = 0; leftIndex < files.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < files.length; rightIndex += 1) {
        if (files[rightIndex].modified > files[leftIndex].modified) {
          const temporary = files[leftIndex];
          files[leftIndex] = files[rightIndex];
          files[rightIndex] = temporary;
        }
      }
    }
    for (let index = this.historyLimit; index < files.length; index += 1) {
      fs.unlinkSync(files[index].filePath);
    }
  }
}

module.exports = { CacheRepository: CacheRepository };
