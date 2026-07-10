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
      characterData: true
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
