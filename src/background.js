import {
  DEFAULT_SETTINGS,
  buildTranslationMessages,
  chatCompletionsUrl,
  endpointPermissionOrigin,
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
  "RENEW_TRANSLATION_JOB",
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
  return disposeJobsForTab(tabId, undefined, "标签页已关闭").catch(
    logJobCleanupError
  );
});

// status 不是"文档换了没有"的信号，它只是标签页在不在加载东西。实测：
// 在 vals.ai 上滚一下鼠标，Next.js 按需去取路由分片，标签页的加载状态就
// 翻一次 {status:"loading"} → {status:"complete"}，changeInfo 里连 url
// 都没有，文档自始至终没动过。以前据此销毁任务，结果就是"翻译到一半一
// 滚动就被取消"——页面停在已经翻出来的那几段上，红字说任务已取消。
//
// 真正说明文档要换的是 changeInfo.url。没有 url 的 loading 一律不管：
// 原地重载由内容脚本的 pagehide 发 RELEASE 负责（那是文档真的要走了才
// 会触发），标签页关闭和被替换各有自己的监听器兜底。万一哪条都没来，
// 留下的也只是一份设置快照，等标签页关闭时一起回收——比误杀一轮正在跑
// 的翻译便宜得多。
chrome.tabs?.onUpdated?.addListener?.((tabId, changeInfo) => {
  if (!changeInfo?.url) {
    return;
  }
  return disposeJobsForTab(
    tabId,
    changeInfo.url,
    "页面已跳转"
  ).catch(logJobCleanupError);
});

chrome.tabs?.onReplaced?.addListener?.((_addedTabId, removedTabId) => {
  return disposeJobsForTab(
    removedTabId,
    undefined,
    "标签页已被替换"
  ).catch(logJobCleanupError);
});

async function handleJobMessage(message, sender) {
  if (message.type === "CHECK_TRANSLATION_BACKEND") {
    await checkTranslationBackend(message.settings);
    return { ok: true };
  }

  if (message.type === "DETECT_LOCAL_BACKENDS") {
    const backends = await detectLocalBackends();
    return { ok: true, backends };
  }

  if (message.type === "CREATE_TRANSLATION_JOB") {
    const job = await createTranslationJob(
      message.settings,
      message.tabId,
      message.tabUrl
    );
    return {
      ok: true,
      ...job
    };
  }

  if (message.type === "RENEW_TRANSLATION_JOB") {
    const job = await renewTranslationJob(
      sender?.tab,
      message.targetLanguage
    );
    return {
      ok: true,
      ...job
    };
  }

  // 弹窗和内容脚本都会发取消，但只有内容脚本带 sender.tab。据此区分，
  // 用户看到的那句话才说得出是哪一边取消的。
  if (message.type === "CANCEL_TRANSLATION_JOB") {
    await disposeTranslationJob(
      message.jobId,
      sender?.tab ? "页面主动取消" : "弹窗主动取消"
    );
    return { ok: true, canceled: true };
  }

  if (message.type === "RELEASE_TRANSLATION_JOB") {
    await disposeTranslationJob(
      message.jobId,
      sender?.tab ? "页面已卸载" : "弹窗释放任务"
    );
    return { ok: true };
  }

  const job = await getTranslationJob(
    message.jobId,
    sender?.tab?.id
  );
  const translations = await translateBatch(message.segments, job);
  return { ok: true, translations };
}

