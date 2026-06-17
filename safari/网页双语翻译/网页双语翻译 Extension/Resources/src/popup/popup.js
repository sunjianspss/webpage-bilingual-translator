import { DEFAULT_SETTINGS } from "../shared.js";

const TRANSLATE_COMMAND = "translate-current-page";
const SHORTCUTS_URL = "chrome://extensions/shortcuts";

const elements = {
  backend: document.querySelector("#backend"),
  localFields: document.querySelector("#local-fields"),
  localBaseUrl: document.querySelector("#local-base-url"),
  localModel: document.querySelector("#local-model"),
  localApiKey: document.querySelector("#local-api-key"),
  highQualityReasoning: document.querySelector(
    "#high-quality-reasoning"
  ),
  deepseekFields: document.querySelector("#deepseek-fields"),
  deepseekApiKey: document.querySelector("#deepseek-api-key"),
  deepseekModel: document.querySelector("#deepseek-model"),
  targetLanguage: document.querySelector("#target-language"),
  modeButtons: [...document.querySelectorAll("[data-mode]")],
  pageTitle: document.querySelector("#page-title"),
  statusDot: document.querySelector("#status-dot"),
  message: document.querySelector("#message"),
  translate: document.querySelector("#translate"),
  restore: document.querySelector("#restore"),
  shortcutValue: document.querySelector("#shortcut-value"),
  shortcutNote: document.querySelector("#shortcut-note"),
  customizeShortcut: document.querySelector("#customize-shortcut")
};

let settings = { ...DEFAULT_SETTINGS };
let activeTab = null;

initialize().catch((error) => setMessage(error.message, "error"));

elements.backend.addEventListener("change", () => {
  updateBackendVisibility();
  persistForm().catch((error) => setMessage(error.message, "error"));
});

for (const input of [
  elements.localBaseUrl,
  elements.localModel,
  elements.localApiKey,
  elements.highQualityReasoning,
  elements.deepseekApiKey,
  elements.deepseekModel,
  elements.targetLanguage
]) {
  input.addEventListener("change", () => {
    persistForm().catch((error) => setMessage(error.message, "error"));
  });
}

for (const button of elements.modeButtons) {
  button.addEventListener("click", async () => {
    settings.viewMode = button.dataset.mode;
    updateModeButtons();
    await chrome.storage.local.set({ translatorSettings: readForm() });
    const response = await sendToPage({
      type: "SET_VIEW_MODE",
      viewMode: settings.viewMode
    });
    if (!response?.ok) {
      setMessage(response?.error || "无法切换显示方式", "error");
    }
  });
}

elements.translate.addEventListener("click", async () => {
  setBusy(true);
  try {
    const nextSettings = readForm();
    validateSettings(nextSettings);
    if (
      nextSettings.backend === "local" &&
      needsEndpointPermission(nextSettings.localBaseUrl)
    ) {
      await ensureEndpointPermission(nextSettings.localBaseUrl);
    }
    settings = nextSettings;
    const persistPromise = chrome.storage.local.set({
      translatorSettings: settings
    });
    const responsePromise = sendToPage({
      type: "TRANSLATE_PAGE",
      settings: pageSettings(settings)
    });
    const [response] = await Promise.all([
      responsePromise,
      persistPromise
    ]);
    if (response?.canceled) {
      return;
    }
    if (!response?.ok) {
      throw new Error(response?.error || "翻译失败");
    }
    applyPageState(response.state);
  } catch (error) {
    setMessage(error.message, "error");
    setDot("error");
  } finally {
    setBusy(false);
  }
});

elements.restore.addEventListener("click", async () => {
  const response = await sendToPage({ type: "RESTORE_PAGE" });
  if (response?.ok) {
    applyPageState(response.state);
  } else {
    setMessage(response?.error || "无法恢复原文", "error");
  }
});

elements.customizeShortcut.addEventListener("click", async () => {
  try {
    await chrome.tabs.create({ url: SHORTCUTS_URL });
    window.close();
  } catch (error) {
    setShortcutNote(
      error instanceof Error ? error.message : "无法打开快捷键设置"
    );
  }
});

async function initialize() {
  const stored = await chrome.storage.local.get("translatorSettings");
  settings = {
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
  writeForm(settings);
  updateBackendVisibility();
  updateModeButtons();
  await refreshShortcutCommand();

  const tabs = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });
  activeTab = tabs[0] || null;
  elements.pageTitle.textContent = activeTab?.title || "翻译当前网页";

  if (!activeTab?.id || !/^https?:/i.test(activeTab.url || "")) {
    setMessage("此页面不支持翻译", "error");
    setDot("error");
    elements.translate.disabled = true;
    return;
  }

  await ensureContentScript();
  const response = await sendToPage({ type: "GET_PAGE_STATE" });
  if (response?.ok) {
    applyPageState(response.state);
  } else {
    setMessage("请刷新页面后再试", "error");
    setDot("error");
  }
}

async function refreshShortcutCommand() {
  if (!chrome.commands?.getAll) {
    setShortcutValue(defaultShortcutLabel());
    setShortcutNote("在浏览器快捷键设置中修改");
    return;
  }

  const commands = await chrome.commands.getAll();
  const command = commands.find((item) => item.name === TRANSLATE_COMMAND);
  setShortcutValue(command?.shortcut || "未设置");
  setShortcutNote(
    command?.shortcut
      ? "在浏览器快捷键设置中修改"
      : "未设置快捷键"
  );
}

