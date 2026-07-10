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
const translationJobs = new Map();
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
  disposeJobsForTab(tabId);
});

chrome.tabs?.onUpdated?.addListener?.((tabId, changeInfo) => {
  if (changeInfo?.status === "loading") {
    disposeJobsForTab(tabId);
  }
});

chrome.tabs?.onReplaced?.addListener?.((_addedTabId, removedTabId) => {
  disposeJobsForTab(removedTabId);
});

async function handleJobMessage(message, sender) {
  if (message.type === "CREATE_TRANSLATION_JOB") {
    return {
      ok: true,
      ...createTranslationJob(message.settings, message.tabId)
    };
  }

  if (message.type === "CANCEL_TRANSLATION_JOB") {
    disposeTranslationJob(message.jobId);
    return { ok: true, canceled: true };
  }

  if (message.type === "RELEASE_TRANSLATION_JOB") {
    disposeTranslationJob(message.jobId);
    return { ok: true };
  }

  const job = getTranslationJob(message.jobId, sender?.tab?.id);
  const translations = await translateBatch(message.segments, job);
  return { ok: true, translations };
}

function createTranslationJob(settings, tabId) {
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
  translationJobs.set(jobId, {
    settings: snapshot,
    controller: new AbortController(),
    tabId: Number.isInteger(tabId) ? tabId : null
  });
  return {
    jobId,
    pageSettings: pageSettings(snapshot)
  };
}

function createJobId() {
  return globalThis.crypto?.randomUUID?.() ||
    `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function getTranslationJob(jobId, senderTabId) {
  const job = translationJobs.get(jobId);
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
}

function disposeTranslationJob(jobId) {
  const job = translationJobs.get(jobId);
  if (!job) {
    return;
  }
  translationJobs.delete(jobId);
  if (!job.controller.signal.aborted) {
    job.controller.abort();
  }
}

function disposeJobsForTab(tabId) {
  for (const [jobId, job] of translationJobs) {
    if (job.tabId === tabId) {
      disposeTranslationJob(jobId);
    }
  }
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
  const job = createTranslationJob(
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
    disposeTranslationJob(job.jobId);
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

function createRequestControl(jobSignal) {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromJob = () => controller.abort();

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
