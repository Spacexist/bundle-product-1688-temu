/**
 * Left Agent Chat Bot Component
 * High quality glass drawer, Kimi 2.6 SSE streaming, document text awareness,
 * workspace-image drag-in, and chat persistence.
 */
(function initAgentPanel() {
  function getApiBase() {
    const config = window.APP_CONFIG || {};
    return String(config.apiBaseUrl || "http://127.0.0.1:3000/api/v1").replace(/\/$/, "");
  }

  /** Resolve an attachment or cache path against the configured API origin. */
  function resolveMediaUrl(url) {
    const source = String(url || "").trim();
    if (!source) {
      return "";
    }
    if (/^https?:\/\//i.test(source) || source.indexOf("data:") === 0 || source.indexOf("blob:") === 0) {
      return source;
    }
    try {
      return new URL(getApiBase()).origin + (source.charAt(0) === "/" ? source : "/" + source);
    } catch (_) {
      return source;
    }
  }

  /** Build a stable local id for pending upload / failure placeholders. */
  function createLocalId(prefix) {
    return String(prefix || "local") + "_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
  }

  /** Guess a downloadable image filename from a URL and MIME type. */
  function guessImageFilename(url, mimeType, fallbackName) {
    const raw = String(url || "");
    const named = String(fallbackName || "").trim();
    if (named && /\.(jpe?g|png|webp|gif)$/i.test(named)) {
      return named;
    }
    const extMatch = raw.match(/\.(jpe?g|png|webp|gif)(?:[?#]|$)/i);
    let ext = ".jpg";
    if (extMatch) {
      ext = "." + String(extMatch[1]).toLowerCase().replace("jpeg", "jpg");
    } else if (String(mimeType || "").indexOf("png") >= 0) {
      ext = ".png";
    } else if (String(mimeType || "").indexOf("webp") >= 0) {
      ext = ".webp";
    } else if (String(mimeType || "").indexOf("gif") >= 0) {
      ext = ".gif";
    }
    if (named) {
      return named.replace(/\.[^.]+$/, "") + ext;
    }
    return "workspace-image" + ext;
  }

  /** Read custom drag MIME types as a plain array. */
  function listDataTransferTypes(dataTransfer) {
    if (!dataTransfer || !dataTransfer.types) {
      return [];
    }
    try {
      return Array.prototype.slice.call(dataTransfer.types);
    } catch (_) {
      return [];
    }
  }

  /** Escape HTML so markdown rendering cannot inject scripts. */
  function escapeHtml(text) {
    return String(text || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /** Render a compact subset of markdown used by Agent replies. */
  function renderAgentMarkdown(text) {
    const escaped = escapeHtml(text);
    return escaped
      .replace(/^###\s+(.+)$/gm, "<strong class=\"agent-md-h3\">$1</strong>")
      .replace(/^##\s+(.+)$/gm, "<strong class=\"agent-md-h2\">$1</strong>")
      .replace(/^#\s+(.+)$/gm, "<strong class=\"agent-md-h1\">$1</strong>")
      .replace(/^---$/gm, "<hr class=\"agent-md-hr\">")
      .replace(/^&gt;\s+(.+)$/gm, "<blockquote class=\"agent-md-quote\">$1</blockquote>")
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`]+)`/g, "<code class=\"agent-md-code\">$1</code>")
      .replace(/\n/g, "<br>");
  }

  /** Return whether the current drag can be accepted by the Agent panel. */
  function isAgentAcceptableDrag(dataTransfer) {
    const types = listDataTransferTypes(dataTransfer);
    if (!types.length) {
      return false;
    }
    if (types.indexOf("application/x-agent-image") >= 0
      || types.indexOf("application/x-temu-1688-image") >= 0
      || types.indexOf("application/x-temu-image-reorder") >= 0
      || types.indexOf("Files") >= 0) {
      return true;
    }
    // Only treat plain text as droppable when it looks like an image URL.
    if (types.indexOf("text/plain") >= 0) {
      try {
        const plain = String(dataTransfer.getData("text/plain") || "").trim();
        return /^https?:\/\//i.test(plain) || plain.indexOf("/api/v1/") === 0;
      } catch (_) {
        return false;
      }
    }
    return false;
  }

  /** Parse one workspace image payload from a DataTransfer object. */
  function parseWorkspaceImagePayload(dataTransfer) {
    if (!dataTransfer) {
      return null;
    }
    const tryParse = function tryParse(raw) {
      const text = String(raw || "").trim();
      if (!text) {
        return null;
      }
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === "object") {
          const imageUrl = String(parsed.image_url || parsed.fetch_url || parsed.url || "").trim();
          if (!imageUrl && !String(parsed.fetch_url || "").trim()) {
            return null;
          }
          return {
            image_url: imageUrl || String(parsed.fetch_url || "").trim(),
            fetch_url: String(parsed.fetch_url || parsed.preview_url || imageUrl || "").trim(),
            preview_url: String(parsed.preview_url || parsed.fetch_url || imageUrl || "").trim(),
            filename: String(parsed.filename || "").trim(),
            source_type: String(parsed.source_type || "image")
          };
        }
      } catch (_) {
        return null;
      }
      return null;
    };

    const fromAgent = tryParse(dataTransfer.getData("application/x-agent-image"));
    if (fromAgent) {
      return fromAgent;
    }

    const fromAli = tryParse(dataTransfer.getData("application/x-temu-1688-image"));
    if (fromAli) {
      return fromAli;
    }

    const plain = String(dataTransfer.getData("text/plain") || "").trim();
    if (plain && (/^https?:\/\//i.test(plain) || plain.indexOf("/api/v1/") === 0)) {
      return {
        image_url: plain,
        fetch_url: plain,
        preview_url: plain,
        filename: "",
        source_type: "image"
      };
    }
    return null;
  }

  const AgentPanelComponent = {
    name: "AgentPanelComponent",
    props: {
      modelValue: { type: Boolean, default: false },
      /** True when the right-side multi-fusion or carousel editor is open. */
      storyboardTargetReady: { type: Boolean, default: false },
      /** Reference images from the open carousel/fusion task (for 识别报告). */
      storyboardSourceImages: { type: Array, default: function emptySources() { return []; } }
    },
    emits: ["update:modelValue", "inject-storyboard"],
    data: function data() {
      return {
        chats: [],
        activeChatId: "",
        activeChat: null,
        draftText: "",
        attachments: [],
        uploadingItems: [],
        dropFailures: [],
        isUploading: false,
        isStreaming: false,
        streamRenderTick: 0,
        isDragOver: false,
        dragEnterDepth: 0,
        panelError: "",
        injectHint: "",
        injectBusy: false,
        sop: null,
        sopLoading: false,
        sopActionBusy: false,
        abortController: null
      };
    },
    computed: {
      /** True when composer has ready attachments or non-empty draft text. */
      canSubmit: function canSubmit() {
        return !this.isUploading && (!!String(this.draftText || "").trim() || this.attachments.length > 0);
      },
      /** Last complete assistant message that contains a valid storyboard JSON block. */
      injectableStoryboard: function injectableStoryboard() {
        const api = window.AgentStoryboard;
        if (!api || typeof api.findInjectableAssistantMessage !== "function") {
          return null;
        }
        return api.findInjectableAssistantMessage(this.activeChat && this.activeChat.messages);
      },
      hasStoryboardSources: function hasStoryboardSources() {
        return Array.isArray(this.storyboardSourceImages) && this.storyboardSourceImages.length > 0;
      },
      canRunRecognize: function canRunRecognize() {
        return this.hasStoryboardSources
          && !this.isStreaming
          && !this.isUploading
          && !this.sopActionBusy
          && !this.injectBusy
          && Boolean(this.sopStep("recognize"));
      },
      canRunStoryboard: function canRunStoryboard() {
        return !this.isStreaming
          && !this.isUploading
          && !this.sopActionBusy
          && !this.injectBusy
          && Boolean(this.sopStep("storyboard"));
      },
      canInjectAndGenerate: function canInjectAndGenerate() {
        return Boolean(this.injectableStoryboard && this.injectableStoryboard.parsed && this.injectableStoryboard.parsed.ok)
          && Boolean(this.storyboardTargetReady)
          && !this.isStreaming
          && !this.injectBusy
          && !this.sopActionBusy;
      },
      recognizeButtonTitle: function recognizeButtonTitle() {
        if (this.isStreaming || this.sopActionBusy) {
          return "请等待当前操作结束";
        }
        if (!this.hasStoryboardSources) {
          return "请先打开右侧编辑器并确保有参考图";
        }
        return "带上右侧全部参考图，发送识别报告步骤";
      },
      storyboardButtonTitle: function storyboardButtonTitle() {
        if (this.isStreaming || this.sopActionBusy) {
          return "请等待当前操作结束";
        }
        return "发送生成分镜步骤（建议先跑识别报告）";
      },
      injectButtonTitle: function injectButtonTitle() {
        if (this.injectBusy) {
          return "正在灌入并生成…";
        }
        if (this.isStreaming) {
          return "生成结束后再操作";
        }
        if (!(this.injectableStoryboard && this.injectableStoryboard.parsed && this.injectableStoryboard.parsed.ok)) {
          return "需要最后一条完整助手消息含合法分镜 JSON";
        }
        if (!this.storyboardTargetReady) {
          return "请先打开右侧多图融合或轮播";
        }
        return "灌入全部分镜并触发生成";
      }
    },
    template: `
      <transition name="agent-sheet">
        <aside
          v-show="modelValue"
          class="panel workspace-agent-panel"
          :class="{ 'is-agent-drop-target': isDragOver }"
          role="complementary"
          aria-label="设计 Agent"
          @dragenter="handlePanelDragEnter"
          @dragover="handlePanelDragOver"
          @dragleave="handlePanelDragLeave"
          @drop.prevent="handlePanelDrop"
        >
        <div v-if="isDragOver" class="agent-drop-overlay" aria-hidden="true">
          <span>松手添加到附件</span>
        </div>

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
            <p>可直接输入需求，或把工作区商品图、Word（.docx）、本机参考图拖入本面板。Agent 会解析文档与视觉要素，梳理专业生图提示词。</p>
          </div>

          <div
            v-for="msg in (activeChat ? activeChat.messages : [])"
            :key="msg.id"
            class="agent-message-card"
            :class="msg.role"
            :data-stream-tick="msg.status === 'streaming' ? streamRenderTick : 0"
          >
            <div v-if="msg.attachments && msg.attachments.length" class="agent-message-attachments">
              <template v-for="att in msg.attachments" :key="att.id">
                <a
                  v-if="isImageAttachment(att)"
                  class="agent-att-thumb"
                  :href="attachmentPreviewUrl(att)"
                  :title="att.filename || '图片'"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <img :src="attachmentPreviewUrl(att)" :alt="att.filename || '图片'" referrerpolicy="no-referrer">
                </a>
                <span
                  v-else
                  class="platform-label agent-att-badge"
                  :title="att.extracted_text ? '文档正文已读入' : '普通文件'"
                >
                  文档 · {{ att.filename }}
                  <small v-if="att.extracted_text" class="count">(已读入)</small>
                </span>
              </template>
            </div>
            <div
              v-if="msg.role === 'assistant'"
              class="agent-message-text agent-message-markdown"
              :class="{ 'is-streaming-plain': msg.status === 'streaming' }"
              v-html="renderAssistantBubble(msg)"
            ></div>
            <div v-else class="agent-message-text">{{ msg.content }}</div>
            <div v-if="msg.status === 'streaming'" class="agent-streaming-indicator">
              <span class="agent-dot-flashing"></span>
              <small>{{ msg.thinking ? '模型思考中…' : '思考生成中…' }}</small>
            </div>
            <div v-if="msg.status === 'timeout' || msg.status === 'aborted' || msg.status === 'failed'" class="agent-stream-error">
              <span>{{ formatStreamStatus(msg) }}</span>
              <button
                class="glass-action-button ghost-button agent-retry-btn"
                type="button"
                :disabled="isStreaming || isUploading"
                @click="retryFromMessage(msg)"
              >重试</button>
            </div>
          </div>
        </section>

        <footer class="agent-composer-container">
          <div
            v-if="uploadingItems.length || attachments.length || dropFailures.length"
            class="agent-pending-attachments"
          >
            <div
              v-for="item in uploadingItems"
              :key="item.id"
              class="agent-pending-thumb is-uploading"
              :title="(item.filename || '图片') + ' · 上传中'"
            >
              <img v-if="item.preview_url" :src="item.preview_url" :alt="item.filename || '上传中'" referrerpolicy="no-referrer">
              <span v-else class="agent-thumb-fallback">…</span>
            </div>

            <div
              v-for="(att, idx) in attachments"
              :key="att.id"
              class="agent-pending-item-wrap"
            >
              <div
                v-if="isImageAttachment(att)"
                class="agent-pending-thumb"
                :title="att.filename || '图片'"
              >
                <img :src="attachmentPreviewUrl(att)" :alt="att.filename || '图片'" referrerpolicy="no-referrer">
                <button class="listing-card-delete agent-remove-btn" type="button" aria-label="移除附件" @click="removeAttachment(idx)">×</button>
              </div>
              <div v-else class="platform-label agent-pending-item">
                <span>文档 · {{ att.filename }}</span>
                <small v-if="att.extracted_text" class="count">正文已读取</small>
                <button class="listing-card-delete agent-remove-btn" type="button" @click="removeAttachment(idx)">×</button>
              </div>
            </div>

            <div
              v-for="(fail, failIdx) in dropFailures"
              :key="fail.id"
              class="agent-pending-thumb is-failed"
              :title="fail.error || '上传失败'"
            >
              <img v-if="fail.preview_url" :src="fail.preview_url" :alt="fail.filename || '失败'" referrerpolicy="no-referrer">
              <span class="agent-thumb-fail-mask">失败</span>
              <button class="listing-card-delete agent-remove-btn" type="button" aria-label="关闭失败提示" @click="removeDropFailure(failIdx)">×</button>
            </div>
          </div>

          <textarea
            class="agent-input-box"
            v-model="draftText"
            placeholder="输入设计需求、生图方向，或直接拖入工作区图片 / Word / 本机图片..."
            @keydown.enter.exact.prevent="submitMessage"
          ></textarea>

          <div class="agent-composer-footer">
            <span class="count">{{ injectHint || '支持拖入工作区图、docx、txt 或本机图' }}</span>
            <div class="agent-composer-actions agent-sop-actions">
              <button
                class="glass-action-button ghost-button agent-sop-btn"
                type="button"
                :disabled="!canRunRecognize"
                :title="recognizeButtonTitle"
                @click="runRecognizeStep"
              >
                识别报告
              </button>
              <button
                class="glass-action-button ghost-button agent-sop-btn"
                type="button"
                :disabled="!canRunStoryboard"
                :title="storyboardButtonTitle"
                @click="runStoryboardStep"
              >
                生成分镜
              </button>
              <button
                class="glass-action-button ghost-button agent-inject-btn"
                type="button"
                :disabled="!canInjectAndGenerate"
                :title="injectButtonTitle"
                @click="handleInjectAndGenerate"
              >
                {{ injectBusy ? '处理中…' : '灌入并生成' }}
              </button>
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
                :disabled="!canSubmit"
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
      this.loadSop();
      window.addEventListener("keydown", this.handleGlobalKeyDown);
      window.addEventListener("dragend", this.clearDragOverState, true);
    },
    beforeUnmount: function onAgentUnmount() {
      window.removeEventListener("keydown", this.handleGlobalKeyDown);
      window.removeEventListener("dragend", this.clearDragOverState, true);
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
        this.clearDragOverState();
        this.$emit("update:modelValue", false);
      },
      /** Resolve one SOP step from loaded pack or fallback. */
      sopStep: function sopStep(stepId) {
        const api = window.AgentStoryboard;
        if (!api || typeof api.findSopStep !== "function") {
          return null;
        }
        return api.findSopStep(this.sop || api.FALLBACK_SOP, stepId);
      },
      /** Load SOP pack from GET /agent/sop (fallback to built-in). */
      loadSop: async function loadSop() {
        const api = window.AgentStoryboard;
        this.sopLoading = true;
        try {
          if (api && typeof api.fetchSop === "function") {
            this.sop = await api.fetchSop(getApiBase());
          } else {
            this.sop = api && api.FALLBACK_SOP ? api.FALLBACK_SOP : null;
          }
        } catch (error) {
          this.sop = api && api.FALLBACK_SOP ? api.FALLBACK_SOP : null;
          console.warn("[agent-panel] SOP 读取失败，使用内置兜底：", error && error.message ? error.message : error);
        } finally {
          this.sopLoading = false;
        }
      },
      /** Send one SOP step instruction as a user message (optionally with current attachments). */
      sendSopInstruction: async function sendSopInstruction(instruction) {
        const text = String(instruction || "").trim();
        if (!text) {
          this.injectHint = "SOP 步骤文案为空。";
          return false;
        }
        this.draftText = text;
        await this.submitMessage();
        return true;
      },
      /** 识别报告：上传右侧任务全部参考图后直接发送第 1 步. */
      runRecognizeStep: async function runRecognizeStep() {
        if (!this.canRunRecognize) {
          this.injectHint = this.recognizeButtonTitle;
          return;
        }
        const step = this.sopStep("recognize");
        if (!step) {
          this.injectHint = "未找到「识别报告」步骤。";
          return;
        }
        this.sopActionBusy = true;
        this.injectHint = "正在附带参考图并发送识别报告…";
        this.panelError = "";
        try {
          if (!(await this.ensureActiveChat())) {
            this.injectHint = "无法创建会话。";
            return;
          }
          this.attachments = [];
          this.dropFailures = [];
          const sources = Array.isArray(this.storyboardSourceImages) ? this.storyboardSourceImages : [];
          for (let index = 0; index < sources.length; index += 1) {
            await this.uploadWorkspaceImage(sources[index]);
          }
          if (!this.attachments.length) {
            this.injectHint = "参考图上传失败，请重试或手动拖入图片。";
            return;
          }
          const attachedCount = this.attachments.length;
          const sent = await this.sendSopInstruction(step.instruction);
          if (sent) {
            this.injectHint = "已发送识别报告（附带 " + attachedCount + " 张参考图）。";
          }
        } catch (error) {
          this.injectHint = String(error && error.message || error || "识别报告发送失败。");
        } finally {
          this.sopActionBusy = false;
        }
      },
      /** 生成分镜：直接发送第 2 步，并轻提示建议先识别. */
      runStoryboardStep: async function runStoryboardStep() {
        if (!this.canRunStoryboard) {
          this.injectHint = this.storyboardButtonTitle;
          return;
        }
        const step = this.sopStep("storyboard");
        if (!step) {
          this.injectHint = "未找到「生成分镜」步骤。";
          return;
        }
        const api = window.AgentStoryboard;
        this.injectHint = api && api.STORYBOARD_TIP ? api.STORYBOARD_TIP : "建议先跑「识别报告」，再生成分镜。";
        this.sopActionBusy = true;
        this.panelError = "";
        try {
          await this.sendSopInstruction(step.instruction);
        } catch (error) {
          this.injectHint = String(error && error.message || error || "生成分镜发送失败。");
        } finally {
          this.sopActionBusy = false;
        }
      },
      /** Emit parsed pages for inject + generate on the open editor. */
      handleInjectAndGenerate: function handleInjectAndGenerate() {
        const hit = this.injectableStoryboard;
        if (!hit || !hit.parsed || !hit.parsed.ok) {
          this.injectHint = "没有可灌入的合法分镜 JSON。";
          return;
        }
        if (!this.storyboardTargetReady) {
          this.injectHint = "请先打开多图融合或轮播。";
          return;
        }
        this.injectBusy = true;
        this.injectHint = hit.parsed.warning || "正在灌入并生成…";
        const self = this;
        this.$emit("inject-storyboard", {
          pages: hit.parsed.pages,
          warning: hit.parsed.warning || "",
          generate: true,
          done: function onInjectDone(result) {
            self.injectBusy = false;
            const payload = result && typeof result === "object" ? result : {};
            if (payload.ok === false) {
              self.injectHint = String(payload.error || "灌入并生成失败。");
              return;
            }
            self.injectHint = String(payload.message || "已灌入并开始生成。");
          }
        });
      },
      clearDragOverState: function clearDragOverState() {
        this.isDragOver = false;
        this.dragEnterDepth = 0;
      },
      /** Highlight the whole panel while an acceptable image/file drag is over it. */
      handlePanelDragEnter: function handlePanelDragEnter(event) {
        if (!this.modelValue || !isAgentAcceptableDrag(event.dataTransfer)) {
          return;
        }
        event.preventDefault();
        this.dragEnterDepth += 1;
        this.isDragOver = true;
      },
      handlePanelDragOver: function handlePanelDragOver(event) {
        if (!this.modelValue || !isAgentAcceptableDrag(event.dataTransfer)) {
          return;
        }
        event.preventDefault();
        if (event.dataTransfer) {
          event.dataTransfer.dropEffect = "copy";
        }
        this.isDragOver = true;
      },
      handlePanelDragLeave: function handlePanelDragLeave(event) {
        if (!this.modelValue) {
          return;
        }
        this.dragEnterDepth = Math.max(0, this.dragEnterDepth - 1);
        if (this.dragEnterDepth === 0) {
          this.isDragOver = false;
        }
      },
      /** Accept OS files or workspace product images into pending attachments. */
      handlePanelDrop: async function handlePanelDrop(event) {
        this.clearDragOverState();
        if (!this.modelValue) {
          return;
        }
        const files = event.dataTransfer && event.dataTransfer.files ? event.dataTransfer.files : [];
        if (files && files.length) {
          await this.handleFileDrop(event);
          return;
        }
        const payload = parseWorkspaceImagePayload(event.dataTransfer);
        if (payload) {
          await this.uploadWorkspaceImage(payload);
        }
      },
      isImageAttachment: function isImageAttachment(att) {
        if (!att) {
          return false;
        }
        if (att.is_image) {
          return true;
        }
        const name = String(att.filename || att.stored_filename || "").toLowerCase();
        return /\.(jpe?g|png|webp|gif)$/i.test(name);
      },
      attachmentPreviewUrl: function attachmentPreviewUrl(att) {
        if (!att) {
          return "";
        }
        if (att.preview_url) {
          return resolveMediaUrl(att.preview_url);
        }
        return resolveMediaUrl(att.url);
      },
      formatAssistantHtml: function formatAssistantHtml(content) {
        return renderAgentMarkdown(content);
      },
      /** Streaming uses plain text so incomplete markdown does not thrash; completed uses markdown. */
      formatStreamingHtml: function formatStreamingHtml(content) {
        return escapeHtml(content).replace(/\n/g, "<br>");
      },
      /** Pick the bubble renderer; streamRenderTick keeps Vue painting each typewriter tick. */
      renderAssistantBubble: function renderAssistantBubble(msg) {
        void this.streamRenderTick;
        if (!msg) {
          return "";
        }
        if (msg.status === "streaming") {
          return this.formatStreamingHtml(msg.content);
        }
        return this.formatAssistantHtml(msg.content);
      },
      formatStreamStatus: function formatStreamStatus(msg) {
        if (!msg) {
          return "生成失败";
        }
        if (msg.status === "timeout") {
          return msg.error || "请求超时，请重试";
        }
        if (msg.status === "aborted") {
          return msg.error || "流式已停止";
        }
        const raw = String(msg.error || "生成失败");
        if (/terminated/i.test(raw)) {
          return "Kimi 连接中断，回复可能不完整，请点击重试。";
        }
        return raw;
      },
      /** Re-send the nearest preceding user message after a failed assistant reply. */
      retryFromMessage: async function retryFromMessage(failedMsg) {
        if (!this.activeChat || !Array.isArray(this.activeChat.messages) || this.isStreaming || this.isUploading) {
          return;
        }
        const list = this.activeChat.messages;
        const failedIndex = list.indexOf(failedMsg);
        let userMsg = null;
        for (let index = failedIndex - 1; index >= 0; index -= 1) {
          if (list[index] && list[index].role === "user") {
            userMsg = list[index];
            break;
          }
        }
        if (!userMsg) {
          this.panelError = "找不到可重试的用户消息。";
          return;
        }
        this.draftText = String(userMsg.content || "");
        this.attachments = Array.isArray(userMsg.attachments) ? userMsg.attachments.slice() : [];
        await this.submitMessage();
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
            this.attachments = [];
            this.uploadingItems = [];
            this.dropFailures = [];
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
      ensureActiveChat: async function ensureActiveChat() {
        if (this.activeChatId) {
          return this.activeChatId;
        }
        const newChat = await this.handleCreateChat();
        return newChat && newChat.id ? newChat.id : "";
      },
      handleFileDrop: async function handleFileDrop(event) {
        const files = event.dataTransfer ? event.dataTransfer.files : [];
        if (!files || !files.length) {
          return;
        }
        if (!(await this.ensureActiveChat())) {
          return;
        }
        for (let i = 0; i < files.length; i += 1) {
          await this.uploadFile(files[i]);
        }
      },
      /** Fetch one workspace image and upload it as an Agent attachment. */
      uploadWorkspaceImage: async function uploadWorkspaceImage(payload) {
        const info = payload && typeof payload === "object" ? payload : {};
        const fetchUrl = resolveMediaUrl(info.fetch_url || info.preview_url || info.image_url);
        const previewUrl = resolveMediaUrl(info.preview_url || info.fetch_url || info.image_url);
        const localId = createLocalId("up");
        const filenameHint = String(info.filename || "").trim();

        if (!(await this.ensureActiveChat())) {
          this.dropFailures.push({
            id: createLocalId("fail"),
            filename: filenameHint || "workspace-image.jpg",
            preview_url: previewUrl,
            error: "无法创建会话，附件未上传"
          });
          return;
        }

        this.uploadingItems.push({
          id: localId,
          filename: filenameHint || "workspace-image.jpg",
          preview_url: previewUrl
        });
        this.isUploading = true;

        try {
          if (!fetchUrl) {
            throw new Error("图片地址无效");
          }
          const response = await fetch(fetchUrl, { cache: "no-store" });
          if (!response.ok) {
            throw new Error("读取图片失败 [" + response.status + "]");
          }
          const blob = await response.blob();
          if (!blob || !blob.size) {
            throw new Error("图片内容为空");
          }
          const mimeType = blob.type || "image/jpeg";
          const filename = guessImageFilename(info.image_url || fetchUrl, mimeType, filenameHint);
          const file = new File([blob], filename, { type: mimeType });
          const uploaded = await this.uploadFile(file, { skipEnsureChat: true, skipUploadingPlaceholder: true });
          if (!uploaded) {
            throw new Error("附件上传失败");
          }
        } catch (error) {
          this.dropFailures.push({
            id: createLocalId("fail"),
            filename: filenameHint || "workspace-image.jpg",
            preview_url: previewUrl,
            error: error && error.message ? error.message : "上传失败"
          });
        } finally {
          this.uploadingItems = this.uploadingItems.filter(function keep(item) {
            return item.id !== localId;
          });
          this.isUploading = this.uploadingItems.length > 0;
        }
      },
      uploadFile: async function uploadFile(file, options) {
        const opts = options && typeof options === "object" ? options : {};
        if (!file) {
          return false;
        }
        if (!opts.skipEnsureChat) {
          if (!(await this.ensureActiveChat())) {
            return false;
          }
        }
        if (!this.activeChatId) {
          return false;
        }

        const isImageFile = String(file.type || "").indexOf("image/") === 0
          || /\.(jpe?g|png|webp|gif)$/i.test(String(file.name || ""));
        const localId = createLocalId("up");
        let objectUrl = "";
        if (isImageFile && !opts.skipUploadingPlaceholder) {
          try {
            objectUrl = URL.createObjectURL(file);
          } catch (_) {
            objectUrl = "";
          }
          this.uploadingItems.push({
            id: localId,
            filename: file.name || "image.jpg",
            preview_url: objectUrl
          });
        }

        this.isUploading = true;
        try {
          const endpoint = getApiBase() + "/agent/chats/" + encodeURIComponent(this.activeChatId) + "/attachments";
          const res = await fetch(endpoint, {
            method: "POST",
            headers: {
              "Content-Type": "application/octet-stream",
              "X-Filename": encodeURIComponent(file.name || "upload.bin")
            },
            body: file
          });
          const payload = await res.json();
          if (res.ok && payload.ok && payload.data && payload.data.attachment) {
            this.attachments.push(payload.data.attachment);
            return true;
          }
          throw new Error(payload && payload.error && payload.error.message || "上传附件失败");
        } catch (error) {
          if (opts.skipUploadingPlaceholder) {
            throw error;
          }
          if (isImageFile) {
            this.dropFailures.push({
              id: createLocalId("fail"),
              filename: file.name || "image.jpg",
              preview_url: objectUrl,
              error: error && error.message ? error.message : "上传失败"
            });
          } else {
            this.panelError = "附件上传异常：" + (error && error.message ? error.message : "未知错误");
          }
          return false;
        } finally {
          if (!opts.skipUploadingPlaceholder) {
            this.uploadingItems = this.uploadingItems.filter(function keep(item) {
              return item.id !== localId;
            });
          }
          this.isUploading = this.uploadingItems.length > 0;
        }
      },
      removeAttachment: function removeAttachment(index) {
        this.attachments.splice(index, 1);
      },
      removeDropFailure: function removeDropFailure(index) {
        const removed = this.dropFailures.splice(index, 1)[0];
        if (removed && removed.preview_url && String(removed.preview_url).indexOf("blob:") === 0) {
          try {
            URL.revokeObjectURL(removed.preview_url);
          } catch (_) {}
        }
      },
      stopGeneration: function stopGeneration() {
        if (this.abortController) {
          this.abortController.abort();
          this.abortController = null;
        }
        if (this.activeChat && Array.isArray(this.activeChat.messages)) {
          for (let index = this.activeChat.messages.length - 1; index >= 0; index -= 1) {
            const msg = this.activeChat.messages[index];
            if (msg && msg.role === "assistant" && msg.status === "streaming") {
              msg.status = "aborted";
              msg.thinking = false;
              msg.error = "流式已停止";
              break;
            }
          }
        }
        this.isStreaming = false;
      },
      submitMessage: async function submitMessage() {
        const text = String(this.draftText || "").trim();
        if ((!text && !this.attachments.length) || this.isStreaming || this.isUploading) {
          return;
        }
        this.panelError = "";

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
        if (!Array.isArray(this.activeChat.messages)) {
          this.activeChat.messages = [];
        }

        this.activeChat.messages.push({
          id: "temp_u_" + Date.now(),
          role: "user",
          content: text,
          attachments: userMsg.attachments
        });

        this.draftText = "";
        this.attachments = [];
        this.dropFailures = [];
        this.scrollToBottom();

        this.activeChat.messages.push({
          id: "temp_a_" + Date.now(),
          role: "assistant",
          content: "",
          status: "streaming",
          thinking: false
        });
        // Important: mutate the reactive proxy from the array, not the raw pushed object.
        const assistantMsg = this.activeChat.messages[this.activeChat.messages.length - 1];
        this.isStreaming = true;
        this.streamRenderTick = 0;
        this.scrollToBottom();

        this.abortController = new AbortController();
        const self = this;
        let pendingDelta = "";
        let paintTimer = null;
        let scrollBudget = 0;

        /** How many characters to reveal this tick: keep typewriter feel, catch up if backlog grows. */
        function charsPerTick() {
          const queued = pendingDelta.length;
          if (queued > 240) {
            return 24;
          }
          if (queued > 80) {
            return 12;
          }
          if (queued > 24) {
            return 4;
          }
          return 2;
        }

        /** Paint one slice from the typewriter queue onto the reactive assistant bubble. */
        function paintDeltaSlice() {
          if (!pendingDelta) {
            paintTimer = null;
            return;
          }
          const take = Math.min(charsPerTick(), pendingDelta.length);
          const piece = pendingDelta.slice(0, take);
          pendingDelta = pendingDelta.slice(take);
          assistantMsg.thinking = false;
          assistantMsg.content = String(assistantMsg.content || "") + piece;
          self.streamRenderTick += 1;
          scrollBudget += 1;
          if (scrollBudget >= 4) {
            scrollBudget = 0;
            self.scrollToBottom();
          }
          if (pendingDelta) {
            paintTimer = window.setTimeout(paintDeltaSlice, 18);
          } else {
            paintTimer = null;
            self.scrollToBottom();
          }
        }

        /** Enqueue tokens; never dump a whole network chunk into the DOM at once. */
        const queueDelta = function queueDelta(piece) {
          const value = String(piece || "");
          if (!value) {
            return;
          }
          pendingDelta += value;
          if (paintTimer == null) {
            paintTimer = window.setTimeout(paintDeltaSlice, 0);
          }
        };

        /** Flush the remaining typewriter queue immediately (end / error / abort). */
        const flushDeltaNow = function flushDeltaNow() {
          if (paintTimer != null) {
            window.clearTimeout(paintTimer);
            paintTimer = null;
          }
          if (!pendingDelta) {
            return;
          }
          assistantMsg.thinking = false;
          assistantMsg.content = String(assistantMsg.content || "") + pendingDelta;
          pendingDelta = "";
          self.streamRenderTick += 1;
          self.scrollToBottom();
        };

        const processSseBlock = function(blockText) {
          if (!blockText || !blockText.trim()) return;
          const lines = blockText.split("\n");
          let eventType = "";
          const dataLines = [];
          for (const line of lines) {
            if (line.charAt(0) === ":") {
              continue;
            }
            if (line.startsWith("event:")) {
              eventType = line.slice(6).trim();
            } else if (line.startsWith("data:")) {
              dataLines.push(line.slice(5).trim());
            }
          }
          if (!dataLines.length) return;
          const dataStr = dataLines.join("\n");
          try {
            const data = JSON.parse(dataStr);
            if (eventType === "thinking") {
              assistantMsg.thinking = true;
              self.streamRenderTick += 1;
            } else if (eventType === "delta" && data.delta) {
              queueDelta(data.delta);
            } else if (eventType === "message_done") {
              flushDeltaNow();
              assistantMsg.thinking = false;
              assistantMsg.status = "completed";
              if (data.content) {
                assistantMsg.content = data.content;
              }
              self.streamRenderTick += 1;
            } else if (eventType === "error") {
              flushDeltaNow();
              assistantMsg.thinking = false;
              assistantMsg.status = data.status || "failed";
              assistantMsg.error = data.message;
              self.streamRenderTick += 1;
            } else if (eventType === "message_start" && data.message_id) {
              assistantMsg.id = data.message_id;
            }
          } catch (_) {}
        };

        try {
          const endpoint = getApiBase() + "/agent/chats/" + encodeURIComponent(this.activeChatId) + "/messages/stream";
          const response = await fetch(endpoint, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Accept": "text/event-stream"
            },
            body: JSON.stringify(userMsg),
            signal: this.abortController.signal
          });

          if (!response.ok) {
            throw new Error("服务响应异常 [" + response.status + "]");
          }
          if (!response.body || typeof response.body.getReader !== "function") {
            throw new Error("浏览器未拿到 SSE 响应流");
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

          if (buffer.trim()) {
            processSseBlock(buffer.trim());
            buffer = "";
          }

          flushDeltaNow();
          if (assistantMsg.status === "streaming") {
            assistantMsg.status = "completed";
            this.streamRenderTick += 1;
          }
        } catch (error) {
          flushDeltaNow();
          if (error.name === "AbortError" || (this.abortController && this.abortController.signal.aborted)) {
            assistantMsg.status = "aborted";
            assistantMsg.error = "流式已停止";
          } else {
            assistantMsg.status = "failed";
            assistantMsg.error = error.message;
          }
          this.streamRenderTick += 1;
        } finally {
          flushDeltaNow();
          assistantMsg.thinking = false;
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
