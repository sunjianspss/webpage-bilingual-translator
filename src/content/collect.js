  // 采集里到处是“某个候选是不是被另一个候选套住”的判断。逐对调用
  // contains 在候选上百的页面上是平方级开销，而每次动态重扫都要重跑一遍。
  // 这两个工具把它换成“沿 parentElement 上溯一次 + Set 查询”，
  // 结果完全等价（contains 含自身，靠 includeSelf 对齐）。
  function hasAncestorIn(node, elements, includeSelf = true) {
    if (elements.size === 0) {
      return false;
    }
    let current =
      includeSelf && node?.nodeType === Node.ELEMENT_NODE
        ? node
        : node?.parentElement;
    while (current) {
      if (elements.has(current)) {
        return true;
      }
      current = current.parentElement;
    }
    return false;
  }

  // 收集每个元素自身及其全部祖先。此后“存在某个 e 使 x.contains(e)”
  // 就是一次 Set 查询：x 必然在某个 e 的祖先链上。
  function collectAncestorSet(elements) {
    const ancestors = new Set();
    for (const element of elements) {
      for (let node = element; node; node = node.parentElement) {
        if (ancestors.has(node)) {
          break;
        }
        ancestors.add(node);
      }
    }
    return ancestors;
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
    // 结构化元素的祖先集合：candidate.target.contains(结构化元素) 等价于
    // target 出现在这个集合里，target === 结构化元素也被它覆盖。
    const structuredAncestors = collectAncestorSet(structuredTextElements);
    const flowCandidates = useFocusedSocialExtraction
      ? []
      : roots.flatMap((root) =>
        collectFlowCandidates(root).filter(
          (candidate) =>
            !structuredAncestors.has(candidate.target) &&
            !hasAncestorIn(candidate.target, structuredTextElements)
        )
      );
    const flowElements = new Set(
      flowCandidates.flatMap((candidate) =>
        candidate.nodes.filter((node) => node.nodeType === Node.ELEMENT_NODE)
      )
    );
    const flowCoverage = buildFlowCoverage(flowCandidates);
    let candidates = [...flowCandidates];

    // 这个上限是用来兜住超大页面的采集开销的，只应约束本循环自己的产出。
    // 原来它比的是 candidates.length，而数组里已经躺着全部 flow 候选：
    // 带内联链接的列表项一多（真实站点里很常见），元素循环会在第一次
    // 迭代就 break，页面顶部的标题和正文根本没被采集，后面再怎么排序都
    // 救不回来。
    let collectedElements = 0;

    for (const element of elements) {
      if (collectedElements >= limit * 3) {
        break;
      }
      if (
        isFullyCoveredByFlow(element, flowCoverage) ||
        hasAncestorIn(element, flowElements) ||
        hasAncestorIn(element, structuredTextElements, false)
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
      collectedElements += 1;
    }

    candidates = dedupeCandidatePlacements(
      removeAncestorConflicts(candidates)
    );
    const candidateElements = new Set(
      candidates
        .filter((item) => item.targetType !== "flow")
        .map((item) => item.target)
    );
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
          hasAncestorIn(parent, candidateElements)
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
    return sortByDocumentOrder(
      dedupeCandidatePlacements(candidates)
    ).slice(0, limit);
  }

  // 候选是分三批拼起来的：先 flow，再 element/heading，最后裸文本节点。
  // 直接 slice 就等于把这个拼装顺序当成了优先级——页面顶部的大标题会
  // 输给页面底部带内联链接的列表项（flow 候选往往成百上千）。按文档顺序
  // 排一次再截断，配额就落在“用户先读到的内容”上。未超配额时排序不改变
  // 结果集，只影响顺序。
  function sortByDocumentOrder(candidates) {
    return candidates
      .map((candidate, index) => ({ candidate, index }))
      .sort((a, b) => {
        const aNode = placementIdentity(a.candidate);
        const bNode = placementIdentity(b.candidate);
        if (aNode === bNode) {
          return a.index - b.index;
        }
        const relation = aNode.compareDocumentPosition(bNode);
        if (relation & Node.DOCUMENT_POSITION_FOLLOWING) {
          return -1;
        }
        if (relation & Node.DOCUMENT_POSITION_PRECEDING) {
          return 1;
        }
        // 互不包含也无先后（例如已脱离文档）：保持原有相对顺序。
        return a.index - b.index;
      })
      .map((entry) => entry.candidate);
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
      // 裸 div 的数量远大于 <p>，没有下限就会把计数、按钮文案这类 UI
      // 碎片也当成正文。这里沿用 flow 候选和结构化回退的同一个阈值。
      // 只做长度粗筛，用 textContent 而非 innerText，避免强制回流。
      // 长度筛必须排在 isInlineTextBlock 之前：后者要 getComputedStyle，
      // 而整页的 div 里绝大多数在这一步就被刷掉了。
      const text = normalizeText(element.textContent);
      if (text.length < INLINE_TEXT_BLOCK_MIN_LENGTH) {
        continue;
      }
      if (isInlineTextBlock(element)) {
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
      // 三次 closest 各自向上走一遍祖先链，合成一个选择器只走一遍。
      if (container.closest(EXCLUDED_CONTAINER_SELECTOR)) {
        continue;
      }
      // flush() 只在 run 里含链接、且至少两个节点时才产出候选。这两个
      // 条件都不成立的容器，下面对每个子节点的 getComputedStyle 是白做的。
      if (
        container.childNodes.length < 2 ||
        !container.querySelector("a")
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
    // 一个候选自己的 nodes 全是 target 的子节点，谁都不会包含 target，
    // 所以不必再排除 other !== candidate：命中的一定是别的 flow。
    const flowElementNodes = new Set();
    for (const candidate of candidates) {
      for (const node of candidate.nodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          flowElementNodes.add(node);
        }
      }
    }
    return candidates.filter(
      (candidate) => !hasAncestorIn(candidate.target, flowElementNodes)
    );
  }

  // 丢弃“套着别的普通候选”的外层元素，避免同一段正文翻两遍。判定条件：
  // 候选的子树里还有别的非 flow 候选，或者它被某个结构化候选罩住。
  // 原实现是候选两两 contains（候选上限 limit*3 时约 40 万次 DOM 调用），
  // 这里改成一次自底向上的祖先标记，规模从 O(n²) 降到 O(n × 树深)。
  function removeAncestorConflicts(candidates) {
    const targetCounts = new Map();
    const structuredTargets = new Set();
    for (const candidate of candidates) {
      if (candidate.targetType === "flow") {
        continue;
      }
      targetCounts.set(
        candidate.target,
        (targetCounts.get(candidate.target) || 0) + 1
      );
      if (candidate.structured) {
        structuredTargets.add(candidate.target);
      }
    }

    const hasNonFlowDescendant = new Set();
    for (const target of targetCounts.keys()) {
      for (let node = target.parentElement; node; node = node.parentElement) {
        // 这个祖先之前被标记时已经一路向上标到根，上面无需再走。
        if (hasNonFlowDescendant.has(node)) {
          break;
        }
        if (targetCounts.has(node)) {
          hasNonFlowDescendant.add(node);
        }
      }
    }

    return candidates.filter((candidate) => {
      if (candidate.targetType === "flow" || candidate.structured) {
        return true;
      }
      // 同一个 target 上还挂着另一个非 flow 候选时，原来两者互相 contains
      // （contains 含自身）会双双出局，这里用计数保持同样的行为。
      if (targetCounts.get(candidate.target) > 1) {
        return false;
      }
      return (
        !hasNonFlowDescendant.has(candidate.target) &&
        !hasAncestorIn(candidate.target, structuredTargets, false)
      );
    });
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
      if (element.closest(EXCLUDED_CONTAINER_SELECTOR)) {
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
