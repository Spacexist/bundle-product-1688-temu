/**
 * Left Agent Chat Bot Component
 * Standalone module managing chat history, Kimi 2.6 SSE streaming, and drag-and-drop attachments.
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
    data: function createAgentData() {
      return {
        chats: [],
        activeChatId: "",
        activeChat: null,
        draftText: "",
        attachments: [],
        isUploading: false,
        isStreaming: false,
        streamError: ""
      };
    },
    template: 
      <aside class="workspace-agent-panel" :class="{ 'is-closed': !modelValue }">
        <header class="agent-panel-header">
          <div class="agent-panel-title">
            <span>设计 Agent</span>
            <span class="agent-badge">Kimi 2.6</span>
          </div>
          <div class="agent-panel-actions">
            <button class="agent-icon-btn" type="button" title="新建会话" @click="handleCreateChat">＋</button>
            <button class="agent-icon-btn" type="button" title="关闭面板 (C)" @click="closePanel">✕</button>
          </div>
        </header>

        <div v-if="chats.length" class="agent-chat-list-bar">
          <button
            v-for="c in chats"
            :key="c.id"
            class="agent-chat-pill"
            :class="{ active: c.id === activeChatId }"
            type="button"
            :title="c.title"
            @click="selectChat(c.id)"
          >
            {{ c.title || '新对话' }}
          </button>
        </div>

        <section class="agent-messages-container" ref="messagesContainer">
          <div v-if="!activeChat || !activeChat.messages || !activeChat.messages.length" class="agent-empty-tip" style="text-align: center; color: #64748b; margin-top: 40px; font-size: 13px;">
            <p>👋 你好！我是跨境电商图片设计助手。</p>
            <p style="margin-top: 6px; font-size: 12px;">支持拖入 Word 文档、图片或输入需求，帮你梳理提示词和视觉创意。</p>
          </div>

          <div
            v-for="msg in (activeChat ? activeChat.messages : [])"
            :key="msg.id"
            class="agent-message-card"
            :class="msg.role"
          >
            <div v-if="msg.attachments && msg.attachments.length" class="agent-message-attachments">
              <span v-for="att in msg.attachments" :key="att.id" class="agent-attachment-tag">
                📎 {{ att.filename }}
              </span>
            </div>
            <div class="agent-message-text" style="white-space: pre-wrap;">{{ msg.content }}</div>
            <div v-if="msg.status === 'aborted'" style="font-size: 11px; color: #f59e0b; margin-top: 4px;">[流式已中断]</div>
            <div v-if="msg.status === 'failed'" style="font-size: 11px; color: #ef4444; margin-top: 4px;">[{{ msg.error || '生成失败' }}]</div>
          </div>
        </section>

        <footer class="agent-composer-container" @dragover.prevent @drop.prevent="handleFileDrop">
          <div v-if="attachments.length" class="agent-pending-attachments">
            <div v-for="(att, idx) in attachments" :key="att.id" class="agent-pending-item">
              <span>📎 {{ att.filename }}</span>
              <button class="agent-pending-remove" type="button" @click="removeAttachment(idx)">✕</button>
            </div>
          </div>

          <textarea
            class="agent-input-box"
            v-model="draftText"
            placeholder="输入设计需求、Prompt 或拖入文档/图片..."
            @keydown.enter.exact.prevent="submitMessage"
          ></textarea>

          <div class="agent-composer-footer">
            <span class="agent-drop-hint">拖拽可添加图片或 Word 文档</span>
            <button
              class="agent-send-button"
              type="button"
              :disabled="isStreaming || isUploading || (!draftText.trim() && !attachments.length)"
              @click="submitMessage"
            >
              {{ isStreaming ? '生成中…' : '发送 (Enter)' }}
            </button>
          </div>
        </footer>
      </aside>
    ,
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
            this.("update:modelValue", !this.modelValue);
          }
        }
      },
      closePanel: function closePanel() {
        this.("update:modelValue", false);
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
          }
        } catch (_) {}
      },
      handleCreateChat: async function handleCreateChat() {
        try {
          const res = await fetch(getApiBase() + "/agent/chats", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title: "新对话" })
          });
          const payload = await res.json();
          if (res.ok && payload.ok && payload.data && payload.data.chat) {
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
          }
        } catch (_) {}
      },
      selectChat: async function selectChat(chatId) {
        this.activeChatId = chatId;
        try {
          const res = await fetch(getApiBase() + "/agent/chats/" + encodeURIComponent(chatId));
          const payload = await res.json();
          if (res.ok && payload.ok && payload.data && payload.data.chat) {
            this.activeChat = payload.data.chat;
            this.scrollToBottom();
          }
        } catch (_) {}
      },
      scrollToBottom: function scrollToBottom() {
        this.(() => {
          const container = this..messagesContainer;
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
          await this.handleCreateChat();
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
        try {
          const endpoint = getApiBase() + "/agent/chats/" + encodeURIComponent(this.activeChatId) + "/attachments";
          const res = await fetch(endpoint, {
            method: "POST",
            headers: {
              "Content-Type": file.type || "application/octet-stream",
              "X-Filename": encodeURIComponent(file.name)
            },
            body: file
          });
          const payload = await res.json();
          if (res.ok && payload.ok && payload.data && payload.data.attachment) {
            this.attachments.push(payload.data.attachment);
          }
        } catch (_) {
        } finally {
          this.isUploading = false;
        }
      },
      removeAttachment: function removeAttachment(index) {
        this.attachments.splice(index, 1);
      },
      submitMessage: async function submitMessage() {
        const text = String(this.draftText || "").trim();
        if ((!text && !this.attachments.length) || this.isStreaming) {
          return;
        }
        if (!this.activeChatId) {
          await this.handleCreateChat();
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

        try {
          const endpoint = getApiBase() + "/agent/chats/" + encodeURIComponent(this.activeChatId) + "/messages/stream";
          const response = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(userMsg)
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
              const lines = ev.split("\n");
              let eventType = "";
              let dataStr = "";
              for (const line of lines) {
                if (line.startsWith("event:")) {
                  eventType = line.slice(6).trim();
                } else if (line.startsWith("data:")) {
                  dataStr = line.slice(5).trim();
                }
              }
              if (!dataStr) {
                continue;
              }
              try {
                const data = JSON.parse(dataStr);
                if (eventType === "delta" && data.delta) {
                  assistantMsg.content += data.delta;
                  this.scrollToBottom();
                } else if (eventType === "message_done") {
                  assistantMsg.status = "completed";
                  if (data.content) {
                    assistantMsg.content = data.content;
                  }
                } else if (eventType === "error") {
                  assistantMsg.status = "failed";
                  assistantMsg.error = data.message;
                }
              } catch (_) {}
            }
          }
          if (assistantMsg.status === "streaming") {
            assistantMsg.status = "completed";
          }
        } catch (error) {
          assistantMsg.status = "failed";
          assistantMsg.error = error.message;
        } finally {
          this.isStreaming = false;
          this.fetchChats();
          this.scrollToBottom();
        }
      }
    }
  };

  window.AgentPanelComponent = AgentPanelComponent;
})();
