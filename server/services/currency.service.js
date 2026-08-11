const defaultRates = {
  CNY: 1,
  USD: 6.744,
  JPY: 0.0425,
  CAD: 4.838,
  EUR: 7.7931,
  GBP: 9.108,
  HKD: 0.8596,
  KRW: 0.00476,
  AUD: 4.764,
  SGD: 5.27
};

const currencyNames = {
  CNY: "人民币",
  USD: "美元",
  JPY: "日元",
  CAD: "加拿大元",
  EUR: "欧元",
  GBP: "英镑",
  HKD: "港币",
  KRW: "韩元",
  AUD: "澳元",
  SGD: "新加坡元"
};

const currencyAliases = {
  人民币: "CNY",
  元: "CNY",
  "¥": "CNY",
  "￥": "CNY",
  美元: "USD",
  "$": "USD",
  日元: "JPY",
  円: "JPY",
  "¥日元": "JPY",
  加拿大元: "CAD",
  加元: "CAD",
  "C$": "CAD",
  "CA$": "CAD",
  欧元: "EUR",
  "€": "EUR",
  英镑: "GBP",
  "£": "GBP",
  港币: "HKD",
  "HK$": "HKD",
  韩元: "KRW",
  "₩": "KRW",
  澳元: "AUD",
  "A$": "AUD",
  新加坡元: "SGD",
  "S$": "SGD"
};

/** Currency conversion service using configurable rates against one base currency. */
class CurrencyService {
  /** Store the server configuration reader without caching mutable exchange rates. */
  constructor(options) {
    const settings = options || {};
    this.readConfig = settings.readConfig;
    this.writeConfig = settings.writeConfig;
    this.liveRates = null;
  }

  /** Create one request error with a client-facing HTTP status code. */
  createCurrencyError(message, statusCode) {
    const error = new Error(String(message || "汇率转换失败。"));
    error.statusCode = Number(statusCode || 400);
    return error;
  }

  /** Read the exchange-rate settings without exposing the whole server config. */
  getExchangeConfig() {
    const config = typeof this.readConfig === "function" ? this.readConfig() : {};
    return config.exchange_rates && typeof config.exchange_rates === "object"
      ? config.exchange_rates
      : {};
  }

  /** Return the local fallback base currency and validated positive rates. */
  getFallbackRates() {
    const exchange = this.getExchangeConfig();
    const baseCurrency = String(exchange.base_currency || "CNY").toUpperCase();
    const rates = {};
    const defaultKeys = Object.keys(defaultRates);
    for (let index = 0; index < defaultKeys.length; index += 1) {
      const currency = defaultKeys[index];
      rates[currency] = defaultRates[currency];
    }
    const configuredRates = exchange.rates && typeof exchange.rates === "object"
      ? exchange.rates
      : {};
    const configuredKeys = Object.keys(configuredRates);
    for (let index = 0; index < configuredKeys.length; index += 1) {
      const currency = String(configuredKeys[index] || "").toUpperCase();
      const rate = Number(configuredRates[configuredKeys[index]]);
      if (currency && Number.isFinite(rate) && rate > 0) {
        rates[currency] = rate;
      }
    }
    if (!rates[baseCurrency]) {
      rates[baseCurrency] = 1;
    }
    return {
      base_currency: baseCurrency,
      rates: rates,
      updated_at: String(exchange.updated_at || "默认配置"),
      update_time: String(exchange.update_time || exchange.updated_at || "默认配置"),
      source: String(exchange.source || "本地配置"),
      live: false,
      rate_date: String(exchange.rate_date || exchange.updated_at || "")
    };
  }

  /** Parse the ECB daily XML into rates quoted against EUR. */
  parseEcbRates(xml) {
    const source = String(xml || "");
    const rates = { EUR: 1 };
    const pattern = /currency=["']([A-Z]{3})["']\s+rate=["']([0-9.]+)["']/g;
    let match = pattern.exec(source);
    while (match) {
      const rate = Number(match[2]);
      if (Number.isFinite(rate) && rate > 0) {
        rates[match[1]] = rate;
      }
      match = pattern.exec(source);
    }
    return rates;
  }

  /** Read the published ECB rate date from the daily XML document. */
  readEcbRateDate(xml) {
    const match = /time=["'](\d{4}-\d{2}-\d{2})["']/.exec(String(xml || ""));
    return match ? match[1] : "";
  }

  /** Request the latest ECB daily rates and convert them to the configured base currency. */
  async requestLiveRates() {
    const exchange = this.getExchangeConfig();
    const requestUrl = String(exchange.request_url || "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml");
    const timeoutMs = Math.max(1000, Number(exchange.request_timeout_ms || 5000));
    const response = await fetch(requestUrl, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "User-Agent": "auto-packing-currency-service/1.0" }
    });
    if (!response.ok) {
      throw this.createCurrencyError("实时汇率请求失败，HTTP " + response.status + "。", 503);
    }
    const xml = await response.text();
    const euroRates = this.parseEcbRates(xml);
    const cnyPerEuro = Number(euroRates.CNY || 0);
    if (!cnyPerEuro) {
      throw this.createCurrencyError("实时汇率响应中没有 CNY。", 503);
    }
    const fallback = this.getFallbackRates();
    const rates = {};
    const currencies = Object.keys(fallback.rates);
    for (let index = 0; index < currencies.length; index += 1) {
      const currency = currencies[index];
      if (currency === "CNY") {
        rates[currency] = 1;
        continue;
      }
      const euroRate = Number(euroRates[currency] || 0);
      rates[currency] = euroRate > 0 ? cnyPerEuro / euroRate : fallback.rates[currency];
    }
    return {
      base_currency: fallback.base_currency,
      rates: rates,
      updated_at: new Date().toISOString(),
      update_time: new Date().toISOString(),
      source: "ECB eurofxref-daily.xml",
      live: true,
      rate_date: this.readEcbRateDate(xml)
    };
  }

