const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const { AgentChatService, resolveKimiEndpoint, buildKimiChatMessages } = require("../services/agent-chat.service");

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

test("AgentChatService can extract text from text attachments and requires existing chat", () => {
  const testDir = path.join(__dirname, "test-agent-cache");
  fs.mkdirSync(testDir, { recursive: true });

  const service = new AgentChatService({
    storageDirectory: testDir,
    readConfig: () => ({ kimi: { apikey: "dummy" } })
  });

  const chat = service.createChat("测试附件会话");
  const textBuffer = Buffer.from("这是跨境电商商品设计需求说明", "utf8");
  const attachment = service.saveAttachment(chat.id, "requirements.txt", textBuffer, "text/plain");

  assert.equal(attachment.chat_id, chat.id);
  assert.equal(attachment.extracted_text, "这是跨境电商商品设计需求说明");
  assert.equal(attachment.is_image, false);

  assert.throws(() => {
    service.saveAttachment("non_existent_chat", "file.txt", textBuffer, "text/plain");
  }, /会话不存在/);

  service.deleteChat(chat.id);
  fs.rmSync(testDir, { recursive: true, force: true });
});

test("resolveKimiEndpoint correctly resolves various relative and absolute URLs without dropping base path", () => {
  // 1. 标准相对路径
  assert.equal(
    resolveKimiEndpoint("https://api.moonshot.cn/v1", "chat/completions"),
    "https://api.moonshot.cn/v1/chat/completions"
  );
  // 2. 带斜杠的相对路径（核心防护：不能把 /v1 吃掉）
  assert.equal(
    resolveKimiEndpoint("https://api.moonshot.cn/v1", "/chat/completions"),
    "https://api.moonshot.cn/v1/chat/completions"
  );
  // 3. base 末尾带斜杠
  assert.equal(
    resolveKimiEndpoint("https://api.moonshot.cn/v1/", "/chat/completions"),
    "https://api.moonshot.cn/v1/chat/completions"
  );
  // 4. 完整的第三方代理绝对 URL
  assert.equal(
    resolveKimiEndpoint("https://api.moonshot.cn/v1", "https://proxy.example.com/v1/chat/completions"),
    "https://proxy.example.com/v1/chat/completions"
  );
  // 5. 默认回退
  assert.equal(
    resolveKimiEndpoint(null, null),
    "https://api.moonshot.cn/v1/chat/completions"
  );
});

test("streamKimiChat throws 404 CHAT_NOT_FOUND when chat does not exist", async () => {
  const testDir = path.join(__dirname, "test-agent-cache-stream");
  fs.mkdirSync(testDir, { recursive: true });

  const service = new AgentChatService({
    storageDirectory: testDir,
    readConfig: () => ({ kimi: { apikey: "dummy" } })
  });

  await assert.rejects(
    async () => {
      await service.streamKimiChat("non_existent_chat_id", { content: "hello" }, {});
    },
    (err) => {
      assert.equal(err.statusCode, 404);
      assert.equal(err.code, "CHAT_NOT_FOUND");
      return true;
    }
  );

  fs.rmSync(testDir, { recursive: true, force: true });
});

test("deleteChat physically unlinks referenced attachment files from disk", () => {
  const testDir = path.join(__dirname, "test-agent-cache-delete");
  fs.mkdirSync(testDir, { recursive: true });

  const service = new AgentChatService({
    storageDirectory: testDir,
    readConfig: () => ({ kimi: { apikey: "dummy" } })
  });

  const chat = service.createChat("测试附件清理");
  const dummyData = Buffer.from("image or doc content", "utf8");
  const attachment = service.saveAttachment(chat.id, "sample.txt", dummyData, "text/plain");

  const attachedFilePath = path.join(service.attachmentsDirectory, attachment.stored_filename);
  assert.ok(fs.existsSync(attachedFilePath), "附件文件必须先成功写入磁盘");

  // 将附件引用挂载到会话消息中
  chat.messages.push({
    id: "msg_1",
    role: "user",
    content: "带附件的消息",
    attachments: [attachment]
  });
  service.saveChat(chat);

  // 删除会话
  service.deleteChat(chat.id);

  // 校验：会话被删除，且磁盘上的物理附件也被同步删除
  assert.equal(service.getChat(chat.id), null);
  assert.ok(!fs.existsSync(attachedFilePath), "会话删除后，磁盘上的关联附件文件应被清理");

  fs.rmSync(testDir, { recursive: true, force: true });
});

test("AgentChatService reads server/sop.json with recognize and storyboard steps", () => {
  const testDir = path.join(__dirname, "test-agent-cache-sop");
  fs.mkdirSync(testDir, { recursive: true });
  const service = new AgentChatService({
    storageDirectory: testDir,
    readConfig: () => ({ kimi: { apikey: "dummy" } })
  });
  const sop = service.getSop();
  assert.equal(sop.id, "temu-suite");
  assert.ok(Array.isArray(sop.steps));
  assert.equal(sop.steps.length, 2);
  assert.equal(sop.steps[0].id, "recognize");
  assert.equal(sop.steps[1].id, "storyboard");
  assert.ok(sop.steps[0].instruction.length > 10);
  assert.ok(sop.steps[1].instruction.indexOf("```json") >= 0);
  fs.rmSync(testDir, { recursive: true, force: true });
});

test("buildKimiChatMessages skips empty assistant turns that would 400 Moonshot", () => {
  const built = buildKimiChatMessages([
    { role: "user", content: "请写识别报告" },
    { role: "assistant", content: "", status: "failed", error: "terminated" },
    { role: "user", content: "请写识别报告" }
  ], "system");
  assert.equal(built[0].role, "system");
  assert.equal(built.length, 3);
  assert.equal(built[1].role, "user");
  assert.equal(built[2].role, "user");
  assert.ok(built.every(function noEmptyAssistant(msg) {
    return msg.role !== "assistant" || String(msg.content || "").trim().length > 0;
  }));
});
