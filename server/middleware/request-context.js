/** Attach a request identifier and write one grouped request lifecycle to server logs. */
function attachRequestContext(request, response, next) {
  const pathname = String(request.originalUrl || request.url || "").split("?")[0];
  const method = String(request.method || "GET").toUpperCase();
  if (pathname === "/api/v1/logs"
    || pathname === "/api/v1/logs/events"
    || pathname === "/api/v1/clip/status"
    || pathname === "/api/v1/queue"
    || pathname === "/api/v1/queue/events") {
    next();
    return;
  }
  const longLivedEventPaths = ["/api/v1/events"];
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
      source: getRequestSource(request),
      target: "Local API " + request.method + " " + request.originalUrl,
      upload: createRequestUploadSummary(request),
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
      source: "Local API " + request.method + " " + request.originalUrl,
      target: getRequestSource(request),
      status: response.statusCode,
      duration_ms: Date.now() - startedAt,
      body: request.responsePayload === undefined ? null : request.responsePayload
    }, requestId);
  }
  response.on("finish", logCompletedResponse);
  next();
}

/** Return the browser, extension, or client origin visible to the local API. */
function getRequestSource(request) {
  const headers = request && request.headers ? request.headers : {};
  const origin = headers.origin || headers.referer || headers.referrer || "";
  const address = request && (request.ip || request.socket && request.socket.remoteAddress) || "";
  return String(origin || address || "local client");
}

/** Summarize one incoming upload without retaining bulky request details. */
function createRequestUploadSummary(request) {
  const headers = request && request.headers ? request.headers : {};
  const body = request && request.body;
  const summary = {
    content_type: String(headers["content-type"] || ""),
    content_length: String(headers["content-length"] || ""),
    has_body: body !== undefined && body !== null
  };
  if (Array.isArray(body)) {
    summary.body_type = "array";
    summary.item_count = body.length;
  } else if (body && typeof body === "object") {
    summary.body_type = "object";
    summary.fields = Object.keys(body).slice(0, 30);
    summary.field_count = Object.keys(body).length;
  } else {
    summary.body_type = typeof body;
  }
  return summary;
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
