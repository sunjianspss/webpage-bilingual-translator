import {
  DEFAULT_SETTINGS,
  buildTranslationMessages,
  chatCompletionsUrl,
  estimateTranslationMaxTokens,
  parseTranslations,
  translateWithFallback
} from "./shared.js";

const TRANSLATE_COMMAND = "translate-current-page";

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "TRANSLATE_BATCH") {
    return false;
  }

  translateBatch(message.segments)
    .then((translations) => sendResponse({ ok: true, translations }))
    .catch((error) =>
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      })
    );
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

async function translateBatch(segments) {
  const settings = await loadTranslatorSettings();
  return translateWithFallback(
    segments,
    (batch) => requestTranslations(batch, settings)
  );
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
  const response = await chrome.tabs.sendMessage(tab.id, {
    type: "TRANSLATE_PAGE",
    settings: pageSettings(await loadTranslatorSettings())
  });
  if (!response?.ok) {
    throw new Error(response?.error || "翻译失败");
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

async function requestTranslations(segments, settings) {
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

  let response;
  try {
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
      body: JSON.stringify(body)
    });
  } catch (error) {
    throw new Error(`无法连接翻译服务：${error.message}`);
  }

  if (!response.ok) {
    const detail = await readErrorDetail(response);
    throw new Error(`翻译服务返回 ${response.status}${detail}`);
  }

  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("翻译服务返回了空内容");
  }
  try {
    const translations = parseTranslations(content, requestSegments);
    const missing = requestSegments.filter((item) => !translations[item.id]);
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
