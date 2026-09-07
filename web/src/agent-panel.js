/**
 * Left Agent Chat Bot Component
 * High quality glass drawer, Kimi 2.6 SSE streaming, document text awareness, and chat persistence.
 */
(function initAgentPanel() {
  function getApiBase() {
    const config = window.APP_CONFIG || {};
    return String(config.apiBaseUrl || "http://127.0.0.1:3000/api/v1").replace(/\/$/, "");
  }

  const AgentPanelComponent = {
    name: "AgentPanelComponent",
    props: {
      modelValue: { type: Boolean, default: false }
    },
    emits: ["update:modelValue"],
    data: function data() {
      return {
        chats: [],
        activeChatId: "",
        activeChat: null,
        draftText: "",
        attachments: [],
        isUploading: false,
        isStreaming: false,
        panelError: "",
        abortController: null
      };
    },
    template: `
      <transition name="agent-sheet">
        <aside
          v-show="modelValue"
          class="panel workspace-agent-panel"
          role="complementary"
          aria-label="设计 Agent"
        >
        <header class="agent-panel-header">
          <div class="panel-title agent-header-title">
            <span class="agent-spark-icon">✦</span>
            <span>设计 Agent</span>
            <span class="count agent-model-badge">Kimi 2.6</span>
          </div>
          <div class="agent-header-actions">
            <button class="glass-action-button ghost-button" type="button" title="新建会话" :disabled="isStreaming" @click="handleCreateChat">＋ 新建</button>
            <button v-if="activeChatId" class="glass-action-button ghost-button" type="button" title="清空当前会话" :disabled="isStreaming" @click="handleDeleteCurrentChat">清空</button>
            <button class="glass-action-button ghost-button agent-close-btn" type="button" title="关闭面板 (快捷键 C)" aria-label="关闭面板" @click="closePanel">×</button>
          </div>
        </header>

        <div v-if="chats.length" class="agent-chat-list-bar">
          <button
            v-for="c in chats"
            :key="c.id"
            class="glass-action-button tab-button"
            :class="{ active: c.id === activeChatId }"
            type="button"
            :title="c.title"
            :disabled="isStreaming"
            @click="selectChat(c.id)"
          >
            {{ c.title || '新对话' }}
          </button>
        </div>

        <section class="agent-messages-container" ref="messagesContainer">
          <div v-if="panelError" class="status error agent-alert-banner">
            <span>{{ panelError }}</span>
            <button class="glass-action-button" type="button" @click="panelError = ''">×</button>
          </div>

          <div v-if="!activeChat || !activeChat.messages || !activeChat.messages.length" class="agent-empty-tip">
            <div class="brand-mark agent-brand-mark">✦</div>
            <strong class="panel-title">跨境电商图片设计助手</strong>
            <p>可直接输入需求，或把 Word 文档（.docx）、参考图拖入下方。Agent 会深度解析文档正文与视觉要素，为您梳理专业生图提示词。</p>
          </div>

          <div
            v-for="msg in (activeChat ? activeChat.messages : [])"
            :key="msg.id"
            class="agent-message-card"
            :class="msg.role"
          >
            <div v-if="msg.attachments && msg.attachments.length" class="agent-message-attachments">
              <span v-for="att in msg.attachments" :key="att.id" class="platform-label agent-att-badge" :title="att.is_image ? '图片素材' : (att.extracted_text ? '文档正文已读入' : '普通文件')">
                {{ att.is_image ? '图片' : '文档' }} · {{ att.filename }}
                <small v-if="att.extracted_text" class="count">(已读入)</small>
              </span>
            </div>
            <div class="agent-message-text">{{ msg.content }}</div>
            <div v-if="msg.status === 'streaming'" class="agent-streaming-indicator">
              <span class="agent-dot-flashing"></span>
              <small>思考生成中…</small>
            </div>
            <div v-if="msg.status === 'timeout'" class="status error">[请求超时，请重试]</div>
            <div v-if="msg.status === 'aborted'" class="status">[流式已停止]</div>
            <div v-if="msg.status === 'failed'" class="status error">[{{ msg.error || '生成失败' }}]</div>
          </div>
        </section>

        <footer class="agent-composer-container" @dragover.prevent @drop.prevent="handleFileDrop">
          <div v-if="attachments.length" class="agent-pending-attachments">
            <div v-for="(att, idx) in attachments" :key="att.id" class="platform-label agent-pending-item">
              <span>{{ att.is_image ? '图片' : '文档' }} · {{ att.filename }}</span>
              <small v-if="att.extracted_text" class="count">正文已读取</small>
              <button class="listing-card-delete agent-remove-btn" type="button" @click="removeAttachment(idx)">×</button>
            </div>
          </div>

          <textarea
            class="agent-input-box"
            v-model="draftText"
            placeholder="输入设计需求、生图方向，或直接拖入 Word 文档/图片..."
            @keydown.enter.exact.prevent="submitMessage"
          ></textarea>

          <div class="agent-composer-footer">
            <span class="count">支持拖入 docx、txt 或商品图</span>
            <div class="agent-composer-actions">
              <button
                v-if="isStreaming"
                class="glass-action-button ghost-button agent-stop-btn"
                type="button"
                @click="stopGeneration"
              >
                停止生成
              </button>
              <button
                v-else
                class="glass-action-button primary-button agent-send-btn"
                type="button"
                :disabled="isUploading || (!draftText.trim() && !attachments.length)"
                @click="submitMessage"
              >
                {{ isUploading ? '上传中…' : '发送' }}
              </button>
            </div>
          </div>
        </footer>
      </aside>
    </transition>
    `,
    mounted: function onAgentMounted() {
      this.fetchChats();
      window.addEventListener("keydown", this.handleGlobalKeyDown);
    },
    beforeUnmount: function onAgentUnmount() {
      window.removeEventListener("keydown", this.handleGlobalKeyDown);
    },
    methods: {
      handleGlobalKeyDown: function handleGlobalKeyDown(event) {
        if (event.key === "c" || event.key === "C") {
          const activeEl = document.activeElement;
          const isInput = activeEl && (
            activeEl.tagName === "INPUT" ||
            activeEl.tagName === "TEXTAREA" ||
            activeEl.isContentEditable
          );
          if (!isInput && !event.ctrlKey && !event.metaKey && !event.altKey) {
            event.preventDefault();
            this.$emit("update:modelValue", !this.modelValue);
          }
        }
      },
      closePanel: function closePanel() {
        this.$emit("update:modelValue", false);
      },
      fetchChats: async function fetchChats() {
        try {
          const res = await fetch(getApiBase() + "/agent/chats");
          const payload = await res.json();
          if (res.ok && payload.ok && payload.data && Array.isArray(payload.data.chats)) {
            this.chats = payload.data.chats;
            if (this.chats.length && !this.activeChatId) {
              this.selectChat(this.chats[0].id);
            }
          } else {
            this.panelError = "读取会话列表失败：" + (payload && payload.error && payload.error.message || "未知错误");
          }
        } catch (error) {
          console.warn("[agent-panel] 读取会话失败：", error.message);
          this.panelError = "网络异常无法获取会话：" + error.message;
        }
      },
      handleCreateChat: async function handleCreateChat() {
        this.panelError = "";
        try {
          const res = await fetch(getApiBase() + "/agent/chats", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title: "新对话" })
          });
          const payload = await res.json();
          if (!res.ok || !payload.ok || !payload.data || !payload.data.chat) {
            throw new Error(payload && payload.error && payload.error.message || "新建会话失败");
          }
          const chat = payload.data.chat;
          this.chats.unshift({
            id: chat.id,
            title: chat.title,
            created_at: chat.created_at,
            updated_at: chat.updated_at,
            message_count: 0
          });
          this.activeChatId = chat.id;
          this.activeChat = chat;
          return chat;
        } catch (error) {
          this.panelError = "新建会话失败：" + error.message;
          return null;
        }
      },
      handleDeleteCurrentChat: async function handleDeleteCurrentChat() {
        if (!this.activeChatId || this.isStreaming) {
          return;
        }
        const targetId = this.activeChatId;
        try {
          const res = await fetch(getApiBase() + "/agent/chats/" + encodeURIComponent(targetId), {
            method: "DELETE"
          });
          if (res.ok) {
            this.chats = this.chats.filter(function keep(c) { return c.id !== targetId; });
            this.activeChatId = this.chats.length ? this.chats[0].id : "";
            this.activeChat = null;
            if (this.activeChatId) {
              this.selectChat(this.activeChatId);
            }
          }
        } catch (error) {
          this.panelError = "删除会话失败：" + error.message;
        }
      },
      selectChat: async function selectChat(chatId) {
        if (!chatId) {
          return;
        }
        this.activeChatId = chatId;
        try {
          const res = await fetch(getApiBase() + "/agent/chats/" + encodeURIComponent(chatId));
          const payload = await res.json();
          if (res.ok && payload.ok && payload.data && payload.data.chat) {
            this.activeChat = payload.data.chat;
            this.scrollToBottom();
          }
        } catch (error) {
          console.warn("[agent-panel] 读取单会话失败：", error.message);
        }
      },
      scrollToBottom: function scrollToBottom() {
        this.$nextTick(() => {
          const container = this.$refs.messagesContainer;
          if (container) {
            container.scrollTop = container.scrollHeight;
          }
        });
      },
      handleFileDrop: async function handleFileDrop(event) {
        const files = event.dataTransfer ? event.dataTransfer.files : [];
        if (!files || !files.length) {
          return;
        }
        if (!this.activeChatId) {
          const newChat = await this.handleCreateChat();
          if (!newChat || !newChat.id) {
            return;
          }
        }
        for (let i = 0; i < files.length; i += 1) {
          await this.uploadFile(files[i]);
        }
      },
      uploadFile: async function uploadFile(file) {
        if (!file || !this.activeChatId) {
          return;
        }
        this.isUploading = true;
        this.panelError = "";
        try {
          const endpoint = getApiBase() + "/agent/chats/" + encodeURIComponent(this.activeChatId) + "/attachments";
          const res = await fetch(endpoint, {
            method: "POST",
            headers: {
              "Content-Type": "application/octet-stream",
              "X-Filename": encodeURIComponent(file.name)
            },
            body: file
          });
          const payload = await res.json();
          if (res.ok && payload.ok && payload.data && payload.data.attachment) {
            this.attachments.push(payload.data.attachment);
          } else {
            throw new Error(payload && payload.error && payload.error.message || "上传附件失败");
          }
        } catch (error) {
          this.panelError = "附件上传异常：" + error.message;
        } finally {
          this.isUploading = false;
        }
      },
      removeAttachment: function removeAttachment(index) {
        this.attachments.splice(index, 1);
      },
      stopGeneration: function stopGeneration() {
        if (this.abortController) {
          this.abortController.abort();
          this.abortController = null;
        }
        this.isStreaming = false;
      },
      submitMessage: async function submitMessage() {
        const text = String(this.draftText || "").trim();
        if ((!text && !this.attachments.length) || this.isStreaming) {
          return;
        }
        this.panelError = "";

        // 必须确保有效会话 ID
        if (!this.activeChatId) {
          const created = await this.handleCreateChat();
          if (!created || !created.id) {
            this.panelError = "无法连接后端创建会话，请检查服务。";
            return;
          }
        }

        const userMsg = {
          role: "user",
          content: text,
          attachments: this.attachments.slice()
        };

        if (!this.activeChat) {
          this.activeChat = { id: this.activeChatId, title: "新对话", messages: [] };
        }

        this.activeChat.messages.push({
          id: "temp_u_" + Date.now(),
          role: "user",
          content: text,
          attachments: userMsg.attachments
        });

        this.draftText = "";
        this.attachments = [];
        this.scrollToBottom();

        const assistantMsg = {
          id: "temp_a_" + Date.now(),
          role: "assistant",
          content: "",
          status: "streaming"
        };
        this.activeChat.messages.push(assistantMsg);
        this.isStreaming = true;
        this.scrollToBottom();

        this.abortController = new AbortController();
        const self = this;

        const processSseBlock = function(blockText) {
          if (!blockText || !blockText.trim()) return;
          const lines = blockText.split("\n");
          let eventType = "";
          let dataStr = "";
          for (const line of lines) {
            if (line.startsWith("event:")) {
              eventType = line.slice(6).trim();
            } else if (line.startsWith("data:")) {
              dataStr = line.slice(5).trim();
            }
          }
          if (!dataStr) return;
          try {
            const data = JSON.parse(dataStr);
            if (eventType === "delta" && data.delta) {
              assistantMsg.content += data.delta;
              self.scrollToBottom();
            } else if (eventType === "message_done") {
              assistantMsg.status = "completed";
              if (data.content) {
                assistantMsg.content = data.content;
              }
            } else if (eventType === "error") {
              assistantMsg.status = data.status || "failed";
              assistantMsg.error = data.message;
            }
          } catch (_) {}
        };

        try {
          const endpoint = getApiBase() + "/agent/chats/" + encodeURIComponent(this.activeChatId) + "/messages/stream";
          const response = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(userMsg),
            signal: this.abortController.signal
          });

          if (!response.ok) {
            throw new Error("服务响应异常 [" + response.status + "]");
          }

          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";

          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              break;
            }
            buffer += decoder.decode(value || new Uint8Array(), { stream: true });
            const events = buffer.split("\n\n");
            buffer = events.pop() || "";

            for (const ev of events) {
              processSseBlock(ev);
            }
          }

          // 循环结束后，冲刷残余 buffer（Review Issue 10）
          if (buffer.trim()) {
            processSseBlock(buffer.trim());
            buffer = "";
          }

          if (assistantMsg.status === "streaming") {
            assistantMsg.status = "completed";
          }
        } catch (error) {
          if (error.name === "AbortError" || (this.abortController && this.abortController.signal.aborted)) {
            assistantMsg.status = "aborted";
          } else {
            assistantMsg.status = "failed";
            assistantMsg.error = error.message;
          }
        } finally {
          this.isStreaming = false;
          this.abortController = null;
          this.fetchChats();
          this.scrollToBottom();
        }
      }
    }
  };

  window.AgentPanelComponent = AgentPanelComponent;
})();
