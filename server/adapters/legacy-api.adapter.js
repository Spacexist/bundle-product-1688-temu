const legacyApi = require("../legacy-api");

/** Create an Express handler that exposes one legacy provider operation under a v1 route. */
function createLegacyApiAdapter(targetPath) {
  /** Rewrite only the internal URL and delegate to the proven provider implementation. */
  function handleLegacyApi(request, response, next) {
    const originalUrl = request.url;
    const originalRequestUrl = request.originalUrl;
    const queryIndex = originalUrl.indexOf("?");
    const query = queryIndex >= 0 ? originalUrl.slice(queryIndex) : "";
    request.isLegacyApiAdapter = true;
    response.apiRequestLabel = String(request.method || "GET") + " " + String(originalRequestUrl || originalUrl).split("?")[0];
    request.url = targetPath + query;
    request.originalUrl = targetPath + query;
    try {
      const handled = legacyApi.handleApiRequest(request, response);
      if (!handled) {
        request.isLegacyApiAdapter = false;
        request.url = originalUrl;
        request.originalUrl = originalRequestUrl;
        next();
      }
    } catch (error) {
      request.isLegacyApiAdapter = false;
      request.url = originalUrl;
      request.originalUrl = originalRequestUrl;
      next(error);
    }
  }
  return handleLegacyApi;
}

module.exports = { createLegacyApiAdapter: createLegacyApiAdapter };
