import { adminPage } from "./admin-page.js";

const CURRENT_CONFIG = "config:current";
const PREVIOUS_CONFIG = "config:previous";
const TEST_CONFIG = "config:test";
const ACCOUNT_PREFIX = "account:";
const ACCESS_PREFIX = "access:";
const ADMIN_LOGIN_FAILURE_PREFIX = "admin-login-failure:";
const SESSION_TTL_SECONDS = 12 * 60 * 60;
const AUDIT_PAGE_SIZE = 120;
const ADMIN_LOGIN_MAX_FAILURES = 5;
const ADMIN_LOGIN_LOCK_MS = 60 * 1000;
const ADMIN_LOGIN_FAILURE_TTL_SECONDS = 15 * 60;

/** Return one JSON response that never caches sensitive payloads. */
function jsonResponse(value, status) {
  return new Response(JSON.stringify(value), {
    status: status || 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

/** Return one HTML response for the bundled admin page. */
function htmlResponse(value) {
  return new Response(value, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

/** Read and parse a bounded JSON request body. */
async function readJson(request) {
  const text = await request.text();
  if (text.length > 2 * 1024 * 1024) {
    throw new Error("请求内容过大。");
  }
  return text ? JSON.parse(text) : {};
}

/** Convert binary bytes to lowercase hexadecimal. */
function bytesToHex(bytes) {
  let output = "";
  for (let index = 0; index < bytes.length; index += 1) {
    output += bytes[index].toString(16).padStart(2, "0");
  }
  return output;
}

/** Return the SHA-256 digest for a string. */
async function sha256(value) {
  const bytes = new TextEncoder().encode(String(value || ""));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return bytesToHex(new Uint8Array(digest));
}

/** Return an HMAC digest using the Worker AUTH_PEPPER secret. */
async function hmacDigest(value, pepper) {
  if (!pepper) {
    throw new Error("Worker Secret AUTH_PEPPER 尚未配置。");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(String(pepper)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(String(value || "")));
  return bytesToHex(new Uint8Array(signature));
}

/** Compare equal-length strings without early-exit timing differences. */
function safeEqual(left, right) {
  const a = String(left || "");
  const b = String(right || "");
  if (a.length !== b.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return difference === 0;
}

/** Return the client IP from Cloudflare request headers. */
function clientIp(request) {
  return String(request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || "unknown").split(",")[0].trim().slice(0, 80);
}

/** Return the Beijing-local audit day for one timestamp. */
function auditDay(timestamp) {
  return new Date(timestamp + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** Write one best-effort audit log row into D1. */
async function writeAudit(environment, request, action, outcome, status, accountName, detail) {
  if (!environment.BUNDLE_1688_TEMU_AUDIT) {
    return;
  }
  const timestamp = Date.now();
  try {
    await environment.BUNDLE_1688_TEMU_AUDIT.prepare(`
      INSERT INTO audit_logs (requested_at, day, ip, account_name, route, action, status, outcome, detail, user_agent)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      timestamp,
      auditDay(timestamp),
      clientIp(request),
      String(accountName || "").slice(0, 80),
      new URL(request.url).pathname.slice(0, 300),
      String(action || "").slice(0, 80),
      Number(status || 0),
      String(outcome || "").slice(0, 80),
      String(detail || "").slice(0, 500),
      String(request.headers.get("User-Agent") || "").slice(0, 500)
    ).run();
  } catch (error) {
    console.error("审计写入失败", error);
  }
}

/** Read an account name from one JSON response clone for audit display. */
async function auditAccountNameFromResponse(response) {
  try {
    const payload = await response.clone().json();
    const data = payload && payload.data && typeof payload.data === "object" ? payload.data : {};
    const account = data.account && typeof data.account === "object" ? data.account : {};
    return String(account.name || data.accountName || "").slice(0, 80);
  } catch (error) {
    return "";
  }
}

/** Encode one token segment as URL-safe base64. */
function encodeTokenPart(value) {
  const bytes = new TextEncoder().encode(String(value || ""));
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Decode one URL-safe base64 token segment into UTF-8 text. */
function decodeTokenPart(value) {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new TextDecoder().decode(bytes);
}

/** Create one signed admin bearer token for the authenticated administrator. */
async function createAdminToken(environment, username) {
  const payload = encodeTokenPart(JSON.stringify({ name: String(username || "root"), exp: Date.now() + SESSION_TTL_SECONDS * 1000 }));
  const signature = await hmacDigest(payload, environment.AUTH_PEPPER);
  return payload + "." + signature;
}

/** Authenticate one admin bearer token and return its payload. */
async function authenticateAdmin(request, environment) {
  const header = String(request.headers.get("Authorization") || "");
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const parts = token.split(".");
  if (parts.length !== 2) {
    throw new Error("管理员未登录。");
  }
  const expected = await hmacDigest(parts[0], environment.AUTH_PEPPER);
  if (!safeEqual(expected, parts[1])) {
    throw new Error("管理员会话无效。");
  }
  const payload = JSON.parse(decodeTokenPart(parts[0]));
  if (Number(payload.exp || 0) < Date.now()) {
    throw new Error("管理员会话已过期。");
  }
  return payload;
}

/** Ensure the required KV namespace is bound before handling a route. */
function requireVault(environment) {
  if (!environment.BUNDLE_1688_TEMU_VAULT) {
    throw new Error("KV 绑定 BUNDLE_1688_TEMU_VAULT 尚未配置。");
  }
  return environment.BUNDLE_1688_TEMU_VAULT;
}

/** Return one privacy-preserving KV key for an administrator login source IP. */
async function adminLoginFailureKey(request, environment) {
  const digest = await hmacDigest("admin-login:" + clientIp(request), environment.AUTH_PEPPER);
  return ADMIN_LOGIN_FAILURE_PREFIX + digest;
}

/** Read one administrator login failure record from KV. */
async function readAdminLoginFailure(environment, key) {
  const record = await requireVault(environment).get(key, "json");
  return record && typeof record === "object"
    ? { failures: Math.max(0, Math.floor(Number(record.failures) || 0)), lockedUntil: Math.max(0, Number(record.lockedUntil) || 0) }
    : { failures: 0, lockedUntil: 0 };
}

/** Return the remaining whole seconds for one active administrator lock. */
function adminLoginRetryAfterSeconds(record, now) {
  return Math.max(0, Math.ceil((Number(record && record.lockedUntil) - Number(now || Date.now())) / 1000));
}

/** Persist one failed administrator login and lock the source after five failures. */
async function recordAdminLoginFailure(environment, key, previous, now) {
  const failures = Math.max(0, Math.floor(Number(previous && previous.failures) || 0)) + 1;
  const lockedUntil = failures >= ADMIN_LOGIN_MAX_FAILURES ? now + ADMIN_LOGIN_LOCK_MS : 0;
  const record = { failures: failures, lockedUntil: lockedUntil };
  await requireVault(environment).put(key, JSON.stringify(record), {
    expirationTtl: lockedUntil ? Math.ceil(ADMIN_LOGIN_LOCK_MS / 1000) + 5 : ADMIN_LOGIN_FAILURE_TTL_SECONDS
  });
  return record;
}

/** Clear administrator login failures after valid credentials are supplied. */
async function clearAdminLoginFailures(environment, key) {
  await requireVault(environment).delete(key);
}

/** Generate a one-time 16-character access code and its SHA-256 digest. */
async function generateAccessCredential() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const accessCode = bytesToHex(bytes);
  return { accessCode: accessCode, accessHash: await sha256(accessCode) };
}

/** Normalize an access hash submitted by the local backend. */
function normalizeAccessHash(value) {
  const accessHash = String(value || "").trim().toLocaleLowerCase();
  if (!/^[a-f0-9]{64}$/.test(accessHash)) {
    throw new Error("访问码无效。");
  }
  return accessHash;
}

/** Normalize the account config channel used for staged config testing. */
function normalizeConfigChannel(value) {
  return String(value || "current") === "test" ? "test" : "current";
}

/** Read all stored user accounts from KV. */
async function listAccounts(environment) {
  const vault = requireVault(environment);
  const listed = await vault.list({ prefix: ACCOUNT_PREFIX });
  const accounts = [];
  for (let index = 0; index < listed.keys.length; index += 1) {
    const account = await vault.get(listed.keys[index].name, "json");
    if (account) {
      accounts.push(publicAccount(account));
    }
  }
  /** Sort accounts by display name for stable admin rendering. */
  accounts.sort(function sortAccounts(left, right) {
    return String(left.name || "").localeCompare(String(right.name || ""));
  });
  return accounts;
}

/** Return one account object without exposing its access hash. */
function publicAccount(account) {
  return {
    id: String(account.id || ""),
    name: String(account.name || ""),
    note: String(account.note || ""),
    enabled: account.enabled !== false,
    macBound: Boolean(account.macHash),
    macMissingGrant: Boolean(account.macMissingGrant),
    configChannel: normalizeConfigChannel(account.configChannel),
    createdAt: String(account.createdAt || ""),
    updatedAt: String(account.updatedAt || ""),
    lastSyncAt: String(account.lastSyncAt || ""),
    lastDeviceName: String(account.lastDeviceName || "")
  };
}

/** Read one account by id or fail with a user-readable error. */
async function readAccount(environment, id) {
  const key = ACCOUNT_PREFIX + String(id || "");
  const account = await requireVault(environment).get(key, "json");
  if (!account) {
    throw new Error("账号不存在。");
  }
  return { ...account, storageKey: key };
}

/** Save one account object back to KV. */
async function writeAccount(environment, account) {
  await requireVault(environment).put(ACCOUNT_PREFIX + account.id, JSON.stringify(account));
  return account;
}

/** Return the current cloud config package. */
async function readCurrentConfig(environment) {
  return await requireVault(environment).get(CURRENT_CONFIG, "json") || { version: 0, updatedAt: "", config: {} };
}

/** Return the staged test config package without affecting normal users. */
async function readTestConfig(environment) {
  return await requireVault(environment).get(TEST_CONFIG, "json") || { version: 0, updatedAt: "", config: {} };
}

/** Validate and return one config JSON object from a request body field. */
function readConfigObject(value) {
  const config = typeof value === "string" ? JSON.parse(value) : value;
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("配置必须是 JSON 对象。");
  }
  return config;
}

/** Return the config package selected for one verified account. */
async function readConfigForAccount(environment, account) {
  const channel = normalizeConfigChannel(account.configChannel);
  if (channel === "test") {
    const testConfig = await readTestConfig(environment);
    if (Number(testConfig.version || 0) > 0) {
      return { channel: "test", package: testConfig };
    }
  }
  return { channel: "current", package: await readCurrentConfig(environment) };
}

/** Return the recent audit rows shown in the admin page. */
async function readRecentAudit(environment) {
  if (!environment.BUNDLE_1688_TEMU_AUDIT) {
    return [];
  }
  const result = await environment.BUNDLE_1688_TEMU_AUDIT.prepare(`
    SELECT requested_at, account_name, action, status, outcome, detail
    FROM audit_logs
    ORDER BY requested_at DESC
    LIMIT ?
  `).bind(AUDIT_PAGE_SIZE).all();
  return result.results || [];
}

/** Authenticate one access hash and return its account. */
async function authenticateAccessHash(environment, value) {
  const accessHash = normalizeAccessHash(value);
  const index = await requireVault(environment).get(ACCESS_PREFIX + accessHash, "json");
  if (!index || !index.accountId) {
    throw new Error("访问码无效。");
  }
  const account = await readAccount(environment, index.accountId);
  if (account.enabled === false || !safeEqual(account.accessHash, accessHash)) {
    throw new Error("访问码无效或账号已停用。");
  }
  return account;
}

/** Verify or initialize a strict MAC binding for one user account. */
async function verifyMacBinding(environment, account, body) {
  const macHash = String(body.macHash || "").trim().toLocaleLowerCase();
  const macMissing = Boolean(body.macMissing) || !macHash;
  if (macMissing) {
    if (!account.macMissingGrant) {
      throw new Error("无法读取本机 MAC，请联系管理员临时授权。");
    }
    account.macMissingGrant = false;
  } else if (!/^[a-f0-9]{64}$/.test(macHash)) {
    throw new Error("本机 MAC 摘要无效。");
  } else if (!account.macHash) {
    account.macHash = macHash;
    account.macBoundAt = new Date().toISOString();
  } else if (!safeEqual(account.macHash, macHash)) {
    throw new Error("此访问码已绑定另一台设备。");
  }
  account.lastSyncAt = new Date().toISOString();
  account.lastDeviceName = String(body.deviceName || "").slice(0, 80);
  account.updatedAt = account.lastSyncAt;
  await writeAccount(environment, account);
  return account;
}

/** Validate administrator credentials and enforce an IP-based failure lock. */
async function handleAdminLogin(request, environment) {
  const body = await readJson(request);
  const username = String(body.username || "").trim();
  const password = String(body.password || "");
  const expectedUsername = String(environment.ADMIN_USERNAME || "root");
  const failureKey = await adminLoginFailureKey(request, environment);
  const now = Date.now();
  let failure = await readAdminLoginFailure(environment, failureKey);
  const activeRetryAfter = adminLoginRetryAfterSeconds(failure, now);
  if (activeRetryAfter > 0) {
    return jsonResponse({
      ok: false,
      data: { retryAfterSeconds: activeRetryAfter, remainingAttempts: 0 },
      error: "连续失败次数过多，请稍后再试。"
    }, 429);
  }
  if (failure.lockedUntil > 0) {
    failure = { failures: 0, lockedUntil: 0 };
  }
  const usernameValid = safeEqual(username, expectedUsername);
  const passwordValid = Boolean(environment.ADMIN_PASSWORD) && safeEqual(password, environment.ADMIN_PASSWORD);
  if (!usernameValid || !passwordValid) {
    const updatedFailure = await recordAdminLoginFailure(environment, failureKey, failure, now);
    const retryAfterSeconds = adminLoginRetryAfterSeconds(updatedFailure, now);
    return jsonResponse({
      ok: false,
      data: {
        retryAfterSeconds: retryAfterSeconds,
        remainingAttempts: Math.max(0, ADMIN_LOGIN_MAX_FAILURES - updatedFailure.failures)
      },
      error: retryAfterSeconds > 0 ? "连续失败次数过多，已锁定一分钟。" : "管理员账号或密码错误。"
    }, retryAfterSeconds > 0 ? 429 : 401);
  }
  await clearAdminLoginFailures(environment, failureKey);
  return jsonResponse({ ok: true, data: { token: await createAdminToken(environment, expectedUsername) }, error: null });
}

/** Handle the admin dashboard state request. */
async function handleAdminState(request, environment) {
  await authenticateAdmin(request, environment);
  const config = await readCurrentConfig(environment);
  const testConfig = await readTestConfig(environment);
  const accounts = await listAccounts(environment);
  const audit = await readRecentAudit(environment);
  return jsonResponse({
    ok: true,
    data: {
      accounts: accounts,
      config: { version: config.version, updatedAt: config.updatedAt, config: config.config },
      testConfig: { version: testConfig.version, updatedAt: testConfig.updatedAt, config: testConfig.config },
      audit: audit
    },
    error: null
  });
}

/** Handle creation of a user account and return its one-time access code. */
async function handleCreateAccount(request, environment) {
  await authenticateAdmin(request, environment);
  const body = await readJson(request);
  const name = String(body.name || "").trim().slice(0, 80);
  if (!name) {
    throw new Error("请输入账号名。");
  }
  const credential = await generateAccessCredential();
  const now = new Date().toISOString();
  const account = {
    id: crypto.randomUUID(),
    name: name,
    note: String(body.note || "").trim().slice(0, 200),
    role: "user",
    enabled: true,
    accessHash: credential.accessHash,
    macHash: "",
    macMissingGrant: false,
    configChannel: "current",
    createdAt: now,
    updatedAt: now
  };
  await writeAccount(environment, account);
  await requireVault(environment).put(ACCESS_PREFIX + account.accessHash, JSON.stringify({ accountId: account.id }));
  return jsonResponse({ ok: true, data: { account: publicAccount(account), accessCode: credential.accessCode }, error: null });
}

/** Handle account field updates from the admin page. */
async function handleUpdateAccount(request, environment, id) {
  await authenticateAdmin(request, environment);
  const body = await readJson(request);
  const account = await readAccount(environment, id);
  if (Object.prototype.hasOwnProperty.call(body, "name")) {
    account.name = String(body.name || "").trim().slice(0, 80) || account.name;
  }
  if (Object.prototype.hasOwnProperty.call(body, "note")) {
    account.note = String(body.note || "").trim().slice(0, 200);
  }
  if (Object.prototype.hasOwnProperty.call(body, "enabled")) {
    account.enabled = Boolean(body.enabled);
  }
  if (Object.prototype.hasOwnProperty.call(body, "configChannel")) {
    account.configChannel = normalizeConfigChannel(body.configChannel);
  }
  account.updatedAt = new Date().toISOString();
  await writeAccount(environment, account);
  return jsonResponse({ ok: true, data: { account: publicAccount(account) }, error: null });
}

/** Handle deletion of one account and its access-code index. */
async function handleDeleteAccount(request, environment, id) {
  await authenticateAdmin(request, environment);
  const account = await readAccount(environment, id);
  await requireVault(environment).delete(ACCESS_PREFIX + account.accessHash);
  await requireVault(environment).delete(ACCOUNT_PREFIX + account.id);
  return jsonResponse({ ok: true, data: { deleted: true }, error: null });
}

/** Handle resetting one account access code. */
async function handleResetCode(request, environment, id) {
  await authenticateAdmin(request, environment);
  const account = await readAccount(environment, id);
  const credential = await generateAccessCredential();
  await requireVault(environment).delete(ACCESS_PREFIX + account.accessHash);
  account.accessHash = credential.accessHash;
  account.updatedAt = new Date().toISOString();
  await writeAccount(environment, account);
  await requireVault(environment).put(ACCESS_PREFIX + account.accessHash, JSON.stringify({ accountId: account.id }));
  return jsonResponse({ ok: true, data: { account: publicAccount(account), accessCode: credential.accessCode }, error: null });
}

/** Handle clearing one account's MAC binding without changing its access code. */
async function handleUnbindMac(request, environment, id) {
  await authenticateAdmin(request, environment);
  const account = await readAccount(environment, id);
  account.macHash = "";
  account.macBoundAt = "";
  account.updatedAt = new Date().toISOString();
  await writeAccount(environment, account);
  return jsonResponse({ ok: true, data: { account: publicAccount(account) }, error: null });
}

/** Handle one-time authorization for clients that cannot read a MAC address. */
async function handleGrantMacMissing(request, environment, id) {
  await authenticateAdmin(request, environment);
  const account = await readAccount(environment, id);
  account.macMissingGrant = true;
  account.updatedAt = new Date().toISOString();
  await writeAccount(environment, account);
  return jsonResponse({ ok: true, data: { account: publicAccount(account) }, error: null });
}

/** Handle publishing a new server/config.json package. */
async function handlePublishConfig(request, environment) {
  await authenticateAdmin(request, environment);
  const body = await readJson(request);
  const config = readConfigObject(body.config);
  const current = await readCurrentConfig(environment);
  const next = {
    version: Math.max(0, Math.floor(Number(current.version) || 0)) + 1,
    updatedAt: new Date().toISOString(),
    config: config
  };
  await requireVault(environment).put(PREVIOUS_CONFIG, JSON.stringify(current));
  await requireVault(environment).put(CURRENT_CONFIG, JSON.stringify(next));
  return jsonResponse({ ok: true, data: { version: next.version, updatedAt: next.updatedAt }, error: null });
}

/** Handle saving a staged config package for selected test accounts only. */
async function handleSaveTestConfig(request, environment) {
  await authenticateAdmin(request, environment);
  const body = await readJson(request);
  const config = readConfigObject(body.config);
  const currentTest = await readTestConfig(environment);
  const next = {
    version: Math.max(0, Math.floor(Number(currentTest.version) || 0)) + 1,
    updatedAt: new Date().toISOString(),
    config: config
  };
  await requireVault(environment).put(TEST_CONFIG, JSON.stringify(next));
  return jsonResponse({ ok: true, data: { version: next.version, updatedAt: next.updatedAt }, error: null });
}

/** Handle copying the current production config into the staged test slot. */
async function handleCopyCurrentToTest(request, environment) {
  await authenticateAdmin(request, environment);
  const current = await readCurrentConfig(environment);
  const currentTest = await readTestConfig(environment);
  const next = {
    version: Math.max(0, Math.floor(Number(currentTest.version) || 0)) + 1,
    updatedAt: new Date().toISOString(),
    config: current.config || {}
  };
  await requireVault(environment).put(TEST_CONFIG, JSON.stringify(next));
  return jsonResponse({ ok: true, data: { version: next.version, updatedAt: next.updatedAt }, error: null });
}

/** Handle promoting the staged test config to the current production package. */
async function handlePromoteTestConfig(request, environment) {
  await authenticateAdmin(request, environment);
  const testConfig = await readTestConfig(environment);
  if (Number(testConfig.version || 0) <= 0) {
    throw new Error("请先保存测试配置。");
  }
  const config = readConfigObject(testConfig.config);
  const current = await readCurrentConfig(environment);
  const next = {
    version: Math.max(0, Math.floor(Number(current.version) || 0)) + 1,
    updatedAt: new Date().toISOString(),
    config: config
  };
  await requireVault(environment).put(PREVIOUS_CONFIG, JSON.stringify(current));
  await requireVault(environment).put(CURRENT_CONFIG, JSON.stringify(next));
  return jsonResponse({ ok: true, data: { version: next.version, updatedAt: next.updatedAt }, error: null });
}

/** Handle rolling the current config back to the previous package. */
async function handleRollbackConfig(request, environment) {
  await authenticateAdmin(request, environment);
  const current = await readCurrentConfig(environment);
  const previous = await requireVault(environment).get(PREVIOUS_CONFIG, "json");
  if (!previous || !previous.config) {
    throw new Error("没有可回滚的上一版配置。");
  }
  const next = {
    version: Math.max(0, Math.floor(Number(current.version) || 0)) + 1,
    updatedAt: new Date().toISOString(),
    config: readConfigObject(previous.config)
  };
  await requireVault(environment).put(PREVIOUS_CONFIG, JSON.stringify(current));
  await requireVault(environment).put(CURRENT_CONFIG, JSON.stringify(next));
  return jsonResponse({ ok: true, data: { version: next.version, updatedAt: next.updatedAt }, error: null });
}

/** Handle local client authorization and optional config download. */
async function handleUserConfig(request, environment) {
  const body = await readJson(request);
  const account = await authenticateAccessHash(environment, body.accessHash);
  const verified = await verifyMacBinding(environment, account, body);
  const selectedConfig = await readConfigForAccount(environment, verified);
  const current = selectedConfig.package;
  const remoteVersion = Number(current.version || 0);
  const data = {
    account: publicAccount(verified),
    configChannel: selectedConfig.channel,
    configVersion: remoteVersion,
    updatedAt: String(current.updatedAt || ""),
    configChanged: true,
    config: current.config || {}
  };
  return jsonResponse({ ok: true, data: data, error: null });
}

/** Dispatch one routed request and produce a Response. */
async function routeRequest(request, environment) {
  const url = new URL(request.url);
  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }
  if ((pathname === "/" || pathname === "/admin") && request.method === "GET") {
    return htmlResponse(adminPage);
  }
  if (pathname === "/api/admin/login" && request.method === "POST") {
    return handleAdminLogin(request, environment);
  }
  if (pathname === "/api/admin/state" && request.method === "GET") {
    return handleAdminState(request, environment);
  }
  if (pathname === "/api/admin/accounts" && request.method === "POST") {
    return handleCreateAccount(request, environment);
  }
  const accountMatch = pathname.match(/^\/api\/admin\/accounts\/([^/]+)(?:\/([^/]+))?$/);
  if (accountMatch && request.method === "PATCH" && !accountMatch[2]) {
    return handleUpdateAccount(request, environment, decodeURIComponent(accountMatch[1]));
  }
  if (accountMatch && request.method === "DELETE" && !accountMatch[2]) {
    return handleDeleteAccount(request, environment, decodeURIComponent(accountMatch[1]));
  }
  if (accountMatch && request.method === "POST" && accountMatch[2] === "reset-code") {
    return handleResetCode(request, environment, decodeURIComponent(accountMatch[1]));
  }
  if (accountMatch && request.method === "POST" && accountMatch[2] === "unbind-mac") {
    return handleUnbindMac(request, environment, decodeURIComponent(accountMatch[1]));
  }
  if (accountMatch && request.method === "POST" && accountMatch[2] === "grant-mac-missing") {
    return handleGrantMacMissing(request, environment, decodeURIComponent(accountMatch[1]));
  }
  if (pathname === "/api/admin/config" && request.method === "POST") {
    return handlePublishConfig(request, environment);
  }
  if (pathname === "/api/admin/test-config" && request.method === "POST") {
    return handleSaveTestConfig(request, environment);
  }
  if (pathname === "/api/admin/test-config/copy-current" && request.method === "POST") {
    return handleCopyCurrentToTest(request, environment);
  }
  if (pathname === "/api/admin/test-config/promote" && request.method === "POST") {
    return handlePromoteTestConfig(request, environment);
  }
  if (pathname === "/api/admin/rollback" && request.method === "POST") {
    return handleRollbackConfig(request, environment);
  }
  if (pathname === "/api/user/config" && request.method === "POST") {
    return handleUserConfig(request, environment);
  }
  return jsonResponse({ ok: false, error: "接口不存在。" }, 404);
}

export default {
  /** Handle one Cloudflare Worker fetch event. */
  async fetch(request, environment) {
    let response = null;
    let action = new URL(request.url).pathname;
    let accountName = "";
    try {
      response = await routeRequest(request, environment);
      if (request.method !== "OPTIONS") {
        accountName = await auditAccountNameFromResponse(response);
        await writeAudit(environment, request, action, response.status < 400 ? "success" : "failed", response.status, accountName, "");
      }
      return response;
    } catch (error) {
      response = jsonResponse({ ok: false, error: error.message || "请求失败。" }, 400);
      await writeAudit(environment, request, action, "failed", response.status, accountName, error.message);
      return response;
    }
  }
};
