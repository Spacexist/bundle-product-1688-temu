/**
 * Agent storyboard + SOP helpers.
 * Parse injectable JSON pages, load server SOP, and keep parse logic out of app.js.
 */
(function initAgentStoryboard(global) {
  const MAX_PAGES = 10;
  const STORYBOARD_TIP = "建议先跑「识别报告」，再生成分镜。";

  const FALLBACK_SOP = {
    id: "temu-suite",
    name: "Temu 套图策划",
    steps: [
      {
        id: "recognize",
        title: "识别报告",
        instruction: "请根据我上传的产品参考图，输出【识别报告】（品类、规格、核心卖点中英、受众、调性、包装亮点、推荐视觉/文字效果、特殊需求）。"
      },
      {
        id: "storyboard",
        title: "生成分镜",
        instruction: [
          "请依据上文【识别报告】生成 1–10 张 1:1 电商图分镜，最后用且仅用一个 JSON 代码块收束：",
          "```json",
          "{",
          '  "pages": [',
          '    { "purpose": "分镜用途（中文）", "prompt": "完整生图提示词", "negative_prompt": "负面提示词" }',
          "  ]",
          "}",
          "```"
        ].join("\n")
      }
    ]
  };

  /** Extract the last fenced ```json ... ``` block from one assistant message. */
  function extractLastJsonFence(text) {
    const source = String(text || "");
    const fencePattern = /```json\s*([\s\S]*?)```/gi;
    let match = null;
    let last = null;
    while ((match = fencePattern.exec(source)) !== null) {
      last = match[1];
    }
    return last ? String(last).trim() : "";
  }

  /** Normalize one page object into purpose/prompt/negative_prompt. */
  function normalizePage(raw, index) {
    const item = raw && typeof raw === "object" ? raw : {};
    const purpose = String(item.purpose || item.title || ("分镜" + (index + 1))).trim() || ("分镜" + (index + 1));
    const prompt = String(item.prompt || item.image_prompt || "").trim();
    const negativePrompt = String(item.negative_prompt || item.negative || "").trim();
    return {
      purpose: purpose.slice(0, 500),
      prompt: prompt,
      negative_prompt: negativePrompt
    };
  }

  /** Parse and validate storyboard pages from one complete assistant message. */
  function parseStoryboardFromAssistantMessage(content) {
    const fence = extractLastJsonFence(content);
    if (!fence) {
      return {
        ok: false,
        error: "最后一条完整回复里没有可用的 ```json 分镜块。",
        pages: [],
        truncated: false,
        originalCount: 0
      };
    }
    let parsed = null;
    try {
      parsed = JSON.parse(fence);
    } catch (error) {
      return {
        ok: false,
        error: "分镜 JSON 无法解析：" + String(error && error.message || error),
        pages: [],
        truncated: false,
        originalCount: 0
      };
    }
    const list = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && Array.isArray(parsed.pages)
        ? parsed.pages
        : null;
    if (!list) {
      return {
        ok: false,
        error: "分镜 JSON 必须是 { \"pages\": [...] } 或页面数组。",
        pages: [],
        truncated: false,
        originalCount: 0
      };
    }
    const normalized = [];
    for (let index = 0; index < list.length; index += 1) {
      const page = normalizePage(list[index], index);
      if (!page.prompt) {
        return {
          ok: false,
          error: "第 " + (index + 1) + " 页 prompt 不能为空。",
          pages: [],
          truncated: false,
          originalCount: list.length
        };
      }
      if (page.prompt.length > 10000) {
        return {
          ok: false,
          error: "第 " + (index + 1) + " 页 prompt 超过 10000 字。",
          pages: [],
          truncated: false,
          originalCount: list.length
        };
      }
      normalized.push(page);
    }
    if (!normalized.length) {
      return {
        ok: false,
        error: "分镜 pages 不能为空。",
        pages: [],
        truncated: false,
        originalCount: 0
      };
    }
    const truncated = normalized.length > MAX_PAGES;
    const pages = truncated ? normalized.slice(0, MAX_PAGES) : normalized;
    return {
      ok: true,
      error: "",
      pages: pages,
      truncated: truncated,
      originalCount: normalized.length,
      warning: truncated ? ("分镜超过 " + MAX_PAGES + " 页，已截断为 " + MAX_PAGES + " 页。") : ""
    };
  }

  /** Find the last completed assistant message that can be parsed as a storyboard. */
  function findInjectableAssistantMessage(messages) {
    const list = Array.isArray(messages) ? messages : [];
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const msg = list[index];
      if (!msg || msg.role !== "assistant") {
        continue;
      }
      const status = String(msg.status || "completed");
      if (status === "streaming" || status === "failed" || status === "timeout" || status === "aborted") {
        continue;
      }
      const parsed = parseStoryboardFromAssistantMessage(msg.content);
      if (parsed.ok) {
        return { message: msg, parsed: parsed };
      }
    }
    return null;
  }

  /** Merge agent negative_prompt into the editable prompt field used by carousel/fusion. */
  function composeEditablePrompt(page) {
    const prompt = String(page && page.prompt || "").trim();
    const negative = String(page && page.negative_prompt || "").trim();
    if (!negative) {
      return prompt;
    }
    if (prompt.indexOf("负面提示词") >= 0 || /negative\s*prompt/i.test(prompt)) {
      return prompt;
    }
    return prompt + "\n\n负面提示词：" + negative;
  }

  /** Normalize a SOP payload from API or fallback. */
  function normalizeSop(raw) {
    const source = raw && typeof raw === "object" ? raw : {};
    const stepsSource = Array.isArray(source.steps) ? source.steps : [];
    const steps = [];
    for (let index = 0; index < stepsSource.length; index += 1) {
      const step = stepsSource[index] && typeof stepsSource[index] === "object" ? stepsSource[index] : {};
      const instruction = String(step.instruction || "").trim();
      if (!instruction) {
        continue;
      }
      steps.push({
        id: String(step.id || ("step-" + (index + 1))).trim() || ("step-" + (index + 1)),
        title: String(step.title || ("步骤 " + (index + 1))).trim() || ("步骤 " + (index + 1)),
        instruction: instruction
      });
    }
    if (!steps.length) {
      return null;
    }
    return {
      id: String(source.id || "temu-suite").trim() || "temu-suite",
      name: String(source.name || "Temu 套图策划").trim() || "Temu 套图策划",
      steps: steps
    };
  }

  /** Find one SOP step by id. */
  function findSopStep(sop, stepId) {
    const pack = normalizeSop(sop) || FALLBACK_SOP;
    const wanted = String(stepId || "").trim();
    for (let index = 0; index < pack.steps.length; index += 1) {
      if (pack.steps[index].id === wanted) {
        return pack.steps[index];
      }
    }
    return null;
  }

  /**
   * Fetch SOP from GET /agent/sop.
   * apiBase should be like http://127.0.0.1:3000/api/v1 (no trailing slash).
   */
  async function fetchSop(apiBase) {
    const base = String(apiBase || "").replace(/\/$/, "");
    const response = await fetch(base + "/agent/sop", { cache: "no-store" });
    const payload = await response.json().catch(function emptyPayload() { return null; });
    if (!response.ok || !payload || !payload.ok || !payload.data || !payload.data.sop) {
      const message = payload && payload.error && payload.error.message
        ? String(payload.error.message)
        : "SOP 读取失败。";
      throw new Error(message);
    }
    const sop = normalizeSop(payload.data.sop);
    if (!sop) {
      throw new Error("SOP 配置无效。");
    }
    return sop;
  }

  global.AgentStoryboard = {
    MAX_PAGES: MAX_PAGES,
    STORYBOARD_TIP: STORYBOARD_TIP,
    FALLBACK_SOP: FALLBACK_SOP,
    extractLastJsonFence: extractLastJsonFence,
    parseStoryboardFromAssistantMessage: parseStoryboardFromAssistantMessage,
    findInjectableAssistantMessage: findInjectableAssistantMessage,
    composeEditablePrompt: composeEditablePrompt,
    normalizeSop: normalizeSop,
    findSopStep: findSopStep,
    fetchSop: fetchSop
  };
})(window);