  /** Persist the latest live rates and update time into server/config.json. */
  persistLiveRates(liveRates) {
    if (typeof this.readConfig !== "function" || typeof this.writeConfig !== "function") {
      return;
    }
    const config = this.readConfig();
    const exchange = config.exchange_rates && typeof config.exchange_rates === "object"
      ? config.exchange_rates
      : {};
    exchange.base_currency = liveRates.base_currency;
    exchange.rates = liveRates.rates;
    exchange.updated_at = liveRates.updated_at;
    exchange.update_time = liveRates.update_time;
    exchange.rate_date = liveRates.rate_date;
    exchange.source = liveRates.source;
    config.exchange_rates = exchange;
    this.writeConfig(config);
  }

  /** Load live rates with a short configurable cache and local fallback. */
  async getConfiguredRates() {
    const fallback = this.getFallbackRates();
    const exchange = this.getExchangeConfig();
    if (exchange.live_update === false) {
      return fallback;
    }
    const refreshIntervalMs = Math.max(0, Number(exchange.refresh_interval_ms || 86400000));
    if (this.liveRates && Date.now() - this.liveRates.fetched_at < refreshIntervalMs) {
      return this.liveRates.data;
    }
    const persistedUpdateTime = Date.parse(String(exchange.update_time || exchange.updated_at || ""));
    if (Number.isFinite(persistedUpdateTime) && Date.now() - persistedUpdateTime < refreshIntervalMs) {
      fallback.live = true;
      return fallback;
    }
    try {
      const live = await this.requestLiveRates();
      try {
        this.persistLiveRates(live);
      } catch (error) {
        live.config_write_error = error.message || "汇率配置写入失败。";
      }
      this.liveRates = { fetched_at: Date.now(), data: live };
      return live;
    } catch (error) {
      return fallback;
    }
  }

  /** Normalize one currency code from the request body. */
  normalizeCurrency(value, fallback) {
    const original = String(value || fallback || "").trim();
    const alias = currencyAliases[original] || currencyAliases[original.toUpperCase()];
    return String(alias || original).trim().toUpperCase();
  }

  /** Detect a supported currency from a visible price or currency label. */
  detectCurrencyFromText(value) {
    const text = String(value || "").trim();
    const upperText = text.toUpperCase();
    const markers = [
      { currency: "CAD", values: ["CA$", "C$", "CAD", "加拿大元", "加元"] },
      { currency: "AUD", values: ["A$", "AUD", "澳元"] },
      { currency: "SGD", values: ["S$", "SGD", "新加坡元"] },
      { currency: "HKD", values: ["HK$", "HKD", "港币"] },
      { currency: "JPY", values: ["JPY", "日元", "円"] },
      { currency: "USD", values: ["USD", "美元", "$"] },
      { currency: "EUR", values: ["EUR", "欧元", "€"] },
      { currency: "GBP", values: ["GBP", "英镑", "£"] },
      { currency: "KRW", values: ["KRW", "韩元", "₩"] },
      { currency: "CNY", values: ["CNY", "人民币", "元", "¥", "￥"] }
    ];
    for (let index = 0; index < markers.length; index += 1) {
      const marker = markers[index];
      for (let valueIndex = 0; valueIndex < marker.values.length; valueIndex += 1) {
        const token = String(marker.values[valueIndex]);
        if (upperText.indexOf(token.toUpperCase()) >= 0) {
          return marker.currency;
        }
      }
    }
    return "";
  }

