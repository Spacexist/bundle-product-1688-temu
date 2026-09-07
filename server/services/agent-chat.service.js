const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

/** Extract raw body text from a .docx binary buffer without external dependencies. */
function extractDocxText(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    return "";
  }
  let offset = 0;
  while (offset < buffer.length - 4) {
    if (buffer[offset] === 0x50 && buffer[offset + 1] === 0x4B && buffer[offset + 2] === 0x03 && buffer[offset + 3] === 0x04) {
      const compression = buffer.readUInt16LE(offset + 8);
      const compressedSize = buffer.readUInt32LE(offset + 18);
      const filenameLength = buffer.readUInt16LE(offset + 26);
      const extraLength = buffer.readUInt16LE(offset + 28);
      const filename = buffer.toString("utf8", offset + 30, offset + 30 + filenameLength);
      const dataOffset = offset + 30 + filenameLength + extraLength;
      if (filename === "word/document.xml") {
        try {
          const compressedData = buffer.slice(dataOffset, dataOffset + compressedSize);
          const xml = compression === 8 ? zlib.inflateRawSync(compressedData).toString("utf8") : compressedData.toString("utf8");
          return xml
            .replace(/<w:p[^>]*>/g, "\n")
            .replace(/<w:tr[^>]*>/g, "\n")
            .replace(/<w:tc[^>]*>/g, "\t")
            .replace(/<[^>]+>/g, "")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&amp;/g, "&")
            .replace(/&quot;/g, "\"")
            .replace(/&apos;/g, "'")
            .replace(/\t+/g, " ")
            .replace(/\n\s*\n/g, "\n")
            .trim();
        } catch (_) {
          return "";
        }
      }
      offset = dataOffset + compressedSize;
    } else {
      offset += 1;
    }
  }
  return "";
}

/** Safely resolve one Kimi endpoint URL. */
function resolveKimiEndpoint(baseUrl, endpointPath) {
  const rawPath = String(endpointPath || "").trim();
  if (/^https?:\/\//i.test(rawPath)) {
    return rawPath;
  }
  const base = String(baseUrl || "https://api.moonshot.cn/v1").trim().replace(/\/+$/, "") + "/";
  const pathPart = String(rawPath || "chat/completions").trim().replace(/^\/+/, "");
  try {
    return new URL(pathPart, base).toString();
  } catch (_) {
    return base + pathPart;
  }
}

/** Return one filesystem-safe chat ID. */
function sanitizeChatId(chatId) {
  return String(chatId || "").replace(/[^a-zA-Z0-9_-]/g, "");
}

/** Provide chat session storage and Kimi 2.6 SSE streaming for the left Agent panel. */
class AgentChatService {
  constructor(options) {
    const settings = options || {};
    this.readConfig = settings.readConfig || function readEmptyConfig() { return {}; };
    this.writeLog = settings.writeLog || function noopLog() {};
    this.storageDirectory = settings.storageDirectory || "D:/自动组货/cache";
    this.chatsDirectory = path.join(this.storageDirectory, "agent", "chats");
    this.attachmentsDirectory = path.join(this.storageDirectory, "agent", "attachments");
    this.activeStreams = Object.create(null);

    this.ensureDirectories();
  }

  /** Ensure required storage directories exist on disk. */
  ensureDirectories() {
    try {
      fs.mkdirSync(this.chatsDirectory, { recursive: true });
      fs.mkdirSync(this.attachmentsDirectory, { recursive: true });
    } catch (error) {
      console.warn("[agent-chat] 创建 Agent 存储目录失败：", error.message);
    }
  }

  /** Return the JSON file path for one chat ID. */
  getChatFilePath(chatId) {
    const safeId = sanitizeChatId(chatId);
    return path.join(this.chatsDirectory, safeId + ".json");
  }

  /** Return the chats index file path. */
  getIndexFilePath() {
    return path.join(this.chatsDirectory, "chats-index.json");
  }

  /** Read the list of all chat sessions. */
  listChats() {
    this.ensureDirectories();
    const indexPath = this.getIndexFilePath();
    if (!fs.existsSync(indexPath)) {
      return [];
    }
    try {
      const raw = fs.readFileSync(indexPath, "utf8");
      const list = JSON.parse(raw);
      if (!Array.isArray(list)) return [];
      const seen = new Set();
      const deduped = [];
      for (const item of list) {
        if (item && item.id && !seen.has(item.id)) {
          seen.add(item.id);
          deduped.push(item);
        }
      }
      return deduped;
    } catch (error) {
      return [];
    }
  }

  /** Persist the list of chat sessions. */
  saveChatsIndex(list) {
    this.ensureDirectories();
    const indexPath = this.getIndexFilePath();
    try {
      fs.writeFileSync(indexPath, JSON.stringify(list, null, 2), "utf8");
    } catch (error) {
      console.warn("[agent-chat] 写入会话索引失败：", error.message);
    }
  }

  /** Create a new chat session. */
  createChat(title) {
    this.ensureDirectories();
    const id = "chat_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
    const chat = {
      id: id,
      title: String(title || "新对话").trim().slice(0, 50) || "新对话",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      messages: []
    };
    this.saveChat(chat);
    return chat;
  }

