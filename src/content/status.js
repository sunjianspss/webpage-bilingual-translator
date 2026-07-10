  function showTranslationProgress(session) {
    state = { ...state, translated: session.usedPlacements };
    showStatus(
      `正在翻译 ${session.usedPlacements} / ${state.total}`,
      "working"
    );
  }

  function scheduleStatusHide(session) {
    clearScheduledStatusHide(session);
    session.statusHideTimer = window.setTimeout(() => {
      session.statusHideTimer = null;
      if (isCurrentSession(session) && state.status === "done") {
        hideStatus();
      }
    }, 2400);
  }

  function clearScheduledStatusHide(session) {
    if (session.statusHideTimer !== null) {
      window.clearTimeout(session.statusHideTimer);
      session.statusHideTimer = null;
    }
  }

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) {
      return;
    }
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.setAttribute(OWNED_MARKER, "true");
    style.textContent = `
      .${ORIGINAL_CLASS} { display: contents !important; }
      .${TRANSLATION_CLASS} {
        display: block !important;
        color: inherit !important;
        opacity: 0.8 !important;
        font-family: inherit !important;
        font-style: normal !important;
        font-weight: 400 !important;
        text-decoration: none !important;
        text-transform: none !important;
      }
      .ai-page-translator-translation-body {
        margin-top: 0.45em !important;
        margin-bottom: 0.45em !important;
        padding-left: 0.75em !important;
        border-left: 2px solid currentColor !important;
        font-size: 0.94em !important;
        line-height: 1.6 !important;
        white-space: pre-wrap !important;
        overflow-wrap: anywhere !important;
      }
      .ai-page-translator-translation-body::before {
        content: "译文" !important;
        display: block !important;
        margin-bottom: 0.15em !important;
        font-size: 0.72em !important;
        font-weight: 600 !important;
        line-height: 1.2 !important;
        letter-spacing: 0.08em !important;
        opacity: 0.62 !important;
      }
      .ai-page-translator-translation-compact {
        display: inline !important;
        margin-left: 0.45em !important;
        font-size: 0.9em !important;
        line-height: inherit !important;
      }
      .ai-page-translator-translation-heading {
        margin: 0.28em 0 0.85em !important;
        font-size: var(--ai-translator-heading-size, 16px) !important;
        line-height: 1.45 !important;
        letter-spacing: normal !important;
      }
      .ai-page-translator-translated .${ORIGINAL_CLASS} {
        display: none !important;
      }
      .ai-page-translator-translated [${MARKER}][data-translator-target="element"] {
        font-size: 0 !important;
        line-height: 0 !important;
      }
      .ai-page-translator-translated [${MARKER}][data-translator-target="element"] > :not(.${TRANSLATION_CLASS}) {
        display: none !important;
      }
      .ai-page-translator-translated [${MARKER}][data-translator-target="element"] > .${TRANSLATION_CLASS} {
        font-size: var(--ai-translator-element-original-size, 1rem) !important;
        line-height: 1.6 !important;
      }
      .ai-page-translator-translated [${MARKER}][data-translator-target="heading"] {
        display: none !important;
      }
      .ai-page-translator-translated .ai-page-translator-translation-heading {
        margin-top: 0 !important;
        opacity: 1 !important;
        font-size: var(--ai-translator-heading-original-size, 1em) !important;
        font-weight: 500 !important;
      }
      .ai-page-translator-translated .ai-page-translator-translation-body::before {
        display: none !important;
      }
      #${STATUS_ID} {
        position: fixed !important;
        right: 20px !important;
        bottom: 20px !important;
        z-index: 2147483647 !important;
        max-width: 320px !important;
        padding: 10px 14px !important;
        border: 1px solid #dadce0 !important;
        border-radius: 8px !important;
        background: #fff !important;
        box-shadow: 0 2px 8px rgba(60, 64, 67, 0.22) !important;
        color: #3c4043 !important;
        font: 13px/20px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
      }
      #${STATUS_ID}[data-kind="error"] {
        border-color: #f6aea9 !important;
        color: #b3261e !important;
      }
      #${STATUS_ID}[data-kind="success"] {
        border-color: #81c995 !important;
        color: #137333 !important;
      }
    `;
    document.documentElement.appendChild(style);
  }

  function showStatus(message, kind) {
    ensureStyles();
    let status = document.getElementById(STATUS_ID);
    if (!status) {
      status = document.createElement("div");
      status.id = STATUS_ID;
      status.setAttribute(OWNED_MARKER, "true");
      status.setAttribute("role", "status");
      document.documentElement.appendChild(status);
    }
    status.dataset.kind = kind;
    status.textContent = message;
    status.hidden = false;
  }

  function hideStatus() {
    document.getElementById(STATUS_ID)?.remove();
  }
