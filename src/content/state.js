  const MARKER = "data-ai-page-translator";
  const OWNED_MARKER = "data-ai-page-translator-owned";
  const ORIGINAL_CLASS = "ai-page-translator-original";
  const TRANSLATION_CLASS = "ai-page-translator-translation";
  const STYLE_ID = "ai-page-translator-style";
  const STATUS_ID = "ai-page-translator-status";
  const STRUCTURED_TEXT_SELECTOR = [
    "[data-testid='tweetText']",
    "[data-testid='tweet-text']",
    "[data-testid='postText']",
    "[data-testid='post-text']",
    "[data-testid='status-content']",
    "[data-testid='commentText']",
    "[data-testid='comment-text']"
  ].join(", ");
  // 采集时“这个容器整体不该碰”的判定：合成一个选择器，让 closest 只
  // 沿祖先链走一趟，而不是每个容器走三趟。
  const EXCLUDED_CONTAINER_SELECTOR =
    `[${MARKER}], [${OWNED_MARKER}], script, style, noscript, code, pre, ` +
    "svg, canvas, iframe, textarea, input, select, " +
    "[contenteditable='true'], [aria-hidden='true'], nav, header, footer, aside";
  const VIEW_CLASSES = [
    "ai-page-translator-bilingual",
    "ai-page-translator-translated"
  ];
  const BLOCK_LEVEL_TAGS = new Set([
    "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DETAILS", "DIALOG",
    "DIV", "DL", "FIELDSET", "FIGCAPTION", "FIGURE", "FOOTER", "FORM",
    "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HR", "LI", "MAIN",
    "NAV", "OL", "P", "PRE", "SECTION", "TABLE", "UL"
  ]);
  const INLINE_TEXT_BLOCK_MIN_LENGTH = 20;
  const DYNAMIC_RESCAN_DELAYS = [0, 400, 900];
  const DEFAULT_TEXT_MAX_LENGTH = 1200;
  // 整页耗时 ≈ ceil(批次数 / 并发数) × 单批往返时间，并发是唯一的线性
  // 杠杆。远端 DeepSeek 的限流远高于此；本地 OpenAI 兼容服务（LM Studio、
  // vLLM 等）默认都能并行处理数条请求，串行度不足时也只是排队，不会出错。
  const LOCAL_TRANSLATION_BATCH_CONCURRENCY = 4;
  const REMOTE_TRANSLATION_BATCH_CONCURRENCY = 6;
  const LOCAL_FIRST_BATCH_SEGMENT_LIMIT = 5;
  const LOCAL_FIRST_BATCH_CHARACTER_LIMIT = 1400;
  const LOCAL_BATCH_SEGMENT_LIMIT = 18;
  const LOCAL_BATCH_CHARACTER_LIMIT = 4200;
  const REMOTE_FIRST_BATCH_SEGMENT_LIMIT = 4;
  const REMOTE_FIRST_BATCH_CHARACTER_LIMIT = 900;
  const REMOTE_BATCH_SEGMENT_LIMIT = 18;
  const REMOTE_BATCH_CHARACTER_LIMIT = 4200;
  // 推文等结构化正文经常超过 1200 字符，放宽到接近单批 4200 字符的预算，
  // 这样长推文仍可整体翻译而不会被静默跳过。
  const STRUCTURED_TEXT_MAX_LENGTH = 4000;
  const MUTATION_SCAN_DEBOUNCE_MS = 120;
  const PERSISTENT_CACHE_KEY_PREFIX = "aiPageTranslatorCache:";
  const PERSISTENT_CACHE_INDEX_KEY = "aiPageTranslatorCacheIndex";
  const PERSISTENT_CACHE_MAX_ENTRIES = 3000;
  const TARGET_LANGUAGE_SCRIPT_PATTERNS = {
    "zh-CN": /[\u3400-\u9fff]/,
    "zh-TW": /[\u3400-\u9fff]/,
    ja: /[\u3040-\u30ff\u3400-\u9fff]/,
    ko: /[\uac00-\ud7af]/
  };
  let taskGeneration = 0;
  // 预热批只是为了给冷启动的本地模型留出加载时间：一旦本页已经成功拿到
  // 过一次译文，模型必然是热的，再串行等一整个往返就是纯浪费。
  let backendWarmedUp = false;
  let persistentCacheWriteChain = Promise.resolve();
  const persistentCachePendingWrites = new Map();
  let activeSession = null;
  let pendingStartJobId = "";

  let state = {
    status: "idle",
    translated: 0,
    total: 0,
    viewMode: "bilingual",
    error: ""
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "GET_PAGE_STATE") {
      sendResponse({ ok: true, state });
      return false;
    }

    if (message?.type === "SET_VIEW_MODE") {
      setViewMode(message.viewMode);
      sendResponse({ ok: true, state });
      return false;
    }

    if (message?.type === "RESTORE_PAGE") {
      cancelAndRestore();
      sendResponse({ ok: true, state });
      return false;
    }

    if (message?.type === "CLEAR_PAGE_CACHE") {
      clearPagePersistentCache()
        .then(() => sendResponse({ ok: true, state }))
        .catch((error) =>
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            state
          })
        );
      return true;
    }

    if (message?.type === "TRANSLATE_PAGE") {
      if (state.status === "translating") {
        sendResponse({
          ok: false,
          error: "页面正在翻译，请稍候",
          state
        });
        return false;
      }
      if (!message.settings) {
        message.settings = message.pageSettings;
      }
      const settings = message.settings;
      if (!message.jobId || !settings) {
        sendResponse({
          ok: false,
          error: "翻译任务缺少 jobId 或页面设置",
          state
        });
        return false;
      }
      pendingStartJobId = message.jobId;
      startTranslation(message.settings);
      sendResponse({ ok: true, started: true, state });
      return false;
    }

    return false;
  });

  window.addEventListener("pagehide", () => {
    const session = activeSession;
    if (!session) {
      return;
    }
    taskGeneration += 1;
    stopSessionActivity(session);
    if (!session.jobClosed) {
      session.jobClosed = true;
      sendJobMessage("RELEASE_TRANSLATION_JOB", session.jobId);
    }
    activeSession = null;
  }, { once: true });
