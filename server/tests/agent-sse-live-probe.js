/** Live probe: measure real Agent SSE delta gaps against the local backend. */
(async function main() {
  const tokens = [];
  const gaps = [];
  let last = 0;
  let buf = "";
  let content = "";
  const base = "http://127.0.0.1:3000/api/v1";

  const created = await fetch(base + "/agent/chats", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "sse-live-probe" })
  }).then(function parse(response) { return response.json(); });
  if (!created.ok) {
    throw new Error(JSON.stringify(created));
  }
  const chatId = created.data.chat.id;
  const startedAt = Date.now();
  const response = await fetch(base + "/agent/chats/" + encodeURIComponent(chatId) + "/messages/stream", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "text/event-stream"
    },
    body: JSON.stringify({ content: "用一句话介绍保鲜膜，不超过30字" })
  });
  console.log("status", response.status, "ctype", response.headers.get("content-type"));
  if (!response.ok) {
    console.log(await response.text());
    process.exit(1);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let heartbeats = 0;
  let deltas = 0;
  let errorPayload = null;
  let done = false;

  while (true) {
    const readResult = await reader.read();
    if (readResult.done) {
      break;
    }
    buf += decoder.decode(readResult.value || new Uint8Array(), { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop() || "";
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      if (part.trim().indexOf(":") === 0) {
        heartbeats += 1;
        continue;
      }
      let eventName = "";
      let dataText = "";
      const lines = part.split("\n");
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        const line = lines[lineIndex];
        if (line.indexOf("event:") === 0) {
          eventName = line.slice(6).trim();
        }
        if (line.indexOf("data:") === 0) {
          dataText = line.slice(5).trim();
        }
      }
      if (!dataText) {
        continue;
      }
      let parsed = {};
      try {
        parsed = JSON.parse(dataText);
      } catch (_) {}
      const now = Date.now() - startedAt;
      if (eventName === "delta" && parsed.delta) {
        deltas += 1;
        content += parsed.delta;
        if (last) {
          gaps.push(now - last);
        }
        last = now;
        tokens.push({ at: now, len: String(parsed.delta).length });
      } else if (eventName === "error") {
        errorPayload = parsed;
      } else if (eventName === "message_done") {
        done = true;
      }
    }
  }

  const avg = gaps.length ? Math.round(gaps.reduce(function sum(a, b) { return a + b; }, 0) / gaps.length) : null;
  const max = gaps.length ? Math.max.apply(null, gaps) : null;
  console.log(JSON.stringify({
    ok: !errorPayload,
    done: done,
    deltas: deltas,
    heartbeats: heartbeats,
    avg_gap_ms: avg,
    max_gap_ms: max,
    elapsed_ms: Date.now() - startedAt,
    content: content.slice(0, 160),
    error: errorPayload
  }, null, 2));

  await fetch(base + "/agent/chats/" + encodeURIComponent(chatId), { method: "DELETE" });
  if (errorPayload) {
    process.exitCode = 1;
  }
})().catch(function handleError(error) {
  console.error(error);
  process.exit(1);
});
