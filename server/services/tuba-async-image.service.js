const { setTimeout: delay } = require("node:timers/promises");
const { reportImageFailure } = require("./image-failure.service");

const PROVIDER_TIMEOUT_MS = 600000;
const POLL_INTERVAL_MS = 4000;

/** Create a stable image error without attaching credentials or request bodies. */
function imageError(message, code, statusCode) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode || 502;
  return error;
}

/** Stop cancelled work before submitting, polling, or writing an image. */
function assertImageActive(options) {
  const source = options || {};
  if ((source.signal && source.signal.aborted) || (source.isCancelled && source.isCancelled())) {
    throw imageError("图片任务已被放弃；上游任务可能仍会完成并计费。", "IMAGE_TASK_CANCELLED", 409);
  }
}

/** Wait without blocking the event loop and stop promptly on runtime cancellation. */
async function waitForImageTick(milliseconds, signal) {
  try {
    await delay(milliseconds, undefined, { signal: signal });
  } catch (error) {
    assertImageActive({ signal: signal });
    throw error;
  }
}

/** Accept the documented task object and a wrapped data object, never an image data array. */
function taskPayload(payload) {
  const source = payload && typeof payload === "object" ? payload : {};
  return source.data && !Array.isArray(source.data) && typeof source.data === "object"
    && !source.status && !source.task_id && !source.id ? source.data : source;
}

/** Submit exactly once and poll one Tuba image task; queue ownership belongs to the caller. */
class TubaAsyncImageService {
  /** Inject transport and time only for offline tests; production uses the fixed protocol limits. */
  constructor(options) {
    const settings = options || {};
    this.fetch = settings.fetch || globalThis.fetch;
    this.now = settings.now || Date.now;
    this.wait = settings.wait || waitForImageTick;
  }

  /** Persist protocol state and log only identifiers/status rather than full polling payloads. */
  async publish(options, state) {
    if (options.onState) {
      try { await options.onState(Object.assign({}, state)); } catch (error) {
        error.image_stage = "state_persistence";
        throw error;
      }
    }
    if (options.writeLog) {
      options.writeLog("UPSTREAM", "Tuba async image state", state, options.requestId);
    }
  }

  /** Fetch and consume the entire JSON body inside a bounded abortable request. */
  async request(url, init, options, remainingMs) {
    assertImageActive(options);
    const timeoutSignal = AbortSignal.timeout(Math.max(1, Math.min(init.method === "POST" ? PROVIDER_TIMEOUT_MS : 15000, remainingMs)));
    const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
    let response;
    try {
      response = await this.fetch(url, Object.assign({}, init, { signal: signal, redirect: "error" }));
      const text = await response.text();
      assertImageActive(options);
      let payload = {};
      try {
        payload = JSON.parse(text);
      } catch (error) {
        // A malformed successful polling response is treated as an unknown state.
      }
      return { ok: response.ok, status: response.status, payload: payload };
    } catch (error) {
      assertImageActive(options);
      throw Object.assign(imageError("Tuba 网络请求失败或超时。", "PROVIDER_NETWORK_ERROR"), {
        cause: error, failure_url: url, http_status: response && response.status || 0
      });
    }
  }

  /** Return a single completed HTTP(S) image URL, rejecting base64-only or empty responses. */
  readImageUrl(task) {
    const data = Array.isArray(task.data) ? task.data : [];
    const value = String(data[0] && data[0].url || "").trim();
    try {
      const parsed = new URL(value);
      if ((parsed.protocol === "https:" || parsed.protocol === "http:") && !parsed.username && !parsed.password) {
        return value;
      }
    } catch (error) {
      // Invalid URLs must never be passed to the image downloader.
    }
    throw Object.assign(imageError("Tuba 已完成任务，但未返回有效图片 URL。", "PROVIDER_EMPTY_IMAGE"), { failure_url: value });
  }

