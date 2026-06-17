(() => {
  if (globalThis.__AI_PAGE_TRANSLATOR_LOADED__) {
    return;
  }
  globalThis.__AI_PAGE_TRANSLATOR_LOADED__ = true;

  const MARKER = "data-ai-page-translator";
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
  let taskGeneration = 0;

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

    if (message?.type === "TRANSLATE_PAGE") {
      if (state.status === "translating") {
        sendResponse({
          ok: false,
          error: "页面正在翻译，请稍候",
          state
        });
        return false;
      }
      startTranslation(message.settings);
      sendResponse({ ok: true, started: true, state });
      return false;
    }

    return false;
  });

  function startTranslation(settings) {
    translatePage(settings).catch((error) => {
      if (error?.code === "TRANSLATION_CANCELED") {
        return;
      }
      const messageText =
        error instanceof Error ? error.message : String(error);
      state = { ...state, status: "error", error: messageText };
      showStatus(messageText, "error");
    });
  }

  async function translatePage(settings) {
    if (state.status === "translating") {
      throw new Error("页面正在翻译，请稍候");
    }

    const taskId = ++taskGeneration;
    clearTranslations(settings.viewMode || state.viewMode);
    ensureStyles();
    setViewMode(settings.viewMode || "bilingual");

    state = {
      status: "translating",
      translated: 0,
      total: 0,
      viewMode: settings.viewMode || "bilingual",
      error: ""
    };
    showStatus("正在查找可翻译内容", "working");

    const maxSegments = settings.maxSegments || 220;
    const rescanDelays = shouldRescanDynamicContent()
      ? DYNAMIC_RESCAN_DELAYS
      : [0];
    let applied = 0;
    let foundCandidates = false;

    for (const delay of rescanDelays) {
      if (delay > 0) {
        await wait(delay);
      }
      assertCurrentTask(taskId);

      const candidates = collectCandidates(maxSegments);
      if (candidates.length === 0) {
        continue;
      }

      foundCandidates = true;
      state = {
        ...state,
        total: Math.max(state.total, applied + candidates.length)
      };
      showStatus(
        `正在翻译 ${applied} / ${state.total}`,
        "working"
      );

      await translateCandidateBatches(
        makeBatches(candidates, settings),
        getTranslationBatchConcurrency(settings),
        shouldWarmupFirstBatch(settings),
        taskId,
        (batch, response) => {
          for (const candidate of batch) {
            const translatedText = response.translations[candidate.id];
            if (
              translatedText &&
              applyTranslation(
                candidate.target,
                candidate.targetType,
                translatedText,
                settings.targetLanguage,
                candidate.nodes
              )
            ) {
              applied += 1;
            }
          }

          state = { ...state, translated: applied };
          showStatus(
            `正在翻译 ${applied} / ${state.total}`,
            "working"
          );
        }
      );
    }

    if (!foundCandidates) {
      throw new Error("当前页面没有找到可翻译的正文");
    }

    state = {
      ...state,
      status: "done",
      translated: applied,
      total: applied,
      error: ""
    };
    showStatus(`已翻译 ${applied} 处内容`, "success");
    window.setTimeout(hideStatus, 2400);
  }

  async function translateCandidateBatches(
    batches,
    concurrency,
    warmupFirstBatch,
    taskId,
    onBatchTranslated
  ) {
    let workerBatches = batches;
    if (warmupFirstBatch && batches.length > 1) {
      const response = await requestTranslationBatch(batches[0], taskId);
      assertCurrentTask(taskId);
      onBatchTranslated(batches[0], response);
      workerBatches = batches.slice(1);
    }

    let nextIndex = 0;
    let firstError = null;
    const workerCount = Math.min(
      concurrency,
      workerBatches.length
    );

    async function worker() {
      while (!firstError) {
        const batch = workerBatches[nextIndex];
        nextIndex += 1;
        if (!batch) {
          return;
        }

        try {
          const response = await requestTranslationBatch(batch, taskId);
          assertCurrentTask(taskId);
          if (firstError) {
            return;
          }
          onBatchTranslated(batch, response);
        } catch (error) {
          firstError = firstError || error;
          return;
        }
      }
    }

    await Promise.all(
      Array.from({ length: workerCount }, () => worker())
    );
    if (firstError) {
      throw firstError;
    }
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
        const response = await chrome.runtime.sendMessage({
          type: "TRANSLATE_BATCH",
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
        lastError = response?.error || lastError;
      } catch (error) {
        assertCurrentTask(taskId);
        lastError = error instanceof Error ? error.message : String(error);
      }

      if (attempt === 0) {
        showStatus("翻译服务暂时无响应，正在重试", "working");
        await wait(600);
        assertCurrentTask(taskId);
      }
    }
    throw new Error(lastError);
  }

  function collectCandidates(limit) {
    const root =
      document.querySelector(
        "main, [role='main'], #main, .main-contents, article"
      ) || document.body;
    if (!root) {
      return [];
    }

    const primarySelector =
      "h1, h2, h3, h4, h5, h6, p, blockquote, figcaption, td, th, [role='heading']";
    const isSocialPage = shouldRescanDynamicContent();
    const secondarySelector = isSocialPage
      ? ""
      : "li, summary, button, label, a, [class*='preview'], [class*='summary'], [class*='description'], [class*='excerpt']";
    const structuredTextElements = new Set(
      collectStructuredTextElements(root)
    );
    const useFocusedSocialExtraction =
      isSocialPage && structuredTextElements.size > 0;
    const elements = [
      ...structuredTextElements,
      ...root.querySelectorAll(primarySelector),
      ...(secondarySelector ? root.querySelectorAll(secondarySelector) : [])
    ];
    const seenText = new Set();
    const flowCandidates = useFocusedSocialExtraction
      ? []
      : collectFlowCandidates(root).filter(
        (candidate) =>
          ![...structuredTextElements].some(
            (element) =>
              element === candidate.target ||
              element.contains(candidate.target) ||
              candidate.target.contains(element)
          )
      );
    const flowElements = new Set(
      flowCandidates.flatMap((candidate) =>
        candidate.nodes.filter((node) => node.nodeType === Node.ELEMENT_NODE)
      )
    );
    let candidates = [...flowCandidates];
    for (const candidate of flowCandidates) {
      seenText.add(candidate.text);
    }

    for (const element of elements) {
      if (candidates.length >= limit * 3) {
        break;
      }
      if (
        flowElements.has(element) ||
        [...flowElements].some((flowElement) =>
          flowElement.contains(element)
        ) ||
        [...structuredTextElements].some(
          (structuredElement) =>
            structuredElement !== element &&
            structuredElement.contains(element)
        )
      ) {
        continue;
      }
      if (!isEligible(element, root, primarySelector)) {
        continue;
      }

      const structured = structuredTextElements.has(element);
      const text = structured
        ? normalizeStructuredText(element.innerText || element.textContent)
        : normalizeText(element.innerText || element.textContent);
      const maxLength = structured
        ? STRUCTURED_TEXT_MAX_LENGTH
        : DEFAULT_TEXT_MAX_LENGTH;
      if (!isMeaningfulText(text, maxLength) || seenText.has(text)) {
        continue;
      }
      if (
        element.matches("a, button, label, summary") &&
        text.length <= 24 &&
        /^[A-Z0-9_.\s-]+$/.test(text)
      ) {
        continue;
      }

      seenText.add(text);
      candidates.push({
        text,
        target: element,
        targetType: "element",
        structured,
        preserveLayout: structured
      });
    }

    candidates = removeAncestorConflicts(candidates);
    const selectedTexts = new Set(
      candidates.map((candidate) => candidate.text)
    );
    const candidateElements = candidates.map((item) => item.target);
    const flowNodes = new Set(
      flowCandidates.flatMap((candidate) => candidate.nodes)
    );
    if (useFocusedSocialExtraction) {
      return candidates.slice(0, limit).map((candidate, index) => ({
        ...candidate,
        id: `segment-${index + 1}`
      }));
    }
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
      if (!isMeaningfulText(text) || selectedTexts.has(text)) {
        continue;
      }

      selectedTexts.add(text);
      candidates.push({
        text,
        target: textNode,
        targetType: "text"
      });
    }
    return candidates.slice(0, limit).map((candidate, index) => ({
      ...candidate,
      id: `segment-${index + 1}`
    }));
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

  function collectFlowCandidates(root) {
    const candidates = [];
    const containers = [
      root,
      ...root.querySelectorAll("article, section, div, li, blockquote")
    ];

    for (const container of containers) {
      if (
        container.closest(`[${MARKER}]`) ||
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
          text.length <= 1200 &&
          isMeaningfulText(text)
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
    if (
      element.hasAttribute(MARKER) ||
      element.closest(`[${MARKER}]`) ||
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
          normalizeText(node.textContent).length >= 20
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
    if (text.length < 3 || text.length > maxLength) {
      return false;
    }
    if (/^(https?:\/\/|www\.)/i.test(text)) {
      return false;
    }
    return /[\p{L}]/u.test(text);
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
    if (!element.isConnected || element.hasAttribute(MARKER)) {
      return false;
    }
    if (element.matches("h1, h2, h3, h4, h5, h6, [role='heading']")) {
      return applyHeadingTranslation(
        element,
        translatedText,
        targetLanguage
      );
    }

    const original = document.createElement("span");
    original.className = ORIGINAL_CLASS;
    while (element.firstChild) {
      original.appendChild(element.firstChild);
    }

    const translation = document.createElement("span");
    const translationStyle = element.matches(
      "a, button, label, summary"
    )
      ? "ai-page-translator-translation-compact"
      : "ai-page-translator-translation-body";
    translation.className = `${TRANSLATION_CLASS} ${translationStyle}`;
    translation.lang = targetLanguage || "";
    translation.textContent = translatedText;

    element.append(original, translation);
    element.setAttribute(MARKER, "true");
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
    host.dataset.translatorTarget = "flow";

    const original = document.createElement("div");
    original.className = ORIGINAL_CLASS;
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
    translation.lang = targetLanguage || "";
    translation.textContent = translatedText;
    host.appendChild(translation);
    return true;
  }

  function applyHeadingTranslation(element, translatedText, targetLanguage) {
    const translation = document.createElement("div");
    translation.className =
      `${TRANSLATION_CLASS} ai-page-translator-translation-heading`;
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
    host.dataset.translatorTarget = "text";

    const original = document.createElement("span");
    original.className = ORIGINAL_CLASS;
    original.textContent = textNode.textContent;

    const translation = document.createElement("span");
    translation.className =
      `${TRANSLATION_CLASS} ai-page-translator-translation-body`;
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
    if (taskId !== taskGeneration) {
      const error = new Error("翻译任务已取消");
      error.code = "TRANSLATION_CANCELED";
      throw error;
    }
  }

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) {
      return;
    }
    const style = document.createElement("style");
    style.id = STYLE_ID;
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
