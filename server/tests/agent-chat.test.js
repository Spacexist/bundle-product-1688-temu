const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const { AgentChatService } = require("../services/agent-chat.service");

test("AgentChatService can create, list, and delete chat sessions", () => {
  const testDir = path.join(__dirname, "test-agent-cache");
  fs.mkdirSync(testDir, { recursive: true });

  const service = new AgentChatService({
    storageDirectory: testDir,
    readConfig: () => ({ kimi: { apikey: "dummy" } })
  });

  const chat = service.createChat("测试会话 1");
  assert.ok(chat.id);
  assert.equal(chat.title, "测试会话 1");

  const list = service.listChats();
  assert.ok(list.length >= 1);
  assert.equal(list[0].id, chat.id);

  const fetched = service.getChat(chat.id);
  assert.equal(fetched.id, chat.id);

  service.deleteChat(chat.id);
  assert.equal(service.getChat(chat.id), null);

  fs.rmSync(testDir, { recursive: true, force: true });
});
