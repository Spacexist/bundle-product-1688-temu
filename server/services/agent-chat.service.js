const fs = require("fs");
const path = require("path");

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
      return Array.isArray(list) ? list : [];
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

    const indexList = this.listChats();
    indexList.unshift({
      id: chat.id,
      title: chat.title,
      created_at: chat.created_at,
      updated_at: chat.updated_at,
      message_count: 0
    });
    this.saveChatsIndex(indexList);
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
      return;
    }
    this.ensureDirectories();
    chat.updated_at = new Date().toISOString();
    const filePath = this.getChatFilePath(chat.id);
    try {
      fs.writeFileSync(filePath, JSON.stringify(chat, null, 2), "utf8");
    } catch (error) {
      console.warn("[agent-chat] 保存会话失败：", error.message);
    }

    const indexList = this.listChats();
    const target = indexList.find(function match(item) { return item.id === chat.id; });
    if (target) {
      target.title = chat.title;
      target.updated_at = chat.updated_at;
      target.message_count = Array.isArray(chat.messages) ? chat.messages.length : 0;
      this.saveChatsIndex(indexList);
    }
  }

  /** Delete one chat session. */
  deleteChat(chatId) {
    const filePath = this.getChatFilePath(chatId);
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (error) {
      console.warn("[agent-chat] 删除会话文件失败：", error.message);
    }
    const indexList = this.listChats().filter(function keep(item) {
      return item.id !== chatId;
    });
    this.saveChatsIndex(indexList);
    return true;
  }

  /** Save an uploaded attachment to disk. */
  saveAttachment(filename, buffer, mimeType) {
    this.ensureDirectories();
    const ext = path.extname(filename || "") || ".bin";
    const attachmentId = "att_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
    const targetName = attachmentId + ext;
    const targetPath = path.join(this.attachmentsDirectory, targetName);
    fs.writeFileSync(targetPath, buffer);
    return {
      id: attachmentId,
      filename: filename || targetName,
      file_path: targetPath,
      url: "/api/v1/agent/attachments/" + encodeURIComponent(targetName),
      mime_type: mimeType || "application/octet-stream",
      size: buffer.length,
      created_at: new Date().toISOString()
    };
  }

  /** Stream response from Kimi 2.6 using SSE directly into HTTP response. */
  async streamKimiChat(chatId, userMessage, res, requestId) {
    let chat = this.getChat(chatId);
    if (!chat) {
      chat = this.createChat("新对话");
    }

    const config = this.readConfig() || {};
    const kimi = config.kimi && typeof config.kimi === "object" ? config.kimi : {};
    const baseUrl = String(kimi.baseurl || "https://api.moonshot.cn/v1").replace(/\/$/, "");
    const endpoint = baseUrl + (kimi.endpoint || "/chat/completions");
    const apiKey = String(kimi.apikey || "");
    const model = String(kimi.model || "kimi-k2.6");

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

    const systemPrompt = "你是一个专业的跨境电商图片设计与分镜编排 Agent。你可以读取用户提供的文档、图片说明和当前对话历史，帮助用户分析商品卖点、提炼视觉概念、生成可落地的电商生图提示词。回答清晰、结构分明、专业可执行，默认使用中文。";
    const messages = [{ role: "system", content: systemPrompt }];

    for (const msg of chat.messages) {
      if (msg.role === "user") {
        let textContent = msg.content || "";
        if (Array.isArray(msg.attachments) && msg.attachments.length) {
          const fileInfo = msg.attachments.map(function mapAtt(att) {
            return "[附件：" + (att.filename || "文件") + "]";
          }).join(" ");
          textContent = (fileInfo + "\n" + textContent).trim();
        }
        messages.push({ role: "user", content: textContent });
      } else if (msg.role === "assistant") {
        messages.push({ role: "assistant", content: msg.content || "" });
      }
    }

    const requestPayload = {
      model: model,
      messages: messages,
      temperature: 0.6,
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

    res.on("close", () => {
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

      assistantMsgObj.status = "completed";
      sendEvent("message_done", {
        content: assistantMsgObj.content,
        status: "completed"
      });
    } catch (error) {
      const isAborted = error.name === "AbortError" || abortController.signal.aborted;
      assistantMsgObj.status = isAborted ? "aborted" : "failed";
      assistantMsgObj.error = error.message;

      sendEvent("error", {
        message: isAborted ? "流式已中断" : error.message,
        status: assistantMsgObj.status
      });
    } finally {
      delete this.activeStreams[chat.id];
      chat.messages.push(assistantMsgObj);
      this.saveChat(chat);
      res.end();
    }
  }
}

module.exports = {
  AgentChatService: AgentChatService
};
