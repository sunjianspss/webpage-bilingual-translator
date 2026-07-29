import {
  DEFAULT_SETTINGS,
  buildTranslationMessages,
  chatCompletionsUrl,
  estimateTranslationMaxTokens,
  parseTranslations,
  translateWithFallback
} from "./shared.js";

const TRANSLATE_COMMAND = "translate-current-page";
const TRANSLATION_REQUEST_TIMEOUT_MS = 45_000;
// MV3 的 service worker 空闲 30s 就会被回收，而单个翻译请求最长允许 45s，
// 提高并发后单批往返本身也变长（本地模型上从 11s 涨到 27s）。SW 一旦在
// fetch 返回前被杀，content 侧那条 sendMessage 只会收到
// "message channel closed before a response was received"，整批译文丢失。
// 定期调一次扩展 API 可以重置空闲计时器，这是 MV3 下保活的通行做法。
const SERVICE_WORKER_KEEPALIVE_MS = 20_000;
const TRANSLATION_JOB_STORAGE_PREFIX = "translatorTranslationJob:";
const translationJobs = new Map();
let translationJobStateQueue = Promise.resolve();
const JOB_MESSAGE_TYPES = new Set([
  "CREATE_TRANSLATION_JOB",
  "TRANSLATE_BATCH",
  "CANCEL_TRANSLATION_JOB",
  "RELEASE_TRANSLATION_JOB"
]);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!JOB_MESSAGE_TYPES.has(message?.type)) {
    return false;
  }

  handleJobMessage(message, sender)
    .then(sendResponse)
    .catch((error) => sendResponse(errorResponse(error)));
  return true;
});

chrome.commands?.onCommand?.addListener((command) => {
  if (command !== TRANSLATE_COMMAND) {
    return;
  }

  translateActiveTabFromCommand().catch((error) => {
    console.warn(
      "无法通过快捷键翻译当前页面",
      error instanceof Error ? error.message : error
    );
  });
});

chrome.tabs?.onRemoved?.addListener?.((tabId) => {
  return disposeJobsForTab(tabId).catch(logJobCleanupError);
});

chrome.tabs?.onUpdated?.addListener?.((tabId, changeInfo) => {
  if (changeInfo?.status === "loading") {
    return disposeJobsForTab(tabId).catch(logJobCleanupError);
  }
});

chrome.tabs?.onReplaced?.addListener?.((_addedTabId, removedTabId) => {
  return disposeJobsForTab(removedTabId).catch(logJobCleanupError);
});

async function handleJobMessage(message, sender) {
  if (message.type === "CREATE_TRANSLATION_JOB") {
    const job = await createTranslationJob(
      message.settings,
      message.tabId
    );
    return {
      ok: true,
      ...job
    };
  }

  if (message.type === "CANCEL_TRANSLATION_JOB") {
    await disposeTranslationJob(message.jobId);
    return { ok: true, canceled: true };
  }

  if (message.type === "RELEASE_TRANSLATION_JOB") {
    await disposeTranslationJob(message.jobId);
    return { ok: true };
  }

  const job = await getTranslationJob(
    message.jobId,
    sender?.tab?.id
  );
  const translations = await translateBatch(message.segments, job);
  return { ok: true, translations };
}

async function createTranslationJob(settings, tabId) {
  if (!settings || typeof settings !== "object") {
    throw codedError(
      "创建翻译任务时缺少设置",
      "INVALID_TRANSLATION_SETTINGS"
    );
  }

  const snapshot = Object.freeze({
    ...DEFAULT_SETTINGS,
    ...settings
  });
  const jobId = createJobId();
  const job = createRuntimeTranslationJob(snapshot, tabId);

  return withTranslationJobState(async () => {
    translationJobs.set(jobId, job);
    try {
      await persistTranslationJob(jobId, job);
    } catch (error) {
      translationJobs.delete(jobId);
      job.controller.abort();
      throw error;
    }
    return {
      jobId,
      pageSettings: pageSettings(snapshot)
    };
  });
}

