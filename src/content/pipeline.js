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
    return settings?.backend !== "deepseek" && !backendWarmedUp;
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
          backendWarmedUp = true;
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
