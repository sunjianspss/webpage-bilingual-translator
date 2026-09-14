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

    // 变量只被译文自己的 font-size 消费，设在译文节点上即可（heading 路径
    // 一直是这么做的）。设到页面元素上会留下痕迹：removeProperty 清不掉
    // style 属性本身，恢复原文后每个译过的元素都会多出一个 style=""，
    // 站点自己的 p:not([style]) 之类选择器会因此失配。
    const originalSize = Number.parseFloat(
      window.getComputedStyle(element).fontSize
    );
    if (Number.isFinite(originalSize)) {
      translation.style.setProperty(
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
    // 字号读不出来时别写出 "NaNpx"：那会让 var() 在计算时失效，译文标题
    // 退回继承字号。element 路径一直是这么防的，这里对齐。
    const headingSize = Number.parseFloat(
      window.getComputedStyle(element).fontSize
    );
    if (Number.isFinite(headingSize)) {
      translation.style.setProperty(
        "--ai-translator-heading-size",
        `${Math.max(14, Math.min(20, headingSize * 0.62))}px`
      );
      translation.style.setProperty(
        "--ai-translator-heading-original-size",
        `${headingSize}px`
      );
    }

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