function createJobId() {
  return globalThis.crypto?.randomUUID?.() ||
    `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function getTranslationJob(jobId, senderTabId) {
  return withTranslationJobState(async () => {
    let job = translationJobs.get(jobId);
    if (!job) {
      const persisted = await readPersistedTranslationJob(jobId);
      if (persisted) {
        job = createRuntimeTranslationJob(
          persisted.settings,
          persisted.tabId
        );
        translationJobs.set(jobId, job);
      }
    }
    if (!job) {
      throw canceledError(
        "翻译任务不存在或已结束",
        "TRANSLATION_JOB_NOT_FOUND"
      );
    }
    if (job.controller.signal.aborted) {
      throw canceledError();
    }
    if (job.tabId !== null && senderTabId !== job.tabId) {
      throw codedError(
        "翻译任务与当前页面不匹配",
        "TRANSLATION_JOB_TAB_MISMATCH"
      );
    }
    return job;
  });
}

async function disposeTranslationJob(jobId) {
  return withTranslationJobState(async () => {
    abortInMemoryTranslationJob(jobId);
    await removePersistedTranslationJobs([jobId]);
  });
}

async function disposeJobsForTab(tabId) {
  return withTranslationJobState(async () => {
    const jobIds = new Set();
    for (const [jobId, job] of translationJobs) {
      if (job.tabId === tabId) {
        jobIds.add(jobId);
      }
    }
    for (const persisted of await readAllPersistedTranslationJobs()) {
      if (persisted.tabId === tabId) {
        jobIds.add(persisted.jobId);
      }
    }
    for (const jobId of jobIds) {
      abortInMemoryTranslationJob(jobId);
    }
    await removePersistedTranslationJobs([...jobIds]);
  });
}

function createRuntimeTranslationJob(settings, tabId) {
  return {
    settings: Object.freeze({
      ...DEFAULT_SETTINGS,
      ...settings
    }),
    controller: new AbortController(),
    tabId: Number.isInteger(tabId) ? tabId : null
  };
}

function abortInMemoryTranslationJob(jobId) {
  const job = translationJobs.get(jobId);
  translationJobs.delete(jobId);
  if (job && !job.controller.signal.aborted) {
    job.controller.abort();
  }
}

function withTranslationJobState(operation) {
  const result = translationJobStateQueue.then(operation, operation);
  translationJobStateQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

function translationJobStorage() {
  const storage = chrome.storage?.session;
  if (
    !storage ||
    typeof storage.get !== "function" ||
    typeof storage.set !== "function" ||
    typeof storage.remove !== "function"
  ) {
    return null;
  }
  return storage;
}

function translationJobStorageKey(jobId) {
  return `${TRANSLATION_JOB_STORAGE_PREFIX}${jobId}`;
}

async function persistTranslationJob(jobId, job) {
  const storage = translationJobStorage();
  if (!storage) {
    return;
  }
  await storage.set({
    [translationJobStorageKey(jobId)]: {
      version: 1,
      jobId,
      tabId: job.tabId,
      settings: { ...job.settings }
    }
  });
}

async function readPersistedTranslationJob(jobId) {
  const storage = translationJobStorage();
  if (!storage) {
    return null;
  }
  const key = translationJobStorageKey(jobId);
  const stored = await storage.get(key);
  const record = normalizePersistedTranslationJob(stored[key], jobId);
  if (!record && key in stored) {
    await storage.remove(key);
  }
  return record;
}

async function readAllPersistedTranslationJobs() {
  const storage = translationJobStorage();
  if (!storage) {
    return [];
  }
  const stored = await storage.get(null);
  return Object.entries(stored)
    .filter(([key]) => key.startsWith(TRANSLATION_JOB_STORAGE_PREFIX))
    .map(([key, value]) =>
      normalizePersistedTranslationJob(
        value,
        key.slice(TRANSLATION_JOB_STORAGE_PREFIX.length)
      )
    )
    .filter(Boolean);
}

function normalizePersistedTranslationJob(record, jobId) {
  if (
    !record ||
    record.version !== 1 ||
    record.jobId !== jobId ||
    !record.settings ||
    typeof record.settings !== "object" ||
    !(record.tabId === null || Number.isInteger(record.tabId))
  ) {
    return null;
  }
  return {
    jobId,
    tabId: record.tabId,
    settings: Object.freeze({
      ...DEFAULT_SETTINGS,
      ...record.settings
    })
  };
}

async function removePersistedTranslationJobs(jobIds) {
  const storage = translationJobStorage();
  if (!storage || jobIds.length === 0) {
    return;
  }
  await storage.remove(jobIds.map(translationJobStorageKey));
}

function logJobCleanupError(error) {
  console.warn(
    "无法清理翻译任务",
    error instanceof Error ? error.message : error
  );
}

async function translateBatch(segments, job) {
  const translations = await translateWithFallback(
    segments,
    (batch) =>
      requestTranslations(batch, job.settings, job.controller.signal)
  );
  assertJobActive(job.controller.signal);
  return translations;
}

async function translateActiveTabFromCommand() {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });
  if (!tab?.id || !/^https?:/i.test(tab.url || "")) {
    return;
  }

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["src/content.js"]
  });
  const job = await createTranslationJob(
    await loadTranslatorSettings(),
    tab.id
  );
  try {
    const response = await chrome.tabs.sendMessage(tab.id, {
      type: "TRANSLATE_PAGE",
      jobId: job.jobId,
      pageSettings: job.pageSettings
    });
    if (!response?.ok) {
      throw new Error(response?.error || "翻译失败");
    }
  } catch (error) {
    await disposeTranslationJob(job.jobId);
    throw error;
  }
}

async function loadTranslatorSettings() {
  const stored = await chrome.storage.local.get("translatorSettings");
  const settings = {
    ...DEFAULT_SETTINGS,
    ...(stored.translatorSettings || {})
  };
  if (
    typeof stored.translatorSettings?.highQualityReasoning !== "boolean" &&
    typeof stored.translatorSettings?.localDisableReasoning === "boolean"
  ) {
    settings.highQualityReasoning =
      !stored.translatorSettings.localDisableReasoning;
  }
  return settings;
}

function pageSettings(settings) {
  return {
    backend: settings.backend,
    targetLanguage: settings.targetLanguage,
    viewMode: settings.viewMode,
    maxSegments: settings.maxSegments
  };
}

async function requestTranslations(segments, settings, jobSignal) {
  const isDeepSeek = settings.backend === "deepseek";
  const requestSegments = isDeepSeek
    ? segments
    : compactSegmentIds(segments);
  const baseUrl = isDeepSeek
    ? "https://api.deepseek.com"
    : settings.localBaseUrl;
  const model = isDeepSeek
    ? settings.deepseekModel
    : settings.localModel;
  const apiKey = isDeepSeek
    ? settings.deepseekApiKey
    : settings.localApiKey;

  if (!model?.trim()) {
    throw new Error("请填写模型名称");
  }
  if (isDeepSeek && !apiKey?.trim()) {
    throw new Error("请填写 DeepSeek API Key");
  }

  const headers = {
    "Content-Type": "application/json"
  };
  if (apiKey?.trim()) {
    headers.Authorization = `Bearer ${apiKey.trim()}`;
  }

  const requestControl = createRequestControl(jobSignal);
  try {
    let response;
    const body = {
      model: model.trim(),
      messages: buildTranslationMessages(
        requestSegments,
        settings.targetLanguage,
        { compactInput: !isDeepSeek }
      ),
      temperature: 0.2,
      max_tokens: estimateTranslationMaxTokens(requestSegments),
      stream: false
    };
    if (isDeepSeek) {
      body.response_format = { type: "json_object" };
      body.thinking = {
        type: settings.highQualityReasoning ? "enabled" : "disabled"
      };
    } else if (!settings.highQualityReasoning) {
      body.reasoning_effort = "none";
    }

    response = await fetch(chatCompletionsUrl(baseUrl), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: requestControl.signal
    });
    assertRequestActive(jobSignal, requestControl);

    if (!response.ok) {
      const detail = await readErrorDetail(response);
      assertRequestActive(jobSignal, requestControl);
      throw new Error(`翻译服务返回 ${response.status}${detail}`);
    }

    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      assertRequestActive(jobSignal, requestControl);
      throw error;
    }
    assertRequestActive(jobSignal, requestControl);
    const content = payload?.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("翻译服务返回了空内容");
    }
    try {
      const translations = parseTranslations(content, requestSegments);
      const missing = requestSegments.filter(
        (item) => !translations[item.id]
      );
      if (missing.length > 0) {
        const error = new Error(
          `模型漏掉了 ${missing.length} 个翻译片段`
        );
        error.code = "MODEL_OUTPUT";
        throw error;
      }
      return isDeepSeek
        ? translations
        : restoreSegmentIds(translations, segments);
    } catch (error) {
      if (error?.code === "MODEL_OUTPUT") {
        throw error;
      }
      const outputError = new Error(`模型返回格式错误：${error.message}`);
      outputError.code = "MODEL_OUTPUT";
      throw outputError;
    }
  } catch (error) {
    if (
      error?.code === "MODEL_OUTPUT" ||
      error?.code === "TRANSLATION_CANCELED" ||
      error?.code === "TRANSLATION_TIMEOUT" ||
      /^翻译服务返回/.test(error?.message || "")
    ) {
      throw error;
    }
    assertRequestActive(jobSignal, requestControl);
    throw new Error(
      `无法连接翻译服务：${
        error instanceof Error ? error.message : String(error)
      }`
    );
  } finally {
    requestControl.cleanup();
  }
}

let keepAliveHolders = 0;
let keepAliveTimer = null;

function acquireServiceWorkerKeepAlive() {
  keepAliveHolders += 1;
  if (keepAliveTimer !== null) {
    return;
  }
  keepAliveTimer = setInterval(() => {
    try {
      chrome.runtime?.getPlatformInfo?.()?.catch?.(() => {});
    } catch (_error) {
      // 保活失败不该影响翻译本身。
    }
  }, SERVICE_WORKER_KEEPALIVE_MS);
}

function releaseServiceWorkerKeepAlive() {
  keepAliveHolders = Math.max(0, keepAliveHolders - 1);
  if (keepAliveHolders > 0 || keepAliveTimer === null) {
    return;
  }
  clearInterval(keepAliveTimer);
  keepAliveTimer = null;
}

function createRequestControl(jobSignal) {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromJob = () => controller.abort();
  // 请求存续期间保活，cleanup() 已由 finally 保证一定会跑，配对是安全的。
  acquireServiceWorkerKeepAlive();

  if (jobSignal.aborted) {
    abortFromJob();
  } else {
    jobSignal.addEventListener("abort", abortFromJob, { once: true });
  }
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, TRANSLATION_REQUEST_TIMEOUT_MS);

  return {
    signal: controller.signal,
    didTimeOut: () => timedOut,
    cleanup() {
      clearTimeout(timeoutId);
      jobSignal.removeEventListener("abort", abortFromJob);
      releaseServiceWorkerKeepAlive();
    }
  };
}

function assertRequestActive(jobSignal, requestControl) {
  if (jobSignal.aborted) {
    throw canceledError();
  }
  if (requestControl.didTimeOut()) {
    throw codedError("翻译服务请求超时", "TRANSLATION_TIMEOUT");
  }
}

function assertJobActive(jobSignal) {
  if (jobSignal.aborted) {
    throw canceledError();
  }
}

function codedError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function canceledError(
  message = "翻译任务已取消",
  code = "TRANSLATION_CANCELED"
) {
  const error = codedError(message, code);
  error.canceled = true;
  return error;
}

function errorResponse(error) {
  const response = {
    ok: false,
    error: error instanceof Error ? error.message : String(error)
  };
  if (error?.code) {
    response.code = error.code;
  }
  if (error?.canceled) {
    response.canceled = true;
  }
  return response;
}

function compactSegmentIds(segments) {
  return segments.map((segment, index) => ({
    ...segment,
    id: String(index + 1)
  }));
}

function restoreSegmentIds(translations, originalSegments) {
  return Object.fromEntries(
    originalSegments
      .map((segment, index) => [
        segment.id,
        translations[String(index + 1)]
      ])
      .filter(([, text]) => typeof text === "string")
  );
}

async function readErrorDetail(response) {
  try {
    const payload = await response.json();
    const message = payload?.error?.message || payload?.message;
    return message ? `：${message}` : "";
  } catch {
    return "";
  }
}
