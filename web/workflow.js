const { createApp } = Vue;

const workflowPageParameters = new URLSearchParams(window.location.search);
if (workflowPageParameters.get("embedded") === "1") {
  document.body.classList.add("workflow-embedded");
}

/** Resolve one intelligent-packing API URL from frontend configuration. */
function workflowApiUrl(pathname) {
  const config = window.APP_CONFIG || {};
  return String(config.apiBaseUrl || "http://127.0.0.1:3000/api/v1").replace(/\/$/, "") + pathname;
}

/** Return a safe array for one workflow field. */
function workflowArray(value) {
  return Array.isArray(value) ? value : [];
}

/** Read the unified cache record array from supported response shapes. */
function readWorkflowRecords(payload) {
  if (payload && Array.isArray(payload.records)) {
    return payload.records;
  }
  return Array.isArray(payload) ? payload : [];
}

/** Return one readable message from the shared API error envelope. */
function getWorkflowErrorMessage(payload, fallbackMessage) {
  const error = payload && payload.error;
  if (typeof error === "string") {
    return error;
  }
  if (error && typeof error === "object" && error.message) {
    return String(error.message);
  }
  return String(fallbackMessage || "请求失败。");
}

/** Return one stable error code from a failed workflow request. */
function getWorkflowErrorCode(error) {
  return String(error && (error.code || error.statusCode) || "REQUEST_FAILED");
}

/** Build one compact RMB price reference for intelligent-packing recommendations. */
function getWorkflowPriceReference(record) {
  const source = record || {};
  const rows = Array.isArray(source.sku) ? source.sku : [];
  const values = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index] || {};
    const text = String(row.sku_price !== undefined ? row.sku_price : row.price || "").trim();
    const normalized = text.replace(/[^0-9.-]/g, "");
    const value = normalized ? Number(normalized) : null;
    if (value !== null && Number.isFinite(value) && value >= 0) {
      values.push(value);
    }
  }
  if (!values.length) {
    return { available: false, currency: "CNY", min: null, max: null, typical: null, sample_count: 0 };
  }
  for (let start = 0; start < values.length - 1; start += 1) {
    let smallest = start;
    for (let index = start + 1; index < values.length; index += 1) {
      if (values[index] < values[smallest]) {
        smallest = index;
      }
    }
    if (smallest !== start) {
      const temporary = values[start];
      values[start] = values[smallest];
      values[smallest] = temporary;
    }
  }
  const middle = Math.floor(values.length / 2);
  const typical = values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
  return {
    available: true,
    currency: "CNY",
    min: Number(values[0].toFixed(2)),
    max: Number(values[values.length - 1].toFixed(2)),
    typical: Number(typical.toFixed(2)),
    sample_count: values.length
  };
}

/** Unwrap one shared API response while retaining raw SSE payload compatibility. */
function readWorkflowData(payload) {
  if (payload && Object.prototype.hasOwnProperty.call(payload, "data")) {
    return payload.data;
  }
  return payload;
}

/** Send one JSON request and reject non-success API payloads. */
function requestWorkflowJson(url, options) {
  return fetch(url, options).then(function parseWorkflowResponse(response) {
    return response.json().then(function validateWorkflowPayload(payload) {
      if (!response.ok || !payload || payload.ok === false) {
        const apiError = payload && payload.error && typeof payload.error === "object" ? payload.error : {};
        const error = new Error(getWorkflowErrorMessage(payload, "请求失败。"));
        error.code = String(apiError.code || response.status || "REQUEST_FAILED");
        error.statusCode = Number(response.status || 500);
        throw error;
      }
      return readWorkflowData(payload);
    });
  });
}

