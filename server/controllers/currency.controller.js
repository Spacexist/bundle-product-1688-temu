/** Currency HTTP controller that returns the shared API envelope. */
class CurrencyController {
  /** Store the server-side currency conversion service. */
  constructor(options) {
    const settings = options || {};
    this.currency = settings.currency;
  }

  /** Convert one request amount using rates loaded from server configuration. */
  async convert(request, response, next) {
    try {
      const data = await this.currency.convert(request.validatedBody || request.body || {});
      response.json({ ok: true, data: data, error: null, meta: { request_id: request.requestId } });
    } catch (error) {
      next(error);
    }
  }
}

module.exports = { CurrencyController: CurrencyController };
