import {
  DEFAULT_SETTINGS,
  buildTranslationMessages,
  chatCompletionsUrl,
  estimateTranslationMaxTokens,
  modelsUrl,
  chatModelIds,
  LOCAL_BACKEND_CANDIDATES,
  LOCAL_BACKEND_DETECT_TIMEOUT_MS,
  normalizeBaseUrl,
  parseTranslations,
  translateWithFallback
} from "./shared.js";

const TRANSLATE_COMMAND = "translate-current-page";
const TRANSLATION_REQUEST_TIMEOUT_MS = 45_000;
// 探活只是一次本地 GET，慢到 5s 还没回来的服务，整页翻译也没法用。
const BACKEND_PROBE_TIMEOUT_MS = 5_000;
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
  "CHECK_TRANSLATION_BACKEND",
  "DETECT_LOCAL_BACKENDS",
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
  if (message.type === "CHECK_TRANSLATION_BACKEND") {
    await checkTranslationBackend(message.settings);
    return { ok: true };
  }

  if (message.type === "DETECT_LOCAL_BACKENDS") {
    const backends = await detectLocalBackends(message.apiKey);
    return { ok: true, backends };
  }

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
  try {
    const settings = await loadTranslatorSettings();
    await checkTranslationBackend(settings);
    const job = await createTranslationJob(settings, tab.id);
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
  } catch (error) {
    // 快捷键路径没有弹窗可以显示错误，只能把原因送回页面的状态条。
    await showTranslationErrorInTab(tab.id, error);
    throw error;
  }
}

async function showTranslationErrorInTab(tabId, error) {
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: "SHOW_TRANSLATION_ERROR",
      error: error instanceof Error ? error.message : String(error)
    });
  } catch (_sendError) {
    // 页面可能已经跳走或没接上内容脚本，调用方仍会把错误写进控制台。
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

// 本地服务没起来是这个扩展最常见的失败原因（LM Studio 的 server 开关被关、
// 端口改了、模型名和实际加载的对不上）。以前它只能表现成几十个批次全部
// fetch 失败，界面上只剩一句“N 处失败”——原因全丢了，还白等一整轮。
// 开翻前先花一次 /models 往返，把这类问题在第一秒就说清楚。
async function checkTranslationBackend(settings) {
  const merged = Object.freeze({
    ...DEFAULT_SETTINGS,
    ...(settings || {})
  });
  // DeepSeek 的失败本身就带 HTTP 状态码和服务端的错误说明，够清楚了，
  // 不值得为它多付一次跨公网往返。
  if (merged.backend === "deepseek") {
    return;
  }

  const baseUrl = normalizeBaseUrl(merged.localBaseUrl);
  if (!baseUrl) {
    throw new Error("请填写本地 API 地址");
  }
  const model = merged.localModel?.trim();
  if (!model) {
    throw new Error("请填写模型名称");
  }

  const headers = {};
  if (merged.localApiKey?.trim()) {
    headers.Authorization = `Bearer ${merged.localApiKey.trim()}`;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    BACKEND_PROBE_TIMEOUT_MS
  );
  let response;
  try {
    response = await fetch(modelsUrl(baseUrl), {
      method: "GET",
      headers,
      signal: controller.signal
    });
  } catch (_error) {
    throw codedError(
      `无法连接本地翻译服务 ${baseUrl}，请确认 LM Studio 等服务已启动`,
      "LOCAL_BACKEND_UNREACHABLE"
    );
  } finally {
    clearTimeout(timeoutId);
  }

  if (response.status === 401 || response.status === 403) {
    throw codedError(
      "本地翻译服务要求身份验证，请在扩展中填写 API Token",
      "LOCAL_BACKEND_UNAUTHORIZED"
    );
  }
  // 服务活着但没实现 /models 也很正常，这种情况不该挡住翻译，
  // 真出问题时正式请求会带回自己的错误。
  if (!response.ok) {
    return;
  }

  const availableModels = await readModelIds(response);
  if (availableModels.length > 0 && !hasModel(availableModels, model)) {
    throw codedError(
      `本地服务里没有模型 ${model}，当前可用：${availableModels
        .slice(0, 3)
        .join("、")}`,
      "LOCAL_MODEL_NOT_FOUND"
    );
  }
}

// 同时打所有候选端口。串行的话没人监听的端口要各等一次超时,五个端口
// 最坏要等 7.5s;并行之后整体就是最慢的那一个。
async function detectLocalBackends(apiKey) {
  const results = await Promise.all(
    LOCAL_BACKEND_CANDIDATES.map((candidate) =>
      probeLocalBackendCandidate(candidate, apiKey)
    )
  );
  return results.filter((result) => result !== null);
}

async function probeLocalBackendCandidate(candidate, apiKey) {
  const headers = {};
  if (apiKey?.trim()) {
    headers.Authorization = `Bearer ${apiKey.trim()}`;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    LOCAL_BACKEND_DETECT_TIMEOUT_MS
  );
  try {
    const response = await fetch(modelsUrl(candidate.baseUrl), {
      method: "GET",
      headers,
      signal: controller.signal
    });
    if (!response.ok) {
      return null;
    }
    // 模型列表为空也照样返回:LM Studio 开着但没加载模型就是这个形状,
    // 报"在运行但没加载模型"比报"没找到服务"有用得多。
    return {
      baseUrl: candidate.baseUrl,
      label: candidate.label,
      models: chatModelIds(await readModelIds(response))
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function readModelIds(response) {
  try {
    const payload = await response.json();
    const items = Array.isArray(payload?.data) ? payload.data : [];
    return items
      .map((item) => item?.id)
      .filter((id) => typeof id === "string" && id.length > 0);
  } catch {
    return [];
  }
}

// Ollama 把标签算进模型 id（llama3:latest），用户通常只填 llama3。
// 名字对得上就放行，宁可漏报也不要拦住一次本来能成的翻译。
function hasModel(availableModels, model) {
  return availableModels.some(
    (id) => id === model || id.startsWith(`${model}:`)
  );
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
