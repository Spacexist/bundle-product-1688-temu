/** Convert all application errors to the shared API envelope. */
function handleApiError(error, request, response, next) {
  if (response.headersSent) {
    next(error);
    return;
  }
  const statusCode = Number(error.statusCode || 500);
  response.status(statusCode).json({
    ok: false,
    data: null,
    error: {
      code: statusCode === 409 ? String(error.code || "VERSION_CONFLICT") : "REQUEST_FAILED",
      message: error.message || "服务器处理失败。",
      details: error.details || null
    },
    meta: { request_id: request.requestId || "" }
  });
}

module.exports = { handleApiError: handleApiError };
