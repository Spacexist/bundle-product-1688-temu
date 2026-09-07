const carouselModule = require("./carousel-runtime.service");

const createCarouselError = carouselModule.createCarouselError;

/** Persist and coordinate one active multi-image fusion task per Temu product. */
class MultiFusionRuntimeService extends carouselModule.CarouselRuntimeService {
  /** Reuse carousel page/version persistence while isolating multi-fusion task files. */
  constructor(options) {
    super(Object.assign({}, options || {}, { runtimeName: "multi-fusion" }));
  }

  /** Return whether two image sets contain the same selected source URLs. */
  hasSameSources(firstSources, secondSources) {
    const first = Array.isArray(firstSources) ? firstSources.slice() : [];
    const second = Array.isArray(secondSources) ? secondSources.slice() : [];
    first.sort();
    second.sort();
    if (first.length !== second.length || first.length < 3) {
      return false;
    }
    for (let index = 0; index < first.length; index += 1) {
      if (String(first[index]) !== String(second[index])) {
        return false;
      }
    }
    return true;
  }

  /** Normalize one generated result slot for a multi-fusion batch. */
  createResultPage(index, prompt) {
    return {
      index: index,
      purpose: "多图融合 " + (index + 1),
      prompt: String(prompt || "").trim(),
      status: "pending",
      image_url: "",
      selected: true,
      error: "",
      error_code: ""
    };
  }