function defaultShortcutLabel() {
  return /Mac|iPhone|iPad/i.test(navigator.platform)
    ? "Command+Shift+Y"
    : "Ctrl+Shift+Y";
}

function setShortcutValue(value) {
  elements.shortcutValue.textContent = value;
}

function setShortcutNote(value) {
  elements.shortcutNote.textContent = value;
}

function readForm() {
  return {
    backend: elements.backend.value,
    targetLanguage: elements.targetLanguage.value,
    viewMode: settings.viewMode,
    localBaseUrl: elements.localBaseUrl.value.trim(),
    localModel: elements.localModel.value.trim(),
    localApiKey: elements.localApiKey.value.trim(),
    highQualityReasoning: elements.highQualityReasoning.checked,
    deepseekApiKey: elements.deepseekApiKey.value.trim(),
    deepseekModel: elements.deepseekModel.value,
    maxSegments: settings.maxSegments
  };
}

function writeForm(value) {
  elements.backend.value = value.backend;
  elements.localBaseUrl.value = value.localBaseUrl;
  elements.localModel.value = value.localModel;
  elements.localApiKey.value = value.localApiKey;
  elements.highQualityReasoning.checked = value.highQualityReasoning;
  elements.deepseekApiKey.value = value.deepseekApiKey;
  elements.deepseekModel.value = value.deepseekModel;
  elements.targetLanguage.value = value.targetLanguage;
}

async function persistForm(requestPermission = false) {
  const nextSettings = readForm();
  validateSettings(nextSettings);
  if (requestPermission && nextSettings.backend === "local") {
    await ensureEndpointPermission(nextSettings.localBaseUrl);
  }
  settings = nextSettings;
  await chrome.storage.local.set({ translatorSettings: settings });
  return settings;
}

function validateSettings(value) {
  if (value.backend === "local") {
    if (!value.localBaseUrl) {
      throw new Error("请填写本地 API 地址");
    }
    if (!value.localModel) {
      throw new Error("请填写本地模型名称");
    }
    try {
      new URL(value.localBaseUrl);
    } catch {
      throw new Error("本地 API 地址格式不正确");
    }
  }
  if (value.backend === "deepseek" && !value.deepseekApiKey) {
    throw new Error("请填写 DeepSeek API Key");
  }
}

async function ensureEndpointPermission(baseUrl) {
  const url = new URL(baseUrl);
  if (!needsEndpointPermission(baseUrl)) {
    return;
  }
  const originPattern = `${url.protocol}//${url.host}/*`;
  const hasPermission = await chrome.permissions.contains({
    origins: [originPattern]
  });
  if (!hasPermission) {
    const granted = await chrome.permissions.request({
      origins: [originPattern]
    });
    if (!granted) {
      throw new Error("需要允许访问此本地 API 地址");
    }
  }
}

function needsEndpointPermission(baseUrl) {
  const url = new URL(baseUrl);
  return url.hostname !== "127.0.0.1" && url.hostname !== "localhost";
}

function pageSettings(value) {
  return {
    backend: value.backend,
    targetLanguage: value.targetLanguage,
    viewMode: value.viewMode,
    maxSegments: value.maxSegments
  };
}

async function ensureContentScript() {
  await chrome.scripting.executeScript({
    target: { tabId: activeTab.id },
    files: ["src/content.js"]
  });
}

async function sendToPage(message) {
  if (!activeTab?.id) {
    return { ok: false, error: "没有找到当前页面" };
  }
  try {
    return await chrome.tabs.sendMessage(activeTab.id, message);
  } catch {
    return { ok: false, error: "扩展尚未连接页面，请刷新页面" };
  }
}

function updateBackendVisibility() {
  const isDeepSeek = elements.backend.value === "deepseek";
  elements.localFields.hidden = isDeepSeek;
  elements.deepseekFields.hidden = !isDeepSeek;
}

function updateModeButtons() {
  for (const button of elements.modeButtons) {
    button.classList.toggle(
      "selected",
      button.dataset.mode === settings.viewMode
    );
  }
}

function applyPageState(pageState) {
  if (!pageState) {
    return;
  }
  settings.viewMode = pageState.viewMode || settings.viewMode;
  updateModeButtons();
  if (pageState.status === "done") {
    setMessage(`已翻译 ${pageState.translated} 处内容`, "success");
    setDot("done");
  } else if (pageState.status === "translating") {
    setMessage(
      `正在翻译 ${pageState.translated} / ${pageState.total}`,
      ""
    );
    setDot("working");
  } else if (pageState.status === "error") {
    setMessage(pageState.error || "翻译失败", "error");
    setDot("error");
  } else {
    setMessage("准备就绪", "");
    setDot("ready");
  }
}

function setBusy(isBusy) {
  elements.translate.disabled = isBusy;
  elements.restore.disabled = isBusy;
  if (isBusy) {
    setMessage("正在翻译，长页面可能需要一些时间", "");
    setDot("working");
  }
}

function setMessage(text, kind) {
  elements.message.textContent = text;
  elements.message.className = `message${kind ? ` ${kind}` : ""}`;
}

function setDot(kind) {
  elements.statusDot.className = `status-dot ${kind}`;
}
