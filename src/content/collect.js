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
