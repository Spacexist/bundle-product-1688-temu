const legacyApi = require("../legacy-api");

/** Attach a request identifier and write one grouped request lifecycle to server logs. */
function attachRequestContext(request, response, next) {
  const pathname = String(request.originalUrl || request.url || "").split("?")[0];
  const method = String(request.method || "GET").toUpperCase();
  if (pathname === "/api/v1/logs"
    || pathname === "/api/v1/logs/events"
    || pathname === "/api/v1/queue"
    || pathname === "/api/v1/queue/events") {
    next();
    return;
  }
  const longLivedEventPaths = [
    "/api/v1/events",
    "/api/v1/workflow/events",
    "/v1/api/events",
    "/v1/api/workflow/events"
  ];
  if (longLivedEventPaths.indexOf(pathname) >= 0) {
    next();
    return;
  }
  if ((method === "GET" || method === "HEAD") && pathname.indexOf("/api/v1/cache/image/") === 0) {
    next();
    return;
  }
  const requestId = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  request.requestId = requestId;
  response.setHeader("X-Request-Id", requestId);
  const startedAt = Date.now();
  const originalJson = response.json.bind(response);
  /** Capture the actual JSON response so the log page mirrors Network details. */
  response.json = function sendCapturedJson(payload) {
    request.responsePayload = payload;
    return originalJson(payload);
  };
  legacyApi.writeServerLog("RECEIVE", request.method + " " + request.originalUrl, {
    query: request.query,
    body: request.body || null
  }, requestId);
  /** Write the response completion into the same request block. */
  function logCompletedResponse() {
    if (request.isLegacyApiAdapter) {
      legacyApi.writeServerLog("DONE", response.apiRequestLabel || method + " " + pathname, {
        status: response.statusCode,
        duration_ms: Date.now() - startedAt
      }, requestId);
      return;
    }
    legacyApi.writeServerLog("SEND", request.method + " " + request.originalUrl + " -> " + response.statusCode, {
      status: response.statusCode,
      duration_ms: Date.now() - startedAt,
      body: request.responsePayload === undefined ? null : request.responsePayload
    }, requestId);
  }
  response.on("finish", logCompletedResponse);
  next();
}

/** Summarize a parsed request body without retaining any field values. */
function createRequestBodySummary(body) {
  if (Array.isArray(body)) {
    return { type: "array", item_count: body.length };
  }
  if (body && typeof body === "object") {
    return {
      type: "object",
      field_count: Object.keys(body).length,
      fields: Object.keys(body).slice(0, 50)
    };
  }
  return { type: typeof body, present: body !== undefined && body !== null };
}

/** Log parsed request-body metadata after Express completes JSON parsing. */
function logParsedRequestBody(request, response, next) {
  const method = String(request.method || "GET").toUpperCase();
  const bodyMethods = ["POST", "PUT", "PATCH", "DELETE"];
  if (request.requestId && bodyMethods.indexOf(method) >= 0 && request.body !== undefined) {
    legacyApi.writeServerLog(
      "RECEIVE BODY",
      method + " " + String(request.originalUrl || request.url || ""),
      createRequestBodySummary(request.body),
      request.requestId
    );
  }
  next();
}

module.exports = {
  attachRequestContext: attachRequestContext,
  logParsedRequestBody: logParsedRequestBody
};
