const fs = require("fs");
const path = require("path");

/** Controller for Agent chat session management and streaming endpoints. */
class AgentChatController {
  constructor(options) {
    const settings = options || {};
    this.agentService = settings.agentService;
  }

  /** GET /api/v1/agent/chats - List all sessions. */
  listChats(req, res, next) {
    try {
      const chats = this.agentService.listChats();
      res.json({ ok: true, data: { chats: chats }, error: null, meta: { request_id: req.requestId } });
    } catch (error) {
      next(error);
    }
  }

  /** POST /api/v1/agent/chats - Create a new session. */
  createChat(req, res, next) {
    try {
      const title = req.body && req.body.title;
      const chat = this.agentService.createChat(title);
      res.status(201).json({ ok: true, data: { chat: chat }, error: null, meta: { request_id: req.requestId } });
    } catch (error) {
      next(error);
    }
  }

  /** GET /api/v1/agent/chats/:chatId - Get one session with messages. */
  getChat(req, res, next) {
    try {
      const chatId = req.params.chatId;
      const chat = this.agentService.getChat(chatId);
      if (!chat) {
        return res.status(404).json({
          ok: false,
          data: null,
          error: { code: "CHAT_NOT_FOUND", message: "会话不存在。" },
          meta: { request_id: req.requestId }
        });
      }
      res.json({ ok: true, data: { chat: chat }, error: null, meta: { request_id: req.requestId } });
    } catch (error) {
      next(error);
    }
  }

  /** DELETE /api/v1/agent/chats/:chatId - Delete one session. */
  deleteChat(req, res, next) {
    try {
      const chatId = req.params.chatId;
      this.agentService.deleteChat(chatId);
      res.json({ ok: true, data: { deleted: true }, error: null, meta: { request_id: req.requestId } });
    } catch (error) {
      next(error);
    }
  }

  /** POST /api/v1/agent/chats/:chatId/attachments - Upload attachment. */
  uploadAttachment(req, res, next) {
    try {
      const filename = req.headers["x-filename"] ? decodeURIComponent(req.headers["x-filename"]) : "upload.bin";
      const mimeType = req.headers["content-type"] || "application/octet-stream";
      let buffer = req.body;
      if (!Buffer.isBuffer(buffer)) {
        if (typeof buffer === "object" && buffer !== null) {
          buffer = Buffer.from(JSON.stringify(buffer));
        } else if (typeof buffer === "string") {
          buffer = Buffer.from(buffer, "utf8");
        }
      }

      if (!Buffer.isBuffer(buffer) || !buffer.length) {
        return res.status(400).json({
          ok: false,
          data: null,
          error: { code: "EMPTY_FILE", message: "上传内容不能为空。" },
          meta: { request_id: req.requestId }
        });
      }

      const chatId = req.params.chatId;
      const attachment = this.agentService.saveAttachment(chatId, filename, buffer, mimeType);
      res.status(201).json({ ok: true, data: { attachment: attachment }, error: null, meta: { request_id: req.requestId } });
    } catch (error) {
      if (error && error.statusCode === 404) {
        return res.status(404).json({
          ok: false,
          data: null,
          error: { code: "CHAT_NOT_FOUND", message: "会话不存在，无法上传附件。" },
          meta: { request_id: req.requestId }
        });
      }
      next(error);
    }
  }

  /** Serve static uploaded attachments. */
  serveAttachment(req, res, next) {
    try {
      const filename = path.basename(req.params.filename);
      const filePath = path.join(this.agentService.attachmentsDirectory, filename);
      if (!fs.existsSync(filePath)) {
        return res.status(404).send("Attachment not found");
      }
      res.sendFile(filePath);
    } catch (error) {
      next(error);
    }
  }

  /** POST /api/v1/agent/chats/:chatId/messages/stream - SSE chat stream. */
  async streamMessage(req, res, next) {
    try {
      const chatId = req.params.chatId;
      const userMessage = req.body || {};
      await this.agentService.streamKimiChat(chatId, userMessage, res, req.requestId);
    } catch (error) {
      if (res.headersSent) {
        try {
          if (!res.writableEnded && !res.destroyed) {
            res.write("event: error\ndata: " + JSON.stringify({
              message: String(error && error.message || "流式失败"),
              status: "failed"
            }) + "\n\n");
            res.end();
          }
        } catch (_) {}
        return;
      }
      next(error);
    }
  }
}

module.exports = {
  AgentChatController: AgentChatController
};