  /** Create a ready multi-fusion task while enforcing one active task per product. */
  createTask(input) {
    const source = input && typeof input === "object" ? input : {};
    const imageUrls = Array.isArray(source.image_urls) ? source.image_urls.slice() : [];
    const sourceIndices = Array.isArray(source.source_indices) ? source.source_indices.slice() : [];
    const prompt = String(source.prompt || "").trim();
    const count = Math.max(1, Math.min(10, Number(source.count || 1)));
    if (imageUrls.length < 3 || sourceIndices.length !== imageUrls.length) {
      throw createCarouselError("多图融合至少需要选择三张有效图片。", 400, "MULTI_FUSION_SOURCE_INVALID");
    }
    if (!prompt) {
      throw createCarouselError("多图融合提示词不能为空。", 400, "MULTI_FUSION_PROMPT_EMPTY");
    }
    const seenIndices = {};
    for (let index = 0; index < sourceIndices.length; index += 1) {
      const key = String(Number(sourceIndices[index]));
      if (seenIndices[key]) {
        throw createCarouselError("多图融合不能重复选择同一张图片。", 400, "MULTI_FUSION_SOURCE_INDEX_INVALID");
      }
      seenIndices[key] = true;
    }
    const existing = this.findActiveTaskByTemuMainId(source.temu_main_id);
    if (existing) {
      if (this.hasSameSources(existing.source_image_urls, imageUrls)) {
        return { task: existing, existing: true };
      }
      throw createCarouselError("该 Temu 商品已有未完成多图融合任务。", 409, "MULTI_FUSION_TASK_EXISTS", { task: existing });
    }
    const taskId = "multi-fusion-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
    const pages = [];
    for (let index = 0; index < count; index += 1) {
      pages.push(this.createResultPage(index, prompt));
    }
    const task = {
      id: taskId,
      type: "multi-fusion",
      temu_main_id: String(source.temu_main_id || ""),
      temu_platform_id: String(source.temu_platform_id || ""),
      source_image_urls: imageUrls,
      source_indices: sourceIndices,
      gallery_snapshot: Array.isArray(source.gallery_snapshot) ? source.gallery_snapshot.slice() : [],
      count: count,
      market_language: "",
      requirement: prompt,
      mode: "multi-fusion",
      reasoning_enabled: false,
      size: this.normalizeCarouselImageSize(source.size),
      status: "ready",
      estimated_tokens: 0,
      pages: pages,
      error: "",
      error_code: "",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    this.writeTask(task);
    return { task: task, existing: false };
  }

  /** Create a ready multi-fusion task from manually configured storyboard prompts. */
  createManualTask(input) {
    const source = input && typeof input === "object" ? input : {};
    const pages = this.normalizeManualPages(source.pages);
    const created = this.createTask(Object.assign({}, source, {
      count: pages.length,
      prompt: "手动多图分镜"
    }));
    if (created.existing) {
      return created.task;
    }
    const task = created.task;
    task.mode = "manual";
    task.count = pages.length;
    task.requirement = "手动多图分镜";
    task.reasoning_enabled = false;
    task.estimated_tokens = 0;
    task.pages = pages;
    task.status = "ready";
    task.error = "";
    task.error_code = "";
    return this.writeTask(task);
  }

  /** Create one task and immediately submit every requested result slot. */
  createAndStartTask(input, requestId) {
    const created = this.createTask(input);
    const task = created.task;
    if (!created.existing) {
      const pageIndices = [];
      for (let index = 0; index < task.pages.length; index += 1) {
        pageIndices.push(index);
      }
      this.startGeneration(task.id, pageIndices, requestId);
    }
    return this.readTask(task.id) || task;
  }

  /** Generate one multi-fusion result page from all selected source images. */
  async generatePage(taskId, pageIndex, requestId, referenceMode, maskUrl, maskMode) {
    const generationId = "multi-fusion-page-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
    const initialTask = this.readTask(taskId);
    const initialPage = initialTask && initialTask.pages[Number(pageIndex)];
    if (!initialTask || !initialPage) {
      throw createCarouselError("多图融合结果页不存在。", 404, "MULTI_FUSION_PAGE_NOT_FOUND");
    }
    const useCurrentImage = String(referenceMode || "original") === "current";
    const retainedInputUrl = String(initialPage.image_url || "");
    const initialVersions = this.normalizePageImageVersions(initialPage);
    const replacementVersionIndex = useCurrentImage ? initialVersions.indexOf(retainedInputUrl) : -1;
    const scopedMaskMode = useCurrentImage && (maskMode === "cutout" || maskMode === "annotated") ? "annotated" : "";
    const scopedMaskUrl = useCurrentImage ? String(maskUrl || "").trim() : "";
    const maskImageUrl = scopedMaskMode && scopedMaskUrl && this.images && typeof this.images.cacheMaskImage === "function"
      ? this.images.cacheMaskImage(scopedMaskUrl, generationId)
      : scopedMaskUrl;
    if (scopedMaskMode && !maskImageUrl) {
      throw createCarouselError("局部标注任务缺少已保存的标记图。", 400, "MULTI_FUSION_MASK_MISSING");
    }
    const currentPageImageUrl = useCurrentImage ? this.assertCurrentPageImageAvailable(initialPage) : "";
    const imageUrls = useCurrentImage
      ? scopedMaskMode && maskImageUrl ? [maskImageUrl] : [currentPageImageUrl]
      : initialTask.source_image_urls.slice();
    const task = this.markPageGenerating(taskId, pageIndex, generationId);
    const page = task.pages[Number(pageIndex)];
    page.mask_mode = scopedMaskMode;
    page.mask_image_url = scopedMaskMode ? maskImageUrl : "";
    this.writeTask(task);
    const pageRequestId = String(requestId || task.id) + "-p" + Number(pageIndex) + "-" + generationId;
    const controller = new AbortController();
    const controllerKey = this.getGenerationControllerKey(task.id, pageIndex, generationId);
    this.generationControllers[controllerKey] = controller;
    try {
      const normalizedSize = this.normalizeCarouselImageSize(task.size);
      const service = this;
      const result = await this.providers.editImages({
        multi_fusion_task_id: task.id,
        temu_main_id: task.temu_main_id,
        temu_platform_id: task.temu_platform_id,
        multi_fusion_page_index: Number(pageIndex),
        generation_id: generationId,
        image_urls: imageUrls,
        prompt: useCurrentImage ? this.buildCurrentImageEditPrompt(task, page, scopedMaskUrl, scopedMaskMode) : String(page.prompt || task.requirement || ""),
        mask_mode: scopedMaskMode,
        mask_url: scopedMaskMode ? "" : scopedMaskUrl,
        mask_image_url: scopedMaskMode ? maskImageUrl : "",
        size: normalizedSize,
        task_scope: "multi-fusion",
        cancel_signal: controller.signal,
        /** Store the upstream task ID against this exact multi-fusion page execution. */
        on_provider_state: function persistMultiFusionProviderState(state) {
          service.persistProviderState(task.id, pageIndex, generationId, state);
        },
        /** Return whether the owning multi-fusion task or generation slot was abandoned. */
        is_cancelled: function isMultiFusionPageGenerationCancelled() {
          const current = service.readTask(task.id);
          return service.isTaskCancelled(task.id) || !current || !current.pages[Number(pageIndex)]
            || current.pages[Number(pageIndex)].generation_id !== generationId;
        }
      }, useCurrentImage ? "edit" : "fusion", pageRequestId);
      this.assertTaskAvailable(task.id);
      const completedTask = this.markPageSucceeded(task.id, pageIndex, result.image_url, generationId, retainedInputUrl, replacementVersionIndex);
      if (!completedTask) {
        this.deleteGeneratedImage(result.image_url);
      }
      return completedTask;
    } catch (error) {
      return this.markPageFailed(task.id, pageIndex, error, generationId);
    } finally {
      if (this.generationControllers[controllerKey] === controller) {
        delete this.generationControllers[controllerKey];
      }
    }
  }

  /** Delete one multi-fusion task and cancel queued provider work owned by it. */
  deleteTask(taskId, removeImages) {
    const safeTaskId = this.normalizeTaskId(taskId);
    const task = super.deleteTask(taskId, removeImages);
    if (this.providers && typeof this.providers.cancelImageTasks === "function") {
      this.providers.cancelImageTasks(function matchMultiFusionImageQueueTask(metadata) {
        return String(metadata && metadata.multi_fusion_task_id || "") === safeTaskId;
      });
    }
    return task;
  }
}

module.exports = { MultiFusionRuntimeService: MultiFusionRuntimeService };