  /** Resolve the original currency reported by Temu or a supported collector. */
  resolveSourceCurrency(source, platform) {
    const target = source && typeof source === "object" ? source : {};
    const currentCurrency = this.normalizeCurrency(target.currency || target.price_currency, "");
    if (currencyNames[currentCurrency] && currentCurrency === "CNY") {
      return "CNY";
    }
    const candidates = [
      target.currency,
      target.currencyCode,
      target.currency_code,
      target.original_currency,
      target.locale && target.locale.currency,
      target.page && target.page.currency,
      target.page && target.page.locale && target.page.locale.currency,
      target.goods && target.goods.currency
    ];
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      const normalized = this.normalizeCurrency(candidate, "");
      if (currencyNames[normalized]) {
        return normalized;
      }
      const detected = this.detectCurrencyFromText(candidate);
      if (detected) {
        return detected;
      }
    }
    if (String(platform || "").toLowerCase() === "1688") {
      return "CNY";
    }
    const skuRows = Array.isArray(target.sku) ? target.sku : Array.isArray(target.skuRows) ? target.skuRows : [];
    for (let rowIndex = 0; rowIndex < skuRows.length; rowIndex += 1) {
      const row = skuRows[rowIndex] || {};
      const detected = this.detectCurrencyFromText(row.normalPriceStr || row.price || row.discountPrice || row.sku_price);
      if (detected) {
        return detected;
      }
    }
    return "CNY";
  }

  /** Return the multiplier that converts one source currency into RMB. */
  getConversionMultiplier(fromCurrency, configured) {
    const source = this.normalizeCurrency(fromCurrency, "CNY");
    const rates = configured && configured.rates && typeof configured.rates === "object" ? configured.rates : {};
    const fromRate = Number(rates[source]);
    const cnyRate = Number(rates.CNY || 1);
    if (!Number.isFinite(fromRate) || fromRate <= 0 || !Number.isFinite(cnyRate) || cnyRate <= 0) {
      throw this.createCurrencyError("不支持的货币：" + source + "。", 400);
    }
    return fromRate / cnyRate;
  }

  /** Round a SKU display price to two decimal places. */
  roundPrice(value) {
    return Math.round(Number(value) * 100) / 100;
  }

  /** Convert every numeric token in one SKU price while preserving ranges and labels. */
  formatConvertedPrice(value, multiplier) {
    if (value === null || value === undefined || value === "") {
      return value;
    }
    const numberValue = typeof value === "number" ? value : Number(String(value).replace(/,/g, "").trim());
    if (typeof value === "number" && Number.isFinite(numberValue)) {
      return this.roundPrice(numberValue * multiplier);
    }
    const text = String(value);
    const pattern = /\d[\d,]*(?:\.\d+)?/g;
    let cursor = 0;
    let converted = "";
    let match = pattern.exec(text);
    while (match) {
      converted += text.slice(cursor, match.index);
      const sourceNumber = Number(match[0].replace(/,/g, ""));
      converted += Number.isFinite(sourceNumber) ? this.roundPrice(sourceNumber * multiplier).toFixed(2) : match[0];
      cursor = match.index + match[0].length;
      match = pattern.exec(text);
    }
    if (!converted && !pattern.lastIndex) {
      return value;
    }
    converted += text.slice(cursor);
    const hasCurrencyMarker = /USD|JPY|CAD|EUR|GBP|HKD|KRW|AUD|SGD|美元|日元|円|加拿大元|加元|欧元|英镑|港币|韩元|澳元|新加坡元|\$|€|£|₩|元|¥|￥/i.test(text);
    if (hasCurrencyMarker) {
      return "¥" + converted.replace(/USD|JPY|CAD|EUR|GBP|HKD|KRW|AUD|SGD|美元|日元|円|加拿大元|加元|欧元|英镑|港币|韩元|澳元|新加坡元|\$|€|£|₩|元|¥|￥/gi, "").trim();
    }
    return converted;
  }

  /** Convert all supported price fields on one array of SKU rows. */
  convertSkuRows(rows, multiplier) {
    const target = Array.isArray(rows) ? rows : [];
    const fields = ["sku_price", "sku_original_price", "price", "originalPrice", "discountPrice", "promotionPrice", "salePrice", "normalPrice", "normalPriceStr", "multiPrice"];
    for (let rowIndex = 0; rowIndex < target.length; rowIndex += 1) {
      const row = target[rowIndex];
      if (!row || typeof row !== "object") {
        continue;
      }
      for (let fieldIndex = 0; fieldIndex < fields.length; fieldIndex += 1) {
        const fieldName = fields[fieldIndex];
        if (Object.prototype.hasOwnProperty.call(row, fieldName)) {
          row[fieldName] = this.formatConvertedPrice(row[fieldName], multiplier);
        }
      }
    }
    return target;
  }

  /** Copy normalized source prices into an existing canonical SKU array by SKU identity. */
  syncStoredSkuPrices(storedRows, sourceRows) {
    const target = Array.isArray(storedRows) ? storedRows : [];
    const source = Array.isArray(sourceRows) ? sourceRows : [];
    for (let rowIndex = 0; rowIndex < target.length; rowIndex += 1) {
      const stored = target[rowIndex];
      if (!stored || typeof stored !== "object") {
        continue;
      }
      const storedId = String(stored.sku_id || stored.skuId || "");
      let sourceRow = source[rowIndex] || null;
      for (let sourceIndex = 0; sourceIndex < source.length; sourceIndex += 1) {
        const candidate = source[sourceIndex] || {};
        const candidateId = String(candidate.sku_id || candidate.skuId || "");
        if (storedId && candidateId && storedId === candidateId) {
          sourceRow = candidate;
          break;
        }
      }
      if (!sourceRow || typeof sourceRow !== "object") {
        continue;
      }
      const price = sourceRow.sku_price !== undefined
        ? sourceRow.sku_price
        : sourceRow.discountPrice !== undefined
          ? sourceRow.discountPrice
          : sourceRow.promotionPrice !== undefined
            ? sourceRow.promotionPrice
            : sourceRow.salePrice !== undefined
              ? sourceRow.salePrice
              : sourceRow.normalPrice !== undefined ? sourceRow.normalPrice : sourceRow.price;
      const originalPrice = sourceRow.sku_original_price !== undefined
        ? sourceRow.sku_original_price
        : sourceRow.price !== undefined ? sourceRow.price : sourceRow.normalPrice;
      if (price !== undefined) {
        stored.sku_price = price;
      }
      if (originalPrice !== undefined) {
        stored.sku_original_price = originalPrice;
      }
    }
    return target;
  }

  /** Normalize all collected SKU prices to RMB using the daily server rate. */
  async normalizeSourcePrices(source, platform) {
    const target = source && typeof source === "object" ? source : {};
    const originalCurrency = this.resolveSourceCurrency(target, platform);
    const configured = await this.getConfiguredRates();
    const multiplier = this.getConversionMultiplier(originalCurrency, configured);
    const arrays = [];
    if (Array.isArray(target.sku)) {
      arrays.push(target.sku);
    }
    if (Array.isArray(target.skuRows) && arrays.indexOf(target.skuRows) < 0) {
      arrays.push(target.skuRows);
    }
    const goods = target.goods && typeof target.goods === "object" ? target.goods : null;
    if (goods && Array.isArray(goods.sku) && arrays.indexOf(goods.sku) < 0) {
      arrays.push(goods.sku);
    }
    for (let arrayIndex = 0; arrayIndex < arrays.length; arrayIndex += 1) {
      this.convertSkuRows(arrays[arrayIndex], multiplier);
    }
    target.original_currency = target.original_currency || originalCurrency;
    target.currency = "CNY";
    target.price_currency = "CNY";
    target.price_update_time = configured.update_time;
    return {
      original_currency: originalCurrency,
      price_currency: "CNY",
      update_time: configured.update_time,
      live_update: Boolean(configured.live),
      multiplier: multiplier
    };
  }

  /** Round a converted amount to six decimal places for stable API output. */
  roundAmount(value) {
    return Math.round(Number(value) * 1000000) / 1000000;
  }

  /** Convert an amount from one configured currency to another. */
  async convert(input) {
    const source = input || {};
    const amountText = String(source.amount === undefined ? "" : source.amount).replace(/,/g, "").trim();
    const amount = Number(amountText);
    if (!amountText || !Number.isFinite(amount)) {
      throw this.createCurrencyError("amount 必须是有效数字。", 400);
    }
    const fromCurrency = this.normalizeCurrency(source.from_currency || source.from, "CNY");
    const toCurrency = this.normalizeCurrency(source.to_currency || source.to, "USD");
    const configured = await this.getConfiguredRates();
    const fromRate = configured.rates[fromCurrency];
    const toRate = configured.rates[toCurrency];
    if (!fromRate || !toRate) {
      throw this.createCurrencyError("不支持的货币：" + (!fromRate ? fromCurrency : toCurrency) + "。", 400);
    }
    const rate = fromRate / toRate;
    return {
      base_currency: configured.base_currency,
      amount: amount,
      from_currency: fromCurrency,
      from_currency_name: currencyNames[fromCurrency] || fromCurrency,
      to_currency: toCurrency,
      to_currency_name: currencyNames[toCurrency] || toCurrency,
      rate: this.roundAmount(rate),
      converted_amount: this.roundAmount(amount * rate),
      rates: configured.rates,
      updated_at: configured.updated_at,
      update_time: configured.update_time,
      source: configured.source,
      live_update: Boolean(configured.live),
      rate_date: configured.rate_date
    };
  }
}

module.exports = { CurrencyService: CurrencyService };