  /** Read one chat session by ID. */
  getChat(chatId) {
    const filePath = this.getChatFilePath(chatId);
    if (!fs.existsSync(filePath)) {
      return null;
    }
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      return JSON.parse(raw);
    } catch (error) {
      return null;
    }
  }

  /** Save one chat session to disk. */
  saveChat(chat) {
    if (!chat || !chat.id) {
      throw new Error("缺少有效的会话对象。");
    }
    this.ensureDirectories();
    chat.updated_at = new Date().toISOString();
    const filePath = this.getChatFilePath(chat.id);
    fs.writeFileSync(filePath, JSON.stringify(chat, null, 2), "utf8");

    const indexList = this.listChats();
    const target = indexList.find(function match(item) { return item.id === chat.id; });
    if (target) {
      target.title = chat.title;
      target.updated_at = chat.updated_at;
      target.message_count = Array.isArray(chat.messages) ? chat.messages.length : 0;
    } else {
      indexList.unshift({
        id: chat.id,
        title: chat.title,
        created_at: chat.created_at || chat.updated_at,
        updated_at: chat.updated_at,
        message_count: Array.isArray(chat.messages) ? chat.messages.length : 0
      });
    }
    this.saveChatsIndex(indexList);
  }

  /** Delete one chat session and clean up its stored attachments. */
  deleteChat(chatId) {
    const chat = this.getChat(chatId);
    if (chat && Array.isArray(chat.messages)) {
      for (const msg of chat.messages) {
        if (Array.isArray(msg.attachments)) {
          for (const att of msg.attachments) {
            const fileName = att.stored_filename || (att.file_path ? path.basename(att.file_path) : "");
            if (fileName) {
              const fullPath = path.join(this.attachmentsDirectory, fileName);
              if (fs.existsSync(fullPath)) {
                try {
                  fs.unlinkSync(fullPath);
                } catch (_) {}
              }
            }
          }
        }
      }
    }

    const filePath = this.getChatFilePath(chatId);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    const indexList = this.listChats().filter(function keep(item) {
      return item.id !== chatId;
    });
    this.saveChatsIndex(indexList);
    return true;
  }

  /** Save an uploaded attachment to disk, extracting document text when applicable. */
  saveAttachment(chatId, filename, buffer, mimeType) {
    const chat = this.getChat(chatId);
    if (!chat) {
      const error = new Error("会话不存在。");
      error.statusCode = 404;
      error.code = "CHAT_NOT_FOUND";
      throw error;
    }
    this.ensureDirectories();
    const ext = (path.extname(filename || "") || ".bin").toLowerCase();
    const attachmentId = "att_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
    const targetName = attachmentId + ext;
    const targetPath = path.join(this.attachmentsDirectory, targetName);
    fs.writeFileSync(targetPath, buffer);

    let extractedText = "";
    let isImage = false;

    if (ext === ".docx") {
      extractedText = extractDocxText(buffer);
    } else if (ext === ".txt" || ext === ".md" || ext === ".json" || ext === ".csv") {
      try {
        extractedText = buffer.toString("utf8");
      } catch (_) {
        extractedText = "";
      }
    } else if (ext === ".png" || ext === ".jpg" || ext === ".jpeg" || ext === ".webp") {
      isImage = true;
    }

    const maxTextLen = 8000;
    const boundedText = extractedText.length > maxTextLen ? extractedText.slice(0, maxTextLen) : extractedText;

    return {
      id: attachmentId,
      chat_id: chat.id,
      filename: filename || targetName,
      stored_filename: targetName,
      file_path: targetPath,
      url: "/api/v1/agent/attachments/" + encodeURIComponent(targetName),
      mime_type: mimeType || "application/octet-stream",
      size: buffer.length,
      is_image: isImage,
      extracted_text: boundedText,
      created_at: new Date().toISOString()
    };
  }

  /** Stream response from Kimi 2.6 using SSE directly into HTTP response. */
  async streamKimiChat(chatId, userMessage, res, requestId) {
    const chat = this.getChat(chatId);
    if (!chat) {
      const error = new Error("指定会话不存在 [404]");
      error.statusCode = 404;
      error.code = "CHAT_NOT_FOUND";
      throw error;
    }

    const config = this.readConfig() || {};
    const kimi = config.kimi && typeof config.kimi === "object" ? config.kimi : {};
    const endpoint = resolveKimiEndpoint(kimi.baseurl, kimi.endpoint);
    const apiKey = String(kimi.apikey || "");
    const model = String(kimi.model || "kimi-k2.6");
    const timeoutMs = Math.max(10000, Math.min(Number(kimi.timeout_ms || 60000), 180000));

    if (!apiKey) {
      throw new Error("server/config.json 未配置 Kimi API Key。");
    }

    const userMsgObj = {
      id: "msg_" + Date.now().toString(36) + "_u",
      role: "user",
      content: userMessage.content || "",
      attachments: Array.isArray(userMessage.attachments) ? userMessage.attachments : [],
      created_at: new Date().toISOString()
    };
    chat.messages.push(userMsgObj);

    if (chat.title === "新对话" && userMsgObj.content) {
      chat.title = userMsgObj.content.slice(0, 24).trim() || "新对话";
    }
    this.saveChat(chat);

    const systemPrompt = "你是一个专业的跨境电商图片设计与分镜编排 Agent。你可以读取用户提供的商品文档正文、参考图片和对话历史，帮助用户分析商品卖点、提炼视觉概念、生成可落地的电商生图提示词。回答清晰、结构分明、专业可执行，默认使用中文。";
    const messages = [{ role: "system", content: systemPrompt }];

    const historyLimit = 20;
    const historyMessages = (chat.messages || []).slice(-historyLimit);

    for (const msg of historyMessages) {
      if (msg.role === "user") {
        const parts = [];
        if (Array.isArray(msg.attachments) && msg.attachments.length) {
          for (const att of msg.attachments) {
            if (att.extracted_text) {
              parts.push({
                type: "text",
                text: "[参考文档：" + (att.filename || "文档") + "]\n" + att.extracted_text.slice(0, 8000) + "\n[文档结束]"
              });
            }
            if (att.is_image && att.file_path && fs.existsSync(att.file_path)) {
              try {
                const imgBuf = fs.readFileSync(att.file_path);
                const mime = att.mime_type || "image/jpeg";
                parts.push({
                  type: "image_url",
                  image_url: { url: "data:" + mime + ";base64," + imgBuf.toString("base64") }
                });
              } catch (_) {}
            }
          }
        }
        if (msg.content) {
          parts.push({ type: "text", text: msg.content });
        }
        if (parts.length === 1 && parts[0].type === "text") {
          messages.push({ role: "user", content: parts[0].text });
        } else if (parts.length > 0) {
          messages.push({ role: "user", content: parts });
        }
      } else if (msg.role === "assistant") {
        messages.push({ role: "assistant", content: msg.content || "" });
      }
    }

    const requestPayload = {
      model: model,
      messages: messages,
      temperature: typeof kimi.temperature === "number" ? kimi.temperature : 1,
      stream: true
    };

    this.writeLog("OUTBOUND", "Kimi Agent chat POST " + endpoint, requestPayload, requestId);

    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    function sendEvent(eventName, data) {
      res.write("event: " + eventName + "\ndata: " + JSON.stringify(data) + "\n\n");
    }

    const assistantMsgObj = {
      id: "msg_" + Date.now().toString(36) + "_a",
      role: "assistant",
      content: "",
      created_at: new Date().toISOString(),
      status: "streaming"
    };

    sendEvent("message_start", {
      chat_id: chat.id,
      message_id: assistantMsgObj.id,
      role: "assistant"
    });

    const abortController = new AbortController();
    this.activeStreams[chat.id] = abortController;

    let timeoutFired = false;
    const timeoutHandle = setTimeout(function handleKimiTimeout() {
      timeoutFired = true;
      abortController.abort();
    }, timeoutMs);

    res.on("close", () => {
      clearTimeout(timeoutHandle);
      abortController.abort();
      delete this.activeStreams[chat.id];
    });

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + apiKey,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(requestPayload),
        signal: abortController.signal
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error("Kimi 响应错误 [" + response.status + "]: " + errorText.slice(0, 200));
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pendingText = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        pendingText += decoder.decode(value || new Uint8Array(), { stream: true });
        const lines = pendingText.split(/\r?\n/);
        pendingText = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) {
            continue;
          }
          const dataStr = trimmed.slice(5).trim();
          if (dataStr === "[DONE]") {
            continue;
          }
          try {
            const parsed = JSON.parse(dataStr);
            const delta = parsed.choices && parsed.choices[0] && parsed.choices[0].delta ? parsed.choices[0].delta : {};
            const chunkText = delta.content || "";
            if (chunkText) {
              assistantMsgObj.content += chunkText;
              sendEvent("delta", { delta: chunkText });
            }
          } catch (_) {
          }
        }
      }

      clearTimeout(timeoutHandle);
      assistantMsgObj.status = "completed";
      sendEvent("message_done", {
        content: assistantMsgObj.content,
        status: "completed"
      });
    } catch (error) {
      clearTimeout(timeoutHandle);
      const isAborted = error.name === "AbortError" || abortController.signal.aborted;
      assistantMsgObj.status = timeoutFired ? "timeout" : isAborted ? "aborted" : "failed";
      assistantMsgObj.error = timeoutFired ? "Kimi 请求超时，请检查网络或重试。" : isAborted ? "流式已中断" : error.message;

      sendEvent("error", {
        message: assistantMsgObj.error,
        status: assistantMsgObj.status
      });
    } finally {
      clearTimeout(timeoutHandle);
      delete this.activeStreams[chat.id];
      chat.messages.push(assistantMsgObj);
      this.saveChat(chat);
      res.end();
    }
  }
}

module.exports = {
  AgentChatService: AgentChatService,
  resolveKimiEndpoint: resolveKimiEndpoint
};
