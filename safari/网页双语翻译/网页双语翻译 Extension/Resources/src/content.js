// 本文件由 scripts/build-content.mjs 从 src/content/ 各模块拼接生成。
// 请勿直接编辑;修改 src/content/ 后运行 npm run build-content。
(() => {
  if (globalThis.__AI_PAGE_TRANSLATOR_LOADED__) {
    return;
  }
  globalThis.__AI_PAGE_TRANSLATOR_LOADED__ = true;

  const MARKER = "data-ai-page-translator";
  const OWNED_MARKER = "data-ai-page-translator-owned";
  const ORIGINAL_CLASS = "ai-page-translator-original";
  const TRANSLATION_CLASS = "ai-page-translator-translation";
  const STYLE_ID = "ai-page-translator-style";
  const STATUS_ID = "ai-page-translator-status";
  const STRUCTURED_TEXT_SELECTOR = [
    "[data-testid='tweetText']",
    "[data-testid='tweet-text']",
    "[data-testid='postText']",
    "[data-testid='post-text']",
    "[data-testid='status-content']",
    "[data-testid='commentText']",
    "[data-testid='comment-text']"
  ].join(", ");
  const VIEW_CLASSES = [
    "ai-page-translator-bilingual",
    "ai-page-translator-translated"
  ];
  const BLOCK_LEVEL_TAGS = new Set([
    "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DETAILS", "DIALOG",
    "DIV", "DL", "FIELDSET", "FIGCAPTION", "FIGURE", "FOOTER", "FORM",
    "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HR", "LI", "MAIN",
    "NAV", "OL", "P", "PRE", "SECTION", "TABLE", "UL"
  ]);
  const INLINE_TEXT_BLOCK_MIN_LENGTH = 20;
  const DYNAMIC_RESCAN_DELAYS = [0, 400, 900];
  const DEFAULT_TEXT_MAX_LENGTH = 1200;
  const LOCAL_TRANSLATION_BATCH_CONCURRENCY = 2;
  const REMOTE_TRANSLATION_BATCH_CONCURRENCY = 3;
  const LOCAL_FIRST_BATCH_SEGMENT_LIMIT = 5;
  const LOCAL_FIRST_BATCH_CHARACTER_LIMIT = 1400;
  const LOCAL_BATCH_SEGMENT_LIMIT = 18;
  const LOCAL_BATCH_CHARACTER_LIMIT = 4200;
  const REMOTE_FIRST_BATCH_SEGMENT_LIMIT = 4;
  const REMOTE_FIRST_BATCH_CHARACTER_LIMIT = 900;
  const REMOTE_BATCH_SEGMENT_LIMIT = 18;
  const REMOTE_BATCH_CHARACTER_LIMIT = 4200;
  // 推文等结构化正文经常超过 1200 字符，放宽到接近单批 4200 字符的预算，
  // 这样长推文仍可整体翻译而不会被静默跳过。
  const STRUCTURED_TEXT_MAX_LENGTH = 4000;
  const MUTATION_SCAN_DEBOUNCE_MS = 120;
  const PERSISTENT_CACHE_KEY_PREFIX = "aiPageTranslatorCache:";
  const PERSISTENT_CACHE_INDEX_KEY = "aiPageTranslatorCacheIndex";
  const PERSISTENT_CACHE_MAX_ENTRIES = 3000;
  const TARGET_LANGUAGE_SCRIPT_PATTERNS = {
    "zh-CN": /[\u3400-\u9fff]/,
    "zh-TW": /[\u3400-\u9fff]/,
    ja: /[\u3040-\u30ff\u3400-\u9fff]/,
    ko: /[\uac00-\ud7af]/
  };
  let taskGeneration = 0;
  let persistentCacheWriteChain = Promise.resolve();
  const persistentCachePendingWrites = new Map();
  let activeSession = null;
  let pendingStartJobId = "";

  let state = {
    status: "idle",
    translated: 0,
    total: 0,
    viewMode: "bilingual",
    error: ""
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "GET_PAGE_STATE") {
      sendResponse({ ok: true, state });
      return false;
    }

    if (message?.type === "SET_VIEW_MODE") {
      setViewMode(message.viewMode);
      sendResponse({ ok: true, state });
      return false;
    }

    if (message?.type === "RESTORE_PAGE") {
      cancelAndRestore();
      sendResponse({ ok: true, state });
      return false;
    }

    if (message?.type === "CLEAR_PAGE_CACHE") {
      clearPagePersistentCache()
        .then(() => sendResponse({ ok: true, state }))
        .catch((error) =>
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            state
          })
        );
      return true;
    }

    if (message?.type === "TRANSLATE_PAGE") {
      if (state.status === "translating") {
        sendResponse({
          ok: false,
          error: "页面正在翻译，请稍候",
          state
        });
        return false;
      }
      if (!message.settings) {
        message.settings = message.pageSettings;
      }
      const settings = message.settings;
      if (!message.jobId || !settings) {
        sendResponse({
          ok: false,
          error: "翻译任务缺少 jobId 或页面设置",
          state
        });
        return false;
      }
      pendingStartJobId = message.jobId;
      startTranslation(message.settings);
      sendResponse({ ok: true, started: true, state });
      return false;
    }

    return false;
  });

  window.addEventListener("pagehide", () => {
    const session = activeSession;
    if (!session) {
      return;
    }
    taskGeneration += 1;
    stopSessionActivity(session);
    if (!session.jobClosed) {
      session.jobClosed = true;
      sendJobMessage("RELEASE_TRANSLATION_JOB", session.jobId);
    }
    activeSession = null;
  }, { once: true });

  function startTranslation(settings) {
    const jobId = pendingStartJobId;
    pendingStartJobId = "";
    if (activeSession) {
      cancelSession(activeSession);
    }

    const nextSettings = { ...settings };
    const taskId = ++taskGeneration;
    clearTranslations(nextSettings.viewMode || state.viewMode);
    ensureStyles();
    setViewMode(nextSettings.viewMode || "bilingual");

    const session = {
      taskId,
      jobId,
      settings: nextSettings,
      maxPlacements: normalizePlacementLimit(nextSettings.maxSegments),
      usedPlacements: 0,
      countedTargets: new WeakSet(),
      pendingRetranslationTargets: new Set(),
      segmentCounter: 0,
      translationCache: new Map(),
      observer: null,
      mutationTimer: null,
      statusHideTimer: null,
      scanRunning: false,
      scanStats: null,
      rescanRequested: false,
      initializing: true,
      jobClosed: false
    };
    activeSession = session;
    state = {
      status: "translating",
      translated: 0,
      total: 0,
      viewMode: nextSettings.viewMode || "bilingual",
      error: ""
    };
    showStatus("正在查找可翻译内容", "working");
    observeDynamicContent(session);

    translatePage(session).catch((error) => {
      handleTaskError(session, error);
    });
  }

  function handleTaskError(session, error) {
    if (!isCurrentSession(session)) {
      return;
    }
    stopSessionActivity(session);
    cancelBackgroundJob(session);
    const messageText =
      error instanceof Error ? error.message : String(error);
    state = { ...state, status: "error", error: messageText };
    showStatus(messageText, "error");
  }

  function cancelSession(session) {
    stopSessionActivity(session);
    cancelBackgroundJob(session);
  }

  function stopSessionActivity(session) {
    session.observer?.disconnect();
    if (session.mutationTimer !== null) {
      window.clearTimeout(session.mutationTimer);
      session.mutationTimer = null;
    }
    clearScheduledStatusHide(session);
  }

  function cancelBackgroundJob(session) {
    if (session.jobClosed) {
      return;
    }
    session.jobClosed = true;
    sendJobMessage("CANCEL_TRANSLATION_JOB", session.jobId);
  }

  function sendJobMessage(type, jobId) {
    if (!jobId) {
      return;
    }
    try {
      const pending = chrome.runtime.sendMessage({ type, jobId });
      pending?.catch?.(() => {});
    } catch (_error) {
      // The page may be unloading or the extension may have been reloaded.
    }
  }

  function isCurrentSession(session) {
    return Boolean(
      session &&
      activeSession === session &&
      session.taskId === taskGeneration
    );
  }

  function setViewMode(viewMode) {
    const nextMode =
      viewMode === "translated" ? "translated" : "bilingual";
    document.documentElement.classList.remove(...VIEW_CLASSES);
    document.documentElement.classList.add(
      nextMode === "translated"
        ? "ai-page-translator-translated"
        : "ai-page-translator-bilingual"
    );
    state = { ...state, viewMode: nextMode };
  }

  function cancelAndRestore() {
    taskGeneration += 1;
    if (activeSession) {
      cancelSession(activeSession);
      activeSession = null;
    }
    clearTranslations(state.viewMode);
  }

  function clearTranslations(viewMode) {
    const translatedElements = document.querySelectorAll(`[${MARKER}]`);
    for (const element of translatedElements) {
      if (element.dataset.translatorTarget === "heading") {
        const next = element.nextElementSibling;
        if (next?.dataset.translatorForHeading === "true") {
          next.remove();
        }
        element.removeAttribute(MARKER);
        delete element.dataset.translatorTarget;
        continue;
      }
      if (element.dataset.translatorTarget === "flow") {
        const original = element.querySelector(
          `:scope > .${ORIGINAL_CLASS}`
        );
        if (original && element.parentNode) {
          while (original.firstChild) {
            element.parentNode.insertBefore(original.firstChild, element);
          }
        }
        element.remove();
        continue;
      }
      if (element.dataset.translatorTarget === "element") {
        element.querySelector(
          `:scope > [data-translator-for-element='true']`
        )?.remove();
        element.removeAttribute(MARKER);
        delete element.dataset.translatorTarget;
        element.style.removeProperty(
          "--ai-translator-element-original-size"
        );
        continue;
      }
      const original = element.querySelector(`:scope > .${ORIGINAL_CLASS}`);
      const translation = element.querySelector(
        `:scope > .${TRANSLATION_CLASS}`
      );
      if (element.dataset.translatorTarget === "text") {
        element.replaceWith(
          document.createTextNode(original?.textContent || "")
        );
        continue;
      }
      if (original) {
        while (original.firstChild) {
          element.insertBefore(original.firstChild, original);
        }
        original.remove();
      }
      translation?.remove();
      element.removeAttribute(MARKER);
      delete element.dataset.translatorTarget;
    }
    document.documentElement.classList.remove(...VIEW_CLASSES);
    hideStatus();
    state = {
      status: "idle",
      translated: 0,
      total: 0,
      viewMode:
        viewMode === "translated" ? "translated" : "bilingual",
      error: ""
    };
  }

  function assertCurrentTask(taskId) {
    if (
      taskId !== taskGeneration ||
      !activeSession ||
      activeSession.taskId !== taskId ||
      activeSession.jobClosed
    ) {
      const error = new Error("翻译任务已取消");
      error.code = "TRANSLATION_CANCELED";
      throw error;
    }
    return activeSession;
  }

  async function translatePage(session) {
    const { settings, taskId } = session;
    const rescanDelays = shouldRescanDynamicContent()
      ? DYNAMIC_RESCAN_DELAYS
      : [0];
    let foundCandidates = false;

    let totalFailures = 0;
    try {
      for (const delay of rescanDelays) {
        if (delay > 0) {
          await wait(delay);
        }
        assertCurrentTask(taskId);
        const result = await translateCurrentCandidates(session);
        foundCandidates = foundCandidates || result.discovered > 0;
        totalFailures += countFailedPlacements(result.failures);
      }
    } finally {
      session.initializing = false;
    }

    const hasFailures = totalFailures > 0;
    state = {
      ...state,
      status: hasFailures ? "error" : "done",
      translated: session.usedPlacements,
      total: session.usedPlacements,
      error: hasFailures ? `${totalFailures} 处内容翻译失败` : ""
    };
    showStatus(
      hasFailures
        ? `已翻译 ${session.usedPlacements} 处内容，${totalFailures} 处失败`
        : foundCandidates
          ? `已翻译 ${session.usedPlacements} 处内容`
          : "暂未发现正文，正在监听动态内容",
      hasFailures ? "error" : "success"
    );
    if (!hasFailures) {
      scheduleStatusHide(session);
    }
    if (session.rescanRequested) {
      session.rescanRequested = false;
      scheduleIncrementalScan(session, 0);
    }
  }

  async function translateCurrentCandidates(session) {
    assertCurrentTask(session.taskId);
    if (session.scanRunning) {
      session.rescanRequested = true;
      return { discovered: 0, failures: [] };
    }

    const remaining = session.maxPlacements - session.usedPlacements;
    if (
      remaining <= 0 &&
      session.pendingRetranslationTargets.size === 0
    ) {
      return { discovered: 0, failures: [] };
    }

    session.scanRunning = true;
    const stats = createScanStats(session);
    session.scanStats = stats;
    try {
      const settings = session.settings;
      const rawCollected = collectCandidates(
        session.maxPlacements +
          session.pendingRetranslationTargets.size
      );
      const collected = rawCollected.filter(
        (placement) =>
          !isAlreadyTargetLanguage(placement.text, settings.targetLanguage)
      );
      stats.collected = rawCollected.length;
      stats.skippedTargetLanguage =
        rawCollected.length - collected.length;
      let availableNewPlacements = remaining;
      const placements = collected.filter((placement) => {
        if (session.countedTargets.has(placementIdentity(placement))) {
          return true;
        }
        if (availableNewPlacements <= 0) {
          return false;
        }
        availableNewPlacements -= 1;
        return true;
      });
      recordPlacementTypes(stats, placements);
      if (placements.length === 0) {
        return { discovered: 0, failures: [] };
      }

      clearScheduledStatusHide(session);
      state = {
        ...state,
        status: "translating",
        total:
          session.usedPlacements +
          placements.filter(
            (placement) =>
              !session.countedTargets.has(placementIdentity(placement))
          ).length,
        error: ""
      };
      showTranslationProgress(session);

      const groups = await groupCandidatePlacements(placements, session);
      stats.groups = groups.length;
      assertCurrentTask(session.taskId);
      for (const group of groups) {
        const cached = session.translationCache.get(group.key);
        if (cached) {
          stats.cacheHits += 1;
          applyTranslatedGroup(session, group, cached);
        }
      }

      const candidates = groups
        .filter((group) => !group.applied)
        .flatMap((group) => group.fragments);
      stats.segments = candidates.length;
      let batchFailures = [];
      if (candidates.length > 0) {
        const batches = makeBatches(candidates, settings);
        stats.batches = batches.length;
        batchFailures = await translateCandidateBatches(
          batches,
          getTranslationBatchConcurrency(settings),
          shouldWarmupFirstBatch(settings),
          session.taskId,
          (batch, response) => {
            const touchedGroups = new Set();
            for (const candidate of batch) {
              const translatedText = response.translations[candidate.id];
              if (!translatedText) {
                stats.missingTranslations += 1;
                continue;
              }
              candidate.group.translations.set(
                candidate.id,
                translatedText
              );
              touchedGroups.add(candidate.group);
            }

            for (const group of touchedGroups) {
              if (
                !group.applied &&
                group.translations.size === group.fragments.length
              ) {
                const translatedText = group.fragments
                  .map((fragment) =>
                    group.translations.get(fragment.id)
                  )
                  .join(group.preserveLayout ? "\n" : " ");
                session.translationCache.set(group.key, translatedText);
                applyTranslatedGroup(session, group, translatedText);
                queuePersistentCacheWrite(
                  session,
                  group.key,
                  translatedText
                );
              }
            }
            showTranslationProgress(session);
          }
        );
      }

      assertCurrentTask(session.taskId);
      recordUnappliedGroups(stats, groups);
      recordBatchErrors(stats, batchFailures);
      const failedPlacements = countFailedPlacements(batchFailures);
      stats.failedPlacements = failedPlacements;
      const hasFailures = failedPlacements > 0;
      state = {
        ...state,
        status: hasFailures ? "error" : "done",
        translated: session.usedPlacements,
        total: session.usedPlacements,
        error: hasFailures
          ? `${failedPlacements} 处内容翻译失败`
          : ""
      };
      showStatus(
        hasFailures
          ? `已翻译 ${session.usedPlacements} 处内容，${failedPlacements} 处失败`
          : `已翻译 ${session.usedPlacements} 处内容`,
        hasFailures ? "error" : "success"
      );
      if (!hasFailures) {
        scheduleStatusHide(session);
      }
      return { discovered: placements.length, failures: batchFailures };
    } finally {
      session.scanRunning = false;
      session.scanStats = null;
      logScanDiagnostics(session, stats);
    }
  }

  // ==== 临时诊断（定位“只翻译了一小部分”）====================
  // 每轮扫描输出一行 [双语翻译诊断]，把“采集到多少 / 过滤掉多少 /
  // 发了几批 / 落地成功多少 / 各类丢失多少”摊开。定位完可整块删除，
  // 并移除 pipeline.js 中对 stats 的赋值。
  function createScanStats(session) {
    return {
      startedAt: Date.now(),
      usedAtStart: session.usedPlacements,
      collected: 0,
      skippedTargetLanguage: 0,
      placements: 0,
      byType: {},
      groups: 0,
      cacheHits: 0,
      segments: 0,
      batches: 0,
      missingTranslations: 0,
      appliedPlacements: 0,
      applyFailedDetached: 0,
      applyFailedMarked: 0,
      limitSkipped: 0,
      unappliedGroups: 0,
      unappliedSamples: [],
      duplicatedTails: [],
      batchErrors: [],
      failedPlacements: 0
    };
  }

  function recordPlacementTypes(stats, placements) {
    stats.placements = placements.length;
    for (const placement of placements) {
      const kind = placement.structured
        ? "structured"
        : placement.targetType;
      stats.byType[kind] = (stats.byType[kind] || 0) + 1;
      recordDuplicatedTail(stats, placement);
    }
  }

  // 定位“链接文字在段末被重复一遍”：找出正文里结尾片段在前文已出现过
  // 的 placement，连同它的类型、目标标签和直接子节点一起打出来。
  function recordDuplicatedTail(stats, placement) {
    const tail = findDuplicatedTail(placement.text);
    if (!tail || stats.duplicatedTails.length >= 4) {
      return;
    }
    const target = placement.target;
    const element = target?.nodeType === Node.ELEMENT_NODE
      ? target
      : target?.parentElement;
    stats.duplicatedTails.push({
      类型: placement.targetType,
      目标: element
        ? `${element.tagName.toLowerCase()}[${
          window.getComputedStyle(element).display
        }]`
        : String(target?.nodeName || ""),
      重复片段: tail,
      正文长度: placement.text.length,
      flow节点: (placement.nodes || []).map((node) =>
        node.nodeType === Node.ELEMENT_NODE
          ? node.tagName.toLowerCase()
          : "#text"
      ),
      目标子节点: element
        ? [...element.childNodes].map((node) =>
          node.nodeType === Node.ELEMENT_NODE
            ? node.tagName.toLowerCase()
            : "#text"
        )
        : []
    });
  }

  function findDuplicatedTail(text) {
    const normalized = String(text || "").trim();
    for (let length = 40; length >= 12; length -= 4) {
      if (normalized.length < length * 2) {
        continue;
      }
      const tail = normalized.slice(-length);
      if (normalized.slice(0, -length).includes(tail)) {
        return tail;
      }
    }
    return "";
  }

  function recordUnappliedGroups(stats, groups) {
    for (const group of groups) {
      if (group.applied) {
        continue;
      }
      stats.unappliedGroups += 1;
      if (stats.unappliedSamples.length < 3) {
        stats.unappliedSamples.push(group.text.slice(0, 60));
      }
    }
  }

  function recordBatchErrors(stats, failures) {
    for (const failure of failures) {
      stats.batchErrors.push({
        segments: failure.batch.length,
        code: failure.error?.code || "",
        message:
          failure.error instanceof Error
            ? failure.error.message
            : String(failure.error)
      });
    }
  }

  function logScanDiagnostics(session, stats) {
    if (!stats) {
      return;
    }
    // 这个函数是在 finally 里调用的：诊断自身抛异常会顶掉真正的错误。
    try {
      writeScanDiagnostics(session, stats);
    } catch (_error) {
      // 诊断失败不影响翻译本身。
    }
  }

  function writeScanDiagnostics(session, stats) {
    console.info("[双语翻译诊断]", {
      页面: location.href,
      正文根: describeContentRoots(),
      耗时毫秒: Date.now() - stats.startedAt,
      后端: session.settings.backend,
      上限maxSegments: session.maxPlacements,
      "1_采集到": stats.collected,
      "2_已是目标语言跳过": stats.skippedTargetLanguage,
      "3_本轮候选": stats.placements,
      "3b_候选类型": stats.byType,
      "3c_正文含重复片段": stats.duplicatedTails,
      "4_去重后分组": stats.groups,
      "4b_命中缓存": stats.cacheHits,
      "5_待翻译片段": stats.segments,
      "5b_请求批次": stats.batches,
      "6_模型漏译片段": stats.missingTranslations,
      "7_落地成功": stats.appliedPlacements,
      "7a_落地失败_节点已断开": stats.applyFailedDetached,
      "7b_落地失败_已被标记": stats.applyFailedMarked,
      "7c_超出上限跳过": stats.limitSkipped,
      "8_始终没拿到译文的分组": stats.unappliedGroups,
      "8b_样例": stats.unappliedSamples,
      "9_失败批次": stats.batchErrors,
      "9b_计入失败的位置数": stats.failedPlacements
    });
  }
  // ==== 临时诊断结束 =========================================

  async function groupCandidatePlacements(placements, session) {
    const groupsByKey = new Map();
    for (const placement of placements) {
      const preserveLayout = Boolean(placement.preserveLayout);
      const key = `${preserveLayout ? "layout" : "plain"}\u0000${placement.text}`;
      let group = groupsByKey.get(key);
      if (!group) {
        group = {
          key,
          text: placement.text,
          preserveLayout,
          placements: [],
          fragments: [],
          translations: new Map(),
          applied: false
        };
        groupsByKey.set(key, group);
      }
      group.placements.push(placement);
    }

    await hydratePersistentCache(session, [...groupsByKey.values()]);

    for (const group of groupsByKey.values()) {
      if (session.translationCache.has(group.key)) {
        continue;
      }
      const maxLength = group.preserveLayout
        ? STRUCTURED_TEXT_MAX_LENGTH
        : DEFAULT_TEXT_MAX_LENGTH;
      group.fragments = splitTextAtSemanticBoundaries(
        group.text,
        maxLength
      ).map((text) => ({
        id: `segment-${++session.segmentCounter}`,
        text,
        preserveLayout: group.preserveLayout,
        group
      }));
    }
    return [...groupsByKey.values()];
  }

  function applyTranslatedGroup(session, group, translatedText) {
    if (group.applied) {
      return;
    }
    let newPlacements = 0;
    const stats = session.scanStats;
    withObserverPaused(session, () => {
      for (const [index, placement] of group.placements.entries()) {
        const identity = placementIdentity(placement);
        const alreadyCounted = session.countedTargets.has(
          identity
        );
        if (
          !alreadyCounted &&
          session.usedPlacements + newPlacements >=
            session.maxPlacements
        ) {
          if (stats) {
            stats.limitSkipped += group.placements.length - index;
          }
          break;
        }
        if (
          applyTranslation(
            placement.target,
            placement.targetType,
            translatedText,
            session.settings.targetLanguage,
            placement.nodes
          )
        ) {
          if (stats) {
            stats.appliedPlacements += 1;
          }
          session.pendingRetranslationTargets.delete(placement.target);
          if (!alreadyCounted) {
            session.countedTargets.add(identity);
            newPlacements += 1;
          }
        } else if (!placement.target.isConnected) {
          if (stats) {
            stats.applyFailedDetached += 1;
          }
          session.pendingRetranslationTargets.delete(placement.target);
        } else if (stats) {
          stats.applyFailedMarked += 1;
        }
      }
    });
    session.usedPlacements += newPlacements;
    group.applied = true;
  }

  function placementIdentity(placement) {
    return placement.targetType === "flow"
      ? placement.nodes?.[0] || placement.target
      : placement.target;
  }

  async function translateCandidateBatches(
    batches,
    concurrency,
    warmupFirstBatch,
    taskId,
    onBatchTranslated
  ) {
    let workerBatches = batches;
    const failures = [];
    if (warmupFirstBatch && batches.length > 1) {
      try {
        const response = await requestTranslationBatch(batches[0], taskId);
        assertCurrentTask(taskId);
        onBatchTranslated(batches[0], response);
      } catch (error) {
        if (isFatalBatchError(error)) {
          throw error;
        }
        failures.push({ batch: batches[0], error });
      }
      workerBatches = batches.slice(1);
    }

    let nextIndex = 0;
    let fatalError = null;
    const workerCount = Math.min(
      concurrency,
      workerBatches.length
    );

    async function worker() {
      while (!fatalError) {
        const batch = workerBatches[nextIndex];
        nextIndex += 1;
        if (!batch) {
          return;
        }

        try {
          const response = await requestTranslationBatch(batch, taskId);
          assertCurrentTask(taskId);
          if (fatalError) {
            return;
          }
          onBatchTranslated(batch, response);
        } catch (error) {
          if (isFatalBatchError(error)) {
            fatalError = error;
            return;
          }
          failures.push({ batch, error });
        }
      }
    }

    await Promise.all(
      Array.from({ length: workerCount }, () => worker())
    );
    if (fatalError) {
      throw fatalError;
    }
    return failures;
  }

  // 失败批次的数量不等于用户看到的失败条数：一个批次里可能有十几个
  // 片段，多个片段又可能同属一段正文。这里按“最终没能落到页面上的
  // 原文位置”计数，和“已翻译 N 处内容”用的是同一个单位。
  function countFailedPlacements(failures) {
    const failedGroups = new Set();
    for (const failure of failures) {
      for (const candidate of failure.batch) {
        if (candidate.group && !candidate.group.applied) {
          failedGroups.add(candidate.group);
        }
      }
    }
    let total = 0;
    for (const group of failedGroups) {
      total += group.placements.length;
    }
    return total;
  }

  function isFatalBatchError(error) {
    return Boolean(
      error?.canceled ||
      error?.code === "TRANSLATION_CANCELED" ||
      error?.code === "TRANSLATION_JOB_NOT_FOUND"
    );
  }

  function getTranslationBatchConcurrency(settings) {
    return settings?.backend === "deepseek"
      ? REMOTE_TRANSLATION_BATCH_CONCURRENCY
      : LOCAL_TRANSLATION_BATCH_CONCURRENCY;
  }

  function shouldWarmupFirstBatch(settings) {
    return settings?.backend !== "deepseek";
  }

  async function requestTranslationBatch(batch, taskId) {
    let lastError = "翻译请求失败";
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const session = assertCurrentTask(taskId);
        const response = await chrome.runtime.sendMessage({
          type: "TRANSLATE_BATCH",
          jobId: session.jobId,
          segments: batch.map(({ id, text, preserveLayout }) => ({
            id,
            text,
            preserveLayout: Boolean(preserveLayout)
          }))
        });
        assertCurrentTask(taskId);
        if (response?.ok) {
          return response;
        }
        const responseError = new Error(response?.error || lastError);
        responseError.code = response?.code || "TRANSLATION_FAILED";
        responseError.canceled = Boolean(response?.canceled);
        throw responseError;
      } catch (error) {
        assertCurrentTask(taskId);
        if (
          error?.canceled ||
          error?.code === "TRANSLATION_CANCELED" ||
          error?.code === "TRANSLATION_JOB_NOT_FOUND"
        ) {
          throw error;
        }
        lastError = error instanceof Error ? error.message : String(error);
        // 临时诊断：把每次批次请求失败的原因打出来（超时 / 模型格式 /
        // 连接失败），定位完可删除。
        console.warn(
          `[双语翻译诊断] 批次请求失败 attempt=${attempt} ` +
          `segments=${batch.length} chars=${
            batch.reduce((total, item) => total + item.text.length, 0)
          } code=${error?.code || ""} ${lastError}`
        );
      }

      if (attempt === 0) {
        showStatus("翻译服务暂时无响应，正在重试", "working");
        await wait(600);
        assertCurrentTask(taskId);
      }
    }
    throw new Error(lastError);
  }

  function makeBatches(candidates, settings) {
    const batches = [];
    let current = [];
    let characters = 0;
    const isLocal = settings?.backend !== "deepseek";
    for (const candidate of candidates) {
      const isFirstBatch = batches.length === 0;
      const segmentLimit = isFirstBatch
        ? (
          isLocal
            ? LOCAL_FIRST_BATCH_SEGMENT_LIMIT
            : REMOTE_FIRST_BATCH_SEGMENT_LIMIT
        )
        : (
          isLocal
            ? LOCAL_BATCH_SEGMENT_LIMIT
            : REMOTE_BATCH_SEGMENT_LIMIT
        );
      const characterLimit = isFirstBatch
        ? (
          isLocal
            ? LOCAL_FIRST_BATCH_CHARACTER_LIMIT
            : REMOTE_FIRST_BATCH_CHARACTER_LIMIT
        )
        : (
          isLocal
            ? LOCAL_BATCH_CHARACTER_LIMIT
            : REMOTE_BATCH_CHARACTER_LIMIT
        );
      if (
        current.length > 0 &&
        (
          current.length >= segmentLimit ||
          characters + candidate.text.length > characterLimit
        )
      ) {
        batches.push(current);
        current = [];
        characters = 0;
      }
      current.push(candidate);
      characters += candidate.text.length;
    }
    if (current.length > 0) {
      batches.push(current);
    }
    return batches;
  }

  function hashText(text) {
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      h1 = Math.imul(h1 ^ code, 2654435761);
      h2 = Math.imul(h2 ^ code, 1597334677);
    }
    h1 =
      Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^
      Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 =
      Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^
      Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  }

  function pageCacheScope() {
    return `${location.hostname}${location.pathname}`;
  }

  function pageCachePrefix() {
    return `${PERSISTENT_CACHE_KEY_PREFIX}${hashText(pageCacheScope())}:`;
  }

  function clearPagePersistentCache() {
    activeSession?.translationCache.clear();
    const storage = chrome?.storage?.local;
    if (!storage) {
      return Promise.resolve();
    }
    const prefix = pageCachePrefix();
    const cleared = persistentCacheWriteChain.then(() =>
      removePagePersistentEntries(storage, prefix)
    );
    persistentCacheWriteChain = cleared.catch(() => {});
    return cleared;
  }

  async function removePagePersistentEntries(storage, prefix) {
    const indexResult = await storage.get(PERSISTENT_CACHE_INDEX_KEY);
    const index = Array.isArray(indexResult?.[PERSISTENT_CACHE_INDEX_KEY])
      ? indexResult[PERSISTENT_CACHE_INDEX_KEY]
      : [];
    const pageKeys = index.filter((key) => key.startsWith(prefix));
    if (pageKeys.length === 0) {
      return;
    }
    await storage.set({
      [PERSISTENT_CACHE_INDEX_KEY]: index.filter(
        (key) => !key.startsWith(prefix)
      )
    });
    await storage.remove(pageKeys);
  }

  function persistentCacheKey(targetLanguage, groupKey) {
    return `${pageCachePrefix()}${hashText(
      `${pageCacheScope()}\u0000${targetLanguage}\u0000${groupKey}`
    )}`;
  }

  async function hydratePersistentCache(session, groups) {
    const storage = chrome?.storage?.local;
    if (!storage) {
      return;
    }
    const targetLanguage = session.settings.targetLanguage;
    const lookup = new Map();
    for (const group of groups) {
      if (session.translationCache.has(group.key)) {
        continue;
      }
      lookup.set(persistentCacheKey(targetLanguage, group.key), group.key);
    }
    if (lookup.size === 0) {
      return;
    }

    let stored;
    try {
      stored = await storage.get([...lookup.keys()]);
    } catch (_error) {
      return;
    }
    for (const [storageKey, groupKey] of lookup) {
      const text = stored?.[storageKey];
      if (typeof text === "string" && text) {
        session.translationCache.set(groupKey, text);
      }
    }
  }

  function queuePersistentCacheWrite(session, groupKey, translatedText) {
    const storage = chrome?.storage?.local;
    if (!storage) {
      return;
    }
    const storageKey = persistentCacheKey(
      session.settings.targetLanguage,
      groupKey
    );
    // 整页翻译会产生上百次写入，逐条写会把整个索引数组（最多 3000 项）
    // 反复读出再写回。这里先攒进待写队列：一次落盘进行中时新到的条目
    // 会自动合并到下一次 flush，写入次数从“每条一次”降到“每轮一次”。
    persistentCachePendingWrites.set(storageKey, translatedText);
    persistentCacheWriteChain = persistentCacheWriteChain
      .then(() => flushPersistentCacheWrites(storage))
      .catch(() => {});
  }

  async function flushPersistentCacheWrites(storage) {
    if (persistentCachePendingWrites.size === 0) {
      return;
    }
    const entries = [...persistentCachePendingWrites];
    persistentCachePendingWrites.clear();

    const indexResult = await storage.get(PERSISTENT_CACHE_INDEX_KEY);
    const index = Array.isArray(indexResult?.[PERSISTENT_CACHE_INDEX_KEY])
      ? indexResult[PERSISTENT_CACHE_INDEX_KEY]
      : [];
    const writtenKeys = new Set(entries.map(([key]) => key));
    const nextIndex = index.filter((key) => !writtenKeys.has(key));
    for (const [key] of entries) {
      nextIndex.push(key);
    }

    const evicted = [];
    while (nextIndex.length > PERSISTENT_CACHE_MAX_ENTRIES) {
      evicted.push(nextIndex.shift());
    }

    await storage.set({
      ...Object.fromEntries(entries),
      [PERSISTENT_CACHE_INDEX_KEY]: nextIndex
    });
    if (evicted.length > 0) {
      await storage.remove(evicted);
    }
  }

  function scriptCharRatio(text, pattern) {
    const characters = [...text].filter((char) => /\S/u.test(char));
    if (characters.length === 0) {
      return 0;
    }
    const matched = characters.filter((char) => pattern.test(char)).length;
    return matched / characters.length;
  }

  function isAlreadyTargetLanguage(text, targetLanguage) {
    const pattern = TARGET_LANGUAGE_SCRIPT_PATTERNS[targetLanguage];
    if (!pattern) {
      return false;
    }
    return scriptCharRatio(text, pattern) >= 0.5;
  }

  function normalizePlacementLimit(value) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 220;
  }

  function collectCandidates(limit) {
    const roots = collectContentRoots();
    if (roots.length === 0) {
      return [];
    }

    const primarySelector =
      "h1, h2, h3, h4, h5, h6, p, blockquote, figcaption, td, th, [role='heading']";
    const isSocialPage = shouldRescanDynamicContent();
    const secondarySelector = isSocialPage
      ? ""
      : "li, summary, button, label, a, [class*='preview'], [class*='summary'], [class*='description'], [class*='excerpt']";
    const structuredTextElements = new Set(
      roots.flatMap((root) => collectStructuredTextElements(root))
    );
    const useFocusedSocialExtraction =
      isSocialPage && structuredTextElements.size > 0;
    const elements = new Set(structuredTextElements);
    for (const root of roots) {
      for (const element of root.querySelectorAll(primarySelector)) {
        elements.add(element);
      }
      if (secondarySelector) {
        for (const element of root.querySelectorAll(secondarySelector)) {
          elements.add(element);
        }
      }
      // 聚焦社交提取只想要推文本体，不能把时间线里的 UI 块卷进来。
      if (!useFocusedSocialExtraction) {
        for (const element of collectInlineTextBlocks(root)) {
          elements.add(element);
        }
      }
    }
    // 这两个列表在下面的逐元素循环里被反复扫描，先物化成数组，
    // 避免每次迭代都重新展开 Set（大页面上会退化成平方级开销）。
    const structuredTextList = [...structuredTextElements];
    const flowCandidates = useFocusedSocialExtraction
      ? []
      : roots.flatMap((root) =>
        collectFlowCandidates(root).filter(
          (candidate) =>
            !structuredTextList.some(
              (element) =>
                element === candidate.target ||
                element.contains(candidate.target) ||
                candidate.target.contains(element)
            )
        )
      );
    const flowElements = new Set(
      flowCandidates.flatMap((candidate) =>
        candidate.nodes.filter((node) => node.nodeType === Node.ELEMENT_NODE)
      )
    );
    const flowElementList = [...flowElements];
    const flowCoverage = buildFlowCoverage(flowCandidates);
    let candidates = [...flowCandidates];

    for (const element of elements) {
      if (candidates.length >= limit * 3) {
        break;
      }
      if (
        flowElements.has(element) ||
        isFullyCoveredByFlow(element, flowCoverage) ||
        flowElementList.some((flowElement) =>
          flowElement.contains(element)
        ) ||
        structuredTextList.some(
          (structuredElement) =>
            structuredElement !== element &&
            structuredElement.contains(element)
        )
      ) {
        continue;
      }
      const root = roots.find((candidateRoot) =>
        candidateRoot === element || candidateRoot.contains(element)
      );
      if (!root || !isEligible(element, root, primarySelector)) {
        continue;
      }

      const structured = structuredTextElements.has(element);
      const text = structured
        ? normalizeStructuredText(element.innerText || element.textContent)
        : normalizeText(element.innerText || element.textContent);
      const maxLength = structured
        ? STRUCTURED_TEXT_MAX_LENGTH
        : DEFAULT_TEXT_MAX_LENGTH;
      if (!isMeaningfulText(text, Number.POSITIVE_INFINITY)) {
        continue;
      }
      if (
        element.matches("a, button, label, summary") &&
        text.length <= 24 &&
        /^[A-Z0-9_.\s-]+$/.test(text)
      ) {
        continue;
      }

      candidates.push({
        text,
        target: element,
        targetType: "element",
        structured,
        preserveLayout: structured
      });
    }

    candidates = dedupeCandidatePlacements(
      removeAncestorConflicts(candidates)
    );
    const candidateElements = candidates
      .filter((item) => item.targetType !== "flow")
      .map((item) => item.target);
    const flowNodes = new Set(
      flowCandidates.flatMap((candidate) => candidate.nodes)
    );
    if (useFocusedSocialExtraction) {
      return candidates.slice(0, limit);
    }
    for (const root of roots) {
      for (const textNode of collectDirectTextNodes(root)) {
        if (candidates.length >= limit) {
          break;
        }
        const parent = textNode.parentElement;
        if (
          flowNodes.has(textNode) ||
          !parent ||
          candidateElements.some(
            (element) => element === parent || element.contains(parent)
          )
        ) {
          continue;
        }

        const text = normalizeText(textNode.textContent);
        if (!isMeaningfulText(text, Number.POSITIVE_INFINITY)) {
          continue;
        }

        candidates.push({
          text,
          target: textNode,
          targetType: "text"
        });
      }
      if (candidates.length >= limit) {
        break;
      }
    }
    return dedupeCandidatePlacements(candidates).slice(0, limit);
  }

  function collectContentRoots() {
    const selector =
      "main, [role='main'], #main, .main-contents, article";
    const matches = [...document.querySelectorAll(selector)];
    const topLevelMatches = matches.filter(
      (candidate) =>
        !matches.some(
          (other) => other !== candidate && other.contains(candidate)
        )
    );
    if (topLevelMatches.length > 0) {
      return topLevelMatches;
    }
    return document.body ? [document.body] : [];
  }

  // 临时诊断用：正文根是什么、里面有多少 p / div，用来判断段落是否
  // 落在 primarySelector 覆盖范围内。定位完可删除。
  function describeContentRoots() {
    return collectContentRoots()
      .map((root) => {
        const name = root.tagName.toLowerCase();
        const id = root.id ? `#${root.id}` : "";
        return `${name}${id}(p:${root.querySelectorAll("p").length},` +
          `div:${root.querySelectorAll("div").length},` +
          `li:${root.querySelectorAll("li").length})`;
      })
      .join(" | ");
  }

  function dedupeCandidatePlacements(candidates) {
    const seenTargets = new Set();
    const seenFlowStarts = new Set();
    return candidates.filter((candidate) => {
      if (candidate.targetType === "flow") {
        const firstNode = candidate.nodes?.[0];
        if (!firstNode || seenFlowStarts.has(firstNode)) {
          return false;
        }
        seenFlowStarts.add(firstNode);
        return true;
      }
      if (seenTargets.has(candidate.target)) {
        return false;
      }
      seenTargets.add(candidate.target);
      return true;
    });
  }

  function collectStructuredTextElements(root) {
    const exactMatches = [...root.querySelectorAll(STRUCTURED_TEXT_SELECTOR)];
    const fallbackMatches = [
      ...root.querySelectorAll(
        "article [lang][dir='auto'], [role='article'] [lang][dir='auto']"
      )
    ].filter((element) => {
      if (
        element.matches("a, button") ||
        element.closest("nav, header, footer, aside")
      ) {
        return false;
      }
      const text = normalizeStructuredText(
        element.innerText || element.textContent
      );
      return (
        text.length >= 20 &&
        !element.querySelector(STRUCTURED_TEXT_SELECTOR) &&
        !element.querySelector("[lang][dir='auto']")
      );
    });
    return [...new Set([...exactMatches, ...fallbackMatches])];
  }

  // flow 候选的 target 是容器本身（blockquote、只含内联子节点的 div 等），
  // 这些容器同时也可能进入元素候选，同一段正文就会被翻译两遍。只有当
  // flow 已经吃掉容器里全部有效子节点时才跳过元素候选——如果 flow 只覆盖
  // 了其中一段（例如靠 <br><br> 分段的容器），剩下的仍要交给元素候选。
  function buildFlowCoverage(flowCandidates) {
    const coverage = new Map();
    for (const candidate of flowCandidates) {
      let nodes = coverage.get(candidate.target);
      if (!nodes) {
        nodes = new Set();
        coverage.set(candidate.target, nodes);
      }
      for (const node of candidate.nodes) {
        nodes.add(node);
      }
    }
    return coverage;
  }

  function isFullyCoveredByFlow(element, coverage) {
    const covered = coverage.get(element);
    if (!covered) {
      return false;
    }
    for (const node of element.childNodes) {
      if (
        node.nodeType !== Node.TEXT_NODE &&
        node.nodeType !== Node.ELEMENT_NODE
      ) {
        continue;
      }
      if (!normalizeText(node.textContent)) {
        continue;
      }
      if (!covered.has(node)) {
        return false;
      }
    }
    return true;
  }

  // X 的文章编辑器把每个段落渲染成 div > span > span[data-text]：页面里
  // 一个 <p> 都没有，文本节点也不是块容器的直接子节点，primarySelector 和
  // collectDirectTextNodes 都够不着。这里把“子节点全是内联元素/文本的块级
  // 容器”本身当作一段正文，补上这类富文本编辑器渲染的页面。
  function collectInlineTextBlocks(root) {
    const blocks = [];
    for (const element of root.querySelectorAll("div, section, li")) {
      if (!isInlineTextBlock(element)) {
        continue;
      }
      // 裸 div 的数量远大于 <p>，没有下限就会把计数、按钮文案这类 UI
      // 碎片也当成正文。这里沿用 flow 候选和结构化回退的同一个阈值。
      // 只做长度粗筛，用 textContent 而非 innerText，避免强制回流。
      const text = normalizeText(element.textContent);
      if (text.length >= INLINE_TEXT_BLOCK_MIN_LENGTH) {
        blocks.push(element);
      }
    }
    return blocks;
  }

  function isInlineTextBlock(element) {
    // 先用标签名快速排除含块级子元素的包装层，避免对整页每个 div 都
    // 调用 getComputedStyle（大页面上这一步会成为瓶颈）。
    for (const child of element.children) {
      // 含 <br> 的容器可能是靠换行分段的（一个容器多段正文），
      // 那是 collectFlowCandidates 的活，这里不越权合并成一段。
      if (child.tagName === "BR" || BLOCK_LEVEL_TAGS.has(child.tagName)) {
        return false;
      }
    }
    const display = window.getComputedStyle(element).display;
    if (
      display !== "block" &&
      display !== "flow-root" &&
      display !== "list-item"
    ) {
      return false;
    }

    let hasText = false;
    for (const node of element.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        if (normalizeText(node.textContent)) {
          hasText = true;
        }
        continue;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) {
        continue;
      }
      const childDisplay = window.getComputedStyle(node).display;
      if (
        childDisplay !== "inline" &&
        childDisplay !== "inline-block" &&
        childDisplay !== "contents"
      ) {
        return false;
      }
      if (normalizeText(node.textContent)) {
        hasText = true;
      }
    }
    return hasText;
  }

  function collectFlowCandidates(root) {
    const candidates = [];
    const containers = [
      root,
      ...root.querySelectorAll("article, section, div, li, blockquote")
    ];

    for (const container of containers) {
      if (
        container.closest(`[${MARKER}]`) ||
        container.closest(`[${OWNED_MARKER}]`) ||
        container.closest(
          "script, style, noscript, code, pre, svg, canvas, iframe, textarea, input, select, [contenteditable='true'], [aria-hidden='true'], nav, header, footer, aside"
        )
      ) {
        continue;
      }

      let run = [];
      let consecutiveBreaks = 0;
      const flush = () => {
        const text = normalizeText(
          run.map((node) => node.textContent || "").join(" ")
        );
        const hasLink = run.some(
          (node) =>
            node.nodeType === Node.ELEMENT_NODE &&
            (node.matches("a") || node.querySelector?.("a"))
        );
        if (
          run.length >= 2 &&
          hasLink &&
          text.length >= 20 &&
          isMeaningfulText(text, Number.POSITIVE_INFINITY)
        ) {
          candidates.push({
            text,
            nodes: [...run],
            target: container,
            targetType: "flow"
          });
        }
        run = [];
        consecutiveBreaks = 0;
      };

      for (const node of container.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) {
          if (normalizeText(node.textContent)) {
            run.push(node);
            consecutiveBreaks = 0;
          }
          continue;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) {
          continue;
        }

        if (node.matches("br")) {
          consecutiveBreaks += 1;
          if (consecutiveBreaks >= 2) {
            flush();
          } else if (run.length > 0) {
            run.push(node);
          }
          continue;
        }

        const display = window.getComputedStyle(node).display;
        if (
          display === "inline" ||
          display === "inline-block" ||
          display === "contents"
        ) {
          run.push(node);
          consecutiveBreaks = 0;
        } else {
          flush();
        }
      }
      flush();
    }

    return removeOverlappingFlows(candidates);
  }

  function removeOverlappingFlows(candidates) {
    return candidates.filter(
      (candidate) =>
        !candidates.some(
          (other) =>
            other !== candidate &&
            other.nodes.some(
              (node) =>
                node.nodeType === Node.ELEMENT_NODE &&
                node.contains(candidate.target)
            )
        )
    );
  }

  function removeAncestorConflicts(candidates) {
    return candidates.filter(
      (candidate) => {
        if (candidate.targetType === "flow") {
          return true;
        }
        if (candidate.structured) {
          return true;
        }
        return !candidates.some(
          (other) =>
            other !== candidate &&
            other.targetType !== "flow" &&
            (other.structured
              ? other.target.contains(candidate.target) ||
                candidate.target.contains(other.target)
              : candidate.target.contains(other.target))
        );
      }
    );
  }

  function isEligible(element, root, primarySelector) {
    // 标题的译文块是插在标题“后面”的兄弟节点，不在 [MARKER] 子树内，
    // 只查 MARKER 会让它在下一轮扫描里被当成新正文再翻一遍。
    // 同理，flow 译文块是插在容器“里面”的，closest 只往上找，会让容器
    // （比如带行内链接的 <li>）在下一轮扫描里被整段再翻一遍。
    if (
      element.hasAttribute(MARKER) ||
      element.hasAttribute(OWNED_MARKER) ||
      element.closest(`[${MARKER}]`) ||
      element.closest(`[${OWNED_MARKER}]`) ||
      element.querySelector(`[${MARKER}], [${OWNED_MARKER}]`) ||
      element.closest(
        "script, style, noscript, code, pre, svg, canvas, iframe, textarea, input, select, [contenteditable='true'], [aria-hidden='true']"
      )
    ) {
      return false;
    }

    const excludedRegion = element.closest(
      "nav, header, footer, aside, [role='navigation'], [role='banner'], [role='contentinfo']"
    );
    if (excludedRegion && excludedRegion !== root) {
      return false;
    }

    if (
      element.matches("li") &&
      element.querySelector(`${primarySelector}, li`)
    ) {
      return false;
    }
    if (
      element.matches("a, button, label, summary") &&
      element.closest(primarySelector)
    ) {
      return false;
    }
    if (
      element.matches(
        "[class*='preview'], [class*='summary'], [class*='description'], [class*='excerpt']"
      ) &&
      element.querySelector(primarySelector)
    ) {
      return false;
    }

    const style = window.getComputedStyle(element);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      Number(style.opacity) === 0
    ) {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function collectDirectTextNodes(root) {
    const nodes = [];
    const elements = [
      root,
      ...root.querySelectorAll(
        "article, section, div, main, [role='main'], blockquote, li"
      )
    ];

    for (const element of elements) {
      if (
        element.closest(`[${MARKER}]`) ||
        element.closest(`[${OWNED_MARKER}]`) ||
        element.closest(
          "script, style, noscript, code, pre, svg, canvas, iframe, textarea, input, select, [contenteditable='true'], [aria-hidden='true'], nav, header, footer, aside"
        )
      ) {
        continue;
      }

      const style = window.getComputedStyle(element);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        Number(style.opacity) === 0
      ) {
        continue;
      }

      for (const node of element.childNodes) {
        if (
          node.nodeType === Node.TEXT_NODE &&
          isMeaningfulText(
            normalizeText(node.textContent),
            Number.POSITIVE_INFINITY
          )
        ) {
          nodes.push(node);
        }
      }
    }
    return nodes;
  }

  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function normalizeStructuredText(value) {
    return String(value || "")
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((line) => line.replace(/[^\S\n]+/g, " ").trim())
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function isMeaningfulText(text, maxLength = DEFAULT_TEXT_MAX_LENGTH) {
    if (text.length < 1 || text.length > maxLength) {
      return false;
    }
    if (/^(https?:\/\/|www\.)/i.test(text)) {
      return false;
    }
    return /[\p{L}]/u.test(text);
  }

  function splitTextAtSemanticBoundaries(text, maxLength) {
    if (text.length <= maxLength) {
      return [text];
    }

    const chunks = [];
    let remaining = text;
    while (remaining.length > maxLength) {
      const windowText = remaining.slice(0, maxLength + 1);
      let boundary = findSentenceBoundary(windowText, maxLength);
      if (boundary < Math.floor(maxLength * 0.3)) {
        boundary = findWhitespaceBoundary(windowText, maxLength);
      }
      if (boundary <= 0 || boundary > maxLength) {
        boundary = maxLength;
      }

      const chunk = remaining.slice(0, boundary).trim();
      if (chunk) {
        chunks.push(chunk);
      }
      remaining = remaining.slice(boundary).trimStart();
    }
    if (remaining.trim()) {
      chunks.push(remaining.trim());
    }
    return chunks;
  }

  function findSentenceBoundary(text, maxLength) {
    const sentenceEnd =
      /(?:[.!?。！？；;…]+["'”’）)\]]*|\n+)(?:\s+|$)/gu;
    let boundary = -1;
    for (const match of text.matchAll(sentenceEnd)) {
      const candidate = match.index + match[0].length;
      if (candidate <= maxLength) {
        boundary = candidate;
      }
    }
    return boundary;
  }

  function findWhitespaceBoundary(text, maxLength) {
    for (let index = maxLength; index > 0; index -= 1) {
      if (/\s/u.test(text[index - 1])) {
        return index;
      }
    }
    return -1;
  }

  function applyTranslation(
    target,
    targetType,
    translatedText,
    targetLanguage,
    targetNodes
  ) {
    if (targetType === "flow") {
      return applyFlowTranslation(
        target,
        targetNodes,
        translatedText,
        targetLanguage
      );
    }
    if (targetType === "text") {
      return applyTextNodeTranslation(
        target,
        translatedText,
        targetLanguage
      );
    }

    const element = target;
    if (
      !element.isConnected ||
      element.hasAttribute(MARKER) ||
      // 里面已经有 flow/文本节点的译文块了，再往元素上追加就成了两块译文
      element.querySelector(`[${MARKER}], .${TRANSLATION_CLASS}`)
    ) {
      return false;
    }
    if (element.matches("h1, h2, h3, h4, h5, h6, [role='heading']")) {
      return applyHeadingTranslation(
        element,
        translatedText,
        targetLanguage
      );
    }

    const translation = document.createElement("span");
    const translationStyle = element.matches(
      "a, button, label, summary"
    )
      ? "ai-page-translator-translation-compact"
      : "ai-page-translator-translation-body";
    translation.className = `${TRANSLATION_CLASS} ${translationStyle}`;
    translation.setAttribute(OWNED_MARKER, "true");
    translation.dataset.translatorForElement = "true";
    translation.lang = targetLanguage || "";
    translation.textContent = translatedText;

    const originalSize = Number.parseFloat(
      window.getComputedStyle(element).fontSize
    );
    if (Number.isFinite(originalSize)) {
      element.style.setProperty(
        "--ai-translator-element-original-size",
        `${originalSize}px`
      );
    }
    element.append(translation);
    element.setAttribute(MARKER, "true");
    element.dataset.translatorTarget = "element";
    return true;
  }

  function applyFlowTranslation(
    container,
    nodes,
    translatedText,
    targetLanguage
  ) {
    const firstNode = nodes.find((node) => node.isConnected);
    if (!firstNode?.parentNode || firstNode.parentNode !== container) {
      return false;
    }

    const host = document.createElement("div");
    host.setAttribute(MARKER, "true");
    host.setAttribute(OWNED_MARKER, "true");
    host.dataset.translatorTarget = "flow";

    const original = document.createElement("div");
    original.className = ORIGINAL_CLASS;
    original.setAttribute(OWNED_MARKER, "true");
    container.insertBefore(host, firstNode);
    host.appendChild(original);
    for (const node of nodes) {
      if (node.isConnected && node.parentNode === container) {
        original.appendChild(node);
      }
    }

    const translation = document.createElement("div");
    translation.className =
      `${TRANSLATION_CLASS} ai-page-translator-translation-body`;
    translation.setAttribute(OWNED_MARKER, "true");
    translation.lang = targetLanguage || "";
    translation.textContent = translatedText;
    host.appendChild(translation);
    return true;
  }

  function applyHeadingTranslation(element, translatedText, targetLanguage) {
    const translation = document.createElement("div");
    translation.className =
      `${TRANSLATION_CLASS} ai-page-translator-translation-heading`;
    translation.setAttribute(OWNED_MARKER, "true");
    translation.dataset.translatorForHeading = "true";
    translation.lang = targetLanguage || "";
    translation.textContent = translatedText;
    const headingSize = Number.parseFloat(
      window.getComputedStyle(element).fontSize
    );
    translation.style.setProperty(
      "--ai-translator-heading-size",
      `${Math.max(14, Math.min(20, headingSize * 0.62))}px`
    );
    translation.style.setProperty(
      "--ai-translator-heading-original-size",
      `${headingSize}px`
    );

    element.setAttribute(MARKER, "true");
    element.dataset.translatorTarget = "heading";
    element.insertAdjacentElement("afterend", translation);
    return true;
  }

  function applyTextNodeTranslation(textNode, translatedText, targetLanguage) {
    if (!textNode.isConnected || !textNode.parentElement) {
      return false;
    }

    const host = document.createElement("span");
    host.setAttribute(MARKER, "true");
    host.setAttribute(OWNED_MARKER, "true");
    host.dataset.translatorTarget = "text";

    const original = document.createElement("span");
    original.className = ORIGINAL_CLASS;
    original.setAttribute(OWNED_MARKER, "true");
    original.textContent = textNode.textContent;

    const translation = document.createElement("span");
    translation.className =
      `${TRANSLATION_CLASS} ai-page-translator-translation-body`;
    translation.setAttribute(OWNED_MARKER, "true");
    translation.lang = targetLanguage || "";
    translation.textContent = translatedText;

    host.append(original, translation);
    textNode.replaceWith(host);
    return true;
  }

  function shouldRescanDynamicContent() {
    return /(^|\.)x\.com$|(^|\.)twitter\.com$/i.test(
      window.location.hostname
    );
  }

  function wait(milliseconds) {
    return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
  }

  function observeDynamicContent(session) {
    if (typeof MutationObserver !== "function") {
      return;
    }
    session.observer = new MutationObserver((records) => {
      const externalRecords = records.filter(isExternalContentMutation);
      if (
        !isCurrentSession(session) ||
        externalRecords.length === 0
      ) {
        return;
      }
      invalidateMutatedSources(session, externalRecords);
      scheduleIncrementalScan(session);
    });
    reconnectObserver(session);
  }

  function reconnectObserver(session) {
    if (!session.observer || !document.documentElement) {
      return;
    }
    session.observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["class", "style", "hidden", "aria-hidden"]
    });
  }

  function withObserverPaused(session, operation) {
    if (!session.observer) {
      return operation();
    }
    session.observer.disconnect();
    try {
      return operation();
    } finally {
      session.observer.takeRecords();
      if (isCurrentSession(session) && !session.jobClosed) {
        reconnectObserver(session);
      }
    }
  }

  function isExternalContentMutation(record) {
    if (isTranslatorOwnedNode(record.target)) {
      return false;
    }
    if (record.type === "characterData") {
      return true;
    }
    if (record.type === "attributes") {
      return true;
    }
    const changedNodes = [
      ...(record.addedNodes || []),
      ...(record.removedNodes || [])
    ];
    return changedNodes.some((node) => !isTranslatorOwnedNode(node));
  }

  function isTranslatorOwnedNode(node) {
    const element = node?.nodeType === Node.ELEMENT_NODE
      ? node
      : node?.parentElement;
    return Boolean(
      element &&
      (
        element.hasAttribute(OWNED_MARKER) ||
        element.closest?.(`[${OWNED_MARKER}]`) ||
        element.id === STYLE_ID ||
        element.id === STATUS_ID
      )
    );
  }

  function invalidateMutatedSources(session, records) {
    const sources = new Set();
    for (const record of records) {
      const targetElement = record.target?.nodeType === Node.ELEMENT_NODE
        ? record.target
        : record.target?.parentElement;
      const source = targetElement?.closest?.(`[${MARKER}]`);
      if (
        source &&
        (
          source.dataset.translatorTarget === "element" ||
          source.dataset.translatorTarget === "heading"
        )
      ) {
        sources.add(source);
      }
    }
    if (sources.size === 0) {
      return;
    }

    withObserverPaused(session, () => {
      for (const source of sources) {
        if (source.dataset.translatorTarget === "heading") {
          const translation = source.nextElementSibling;
          if (translation?.dataset.translatorForHeading === "true") {
            translation.remove();
          }
        } else {
          source.querySelector(
            `:scope > [data-translator-for-element='true']`
          )?.remove();
          source.style.removeProperty(
            "--ai-translator-element-original-size"
          );
        }
        source.removeAttribute(MARKER);
        delete source.dataset.translatorTarget;
        session.pendingRetranslationTargets.add(source);
      }
    });
  }

  function scheduleIncrementalScan(
    session,
    delay = MUTATION_SCAN_DEBOUNCE_MS
  ) {
    if (!isCurrentSession(session) || session.jobClosed) {
      return;
    }
    if (session.initializing || session.scanRunning) {
      session.rescanRequested = true;
      return;
    }

    if (session.mutationTimer !== null) {
      window.clearTimeout(session.mutationTimer);
    }
    session.mutationTimer = window.setTimeout(async () => {
      session.mutationTimer = null;
      if (!isCurrentSession(session) || session.jobClosed) {
        return;
      }
      try {
        await translateCurrentCandidates(session);
      } catch (error) {
        handleTaskError(session, error);
        return;
      }
      if (session.rescanRequested) {
        session.rescanRequested = false;
        scheduleIncrementalScan(session, 0);
      }
    }, delay);
  }

  function showTranslationProgress(session) {
    state = { ...state, translated: session.usedPlacements };
    showStatus(
      `正在翻译 ${session.usedPlacements} / ${state.total}`,
      "working"
    );
  }

  function scheduleStatusHide(session) {
    clearScheduledStatusHide(session);
    session.statusHideTimer = window.setTimeout(() => {
      session.statusHideTimer = null;
      if (isCurrentSession(session) && state.status === "done") {
        hideStatus();
      }
    }, 2400);
  }

  function clearScheduledStatusHide(session) {
    if (session.statusHideTimer !== null) {
      window.clearTimeout(session.statusHideTimer);
      session.statusHideTimer = null;
    }
  }

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) {
      return;
    }
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.setAttribute(OWNED_MARKER, "true");
    style.textContent = `
      .${ORIGINAL_CLASS} { display: contents !important; }
      .${TRANSLATION_CLASS} {
        display: block !important;
        color: inherit !important;
        opacity: 0.8 !important;
        font-family: inherit !important;
        font-style: normal !important;
        font-weight: 400 !important;
        text-decoration: none !important;
        text-transform: none !important;
      }
      .ai-page-translator-translation-body {
        margin-top: 0.45em !important;
        margin-bottom: 0.45em !important;
        padding-left: 0.75em !important;
        border-left: 2px solid currentColor !important;
        font-size: 0.94em !important;
        line-height: 1.6 !important;
        white-space: pre-wrap !important;
        overflow-wrap: anywhere !important;
      }
      .ai-page-translator-translation-body::before {
        content: "译文" !important;
        display: block !important;
        margin-bottom: 0.15em !important;
        font-size: 0.72em !important;
        font-weight: 600 !important;
        line-height: 1.2 !important;
        letter-spacing: 0.08em !important;
        opacity: 0.62 !important;
      }
      .ai-page-translator-translation-compact {
        display: inline !important;
        margin-left: 0.45em !important;
        font-size: 0.9em !important;
        line-height: inherit !important;
      }
      .ai-page-translator-translation-heading {
        margin: 0.28em 0 0.85em !important;
        font-size: var(--ai-translator-heading-size, 16px) !important;
        line-height: 1.45 !important;
        letter-spacing: normal !important;
      }
      .ai-page-translator-translated .${ORIGINAL_CLASS} {
        display: none !important;
      }
      .ai-page-translator-translated [${MARKER}][data-translator-target="element"] {
        font-size: 0 !important;
        line-height: 0 !important;
      }
      .ai-page-translator-translated [${MARKER}][data-translator-target="element"] > :not(.${TRANSLATION_CLASS}) {
        display: none !important;
      }
      .ai-page-translator-translated [${MARKER}][data-translator-target="element"] > .${TRANSLATION_CLASS} {
        font-size: var(--ai-translator-element-original-size, 1rem) !important;
        line-height: 1.6 !important;
      }
      .ai-page-translator-translated [${MARKER}][data-translator-target="heading"] {
        display: none !important;
      }
      .ai-page-translator-translated .ai-page-translator-translation-heading {
        margin-top: 0 !important;
        opacity: 1 !important;
        font-size: var(--ai-translator-heading-original-size, 1em) !important;
        font-weight: 500 !important;
      }
      .ai-page-translator-translated .ai-page-translator-translation-body::before {
        display: none !important;
      }
      #${STATUS_ID} {
        position: fixed !important;
        right: 20px !important;
        bottom: 20px !important;
        z-index: 2147483647 !important;
        max-width: 320px !important;
        padding: 10px 14px !important;
        border: 1px solid #dadce0 !important;
        border-radius: 8px !important;
        background: #fff !important;
        box-shadow: 0 2px 8px rgba(60, 64, 67, 0.22) !important;
        color: #3c4043 !important;
        font: 13px/20px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
      }
      #${STATUS_ID}[data-kind="error"] {
        border-color: #f6aea9 !important;
        color: #b3261e !important;
      }
      #${STATUS_ID}[data-kind="success"] {
        border-color: #81c995 !important;
        color: #137333 !important;
      }
    `;
    document.documentElement.appendChild(style);
  }

  function showStatus(message, kind) {
    ensureStyles();
    let status = document.getElementById(STATUS_ID);
    if (!status) {
      status = document.createElement("div");
      status.id = STATUS_ID;
      status.setAttribute(OWNED_MARKER, "true");
      status.setAttribute("role", "status");
      document.documentElement.appendChild(status);
    }
    status.dataset.kind = kind;
    status.textContent = message;
    status.hidden = false;
  }

  function hideStatus() {
    document.getElementById(STATUS_ID)?.remove();
  }
})();
