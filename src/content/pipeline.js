  // 预算截断是静默的：候选在采集末尾就被 slice 掉了，用户只会看到一句
  // “已翻译 N 处内容”，长页面翻到一半也长这样。把超出的数量缀在后面。
  function placementLimitSuffix(session) {
    if (session.skippedPlacements <= 0) {
      return "";
    }
    return session.skippedIsLowerBound
      ? `，另有至少 ${session.skippedPlacements} 处超出上限`
      : `，另有 ${session.skippedPlacements} 处超出上限`;
  }

  async function translatePage(session) {
    const { settings, taskId } = session;
    const rescanDelays = shouldRescanDynamicContent()
      ? DYNAMIC_RESCAN_DELAYS
      : [0];
    let foundCandidates = false;

    let finalFailures = [];
    try {
      for (const delay of rescanDelays) {
        if (delay > 0) {
          await wait(delay);
        }
        assertCurrentTask(taskId);
        const result = await translateCurrentCandidates(session);
        foundCandidates = foundCandidates || result.discovered > 0;
        finalFailures = result.failures;
      }
    } finally {
      session.initializing = false;
      session.running = false;
    }

    const totalFailures = countFailedPlacements(finalFailures);
    const failureReason = describeFailures(finalFailures);
    const hasFailures = totalFailures > 0;
    const reasonSuffix = hasFailures ? failureSuffix(failureReason) : "";
    const limitSuffix = placementLimitSuffix(session);
    state = {
      ...state,
      status: hasFailures ? "error" : "done",
      translated: session.usedPlacements,
      total: session.usedPlacements,
      skipped: session.skippedPlacements,
      skippedIsLowerBound: session.skippedIsLowerBound,
      error: hasFailures
        ? `${totalFailures} 处内容翻译失败${reasonSuffix}`
        : ""
    };
    showStatus(
      hasFailures
        ? `已翻译 ${session.usedPlacements} 处内容，${totalFailures} 处失败${reasonSuffix}${limitSuffix}`
        : foundCandidates
          ? `已翻译 ${session.usedPlacements} 处内容${limitSuffix}`
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
    try {
      const settings = session.settings;
      const collection = collectCandidates(
        session.maxPlacements +
          session.pendingRetranslationTargets.size
      );
      const rawCollected = collection.placements;
      const collected = rawCollected.filter(
        (placement) =>
          !isAlreadyTargetLanguage(placement.text, settings.targetLanguage)
      );
      let availableNewPlacements = remaining;
      let budgetSkipped = 0;
      const placements = collected.filter((placement) => {
        if (session.countedTargets.has(placementIdentity(placement))) {
          return true;
        }
        if (availableNewPlacements <= 0) {
          budgetSkipped += 1;
          return false;
        }
        availableNewPlacements -= 1;
        return true;
      });
      // 每次扫描都是整页重采，所以这是“当前还差多少”的快照，不是累加量。
      session.skippedPlacements = collection.overflow + budgetSkipped;
      session.skippedIsLowerBound = collection.overflowApproximate;
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
      assertCurrentTask(session.taskId);
      for (const group of groups) {
        const cached = session.translationCache.get(group.key);
        if (cached) {
          applyTranslatedGroup(session, group, cached);
        }
      }

      const candidates = groups
        .filter((group) => !group.applied)
        .flatMap((group) => group.fragments);
      let batchFailures = [];
      if (candidates.length > 0) {
        const batches = makeBatches(candidates, settings);
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
      const failedPlacements = countFailedPlacements(batchFailures);
      const hasFailures = failedPlacements > 0;
      const reasonSuffix = hasFailures
        ? failureSuffix(describeFailures(batchFailures))
        : "";
      const limitSuffix = placementLimitSuffix(session);
      state = {
        ...state,
        status: hasFailures ? "error" : "done",
        translated: session.usedPlacements,
        total: session.usedPlacements,
        skipped: session.skippedPlacements,
      skippedIsLowerBound: session.skippedIsLowerBound,
        error: hasFailures
          ? `${failedPlacements} 处内容翻译失败${reasonSuffix}`
          : ""
      };
      showStatus(
        hasFailures
          ? `已翻译 ${session.usedPlacements} 处内容，${failedPlacements} 处失败${reasonSuffix}${limitSuffix}`
          : `已翻译 ${session.usedPlacements} 处内容${limitSuffix}`,
        hasFailures ? "error" : "success"
      );
      if (!hasFailures) {
        scheduleStatusHide(session);
      }
      return { discovered: placements.length, failures: batchFailures };
    } finally {
      session.scanRunning = false;
    }
  }

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
      const currentPlacements = group.placements.filter(
        placementIsCurrentAndVisible
      );
      if (currentPlacements.length !== group.placements.length) {
        session.rescanRequested = true;
        group.placements = currentPlacements;
      }
      if (group.placements.length === 0) {
        continue;
      }
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
    return [...groupsByKey.values()].filter(
      (group) => group.placements.length > 0
    );
  }

  function applyTranslatedGroup(session, group, translatedText) {
    if (group.applied) {
      return;
    }
    let newPlacements = 0;
    withObserverPaused(session, () => {
      for (const placement of group.placements) {
        const identity = placementIdentity(placement);
        const alreadyCounted = session.countedTargets.has(
          identity
        );
        if (!placementIsCurrentAndVisible(placement)) {
          session.pendingRetranslationTargets.add(placement.target);
          session.rescanRequested = true;
          continue;
        }
        if (
          !alreadyCounted &&
          session.usedPlacements + newPlacements >=
            session.maxPlacements
        ) {
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
          session.pendingRetranslationTargets.delete(placement.target);
          if (!alreadyCounted) {
            session.countedTargets.add(identity);
            newPlacements += 1;
          }
        } else if (!placement.target.isConnected) {
          session.pendingRetranslationTargets.delete(placement.target);
        }
      }
    });
    session.usedPlacements += newPlacements;
    group.applied = true;
  }

  function placementSourceText(placement) {
    if (placement.targetType === "flow") {
      return normalizeText(
        (placement.nodes || [])
          .filter((node) => node.isConnected)
          .map((node) => renderedText(node))
          .join(" ")
      );
    }
    if (placement.targetType === "text") {
      return normalizeText(placement.target?.textContent);
    }
    const value = renderedText(
      placement.target,
      Boolean(placement.structured)
    );
    return placement.structured
      ? normalizeStructuredText(value)
      : normalizeText(value);
  }

  function placementIsCurrentAndVisible(placement) {
    if (
      placement.targetType === "flow" &&
      !(placement.nodes || []).every((node) => {
        if (node.parentNode !== placement.target) {
          return false;
        }
        if (node.nodeType === Node.TEXT_NODE) {
          return textNodeIsVisiblyRendered(node);
        }
        if (node.nodeType !== Node.ELEMENT_NODE) {
          return false;
        }
        return node.matches("br")
          ? hasVisibleAncestry(node)
          : isVisiblyRendered(node);
      })
    ) {
      return false;
    }
    const visibleElement = placement.targetType === "text"
      ? placement.target?.parentElement
      : placement.target;
    return Boolean(
      isVisiblyRendered(visibleElement) &&
      placementSourceText(placement) === placement.text
    );
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

  // 只报数量，用户没法区分“本地服务没开”和“模型输出格式错”——两种都长成
  // 一句“N 处失败”。取第一条失败原因跟在后面；状态条只有一行，太长的截断。
  function describeFailures(failures) {
    for (const failure of failures) {
      const message =
        failure?.error instanceof Error
          ? failure.error.message
          : String(failure?.error ?? "");
      const text = message.trim();
      if (!text) {
        continue;
      }
      return text.length > FAILURE_REASON_MAX_LENGTH
        ? `${text.slice(0, FAILURE_REASON_MAX_LENGTH)}…`
        : text;
    }
    return "";
  }

  function failureSuffix(reason) {
    return reason ? `：${reason}` : "";
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

  // 预热批看着像“串行等一个往返的浪费”，实测正相反：它刻意做得很小
  // （LOCAL_FIRST_BATCH_SEGMENT_LIMIT=5），本地 qwen3.5-35b 上约 2.9s 就回来，
  // 首句译文立刻上屏；跳过它让小批去和满批抢并发，首句退到 6.8s，而总
  // 时长毫无改善（37.2s vs 36.9s）。每轮扫描都值得留着。
  function shouldWarmupFirstBatch(settings) {
    return settings?.backend !== "deepseek";
  }

  // 后台任务丢了不等于用户取消了。MV3 的 service worker 被回收、
  // chrome.storage.session 不可用时，任务记录会凭空消失——把它当致命错误
  // 会让所有 worker 同时收工，整页只剩前面几段译文。先向后台要一个新任
  // 务，把剩下的批次接着跑完；要不到才认输。
  async function requestTranslationBatch(batch, taskId) {
    try {
      return await sendTranslationBatch(batch, taskId);
    } catch (error) {
      if (error?.code !== "TRANSLATION_JOB_NOT_FOUND") {
        throw error;
      }
      const session = assertCurrentTask(taskId);
      await renewTranslationJob(session);
      assertCurrentTask(taskId);
      return await sendTranslationBatch(batch, taskId);
    }
  }

  // 每个会话只续一次，而且所有 worker 共用同一次往返：它们会在同一瞬间
  // 撞上同一个“任务不存在”，各建各的任务只有最后一个留得下来。
  function renewTranslationJob(session) {
    if (!session.jobRenewal) {
      session.jobRenewal = requestRenewedTranslationJob(session);
    }
    return session.jobRenewal;
  }

  async function requestRenewedTranslationJob(session) {
    const response = await chrome.runtime.sendMessage({
      type: "RENEW_TRANSLATION_JOB",
      targetLanguage: session.settings.targetLanguage
    });
    if (!response?.ok || !response.jobId) {
      const error = new Error(
        response?.error || "翻译任务不存在或已结束"
      );
      error.code = "TRANSLATION_JOB_NOT_FOUND";
      error.canceled = true;
      throw error;
    }
    session.jobId = response.jobId;
    return response.jobId;
  }

  async function sendTranslationBatch(batch, taskId) {
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