  /** Execute a single immutable submission, followed only by safe GET retries. */
  async generate(options) {
    const settings = options || {};
    const failureOptions = {
      onFailure: settings.onFailure,
      sensitiveValues: [settings.apiKey, settings.body instanceof FormData ? settings.body.get("prompt") : settings.body && settings.body.prompt]
    };
    const failureContext = { stage: "provider_submit", method: "POST", attempt: 1, url: settings.endpoint };
    const state = { provider_status: "submitting", provider_task_id: "", provider_image_url: "" };
    const startedAt = this.now();
    const deadline = startedAt + PROVIDER_TIMEOUT_MS;
    assertImageActive(settings);
    const endpoint = new URL(settings.endpoint);
    if (!/^\/v1\/images\/(generations|edits)$/.test(endpoint.pathname)) {
      throw imageError("Tuba 图片端点必须为 /v1/images/generations 或 /v1/images/edits。", "PROVIDER_ENDPOINT_INVALID", 400);
    }
    const headers = { Authorization: "Bearer " + settings.apiKey };
    let body;
    if (settings.body instanceof FormData) {
      settings.body.set("async", "true");
      settings.body.set("response_format", "url");
      body = settings.body;
    } else {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(Object.assign({}, settings.body, { async: true, response_format: "url" }));
    }
    await this.publish(settings, state);
    try {
      let submitted;
      try {
        submitted = await this.request(endpoint.toString(), { method: "POST", headers: headers, body: body }, settings, deadline - this.now());
      } catch (error) {
        if (error.code === "IMAGE_TASK_CANCELLED") {
          throw error;
        }
        throw Object.assign(imageError("Tuba 提交结果不确定，未自动重发；请核查上游记录后手动重试。", "PROVIDER_SUBMISSION_UNKNOWN"), { cause: error, http_status: error.http_status });
      }
      failureContext.http_status = submitted.status;
      if (!submitted.ok) {
        throw this.responseError(submitted, "Tuba 提交失败，未自动重发。");
      }
      const task = taskPayload(submitted.payload);
      const id = String(task.task_id || task.id || "").trim();
      if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) {
        throw imageError("Tuba 提交响应缺少有效 task_id，结果不确定，未自动重发。", "PROVIDER_SUBMISSION_UNKNOWN");
      }
      state.provider_task_id = id;
      state.provider_submitted_at = new Date(this.now()).toISOString();
      state.provider_status = "queued";
      await this.publish(settings, state);
      const pollUrl = new URL("/v1/images/" + encodeURIComponent(id), endpoint).toString();
      Object.assign(failureContext, { stage: "provider_poll", method: "GET", attempt: 0, url: pollUrl, http_status: 0 });
      const submittedAt = this.now();
      let unknownCount = 0;
      while (this.now() < deadline) {
        assertImageActive(settings);
        await this.wait(Math.min(POLL_INTERVAL_MS, deadline - this.now()), settings.signal);
        assertImageActive(settings);
        if (this.now() >= deadline) {
          break;
        }
        let result;
        failureContext.attempt += 1;
        failureContext.http_status = 0;
        try {
          result = await this.request(pollUrl, { method: "GET", headers: { Authorization: headers.Authorization } }, settings, deadline - this.now());
        } catch (error) {
          if (error.code !== "PROVIDER_NETWORK_ERROR") {
            throw error;
          }
          reportImageFailure(failureOptions, error, failureContext);
          unknownCount = 0;
          continue;
        }
        if (this.now() >= deadline) {
          break;
        }
        failureContext.http_status = result.status;
        if (!result.ok) {
          unknownCount = 0;
          if (result.status === 429 || result.status >= 500 || (result.status === 404 && this.now() - submittedAt < 30000)) {
            reportImageFailure(failureOptions, this.responseError(result, "Tuba 查询暂时失败，将继续查询。"), failureContext);
            continue;
          }
          throw this.responseError(result, "Tuba 查询失败。");
        }
        const current = taskPayload(result.payload);
        if ((current.task_id || current.id) && String(current.task_id || current.id) !== id) {
          throw imageError("Tuba 查询返回了不匹配的任务 ID。", "PROVIDER_TASK_ID_CONFLICT");
        }
        const status = String(current.status || "");
        if (status === "failed") {
          const message = String(current.error && current.error.message || "图片生成失败。");
          failureContext.stage = "provider_generation";
          throw Object.assign(imageError(message, "PROVIDER_FAILED"), {
            provider_code: current.error && current.error.code || current.code || "",
            http_status: result.status
          });
        }
        if (status === "completed") {
          failureContext.stage = "result_validation";
          state.provider_image_url = this.readImageUrl(current);
          state.provider_status = "completed";
          failureContext.stage = "state_persistence";
          await this.publish(settings, state);
          assertImageActive(settings);
          return state.provider_image_url;
        }
        if (status !== "queued" && status !== "running") {
          unknownCount += 1;
          if (unknownCount >= 3) {
            throw imageError("Tuba 连续三次返回未知任务状态。", "PROVIDER_UNKNOWN_STATUS");
          }
          reportImageFailure(failureOptions, imageError("Tuba 返回未知任务状态：" + status, "PROVIDER_UNKNOWN_STATUS"), Object.assign({}, failureContext, { http_status: result.status }));
          continue;
        }
        unknownCount = 0;
        if (state.provider_status !== status) {
          state.provider_status = status;
          await this.publish(settings, state);
        }
      }
      failureContext.http_status = 0;
      throw imageError("Tuba 图片任务等待超过 600 秒，已停止查询；上游可能仍会完成并计费。", "PROVIDER_TIMEOUT", 504);
    } catch (error) {
      if (error.code !== "IMAGE_TASK_CANCELLED") { reportImageFailure(failureOptions, error, failureContext); }
      state.provider_status = error.code === "IMAGE_TASK_CANCELLED" ? "cancelled"
        : error.code === "PROVIDER_SUBMISSION_UNKNOWN" ? "submission_unknown" : "failed";
      state.provider_error_code = String(error.code || "PROVIDER_ERROR");
      // Cancellation callbacks must not recreate a deleted local task.
      if (error.code !== "IMAGE_TASK_CANCELLED") {
        await this.publish(settings, state);
      } else if (settings.writeLog) {
        settings.writeLog("UPSTREAM", "Tuba task abandoned; upstream may still bill", state, settings.requestId);
      }
      throw error;
    }
  }

  /** Preserve real HTTP status and bounded provider error fields without retaining the response body. */
  responseError(response, fallback) {
    const payload = taskPayload(response.payload);
    const detail = payload && payload.error;
    const message = detail && typeof detail === "object" ? detail.message : typeof detail === "string" ? detail : payload.message;
    return Object.assign(imageError(String(message || fallback), "PROVIDER_HTTP_" + response.status, response.status), {
      http_status: response.status,
      provider_code: detail && typeof detail === "object" ? detail.code || "" : payload.code || ""
    });
  }
}

module.exports = { TubaAsyncImageService, PROVIDER_TIMEOUT_MS, assertImageActive, waitForImageTick, imageError };
