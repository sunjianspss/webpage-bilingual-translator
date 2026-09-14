  function startTranslation(settings) {
    const jobId = pendingStartJobId;
    pendingStartJobId = "";
    if (activeSession) {
      cancelSession(activeSession);
    }

    const nextSettings = { ...settings };
    const taskId = ++taskGeneration;
    const continuingExistingTranslations = hasCompatibleTranslations(
      nextSettings.targetLanguage
    );
    if (!continuingExistingTranslations) {
      clearTranslations(nextSettings.viewMode || state.viewMode);
    }
    ensureStyles();
    setViewMode(nextSettings.viewMode || "bilingual");

    const session = {
      taskId,
      jobId,
      settings: nextSettings,
      maxPlacements: normalizePlacementLimit(nextSettings.maxSegments),
      usedPlacements: 0,
      skippedPlacements: 0,
      skippedIsLowerBound: false,
      countedTargets: new WeakSet(),
      pendingRetranslationTargets: new Set(),
      segmentCounter: 0,
      translationCache: new Map(),
      observer: null,
      mutationTimer: null,
      statusHideTimer: null,
      scanRunning: false,
      rescanRequested: false,
      // 这一轮整页翻译有没有跑完。state.status 每轮扫描都会落回 "done"，
      // 说明不了这件事。
      running: true,
      // 后台任务丢了时共用的那一次续期往返，每个会话只做一次。
      jobRenewal: null,
      initializing: true,
      jobClosed: false
    };
    activeSession = session;
    state = {
      status: "translating",
      translated: 0,
      total: 0,
      skipped: 0,
      skippedIsLowerBound: false,
      viewMode: nextSettings.viewMode || "bilingual",
      error: ""
    };
    showStatus("正在查找可翻译内容", "working");
    observeDynamicContent(session);

    translatePage(session).catch((error) => {
      handleTaskError(session, error);
    });
  }

  function hasCompatibleTranslations(targetLanguage) {
    const translations = [
      ...document.querySelectorAll(`.${TRANSLATION_CLASS}`)
    ];
    if (translations.length === 0) {
      return false;
    }
    const normalizedTarget = String(targetLanguage || "").toLowerCase();
    return translations.every(
      (translation) =>
        String(translation.lang || "").toLowerCase() === normalizedTarget
    );
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
      skipped: 0,
      skippedIsLowerBound: false,
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
