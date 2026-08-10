/** Build Express middleware that replaces request input with Zod-validated data. */
function validate(schema, sourceName) {
  /** Validate one request and forward structured validation errors. */
  function validateRequest(request, response, next) {
    const source = sourceName === "params" ? request.params : request.body;
    const result = schema.safeParse(source);
    if (!result.success) {
      const error = new Error("请求参数格式错误。");
      error.statusCode = 400;
      error.details = result.error.flatten();
      next(error);
      return;
    }
    if (sourceName === "params") {
      request.validatedParams = result.data;
    } else {
      request.validatedBody = result.data;
    }
    next();
  }
  return validateRequest;
}

module.exports = { validate: validate };
