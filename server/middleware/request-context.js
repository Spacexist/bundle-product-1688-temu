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
    "/api/v1/workflow/events"
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
  const diagnostics = request.app && request.app.locals ? request.app.locals.diagnostics : null;
  const startedAt = Date.now();
  const originalJson = response.json.bind(response);
  /** Capture one response body while summarizing the large workbench snapshot. */
  response.json = function sendCapturedJson(payload) {
    request.responsePayload = createResponseDiagnosticsPayload(request, payload);
    return originalJson(payload);
  };
  if (diagnostics && typeof diagnostics.write === "function") {
    diagnostics.write("RECEIVE", request.method + " " + request.originalUrl, {
      query: request.query,
      body: request.body || null
    }, requestId);
  }
  /** Write the response completion into the same request block. */
  function logCompletedResponse() {
    if (!diagnostics || typeof diagnostics.write !== "function") {
      return;
    }
    diagnostics.write("SEND", request.method + " " + request.originalUrl + " -> " + response.statusCode, {
      status: response.statusCode,
      duration_ms: Date.now() - startedAt,
      body: request.responsePayload === undefined ? null : request.responsePayload
    }, requestId);
  }
  response.on("finish", logCompletedResponse);
  next();
}

/** Replace one oversized workbench response with the fields useful for diagnostics. */
function createResponseDiagnosticsPayload(request, payload) {
  const pathname = String(request && request.originalUrl || request && request.url || "").split("?")[0];
  if (pathname !== "/api/v1/workbench" || !payload || typeof payload !== "object") {
    return payload;
  }
  const data = payload.data && typeof payload.data === "object" ? payload.data : {};
  return {
    ok: payload.ok,
    data: {
      version: data.version,
      updated_at: data.updated_at,
      record_count: Array.isArray(data.records) ? data.records.length : 0,
      mapping_count: Array.isArray(data.mappings) ? data.mappings.length : 0,
      has_update_instruction: Boolean(data.update_instruction)
    },
    error: payload.error,
    meta: payload.meta
  };
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
  const diagnostics = request.app && request.app.locals ? request.app.locals.diagnostics : null;
  if (diagnostics && typeof diagnostics.write === "function"
    && request.requestId && bodyMethods.indexOf(method) >= 0 && request.body !== undefined) {
    diagnostics.write(
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