const workflowApp = createApp({
  template: `
    <div class="workflow-shell">
      <header class="workflow-topbar">
        <div class="workflow-brand"><span>T+8</span><div><h1>智能组货</h1><p>Temu 选品 · 四方向生图 · 1688 搜款</p></div></div>
        <a class="back-link" href="/">返回编辑工作台</a>
      </header>
      <div class="workflow-body">
        <aside class="temu-task-list">
          <div class="task-list-heading"><div><strong>Temu 商品</strong><span>{{ temuRecords.length }} 个</span></div><small>每个商品独立处理</small></div>
          <button v-for="record in temuRecords" :key="record.main_id" class="temu-task-card" :class="{ active: String(record.main_id) === String(selectedTemuMainId) }" type="button" @click="selectTemu(record)">
            <img v-if="record.main_image_url" :src="record.main_image_url" referrerpolicy="no-referrer" alt="Temu 商品">
            <span v-else class="task-image-empty">—</span>
            <span class="task-card-copy"><strong>{{ record.product_name }}</strong><small>{{ taskStatusText(record.main_id) }}</small></span>
            <i :class="taskStatusClass(record.main_id)"></i>
          </button>
          <div v-if="!temuRecords.length" class="task-list-empty">请先通过扩展采集 Temu 商品。</div>
        </aside>

        <main v-if="selectedTemu" class="workflow-main">
          <section class="product-summary">
            <div><span class="eyebrow">当前 Temu</span><h2>{{ selectedTemu.product_name }}</h2><p>{{ selectedTemu.product_category || '未提供分类' }}</p></div>
          </section>

          <div class="workflow-status" :class="statusType">{{ statusText }}</div>

          <section class="workflow-step">
            <header><span>01</span><div><h3>选择分析主图</h3><p>默认第一张，可改选其他 Temu 主图。</p></div></header>
            <div class="source-image-grid">
              <button v-for="image in selectedTemu.gallery_image_urls" :key="image" type="button" :class="{ selected: image === selectedImageUrl }" @click="selectSourceImage(image)"><img :src="image" referrerpolicy="no-referrer" alt="Temu 主图"><i>✓</i></button>
            </div>
            <button class="primary-action" type="button" :disabled="promptBusy || !selectedImageUrl" @click="generatePrompts">{{ promptBusy ? 'Kimi 分析中…' : selectedTask && selectedTask.prompts && selectedTask.prompts.length ? '重新生成 4 个组货方向' : '生成 4 个组货方向' }}</button>
          </section>

          <section v-if="localPrompts.length" class="workflow-step">
            <header><span>02</span><div><h3>确认组货提示词</h3><p>四种关系固定，提示词可以直接修改。</p></div></header>
            <div class="prompt-grid">
              <article v-for="(item, index) in localPrompts" :key="index" class="prompt-card">
                <div class="prompt-card-head"><span>{{ item.relation }}</span><strong>{{ item.product_name }}</strong></div>
                <textarea v-model="item.prompt" rows="8" :aria-label="item.relation + '提示词'"></textarea>
              </article>
            </div>
            <button class="primary-action" type="button" :disabled="!selectedTemu" @click="generateImages()">{{ generateBusy ? '提交中…' : hasGeneratedImages ? '全部重新生成' : '一次生成 4 张白底图' }}</button>
          </section>

          <section v-if="localPrompts.length" class="workflow-step">
            <header><span>03</span><div><h3>选择组货图片</h3><p>可单独重生，确认一张后进入 1688 搜图。</p></div></header>
            <div class="result-grid">
              <article v-for="(item, index) in localPrompts" :key="'result-' + index" class="result-card" :class="{ selected: selectedResultIndex === index }">
                <button class="result-image" type="button" :disabled="!item.image_url" @click="selectResult(index)">
                  <img v-if="item.image_url" :src="item.image_url" alt="AI 组货候选图">
                  <span v-else>{{ item.status === 'generating' ? '生成中…' : item.error || '等待生成' }}</span>
                  <i v-if="selectedResultIndex === index">已选择</i>
                </button>
                <div><strong>{{ item.relation }}</strong><span>{{ item.product_name }}</span></div>
                <button class="regenerate-button" type="button" :disabled="!selectedTemu" @click="generateImages(index)">单独重生</button>
              </article>
            </div>
            <button class="search-action" type="button" :disabled="searchBusy || selectedResultIndex < 0" @click="search1688">{{ searchBusy ? '正在发送到 1688…' : '确认图片并打开 1688 搜款' }}</button>
            <div v-if="selectedTask && selectedTask.search_url" class="search-ready"><span>搜款页已生成，进入满意商品详情后选择 Temu，并点击扩展的“确认并绑定”。</span><a :href="selectedTask.search_url" target="_blank">重新打开搜款页</a></div>
          </section>
        </main>
        <main v-else class="workflow-main workflow-empty"><strong>等待 Temu 商品</strong><span>在 Temu 商品详情页点击扩展采集后，这里会实时出现。</span></main>
      </div>
    </div>
  `,
  data: function createWorkflowState() {
    const pageParameters = new URLSearchParams(window.location.search);
    return {
      records: [],
      workflow: { active_temu_main_id: "", tasks: {} },
      selectedTemuMainId: String(pageParameters.get("temu_main_id") || ""),
      selectedImageUrl: "",
      selectedResultIndex: -1,
      localPrompts: [],
      promptBusy: false,
      generateBusy: false,
      searchBusy: false,
      statusText: "等待选择 Temu 商品。",
      statusType: "normal",
      cacheSource: null,
      cacheRefreshTimer: null,
      cacheRefreshQueued: false,
      cacheRefreshInFlight: false,
      cacheLastEventId: 0
    };
  },
  /** Connect the page to the product cache stream. */
  mounted: function mountWorkflowPage() {
    this.startCacheStream();
  },
  /** Close the product cache stream when leaving the workflow page. */
  beforeUnmount: function unmountWorkflowPage() {
    if (this.cacheSource) {
      this.cacheSource.close();
    }
    if (this.cacheRefreshTimer) {
      clearTimeout(this.cacheRefreshTimer);
      this.cacheRefreshTimer = null;
    }
  },
  computed: {
    /** Return normalized Temu products from the shared cache. */
    temuRecords: function getWorkflowTemuRecords() {
      const result = [];
      for (let index = 0; index < this.records.length; index += 1) {
        const record = this.records[index] || {};
        if (String(record.platform || "").toLowerCase() === "temu") {
          result.push(record);
        }
      }
      return result;
    },
    /** Return the currently selected Temu product. */
    selectedTemu: function getSelectedWorkflowTemu() {
      for (let index = 0; index < this.temuRecords.length; index += 1) {
        if (String(this.temuRecords[index].main_id) === String(this.selectedTemuMainId)) {
          return this.temuRecords[index];
        }
      }
      return this.temuRecords[0] || null;
    },
    /** Return the persisted task belonging to the selected Temu product. */
    selectedTask: function getSelectedWorkflowTask() {
      const tasks = this.workflow && this.workflow.tasks ? this.workflow.tasks : {};
      return tasks[String(this.selectedTemuMainId)] || null;
    },
    /** Check whether at least one candidate image has been generated. */
    hasGeneratedImages: function hasWorkflowGeneratedImages() {
      for (let index = 0; index < this.localPrompts.length; index += 1) {
        if (this.localPrompts[index].image_url) {
          return true;
        }
      }
      return false;
    }
  },
  methods: {
    /** Set the operation message displayed above the workflow. */
    setWorkflowStatus: function setWorkflowStatus(message, type) {
      this.statusText = String(message || "");
      this.statusType = type || "normal";
    },
    /** Start receiving unified product cache updates. */
    startCacheStream: function startWorkflowCacheStream() {
      const view = this;
      this.cacheSource = new EventSource(String((window.APP_CONFIG || {}).eventUrl || workflowApiUrl("/events")));
      this.cacheSource.onmessage = function applyCacheEvent(event) {
        let message = {};
        try {
          message = JSON.parse(String(event && event.data || "{}"));
        } catch (error) {
          message = {};
        }
        if (message.action === "connected") {
          return;
        }
        view.cacheLastEventId = Number(event && event.lastEventId) || view.cacheLastEventId;
        view.queueWorkflowCacheRefresh();
      };
      this.cacheRefreshQueued = true;
      this.refreshWorkflowCache();
    },

    /** Queue several close-together product events into one cache refresh. */
    queueWorkflowCacheRefresh: function queueWorkflowCacheRefresh() {
      this.cacheRefreshQueued = true;
      if (this.cacheRefreshTimer || this.cacheRefreshInFlight) {
        return;
      }
      const view = this;
      /** Start one coalesced workflow cache refresh after the current event burst. */
      function startQueuedWorkflowCacheRefresh() {
        view.cacheRefreshTimer = null;
        view.refreshWorkflowCache();
      }
      this.cacheRefreshTimer = setTimeout(startQueuedWorkflowCacheRefresh, 120);
    },

    /** Read one cache snapshot and apply it after coalesced SSE invalidations. */
    refreshWorkflowCache: function refreshWorkflowCache() {
      if (this.cacheRefreshInFlight || !this.cacheRefreshQueued) {
        return;
      }
      this.cacheRefreshQueued = false;
      this.cacheRefreshInFlight = true;
      const view = this;
      fetch(workflowApiUrl("/workbench"), { cache: "no-store" }).then(function readWorkflowCache(response) {
        if (!response.ok) {
          throw new Error("无法读取商品 cache。 ");
        }
        return response.json();
      }).then(function applyWorkflowCachePayload(payload) {
        view.applyWorkflowCache(payload.data || {});
      }).catch(function handleWorkflowCacheError(error) {
        view.setWorkflowStatus(error.message || "商品数据刷新失败。", "error");
      }).finally(function finishWorkflowCacheRefresh() {
        view.cacheRefreshInFlight = false;
        if (view.cacheRefreshQueued) {
          view.queueWorkflowCacheRefresh();
        }
      });
    },
    /** Apply a product cache snapshot and preserve the current Temu selection. */
    applyWorkflowCache: function applyWorkflowCache(payload) {
      this.records = readWorkflowRecords(payload);
      if (!this.selectedTemuMainId && this.temuRecords.length) {
        this.selectTemu(this.temuRecords[0]);
      } else if (this.selectedTemu && !this.selectedImageUrl) {
        this.selectTemu(this.selectedTemu);
      }
    },
    /** Apply one workflow state snapshot without changing the current page. */
    applyWorkflowPayload: function applyWorkflowPayload(payload) {
      const state = payload && payload.workflow ? payload.workflow : payload;
      this.workflow = state && typeof state === "object" ? state : { active_temu_main_id: "", tasks: {} };
      const task = this.selectedTask;
      if (task && Array.isArray(task.prompts) && !this.promptBusy) {
        this.syncLocalPrompts(task);
      }
      if (task && !this.promptBusy && !this.searchBusy) {
        this.setWorkflowStatus(this.taskStatusText(this.selectedTemuMainId), task.status === "completed" ? "success" : "normal");
      }
    },
    /** Select one Temu task and restore its persisted workflow state. */
    selectTemu: function selectWorkflowTemu(record) {
      this.selectedTemuMainId = String(record && record.main_id || "");
      const task = this.selectedTask;
      this.selectedImageUrl = task && task.selected_image_url ? task.selected_image_url : record && (record.main_image_url || record.gallery_image_urls[0]) || "";
      this.selectedResultIndex = task && Number.isFinite(Number(task.selected_result_index)) ? Number(task.selected_result_index) : -1;
      this.syncLocalPrompts(task);
      this.setWorkflowStatus(task && task.status !== "idle" ? this.taskStatusText(this.selectedTemuMainId) : "已选择 Temu 商品，请确认分析主图。", "normal");
    },
    /** Copy persisted prompt objects into editable local prompt objects. */
    syncLocalPrompts: function syncWorkflowLocalPrompts(task) {
      const source = task && Array.isArray(task.prompts) ? task.prompts : [];
      const prompts = [];
      for (let index = 0; index < source.length; index += 1) {
        prompts.push({
          relation: String(source[index].relation || ""),
          product_name: String(source[index].product_name || ""),
          prompt: String(source[index].prompt || ""),
          image_url: String(source[index].image_url || ""),
          status: String(source[index].status || ""),
          error: String(source[index].error || "")
        });
      }
      this.localPrompts = prompts;
      if (task && Number(task.selected_result_index) >= 0) {
        this.selectedResultIndex = Number(task.selected_result_index);
      }
    },
    /** Select the Temu main image sent to Kimi. */
    selectSourceImage: function selectWorkflowSourceImage(image) {
      this.selectedImageUrl = String(image || "");
    },
    /** Request four open-ended product-packing prompts from Kimi. */
    generatePrompts: function generateWorkflowPrompts() {
      if (!this.selectedTemu || !this.selectedImageUrl || this.promptBusy) {
        return;
      }
      this.promptBusy = true;
      this.setWorkflowStatus("Kimi 正在分析商品并生成四个组货方向…", "normal");
      const view = this;
      requestWorkflowJson(workflowApiUrl("/workflow/prompts"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          temu_main_id: this.selectedTemu.main_id,
          image_url: this.selectedImageUrl,
          custom_prompt: "请结合当前 Temu 商品信息和图片，按照你认为最有销售价值的方向推荐 4 个可用于组货的商品。不要使用固定分类，候选方向由当前商品特征决定。",
          product: {
            title: this.selectedTemu.product_name,
            category: this.selectedTemu.product_category,
            attributes: this.selectedTemu.attributes,
            price_reference: getWorkflowPriceReference(this.selectedTemu)
          }
        })
      }).then(function handleWorkflowPromptSuccess(payload) {
        view.syncLocalPrompts(payload.task);
        view.selectedResultIndex = -1;
        view.setWorkflowStatus("四个组货方向已生成，可以修改提示词后生图。", "success");
      }).catch(function handleWorkflowPromptError(error) {
        view.setWorkflowStatus("Kimi 提词失败 [" + getWorkflowErrorCode(error) + "]：" + error.message, "error");
      }).finally(function finishWorkflowPromptRequest() {
        view.promptBusy = false;
      });
    },
    /** Generate all four images or regenerate one selected candidate. */
    generateImages: function generateWorkflowImages(index) {
      if (!this.selectedTemu || this.localPrompts.length !== 4) {
        return;
      }
      this.generateBusy = true;
      this.setWorkflowStatus(index === undefined ? "BeeAPI 正在依次生成四张白底图…" : "BeeAPI 正在重新生成第 " + (Number(index) + 1) + " 张图…", "normal");
      const prompts = [];
      for (let promptIndex = 0; promptIndex < this.localPrompts.length; promptIndex += 1) {
        prompts.push(this.localPrompts[promptIndex].prompt);
      }
      const body = { temu_main_id: this.selectedTemu.main_id, prompts: prompts };
      if (index !== undefined) {
        body.index = Number(index);
      }
      const view = this;
      requestWorkflowJson(workflowApiUrl("/workflow/generate"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      }).then(function handleWorkflowGenerationSuccess(payload) {
        view.syncLocalPrompts(payload.task);
        view.setWorkflowStatus(index === undefined ? "四张白底图已生成，请选择一张。" : "图片已重新生成。", "success");
      }).catch(function handleWorkflowGenerationError(error) {
        view.setWorkflowStatus("BeeAPI 生图失败 [" + getWorkflowErrorCode(error) + "]：" + error.message, "error");
      }).finally(function finishWorkflowGenerationRequest() {
        view.generateBusy = false;
      });
    },
    /** Select one generated candidate image for the 1688 search step. */
    selectResult: function selectWorkflowResult(index) {
      if (this.localPrompts[index] && this.localPrompts[index].image_url) {
        this.selectedResultIndex = Number(index);
      }
    },
    /** Send the selected candidate to 1688 and open the returned search page. */
    search1688: function searchWorkflow1688() {
      if (this.searchBusy || this.selectedResultIndex < 0 || !this.selectedTemu) {
        return;
      }
      this.searchBusy = true;
      this.setWorkflowStatus("正在上传图片到 1688 搜款…", "normal");
      const view = this;
      const selectedImage = this.localPrompts[this.selectedResultIndex] && this.localPrompts[this.selectedResultIndex].image_url;
      requestWorkflowJson(workflowApiUrl("/images/search-1688"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image_url: selectedImage })
      }).then(function handleWorkflowSearchSuccess(payload) {
        const searchData = payload && typeof payload === "object" ? payload : {};
        const searchUrl = String(searchData.search_url || "");
        if (!searchUrl) {
          throw new Error("search-1688 未返回搜款地址。");
        }
        const selectedTask = view.selectedTask;
        if (selectedTask) {
          selectedTask.status = "waiting_1688_confirmation";
          selectedTask.selected_result_index = view.selectedResultIndex;
          selectedTask.search_url = searchUrl;
        }
        const searchWindow = window.open(searchUrl, "_blank");
        if (!searchWindow) {
          view.setWorkflowStatus("1688 搜图完成。浏览器阻止了自动打开，请点击下方“重新打开搜款页”。", "normal");
          return;
        }
        view.setWorkflowStatus("已打开 1688 搜款页。进入满意商品详情后选择 Temu，并点击扩展确认绑定。", "success");
      }).catch(function handleWorkflowSearchError(error) {
        view.setWorkflowStatus("1688 搜图失败：" + error.message, "error");
      }).finally(function finishWorkflowSearchRequest() {
        view.searchBusy = false;
      });
    },
    /** Return the readable task status shown in the Temu list. */
    taskStatusText: function getWorkflowTaskStatusText(temuMainId) {
      const tasks = this.workflow && this.workflow.tasks ? this.workflow.tasks : {};
      const task = tasks[String(temuMainId)];
      const statuses = {
        idle: "等待开始",
        prompts_ready: "提示词已就绪",
        generating: "图片生成中",
        images_ready: "图片已就绪",
        waiting_1688_confirmation: "等待确认 1688",
        completed: "1688 已绑定",
        generation_error: "生图失败",
        search_error: "搜图失败"
      };
      return task ? statuses[task.status] || task.status || "等待开始" : "等待开始";
    },
    /** Return the task status color class used by one Temu card. */
    taskStatusClass: function getWorkflowTaskStatusClass(temuMainId) {
      const tasks = this.workflow && this.workflow.tasks ? this.workflow.tasks : {};
      const task = tasks[String(temuMainId)];
      if (task && task.status === "completed") {
        return "done";
      }
      if (task && (task.status === "generation_error" || task.status === "search_error")) {
        return "failed";
      }
      return task && task.status && task.status !== "idle" ? "working" : "idle";
    }
  }
});

workflowApp.mount("#workflow-app");