async function createTranslationJob(settings, tabId, tabUrl) {
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
  const job = createRuntimeTranslationJob(snapshot, tabId, tabUrl);

  return withTranslationJobState(async () => {
    translationJobs.set(jobId, job);
    try {
      await persistTranslationJob(jobId, job);
    } catch (error) {
      translationJobs.delete(jobId);
      job.controller.abort("任务未能保存");
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
          persisted.tabId,
          persisted.documentUrl
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
      throw canceledError(cancellationMessage(job.controller.signal.reason));
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

async function disposeTranslationJob(jobId, reason) {
  return withTranslationJobState(async () => {
    abortInMemoryTranslationJob(jobId, reason);
    await removePersistedTranslationJobs([jobId]);
  });
}

async function disposeJobsForTab(tabId, nextUrl, reason) {
  return withTranslationJobState(async () => {
    const nextDocument = documentIdentity(nextUrl);
    const survivesNavigation = (job) =>
      nextDocument !== null && job.documentUrl === nextDocument;
    const jobIds = new Set();
    for (const [jobId, job] of translationJobs) {
      if (job.tabId === tabId && !survivesNavigation(job)) {
        jobIds.add(jobId);
      }
    }
    for (const persisted of await readAllPersistedTranslationJobs()) {
      if (
        persisted.tabId === tabId &&
        !survivesNavigation(persisted)
      ) {
        jobIds.add(persisted.jobId);
      }
    }
    for (const jobId of jobIds) {
      abortInMemoryTranslationJob(jobId, reason);
    }
    await removePersistedTranslationJobs([...jobIds]);
  });
}

function createRuntimeTranslationJob(settings, tabId, documentUrl) {
  return {
    settings: Object.freeze({
      ...DEFAULT_SETTINGS,
      ...settings
    }),
    controller: new AbortController(),
    tabId: Number.isInteger(tabId) ? tabId : null,
    documentUrl: documentIdentity(documentUrl)
  };
}

// 文档身份只算到 fragment 之前：#solution 和 #takeaways 是同一篇文档，
// 换了 path 才是换了内容。解析不出来时返回 null，调用方会退回“销毁”，
// 也就是改动前的行为。
function documentIdentity(url) {
  if (typeof url !== "string" || !url) {
    return null;
  }
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.href;
  } catch (_error) {
    return null;
  }
}

function abortInMemoryTranslationJob(jobId, reason) {
  const job = translationJobs.get(jobId);
  translationJobs.delete(jobId);
  if (job && !job.controller.signal.aborted) {
    // AbortSignal.reason 就是为这个存在的：飞行中的批次只拿得到 signal，
    // 拿不到 job，靠它才能说清这一次中止是谁发起的。
    job.controller.abort(reason);
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
      documentUrl: job.documentUrl,
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
    documentUrl: documentIdentity(record.documentUrl),
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

// 后台任务消失不一定是用户取消了：MV3 的 service worker 被回收、
// chrome.storage.session 不可用（Safari）时，任务记录会凭空不见，而页面
// 那边整轮翻译才刚跑到一半。给它重建一个任务，让剩下的批次接着跑，
// 比把半页原文留在那里强。API Key 仍然只在后台读，不经过页面。
async function renewTranslationJob(senderTab, targetLanguage) {
  if (!Number.isInteger(senderTab?.id)) {
    throw codedError(
      "翻译任务只能由页面自己续期",
      "TRANSLATION_JOB_TAB_MISMATCH"
    );
  }
  const stored = await loadTranslatorSettings();
  // 续期读的是当前存储：用户在翻译途中改过目标语言的话，后半页会和前
  // 半页对不上。页面报上来的是它这一轮一直在用的那个，以它为准——这是
  // 页面唯一能影响续期的字段，端点、模型和 Key 仍然只认存储里的。
  const settings = {
    ...stored,
    targetLanguage:
      typeof targetLanguage === "string" && targetLanguage
        ? targetLanguage
        : stored.targetLanguage
  };
  return createTranslationJob(settings, senderTab.id, senderTab.url);
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
    await assertConfiguredEndpointPermission(settings);
    await checkTranslationBackend(settings);
    const job = await createTranslationJob(settings, tab.id, tab.url);
    // 端口断了说明不了页面有没有接下任务。销毁一个正在用的任务，会让在
    // 飞的批次全部报"已取消"，半页原文就留在那里；留下一个没人认领的任
    // 务只是一份设置快照，标签页关闭或跳转时自会回收。所以只在页面明确
    // 回绝时才销毁，发送失败时宁可漏一个。
    const response = await chrome.tabs.sendMessage(tab.id, {
      type: "TRANSLATE_PAGE",
      jobId: job.jobId,
      pageSettings: job.pageSettings
    });
    // 页面已经在翻了不是错误，是这一次按键没事可做。再往页面上糊一条红
    // 字，只会盖掉那一轮真正的进度。
    if (response?.code === "TRANSLATION_IN_PROGRESS") {
      await disposeTranslationJob(job.jobId, "页面已有翻译在进行");
      return;
    }
    if (!response?.ok) {
      await disposeTranslationJob(job.jobId, "页面回绝了任务");
      throw new Error(response?.error || "翻译失败");
    }
  } catch (error) {
    // 快捷键路径没有弹窗可以显示错误，只能把原因送回页面的状态条。
    await showTranslationErrorInTab(tab.id, error);
    throw error;
  }
}

async function assertConfiguredEndpointPermission(settings) {
  if (settings.backend !== "local") {
    return;
  }
  const baseUrl = normalizeBaseUrl(settings.localBaseUrl);
  if (!baseUrl) {
    return;
  }
  const originPattern = endpointPermissionOrigin(baseUrl);
  if (!originPattern) {
    return;
  }
  const hasPermission = await chrome.permissions?.contains?.({
    origins: [originPattern]
  });
  if (!hasPermission) {
    throw codedError(
      "请先打开扩展并允许访问此本地 API 地址",
      "LOCAL_ENDPOINT_PERMISSION_REQUIRED"
    );
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
async function detectLocalBackends() {
  const results = await Promise.all(
    LOCAL_BACKEND_CANDIDATES.map((candidate) =>
      probeLocalBackendCandidate(candidate)
    )
  );
  return results.filter((result) => result !== null);
}

async function probeLocalBackendCandidate(candidate) {
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    LOCAL_BACKEND_DETECT_TIMEOUT_MS
  );
  try {
    const response = await fetch(modelsUrl(candidate.baseUrl), {
      method: "GET",
      headers: {},
      signal: controller.signal
    });
    if (response.status === 401) {
      return {
        baseUrl: candidate.baseUrl,
        label: candidate.label,
        models: [],
        requiresAuth: true
      };
    }
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
  const abortFromJob = () => controller.abort(jobSignal.reason);
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
    throw canceledError(cancellationMessage(jobSignal.reason));
  }
  if (requestControl.didTimeOut()) {
    throw codedError("翻译服务请求超时", "TRANSLATION_TIMEOUT");
  }
}

function assertJobActive(jobSignal) {
  if (jobSignal.aborted) {
    throw canceledError(cancellationMessage(jobSignal.reason));
  }
}

// 中止有五六个来源,共用一句"翻译任务已取消"的话,读到它的人无从分辨
// 是自己点了取消、页面跳走了,还是后台自作主张。把来源缀在后面。
function cancellationMessage(reason) {
  return typeof reason === "string" && reason
    ? `翻译任务已取消（${reason}）`
    : "翻译任务已取消";
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
