/**
 * Measure Agent SSE frame cadence with a mocked Kimi upstream.
 * Proves ChatGPT-style token frames are emitted immediately (not on a long interval).
 */
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { AgentChatService } = require("../services/agent-chat.service");

/** Build one OpenAI-compatible SSE body that drips tokens over time. */
function buildMockKimiStream(tokens, gapMs) {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream({
    async pull(controller) {
      if (index >= tokens.length) {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
        return;
      }
      if (index > 0 && gapMs > 0) {
        await new Promise(function wait(resolve) {
          setTimeout(resolve, gapMs);
        });
      }
      const token = tokens[index];
      index += 1;
      const payload = JSON.stringify({
        choices: [{ delta: { content: token } }]
      });
      controller.enqueue(encoder.encode("data: " + payload + "\n\n"));
    }
  });
}

/** Create a fake Express response that records every SSE write with timestamps. */
function createRecordingResponse() {
  const frames = [];
  const startedAt = Date.now();
  const res = {
    headers: {},
    writableEnded: false,
    destroyed: false,
    statusCode: 200,
    status: function status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader: function setHeader(key, value) {
      this.headers[String(key).toLowerCase()] = value;
    },
    flushHeaders: function flushHeaders() {},
    flush: function flush() {},
    write: function write(chunk) {
      frames.push({
        at: Date.now() - startedAt,
        text: String(chunk || "")
      });
      return true;
    },
    end: function end() {
      this.writableEnded = true;
    },
    on: function on() {},
    removeListener: function removeListener() {},
    socket: { setTimeout: function setTimeout() {} },
    setTimeout: function setTimeout() {}
  };
  return { res: res, frames: frames };
}

/** Parse recorded writes into named SSE events. */
function parseEvents(frames) {
  const events = [];
  for (let index = 0; index < frames.length; index += 1) {
    const text = frames[index].text;
    if (text.charAt(0) === ":") {
      events.push({ type: "heartbeat", at: frames[index].at, raw: text });
      continue;
    }
    const eventMatch = /event:\s*([^\n]+)/.exec(text);
    const dataMatch = /data:\s*([^\n]+)/.exec(text);
    if (!eventMatch || !dataMatch) {
      continue;
    }
    let data = null;
    try {
      data = JSON.parse(dataMatch[1]);
    } catch (_) {
      data = dataMatch[1];
    }
    events.push({
      type: eventMatch[1].trim(),
      at: frames[index].at,
      data: data
    });
  }
  return events;
}

async function main() {
  const testDir = path.join(__dirname, "test-agent-sse-cadence");
  fs.rmSync(testDir, { recursive: true, force: true });
  fs.mkdirSync(testDir, { recursive: true });

  const tokens = ["你", "好", "，", "这", "是", "ChatGPT", "式", "SSE", "测", "试"];
  const upstreamGapMs = 40;
  const originalFetch = global.fetch;

  global.fetch = async function mockKimiFetch() {
    return {
      ok: true,
      status: 200,
      body: buildMockKimiStream(tokens, upstreamGapMs)
    };
  };

  const service = new AgentChatService({
    storageDirectory: testDir,
    readConfig: function readConfig() {
      return {
        kimi: {
          apikey: "test-key",
          baseurl: "https://api.moonshot.cn/v1",
          endpoint: "/chat/completions",
          model: "kimi-k2.6",
          timeout_ms: 30000,
          sse_heartbeat_ms: 2000
        }
      };
    },
    writeLog: function noop() {}
  });

  const chat = service.createChat("sse-cadence");
  const recorded = createRecordingResponse();
  const startedAt = Date.now();
  await service.streamKimiChat(chat.id, { content: "ping" }, recorded.res, "test-sse");
  const elapsedMs = Date.now() - startedAt;

  global.fetch = originalFetch;

  const events = parseEvents(recorded.frames);
  const deltas = events.filter(function keep(event) {
    return event.type === "delta";
  });
  const heartbeats = events.filter(function keep(event) {
    return event.type === "heartbeat";
  });
  const done = events.find(function find(event) {
    return event.type === "message_done";
  });

  assert.equal(recorded.res.headers["content-type"], "text/event-stream; charset=utf-8");
  assert.ok(deltas.length >= tokens.length, "expected one delta per token, got " + deltas.length);
  assert.ok(done, "missing message_done");

  const gaps = [];
  for (let index = 1; index < deltas.length; index += 1) {
    gaps.push(deltas[index].at - deltas[index - 1].at);
  }
  const maxGap = gaps.length ? Math.max.apply(null, gaps) : 0;
  const avgGap = gaps.length ? gaps.reduce(function sum(a, b) { return a + b; }, 0) / gaps.length : 0;
  const joined = deltas.map(function map(event) {
    return event.data && event.data.delta ? event.data.delta : "";
  }).join("");

  assert.equal(joined, tokens.join(""));
  assert.ok(maxGap < 500, "delta gap too large for ChatGPT-style SSE: " + maxGap + "ms");
  assert.ok(avgGap < 120, "average delta gap too large: " + avgGap + "ms");

  console.log(JSON.stringify({
    ok: true,
    elapsed_ms: elapsedMs,
    delta_count: deltas.length,
    heartbeat_count: heartbeats.length,
    avg_delta_gap_ms: Math.round(avgGap),
    max_delta_gap_ms: maxGap,
    first_delta_at_ms: deltas[0] ? deltas[0].at : null,
    content: joined,
    content_type: recorded.res.headers["content-type"]
  }, null, 2));

  fs.rmSync(testDir, { recursive: true, force: true });
}

main().catch(function handleError(error) {
  console.error("SSE cadence test failed:", error && error.stack || error);
  process.exitCode = 1;
});
