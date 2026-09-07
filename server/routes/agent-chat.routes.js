const express = require("express");

/** Build Agent chat API routes. */
function createAgentChatRouter(options) {
  const settings = options || {};
  const controller = settings.agentController;
  const router = express.Router();

  router.get("/agent/chats", controller.listChats.bind(controller));
  router.post("/agent/chats", controller.createChat.bind(controller));
  router.get("/agent/chats/:chatId", controller.getChat.bind(controller));
  router.delete("/agent/chats/:chatId", controller.deleteChat.bind(controller));

  router.post("/agent/chats/:chatId/attachments", express.raw({ type: "*/*", limit: "50mb" }), controller.uploadAttachment.bind(controller));
  router.get("/agent/attachments/:filename", controller.serveAttachment.bind(controller));

  router.post("/agent/chats/:chatId/messages/stream", controller.streamMessage.bind(controller));

  return router;
}

module.exports = {
  createAgentChatRouter: createAgentChatRouter
};
