import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { JSDOM } from "jsdom";

const contentScriptUrl = new URL("../src/content.js", import.meta.url);
const contentScript = await readFile(contentScriptUrl, "utf8");

const TRANSLATION_SELECTOR = ".ai-page-translator-translation";

function translationToken(segment) {
  return `【译文:${segment.id}】`;
}

function successfulTranslation(message) {
  return {
    ok: true,
    translations: Object.fromEntries(
      message.segments.map((segment) => [
        segment.id,
        translationToken(segment)
      ])
    )
  };
}

function createStorageLocalMock(store) {
  return {
    async get(keys) {
      if (keys === undefined || keys === null) {
        return { ...store };
      }
      const keyList = Array.isArray(keys) ? keys : [keys];
      const result = {};
      for (const key of keyList) {
        if (key in store) {
          result[key] = store[key];
        }
      }
      return result;
    },
    async set(items) {
      Object.assign(store, items);
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        delete store[key];
      }
    }
  };
}

function createHarness({
  html,
  url = "https://example.com/article",
  translate = successfulTranslation,
  storageStore = {},
  storageLocal,
  rectForElement,
  timerScale = 1
}) {
  const dom = new JSDOM(html, {
    url,
    pretendToBeVisual: true,
    runScripts: "outside-only"
  });
  const { window } = dom;
  const listeners = [];
  const runtimeMessages = [];
  let renewalCount = 0;
  if (timerScale !== 1) {
    const nativeSetTimeout = window.setTimeout.bind(window);
    window.setTimeout = (callback, delay, ...args) =>
      nativeSetTimeout(callback, delay * timerScale, ...args);
  }

  Object.defineProperty(
    window.HTMLElement.prototype,
    "getBoundingClientRect",
    {
      configurable: true,
      value() {
        if (rectForElement) {
          return rectForElement(this);
        }
        return {
          x: 0,
          y: 0,
          top: 0,
          left: 0,
          right: 640,
          bottom: 24,
          width: 640,
          height: 24,
          toJSON() {
            return this;
          }
        };
      }
    }
  );

  window.chrome = {
    runtime: {
      onMessage: {
        addListener(listener) {
          listeners.push(listener);
        }
      },
      async sendMessage(message) {
        runtimeMessages.push(message);
        if (message?.type === "TRANSLATE_BATCH") {
          return translate(message, successfulTranslation);
        }
        if (message?.type === "RENEW_TRANSLATION_JOB") {
          renewalCount += 1;
          return {
            ok: true,
            jobId: `renewed-job-${renewalCount}`,
            pageSettings: {}
          };
        }
        return { ok: true };
      }
    },
    storage: {
      local: storageLocal || createStorageLocalMock(storageStore)
    }
  };

  window.eval(`${contentScript}\n//# sourceURL=content-behavior.js`);
  assert.equal(listeners.length, 1, "content script should register one listener");

  function dispatch(message) {
    let response;
    listeners[0](message, {}, (value) => {
      response = value;
    });
    return response;
  }

  function dispatchAsync(message) {
    return new Promise((resolve) => {
      listeners[0](message, {}, resolve);
    });
  }

  function state() {
    return dispatch({ type: "GET_PAGE_STATE" }).state;
  }

  function start(settings = {}) {
    return dispatch({
      type: "TRANSLATE_PAGE",
      jobId: "job-content-behavior",
      settings: {
        backend: "deepseek",
        targetLanguage: "zh-CN",
        viewMode: "bilingual",
        maxSegments: 220,
        ...settings
      }
    });
  }

  function requestedSegments() {
    return runtimeMessages
      .filter((message) => message?.type === "TRANSLATE_BATCH")
      .flatMap((message) => message.segments);
  }

  return {
    close: () => dom.window.close(),
    dispatch,
    dispatchAsync,
    document: window.document,
    renewalCount: () => renewalCount,
    requestedSegments,
    runtimeMessages,
    start,
    state,
    window
  };
}

async function waitFor(predicate, description, timeout = 800) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function waitForTerminalState(harness, timeout = 800) {
  return waitFor(
    () => {
      const state = harness.state();
      return state.status === "done" || state.status === "error"
        ? state
        : null;
    },
    "translation to finish",
    timeout
  );
}

test("fans one unique translation out to every DOM occurrence", async (t) => {
  const repeated = "The same reusable notice appears in two separate cards.";
  const harness = createHarness({
    html: `
      <main>
        <section><p id="first">${repeated}</p></section>
        <section><p id="second">${repeated}</p></section>
      </main>
    `
  });
  t.after(harness.close);

  harness.start();
  const state = await waitForTerminalState(harness);

  assert.equal(state.status, "done", state.error);
  assert.match(harness.document.querySelector("#first").textContent, /【译文:/);
  assert.match(harness.document.querySelector("#second").textContent, /【译文:/);
  assert.deepEqual(
    harness.requestedSegments().map((segment) => segment.text),
    [repeated],
    "identical source text should cross the extension boundary only once"
  );
});

test("translates all sibling article roots", async (t) => {
  const harness = createHarness({
    html: `
      <article><p id="article-one">The first article has its own visible body.</p></article>
      <article><p id="article-two">The second article must not be omitted.</p></article>
    `
  });
  t.after(harness.close);

  harness.start();
  const state = await waitForTerminalState(harness);

  assert.equal(state.status, "done", state.error);
  assert.match(
    harness.document.querySelector("#article-one").textContent,
    /【译文:/
  );
  assert.match(
    harness.document.querySelector("#article-two").textContent,
    /【译文:/
  );
});

test("splits and translates an ordinary paragraph longer than 1200 characters", async (t) => {
  const longText = Array.from(
    { length: 28 },
    (_, index) =>
      `Sentence ${index + 1} explains how a long article should be divided at a safe semantic boundary without losing readable source content.`
  ).join(" ");
  assert.ok(longText.length > 1200);

  const harness = createHarness({
    html: `<main><p id="long-paragraph">${longText}</p></main>`
  });
  t.after(harness.close);

  harness.start();
  const state = await waitForTerminalState(harness);
  const segments = harness.requestedSegments();

  assert.equal(state.status, "done", state.error);
  assert.ok(segments.length >= 2, "long text should be sent as multiple segments");
  assert.ok(
    segments.every((segment) => segment.text.length <= 1200),
    "each long-paragraph segment should respect the text limit"
  );
  const renderedText = harness.document.querySelector("#long-paragraph").textContent;
  for (const segment of segments) {
    assert.ok(
      renderedText.includes(translationToken(segment)),
      `translation for ${segment.id} should be rendered at the paragraph`
    );
  }
});

test("splits and translates long direct text without a paragraph wrapper", async (t) => {
  const longText = Array.from(
    { length: 26 },
    (_, index) =>
      `Direct text sentence ${index + 1} remains readable even when a website omits semantic paragraph markup around a long article block.`
  ).join(" ");
  assert.ok(longText.length > 1200);

  const harness = createHarness({
    html: `<main><div id="long-direct">${longText}</div></main>`
  });
  t.after(harness.close);

  harness.start();
  const state = await waitForTerminalState(harness);
  const segments = harness.requestedSegments();

  assert.equal(state.status, "done", state.error);
  assert.ok(segments.length >= 2, "long direct text should be split into segments");
  assert.ok(segments.every((segment) => segment.text.length <= 1200));
  const renderedText = harness.document.querySelector("#long-direct").textContent;
  for (const segment of segments) {
    assert.ok(renderedText.includes(translationToken(segment)));
  }
});

test("translates every mixed flow and uncovered text in one article container", async (t) => {
  const plainFirst =
    "A plain article paragraph appears before any inline link in this section.";
  const linkedFirst =
    "The first mixed paragraph points to a reference and keeps its trailing explanation.";
  const plainSecond =
    "Another plain paragraph must not be hidden by a neighboring flow candidate.";
  const linkedSecond =
    "The second mixed paragraph uses a different link in the same parent container.";
  const harness = createHarness({
    html: `
      <main>
        <div id="wowhead-like-article">
          ${plainFirst}<br><br>
          The first mixed paragraph points to <a href="#first">a reference</a> and keeps its trailing explanation.<br><br>
          ${plainSecond}<br><br>
          The second mixed paragraph uses <a href="#second">a different link</a> in the same parent container.
        </div>
      </main>
    `
  });
  t.after(harness.close);

  harness.start();
  const state = await waitForTerminalState(harness);
  const requestedTexts = harness.requestedSegments().map(({ text }) => text);

  assert.equal(state.status, "done", state.error);
  assert.equal(state.translated, 4, "each logical paragraph counts as one placement");
  assert.equal(
    harness.document.querySelectorAll(TRANSLATION_SELECTOR).length,
    4
  );
  assert.deepEqual(new Set(requestedTexts), new Set([
    plainFirst,
    linkedFirst,
    plainSecond,
    linkedSecond
  ]));
});

test("keeps meaningful one- and two-character paragraph text", async (t) => {
  const harness = createHarness({
    html: `<main><p id="one-char">好</p><p id="two-char">Go</p></main>`
  });
  t.after(harness.close);

  harness.start({ targetLanguage: "en" });
  const state = await waitForTerminalState(harness);

  assert.equal(state.status, "done", state.error);
  assert.match(
    harness.document.querySelector("#one-char").textContent,
    /【译文:/
  );
  assert.match(
    harness.document.querySelector("#two-char").textContent,
    /【译文:/
  );
  assert.deepEqual(
    harness.requestedSegments().map((segment) => segment.text),
    ["好", "Go"]
  );
});

test("enforces maxSegments as one placement budget across dynamic rescans", async (t) => {
  const harness = createHarness({
    html: `
      <main id="budget-root">
        <p>First eligible paragraph for the placement budget.</p>
        <p>Second eligible paragraph for the placement budget.</p>
        <p>Third eligible paragraph must remain untranslated.</p>
      </main>
    `
  });
  t.after(harness.close);

  harness.start({ maxSegments: 2 });
  const state = await waitForTerminalState(harness);
  assert.equal(state.status, "done", state.error);
  assert.equal(
    harness.document.querySelectorAll(TRANSLATION_SELECTOR).length,
    2
  );

  const lateParagraph = harness.document.createElement("p");
  lateParagraph.textContent =
    "A later paragraph must not reset the job placement budget.";
  harness.document.querySelector("#budget-root").append(lateParagraph);
  await new Promise((resolve) => setTimeout(resolve, 220));

  assert.equal(
    harness.document.querySelectorAll(TRANSLATION_SELECTOR).length,
    2
  );
  assert.equal(harness.requestedSegments().length, 2);
});

test("clicking translate again keeps the first pageful and continues the tail", async (t) => {
  const paragraphs = Array.from(
    { length: 222 },
    (_value, index) =>
      `Paragraph ${index + 1} contains unique visible text for continuation coverage.`
  );
  const harness = createHarness({
    html: `<main>${paragraphs
      .map((text, index) => `<p id="continue-${index}">${text}</p>`)
      .join("")}</main>`
  });
  t.after(harness.close);

  harness.start({ maxSegments: 220 });
  const firstState = await waitForTerminalState(harness, 3000);
  assert.equal(firstState.status, "done", firstState.error);
  assert.equal(harness.requestedSegments().length, 220);
  const preservedTranslations = paragraphs.slice(0, 220).map((_text, index) =>
    harness.document
      .querySelector(`#continue-${index}`)
      .querySelector(TRANSLATION_SELECTOR)
  );
  assert.ok(preservedTranslations.every(Boolean));

  harness.start({ maxSegments: 220 });
  const secondState = await waitForTerminalState(harness, 3000);
  assert.equal(secondState.status, "done", secondState.error);
  assert.equal(
    harness.requestedSegments().length,
    222,
    "the second click should send only the untranslated tail"
  );
  assert.equal(
    harness.document.querySelectorAll(TRANSLATION_SELECTOR).length,
    222
  );
  for (const translation of preservedTranslations) {
    assert.equal(translation.isConnected, true, "existing translations stay mounted");
  }
});

test("changing the target language replaces incompatible existing translations", async (t) => {
  const source = "Changing the requested language must replace the old translation.";
  const harness = createHarness({ html: `<main><p>${source}</p></main>` });
  t.after(harness.close);

  harness.start({ targetLanguage: "zh-CN" });
  await waitForTerminalState(harness);
  harness.start({ targetLanguage: "ja" });
  await waitForTerminalState(harness);

  assert.deepEqual(
    harness.requestedSegments().map(({ text }) => text),
    [source, source]
  );
  const translations = [
    ...harness.document.querySelectorAll(TRANSLATION_SELECTOR)
  ];
  assert.equal(translations.length, 1);
  assert.equal(translations[0].lang, "ja");
});

test("observes and translates paragraphs added by a non-X SPA", async (t) => {
  const dynamicText = "This paragraph arrived after client-side navigation completed.";
  const harness = createHarness({
    url: "https://news.example.com/story",
    html: `
      <main id="app">
        <p id="initial">The initial server-rendered paragraph is visible.</p>
      </main>
    `
  });
  t.after(harness.close);

  harness.start();
  const state = await waitForTerminalState(harness);
  assert.equal(state.status, "done", state.error);

  const dynamicParagraph = harness.document.createElement("p");
  dynamicParagraph.id = "dynamic";
  dynamicParagraph.textContent = dynamicText;
  harness.document.querySelector("#app").append(dynamicParagraph);

  await waitFor(
    () => dynamicParagraph.textContent.includes("【译文:"),
    "the MutationObserver translation",
    1200
  );
  assert.ok(
    harness
      .requestedSegments()
      .some((segment) => segment.text === dynamicText),
    "the dynamically inserted source text should be sent for translation"
  );
});

test("keeps observing an initially empty SPA until translatable content appears", async (t) => {
  const lateText = "The SPA rendered its first readable paragraph after startup.";
  const harness = createHarness({
    url: "https://app.example.com/dashboard",
    html: `<main id="app"></main>`
  });
  t.after(harness.close);

  harness.start();
  await new Promise((resolve) => setTimeout(resolve, 40));

  const paragraph = harness.document.createElement("p");
  paragraph.textContent = lateText;
  harness.document.querySelector("#app").append(paragraph);

  await waitFor(
    () => paragraph.textContent.includes("【译文:"),
    "late SPA content after an empty initial scan",
    1200
  );
  assert.ok(
    harness
      .requestedSegments()
      .some((segment) => segment.text === lateText)
  );
});

test("retranslates an existing source node when a SPA changes its text", async (t) => {
  const initialText = "The client-rendered paragraph starts with this text.";
  const updatedText = "The client-rendered paragraph was replaced after navigation.";
  const harness = createHarness({
    html: `<main><p id="mutable">${initialText}</p></main>`,
    translate(message) {
      return {
        ok: true,
        translations: Object.fromEntries(
          message.segments.map((segment) => [
            segment.id,
            `【译文:${segment.text}】`
          ])
        )
      };
    }
  });
  t.after(harness.close);

  harness.start();
  const state = await waitForTerminalState(harness);
  assert.equal(state.status, "done", state.error);

  const paragraph = harness.document.querySelector("#mutable");
  paragraph.firstChild.nodeValue = updatedText;

  await waitFor(
    () => paragraph.textContent.includes(`【译文:${updatedText}】`),
    "the updated source text translation",
    1200
  );
  assert.equal(
    paragraph.querySelectorAll(TRANSLATION_SELECTOR).length,
    1,
    "an updated source should replace its stale translation"
  );
  assert.ok(
    harness
      .requestedSegments()
      .some((segment) => segment.text === updatedText)
  );
});

test("never applies an in-flight response after its source text changes", async (t) => {
  const initialText = "The paragraph starts with source text sent to a slow model.";
  const updatedText = "The paragraph changed while the slow model was responding.";
  let releaseFirstResponse;
  const harness = createHarness({
    html: `<main><p id="mutable">${initialText}</p></main>`,
    translate(message) {
      if (!releaseFirstResponse) {
        return new Promise((resolve) => {
          releaseFirstResponse = () => resolve({
            ok: true,
            translations: Object.fromEntries(
              message.segments.map((segment) => [
                segment.id,
                `【译文:${segment.text}】`
              ])
            )
          });
        });
      }
      return {
        ok: true,
        translations: Object.fromEntries(
          message.segments.map((segment) => [
            segment.id,
            `【译文:${segment.text}】`
          ])
        )
      };
    }
  });
  t.after(harness.close);

  harness.start();
  await waitFor(() => releaseFirstResponse, "the first request to start");
  const paragraph = harness.document.querySelector("#mutable");
  paragraph.firstChild.nodeValue = updatedText;
  releaseFirstResponse();

  await waitFor(
    () => paragraph.textContent.includes(`【译文:${updatedText}】`),
    "the updated text to replace the stale in-flight result",
    1400
  );
  assert.doesNotMatch(paragraph.textContent, new RegExp(`【译文:${initialText}】`));
  assert.deepEqual(
    harness.requestedSegments().map(({ text }) => text),
    [initialText, updatedText]
  );
});

test("RESTORE_PAGE cancels backend work and restores partially translated DOM", async (t) => {
  const originals = Array.from(
    { length: 8 },
    (_, index) => `Paragraph ${index + 1} contains distinct text for cancellation coverage.`
  );
  let batchCount = 0;
  let pendingMessage;
  let releasePending;
  const pendingResponse = new Promise((resolve) => {
    releasePending = resolve;
  });
  const harness = createHarness({
    html: `<main>${originals
      .map((text, index) => `<p id="cancel-${index}">${text}</p>`)
      .join("")}</main>`,
    translate(message, respond) {
      batchCount += 1;
      if (batchCount === 1) {
        return respond(message);
      }
      pendingMessage = message;
      return pendingResponse;
    }
  });
  t.after(harness.close);

  harness.start({ backend: "local" });
  await waitFor(
    () =>
      batchCount >= 2 &&
      harness.document.querySelectorAll(TRANSLATION_SELECTOR).length > 0,
    "a partial translation and an in-flight batch"
  );

  const response = harness.dispatch({ type: "RESTORE_PAGE" });
  const sentCancel = harness.runtimeMessages.some((message) =>
    /CANCEL/i.test(message?.type || "") &&
    message.jobId === "job-content-behavior"
  );

  releasePending(successfulTranslation(pendingMessage));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(response.ok, true);
  assert.equal(sentCancel, true, "restore should notify the background to cancel work");
  assert.equal(
    harness.document.querySelectorAll(TRANSLATION_SELECTOR).length,
    0,
    "restore should remove every rendered translation"
  );
  for (const [index, original] of originals.entries()) {
    assert.equal(
      harness.document.querySelector(`#cancel-${index}`).textContent,
      original
    );
  }
  assert.equal(harness.state().status, "idle");
});

test("RESTORE_PAGE cannot be undone by a late persistent-cache read", async (t) => {
  const html = `<main><p id="cached">A late cache read must not restore translation after cancellation.</p></main>`;
  const sharedStore = {};
  const first = createHarness({ html, storageStore: sharedStore });
  t.after(first.close);
  first.start();
  const firstState = await waitForTerminalState(first);
  assert.equal(firstState.status, "done", firstState.error);
  await waitFor(
    () =>
      Object.keys(sharedStore).some((key) =>
        key.startsWith("aiPageTranslatorCache:")
      ),
    "the cached translation to be persisted"
  );

  const baseStorage = createStorageLocalMock(sharedStore);
  let releaseCacheRead;
  const cacheReadGate = new Promise((resolve) => {
    releaseCacheRead = resolve;
  });
  let cacheReadStarted;
  const cacheReadStart = new Promise((resolve) => {
    cacheReadStarted = resolve;
  });
  const second = createHarness({
    html,
    storageLocal: {
      ...baseStorage,
      async get(keys) {
        if (keys === null || keys === undefined) {
          cacheReadStarted();
          await cacheReadGate;
        }
        return baseStorage.get(keys);
      }
    }
  });
  t.after(second.close);

  second.start();
  await cacheReadStart;
  second.dispatch({ type: "RESTORE_PAGE" });
  releaseCacheRead();
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(second.state().status, "idle");
  assert.equal(second.requestedSegments().length, 0);
  assert.equal(
    second.document.querySelectorAll(TRANSLATION_SELECTOR).length,
    0,
    "a cache result arriving after cancellation must not mutate the DOM"
  );
});

test("BFCache pagehide ends in-flight state and still cleans up later sessions", async (t) => {
  let releaseFirstResponse;
  let requestCount = 0;
  const harness = createHarness({
    html: `<main><p>A page may enter the back-forward cache during translation.</p></main>`,
    translate(message) {
      requestCount += 1;
      if (requestCount === 1) {
        return new Promise((resolve) => {
          releaseFirstResponse = () => resolve(successfulTranslation(message));
        });
      }
      return successfulTranslation(message);
    }
  });
  t.after(harness.close);

  harness.start();
  await waitFor(() => releaseFirstResponse, "the first request to start");
  harness.window.dispatchEvent(
    new harness.window.PageTransitionEvent("pagehide", { persisted: true })
  );
  assert.notEqual(harness.state().status, "translating");
  releaseFirstResponse();
  harness.window.dispatchEvent(
    new harness.window.PageTransitionEvent("pageshow", { persisted: true })
  );

  const restarted = harness.dispatch({
    type: "TRANSLATE_PAGE",
    jobId: "job-after-bfcache",
    settings: {
      backend: "deepseek",
      targetLanguage: "zh-CN",
      viewMode: "bilingual",
      maxSegments: 220
    }
  });
  assert.equal(restarted.ok, true, restarted.error);
  await waitForTerminalState(harness);

  harness.window.dispatchEvent(
    new harness.window.PageTransitionEvent("pagehide", { persisted: true })
  );
  assert.deepEqual(
    harness.runtimeMessages
      .filter((message) => message.type === "RELEASE_TRANSLATION_JOB")
      .map((message) => message.jobId),
    ["job-content-behavior", "job-after-bfcache"]
  );
});

test("translates existing content when a SPA reveals it by attribute", async (t) => {
  const text = "This paragraph becomes visible without being inserted again.";
  const harness = createHarness({
    html: `<main><p id="revealed" hidden>${text}</p></main>`
  });
  t.after(harness.close);

  harness.start();
  const initialState = await waitForTerminalState(harness);
  assert.equal(initialState.status, "done", initialState.error);
  assert.equal(harness.requestedSegments().length, 0);

  const paragraph = harness.document.querySelector("#revealed");
  paragraph.removeAttribute("hidden");

  await waitFor(
    () => paragraph.textContent.includes("【译文:"),
    "attribute-revealed content to be translated",
    1200
  );
  assert.ok(
    harness.requestedSegments().some((segment) => segment.text === text)
  );
});

test("never sends text hidden by an ancestor or a zero layout box", async (t) => {
  const visibleText = "This visible paragraph should still be translated normally.";
  const hiddenDirectText =
    "This hidden account recovery phrase must never leave the page.";
  const hiddenFlowText =
    "This hidden linked paragraph has a reference and must stay private.";
  const transparentText =
    "This transparent recovery phrase must never leave the page.";
  const nestedTransparentText = "NESTED-TRANSPARENT-RECOVERY-CODE";
  const displayContentsText = "HIDDEN-DISPLAY-CONTENTS-CODE";
  const clippedText = "VISUALLY-CLIPPED-RECOVERY-CODE";
  const visibleNestedText =
    "Visible recovery guidance remains public.";
  const harness = createHarness({
    html: `
      <main>
        <section hidden>
          <div>${hiddenDirectText}</div>
          <div>
            This hidden linked paragraph has
            <a href="#private">a reference</a>
            and must stay private.
          </div>
        </section>
        <div style="width:0;height:0;overflow:hidden">
          Another zero-geometry direct text must not be translated.
        </div>
        <section style="opacity:0">
          <p>${transparentText}</p>
        </section>
        <p id="visible-with-transparent-child">
          Visible recovery guidance
          <span style="opacity:0">${nestedTransparentText}</span>
          <span style="display:contents;visibility:hidden">${displayContentsText}</span>
          remains public.
        </p>
        <p style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);clip-path:inset(50%)">
          ${clippedText}
        </p>
        <p id="visible">${visibleText}</p>
      </main>
    `,
    rectForElement(element) {
      const hidden = element.closest("[hidden]");
      const zeroGeometry = element.closest("[style*='width:0']");
      const width = hidden || zeroGeometry ? 0 : 640;
      const height = hidden || zeroGeometry ? 0 : 24;
      return { width, height };
    }
  });
  t.after(harness.close);
  Object.defineProperty(
    harness.document.querySelector("#visible-with-transparent-child"),
    "innerText",
    {
      configurable: true,
      value:
        `Visible recovery guidance ${nestedTransparentText} ${displayContentsText} remains public.`
    }
  );

  harness.start();
  const state = await waitForTerminalState(harness);
  assert.equal(state.status, "done", state.error);
  assert.deepEqual(
    harness.requestedSegments().map(({ text }) => text),
    [visibleNestedText, visibleText]
  );
  assert.doesNotMatch(
    harness.requestedSegments().map(({ text }) => text).join("\n"),
    new RegExp(
      `${hiddenDirectText}|${hiddenFlowText}|${transparentText}|` +
        `${nestedTransparentText}|${displayContentsText}|${clippedText}`
    )
  );
});

test("never sends text fully clipped by a zero-size overflow ancestor", async (t) => {
  const clippedDirectText = "PRIVATE-DIRECT-TEXT-BEHIND-ZERO-HEIGHT-CLIP";
  const clippedStructuredText =
    "PRIVATE STRUCTURED TEXT BEHIND A ZERO HEIGHT OVERFLOW CLIP";
  const visibleText = "This visible paragraph remains eligible for translation.";
  const harness = createHarness({
    html: `
      <main>
        <section id="direct-clip" style="height:0;overflow:hidden">
          <p>${clippedDirectText}</p>
        </section>
        <section id="structured-clip" style="height:0;overflow:clip">
          <div data-testid="tweetText">${clippedStructuredText}</div>
        </section>
        <p>${visibleText}</p>
      </main>
    `,
    rectForElement(element) {
      if (element.matches("#direct-clip, #structured-clip")) {
        return {
          top: 0,
          left: 0,
          right: 640,
          bottom: 0,
          width: 640,
          height: 0
        };
      }
      return {
        top: 0,
        left: 0,
        right: 640,
        bottom: 24,
        width: 640,
        height: 24
      };
    }
  });
  t.after(harness.close);

  harness.start();
  const state = await waitForTerminalState(harness);
  assert.equal(state.status, "done", state.error);
  assert.deepEqual(
    harness.requestedSegments().map(({ text }) => text),
    [visibleText]
  );
});

test("keeps offscreen text inside a user-scrollable overflow container", async (t) => {
  const scrollableText =
    "This article paragraph is below the scrollport but remains user accessible.";
  const harness = createHarness({
    html: `
      <main>
        <section id="scrollport" style="height:100px;overflow:auto">
          <p id="below-scrollport">${scrollableText}</p>
        </section>
      </main>
    `,
    rectForElement(element) {
      if (element.id === "scrollport") {
        return {
          top: 0,
          left: 0,
          right: 640,
          bottom: 100,
          width: 640,
          height: 100
        };
      }
      if (element.id === "below-scrollport") {
        return {
          top: 200,
          left: 0,
          right: 640,
          bottom: 224,
          width: 640,
          height: 24
        };
      }
      return {
        top: 0,
        left: 0,
        right: 640,
        bottom: 240,
        width: 640,
        height: 240
      };
    }
  });
  t.after(harness.close);

  harness.start();
  const state = await waitForTerminalState(harness);
  assert.equal(state.status, "done", state.error);
  assert.deepEqual(
    harness.requestedSegments().map(({ text }) => text),
    [scrollableText]
  );
});

test("visible flow text excludes hidden inline descendants", async (t) => {
  const privateText = "PRIVATE-INLINE-RECOVERY-CODE";
  const transparentPrivateText = "TRANSPARENT-INLINE-RECOVERY-CODE";
  const contentsPrivateText = "DISPLAY-CONTENTS-INLINE-RECOVERY-CODE";
  const expected =
    "Visible introduction public reference and public conclusion.";
  const harness = createHarness({
    html: `
      <main>
        <div>
          <span id="lead">Visible introduction <span style="opacity:0">${transparentPrivateText}</span></span>
          <span style="display:contents;visibility:hidden">${contentsPrivateText}</span>
          <span hidden style="display:inline">${privateText}</span>
          <a href="#public">public reference</a>
          <span>and public conclusion.</span>
        </div>
      </main>
    `
  });
  t.after(harness.close);
  Object.defineProperty(harness.document.querySelector("#lead"), "innerText", {
    configurable: true,
    value: `Visible introduction ${transparentPrivateText}`
  });

  harness.start();
  const state = await waitForTerminalState(harness);
  assert.equal(state.status, "done", state.error);
  assert.deepEqual(
    harness.requestedSegments().map(({ text }) => text),
    [expected]
  );
  assert.doesNotMatch(
    harness.requestedSegments().map(({ text }) => text).join("\n"),
    new RegExp(
      `${privateText}|${transparentPrivateText}|${contentsPrivateText}`
    )
  );
});

test("zero-width br elements still split visible flow paragraphs", async (t) => {
  const first = "The first visible flow has a public reference and ends here.";
  const second = "The second visible flow has another reference and stays separate.";
  const harness = createHarness({
    html: `
      <main>
        <div>
          The first visible flow has <a href="#one">a public reference</a> and ends here.
          <br><br>
          The second visible flow has <a href="#two">another reference</a> and stays separate.
        </div>
      </main>
    `,
    rectForElement(element) {
      return element.matches("br")
        ? { width: 0, height: 16 }
        : { width: 640, height: 24 };
    }
  });
  t.after(harness.close);

  harness.start();
  await waitForTerminalState(harness);
  assert.deepEqual(
    harness.requestedSegments().map(({ text }) => text),
    [first, second]
  );
});

test("zero-width br elements preserve structured social-post line breaks", async (t) => {
  const firstLine = "The first structured line keeps its original boundary.";
  const secondLine = "The second structured line must remain separate.";
  const harness = createHarness({
    url: "https://x.com/example/status/structured-lines",
    html: `
      <main>
        <article>
          <div data-testid="tweetText">${firstLine}<br>${secondLine}</div>
        </article>
      </main>
    `,
    rectForElement(element) {
      return element.matches("br")
        ? { width: 0, height: 16 }
        : { width: 640, height: 24 };
    }
  });
  t.after(harness.close);

  harness.start();
  const state = await waitForTerminalState(harness);
  assert.equal(state.status, "done", state.error);
  assert.deepEqual(
    harness.requestedSegments().map(({ id, text, preserveLayout }) => [
      id,
      text,
      preserveLayout
    ]),
    [["segment-1", `${firstLine}\n${secondLine}`, true]]
  );
});

test("rechecks visibility after cache hydration before sending text", async (t) => {
  const text = "This paragraph becomes hidden while its cache entry is loading.";
  let releaseCacheRead;
  let didStartCacheRead = false;
  const pendingCacheRead = new Promise((resolve) => {
    releaseCacheRead = (result = {}) => resolve(result);
  });
  const harness = createHarness({
    html: `<main><p id="late-hidden">${text}</p></main>`,
    storageLocal: {
      async get(keys) {
        if (keys === null || keys === undefined) {
          didStartCacheRead = true;
          return pendingCacheRead;
        }
        return {};
      },
      async set() {},
      async remove() {}
    },
    rectForElement(element) {
      const hidden = element.closest("[hidden]");
      return { width: hidden ? 0 : 640, height: hidden ? 0 : 24 };
    }
  });
  t.after(harness.close);

  harness.start();
  await waitFor(() => didStartCacheRead, "the persistent cache read to start");
  harness.document.querySelector("#late-hidden").hidden = true;
  releaseCacheRead({});
  await new Promise((resolve) => setTimeout(resolve, 180));

  assert.equal(harness.requestedSegments().length, 0);
  assert.equal(
    harness.document.querySelectorAll(TRANSLATION_SELECTOR).length,
    0
  );
});

test("does not send a flow text node moved into a hidden container during cache hydration", async (t) => {
  const privateText = "SENSITIVE-RECOVERY-CODE-MOVED-WHILE-CACHE-LOADS";
  let releaseCacheRead;
  let didStartCacheRead = false;
  const pendingCacheRead = new Promise((resolve) => {
    releaseCacheRead = (result = {}) => resolve(result);
  });
  const harness = createHarness({
    html: `
      <main>
        <div id="flow">${privateText} <a href="#public">public reference</a> and a visible conclusion.</div>
        <div id="hidden-destination" hidden></div>
      </main>
    `,
    storageLocal: {
      async get(keys) {
        if (keys === null || keys === undefined) {
          didStartCacheRead = true;
          return pendingCacheRead;
        }
        return {};
      },
      async set() {},
      async remove() {}
    }
  });
  t.after(harness.close);

  harness.start();
  await waitFor(() => didStartCacheRead, "the flow cache read to start");
  const flow = harness.document.querySelector("#flow");
  const movedTextNode = [...flow.childNodes].find(
    (node) => node.nodeType === harness.window.Node.TEXT_NODE
  );
  harness.document.querySelector("#hidden-destination").append(movedTextNode);
  releaseCacheRead({});
  await new Promise((resolve) => setTimeout(resolve, 180));

  assert.ok(
    harness.requestedSegments().every(({ text }) => !text.includes(privateText)),
    "the moved hidden text must not be sent even if visible remainder is rescanned"
  );
  assert.equal(
    harness.document.querySelector("#hidden-destination").querySelectorAll(
      TRANSLATION_SELECTOR
    ).length,
    0
  );
});

test("translations persist across a page reload via chrome.storage.local", async (t) => {
  const html = `<main><p id="para">A persistent cache should avoid retranslating this exact paragraph text.</p></main>`;
  const sharedStore = {};

  const first = createHarness({ html, storageStore: sharedStore });
  t.after(first.close);
  first.start();
  const firstState = await waitForTerminalState(first);
  assert.equal(firstState.status, "done", firstState.error);
  assert.equal(first.requestedSegments().length, 1);
  assert.match(first.document.querySelector("#para").textContent, /【译文:/);

  await waitFor(
    () =>
      Object.keys(sharedStore).some((key) =>
        key.startsWith("aiPageTranslatorCache:")
      ),
    "translation to be written to the persistent cache"
  );

  const second = createHarness({ html, storageStore: sharedStore });
  t.after(second.close);
  second.start();
  const secondState = await waitForTerminalState(second);

  assert.equal(secondState.status, "done", secondState.error);
  assert.equal(
    second.requestedSegments().length,
    0,
    "a cached translation should not trigger a new API request"
  );
  assert.match(second.document.querySelector("#para").textContent, /【译文:/);
});

test("legacy string cache values remain readable after the cache format changes", async (t) => {
  const html = `<main><p>A legacy cached translation should still be reused after upgrading.</p></main>`;
  const sharedStore = {};
  const first = createHarness({ html, storageStore: sharedStore });
  t.after(first.close);
  first.start();
  await waitForTerminalState(first);
  const cacheKey = await waitFor(
    () => Object.keys(sharedStore).find((key) =>
      key.startsWith("aiPageTranslatorCache:")
    ),
    "a cache entry to be stored"
  );
  const stored = sharedStore[cacheKey];
  sharedStore[cacheKey] = typeof stored === "string" ? stored : stored.text;

  const second = createHarness({ html, storageStore: sharedStore });
  t.after(second.close);
  second.start();
  await waitForTerminalState(second);
  assert.equal(second.requestedSegments().length, 0);
});

test("concurrent page contexts store self-describing entries without a shared index race", async (t) => {
  const sharedStore = {};
  let waitingIndexReaders = 0;
  let releaseIndexReaders;
  const indexBarrier = new Promise((resolve) => {
    releaseIndexReaders = resolve;
  });
  const storageLocal = {
    async get(keys) {
      if (keys === "aiPageTranslatorCacheIndex") {
        const snapshot = sharedStore[keys];
        waitingIndexReaders += 1;
        if (waitingIndexReaders === 2) {
          releaseIndexReaders();
        }
        await indexBarrier;
        return snapshot ? { [keys]: [...snapshot] } : {};
      }
      if (keys === undefined || keys === null) {
        return { ...sharedStore };
      }
      const result = {};
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        if (key in sharedStore) {
          result[key] = sharedStore[key];
        }
      }
      return result;
    },
    async set(items) { Object.assign(sharedStore, items); },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        delete sharedStore[key];
      }
    }
  };
  const first = createHarness({
    html: `<main><p>The first tab writes a distinct cached translation.</p></main>`,
    url: "https://example.com/first",
    storageLocal
  });
  const second = createHarness({
    html: `<main><p>The second tab writes another cached translation.</p></main>`,
    url: "https://example.com/second",
    storageLocal
  });
  t.after(first.close);
  t.after(second.close);

  first.start();
  second.start();
  await Promise.all([
    waitForTerminalState(first),
    waitForTerminalState(second)
  ]);
  const entries = await waitFor(() => {
    const values = Object.entries(sharedStore).filter(([key]) =>
      key.startsWith("aiPageTranslatorCache:")
    );
    return values.length === 2 ? values : null;
  }, "both contexts to persist their translations");

  assert.equal("aiPageTranslatorCacheIndex" in sharedStore, false);
  assert.ok(entries.every(([, value]) =>
    value && typeof value === "object" && typeof value.text === "string"
  ));
});

test("a cross-tab late write cannot resurrect a page cache after clear", async (t) => {
  const sharedStore = {};
  const storage = createStorageLocalMock(sharedStore);
  let releaseLateWrite;
  let lateWriteStarted = false;
  let lateWriteCommitted = false;
  const lateWriteBarrier = new Promise((resolve) => {
    releaseLateWrite = resolve;
  });
  const delayedStorage = {
    get: storage.get,
    remove: storage.remove,
    async set(items) {
      const writesCacheValue = Object.keys(items).some((key) =>
        key.startsWith("aiPageTranslatorCache:")
      );
      if (writesCacheValue && !lateWriteStarted) {
        lateWriteStarted = true;
        await lateWriteBarrier;
        Object.assign(sharedStore, items);
        lateWriteCommitted = true;
        return;
      }
      Object.assign(sharedStore, items);
    }
  };
  const current = createHarness({
    html: `<main><p>The current tab has an existing page cache entry.</p></main>`,
    url: "https://example.com/shared-page",
    storageLocal: storage
  });
  const late = createHarness({
    html: `<main><p>Another tab finishes an old translation after cache clear.</p></main>`,
    url: "https://example.com/shared-page",
    storageLocal: delayedStorage
  });
  t.after(current.close);
  t.after(late.close);

  current.start();
  await waitForTerminalState(current);
  await waitFor(
    () => Object.keys(sharedStore).some((key) =>
      key.startsWith("aiPageTranslatorCache:")
    ),
    "the initial cache entry"
  );

  late.start();
  await waitForTerminalState(late);
  await waitFor(() => lateWriteStarted, "the other tab's delayed cache write");
  const cleared = await current.dispatchAsync({ type: "CLEAR_PAGE_CACHE" });
  assert.equal(cleared.ok, true, cleared.error);
  releaseLateWrite();
  await waitFor(() => lateWriteCommitted, "the delayed write to commit");
  await waitFor(
    () =>
      Object.keys(sharedStore).filter((key) =>
        key.startsWith("aiPageTranslatorCache:")
      ).length === 0,
    "the stale generation write to be discarded"
  );
});

test("clearing one page does not discard another page's in-flight cache write", async (t) => {
  const sharedStore = {};
  const storage = createStorageLocalMock(sharedStore);
  let releaseOtherPageWrite;
  let otherPageWriteStarted = false;
  const delayedStorage = {
    get: storage.get,
    remove: storage.remove,
    async set(items) {
      if (
        !otherPageWriteStarted &&
        Object.keys(items).some((key) =>
          key.startsWith("aiPageTranslatorCache:")
        )
      ) {
        otherPageWriteStarted = true;
        await new Promise((resolve) => {
          releaseOtherPageWrite = resolve;
        });
      }
      Object.assign(sharedStore, items);
    }
  };
  const otherPage = createHarness({
    html: `<main><p>A different page has a valid translation still in flight.</p></main>`,
    url: "https://example.com/other-in-flight",
    storageLocal: delayedStorage,
    translate(message) {
      return {
        ok: true,
        translations: Object.fromEntries(
          message.segments.map(({ id }) => [id, "OTHER-PAGE-VALUE"])
        )
      };
    }
  });
  const clearer = createHarness({
    html: `<main><p>Only this page's cache should be cleared.</p></main>`,
    url: "https://example.com/page-being-cleared",
    storageLocal: storage
  });
  t.after(otherPage.close);
  t.after(clearer.close);

  otherPage.start();
  await waitFor(() => otherPageWriteStarted, "the other page cache write");
  const cleared = await clearer.dispatchAsync({ type: "CLEAR_PAGE_CACHE" });
  assert.equal(cleared.ok, true, cleared.error);
  releaseOtherPageWrite();
  await waitFor(
    () => Object.values(sharedStore).some(
      (value) => value?.text === "OTHER-PAGE-VALUE"
    ),
    "the unrelated page cache write to remain valid"
  );
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.ok(
    Object.values(sharedStore).some(
      (value) => value?.text === "OTHER-PAGE-VALUE"
    )
  );
});

test("a stale write stays invalid after its page tombstone expires", async (t) => {
  const sharedStore = {};
  const storage = createStorageLocalMock(sharedStore);
  let releaseLateWrite;
  let lateWriteStarted = false;
  const delayedStorage = {
    get: storage.get,
    remove: storage.remove,
    async set(items) {
      if (
        !lateWriteStarted &&
        Object.keys(items).some((key) =>
          key.startsWith("aiPageTranslatorCache:")
        )
      ) {
        lateWriteStarted = true;
        await new Promise((resolve) => {
          releaseLateWrite = resolve;
        });
      }
      Object.assign(sharedStore, items);
    }
  };
  const late = createHarness({
    html: `<main><p>An old sleeping tab must not restore a cleared cache.</p></main>`,
    url: "https://example.com/sleeping-tab",
    storageLocal: delayedStorage,
    translate(message) {
      return {
        ok: true,
        translations: Object.fromEntries(
          message.segments.map(({ id }) => [id, "LATE-STALE-VALUE"])
        )
      };
    }
  });
  const clearer = createHarness({
    html: `<main><p>The active tab clears the shared page cache.</p></main>`,
    url: "https://example.com/sleeping-tab",
    storageLocal: storage
  });
  t.after(late.close);
  t.after(clearer.close);

  let lateNow = Date.now();
  late.window.Date.now = () => lateNow;
  late.start();
  await waitFor(() => lateWriteStarted, "the sleeping tab cache write");
  const cleared = await clearer.dispatchAsync({ type: "CLEAR_PAGE_CACHE" });
  assert.equal(cleared.ok, true, cleared.error);
  const pageGenerationKey = Object.keys(sharedStore).find((key) =>
    key.startsWith("aiPageTranslatorCacheGeneration:")
  );
  assert.ok(pageGenerationKey);
  sharedStore[pageGenerationKey].updatedAt = 0;

  const maintainer = createHarness({
    html: `<main><p>A different page triggers routine cache maintenance.</p></main>`,
    url: "https://example.com/maintenance",
    storageLocal: storage,
    translate(message) {
      return {
        ok: true,
        translations: Object.fromEntries(
          message.segments.map(({ id }) => [id, "MAINTENANCE-VALUE"])
        )
      };
    }
  });
  t.after(maintainer.close);
  maintainer.start();
  await waitForTerminalState(maintainer);
  await waitFor(
    () => !(pageGenerationKey in sharedStore),
    "the expired empty page tombstone to be pruned"
  );

  lateNow += 2 * 60 * 60 * 1000;
  releaseLateWrite();
  await waitFor(
    () => Object.values(sharedStore).some(
      (value) => value?.text === "MAINTENANCE-VALUE"
    ),
    "the maintenance cache write"
  );
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.ok(
    Object.values(sharedStore).every(
      (value) => value?.text !== "LATE-STALE-VALUE"
    ),
    "the pre-clear writer must remain stale after page metadata is reclaimed"
  );
});

test("a delayed generation read cannot extend a pre-clear writer's lifetime", async (t) => {
  const sharedStore = {};
  const storage = createStorageLocalMock(sharedStore);
  let releaseGenerationRead;
  let generationReadStarted = false;
  let releaseLateWrite;
  let lateWriteStarted = false;
  const lateStorage = {
    remove: storage.remove,
    async get(keys) {
      if (!generationReadStarted && (keys === null || keys === undefined)) {
        generationReadStarted = true;
        const snapshot = { ...sharedStore };
        await new Promise((resolve) => {
          releaseGenerationRead = resolve;
        });
        return snapshot;
      }
      return storage.get(keys);
    },
    async set(items) {
      if (
        !lateWriteStarted &&
        Object.keys(items).some((key) =>
          key.startsWith("aiPageTranslatorCache:")
        )
      ) {
        lateWriteStarted = true;
        await new Promise((resolve) => {
          releaseLateWrite = resolve;
        });
      }
      Object.assign(sharedStore, items);
    }
  };
  const late = createHarness({
    html: `<main><p>A delayed cache read must not reset an old writer's expiry clock.</p></main>`,
    url: "https://example.com/delayed-generation-read",
    storageLocal: lateStorage,
    translate(message) {
      return {
        ok: true,
        translations: Object.fromEntries(
          message.segments.map(({ id }) => [id, "DELAYED-READ-STALE"])
        )
      };
    }
  });
  const clearer = createHarness({
    html: `<main><p>This tab clears while the old generation read is suspended.</p></main>`,
    url: "https://example.com/delayed-generation-read",
    storageLocal: storage
  });
  t.after(late.close);
  t.after(clearer.close);

  let lateNow = Date.now();
  late.window.Date.now = () => lateNow;
  late.start();
  await waitFor(() => generationReadStarted, "the generation snapshot read");
  const cleared = await clearer.dispatchAsync({ type: "CLEAR_PAGE_CACHE" });
  assert.equal(cleared.ok, true, cleared.error);
  const pageGenerationKey = Object.keys(sharedStore).find((key) =>
    key.startsWith("aiPageTranslatorCacheGeneration:")
  );
  assert.ok(pageGenerationKey);
  sharedStore[pageGenerationKey].updatedAt = 0;

  lateNow += 2 * 60 * 60 * 1000;
  releaseGenerationRead();
  await waitFor(() => lateWriteStarted, "the delayed old cache write");

  const maintainer = createHarness({
    html: `<main><p>Routine maintenance removes the expired page marker.</p></main>`,
    url: "https://example.com/delayed-read-maintenance",
    storageLocal: storage
  });
  t.after(maintainer.close);
  maintainer.start();
  await waitForTerminalState(maintainer);
  await waitFor(
    () => !(pageGenerationKey in sharedStore),
    "the expired marker after the delayed read"
  );

  releaseLateWrite();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(
    Object.values(sharedStore).every(
      (value) => value?.text !== "DELAYED-READ-STALE"
    )
  );
});

test("an old prune snapshot cannot delete a concurrently refreshed page marker", async (t) => {
  const sharedStore = {};
  const storage = createStorageLocalMock(sharedStore);
  let releaseLateWrite;
  let lateWriteStarted = false;
  const lateStorage = {
    get: storage.get,
    remove: storage.remove,
    async set(items) {
      if (
        !lateWriteStarted &&
        Object.keys(items).some((key) =>
          key.startsWith("aiPageTranslatorCache:")
        )
      ) {
        lateWriteStarted = true;
        await new Promise((resolve) => {
          releaseLateWrite = resolve;
        });
      }
      Object.assign(sharedStore, items);
    }
  };
  const pageUrl = "https://example.com/concurrent-marker-refresh";
  const late = createHarness({
    html: `<main><p>An old writer waits across two cache clears.</p></main>`,
    url: pageUrl,
    storageLocal: lateStorage,
    translate(message) {
      return {
        ok: true,
        translations: Object.fromEntries(
          message.segments.map(({ id }) => [id, "PRUNE-RACE-STALE"])
        )
      };
    }
  });
  const clearer = createHarness({
    html: `<main><p>The current page refreshes its generation marker.</p></main>`,
    url: pageUrl,
    storageLocal: storage
  });
  t.after(late.close);
  t.after(clearer.close);

  late.start();
  await waitFor(() => lateWriteStarted, "the pre-clear cache write");
  const firstClear = await clearer.dispatchAsync({ type: "CLEAR_PAGE_CACHE" });
  assert.equal(firstClear.ok, true, firstClear.error);
  const oldMarkerKey = Object.keys(sharedStore).find((key) =>
    key.startsWith("aiPageTranslatorCacheGeneration:")
  );
  assert.ok(oldMarkerKey);
  sharedStore[oldMarkerKey].updatedAt = 0;

  let nullReads = 0;
  let pruneSnapshotStarted = false;
  let releasePruneSnapshot;
  const maintenanceStorage = {
    set: storage.set,
    remove: storage.remove,
    async get(keys) {
      if (keys === null || keys === undefined) {
        nullReads += 1;
        if (nullReads === 3) {
          pruneSnapshotStarted = true;
          const snapshot = { ...sharedStore };
          await new Promise((resolve) => {
            releasePruneSnapshot = resolve;
          });
          return snapshot;
        }
      }
      return storage.get(keys);
    }
  };
  const maintainer = createHarness({
    html: `<main><p>A separate page begins pruning an old metadata snapshot.</p></main>`,
    url: "https://example.com/prune-snapshot-maintainer",
    storageLocal: maintenanceStorage
  });
  t.after(maintainer.close);
  maintainer.start();
  await waitFor(() => pruneSnapshotStarted, "the stale prune snapshot");

  const secondClear = await clearer.dispatchAsync({ type: "CLEAR_PAGE_CACHE" });
  assert.equal(secondClear.ok, true, secondClear.error);
  releasePruneSnapshot();
  await new Promise((resolve) => setTimeout(resolve, 40));
  releaseLateWrite();
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.ok(
    Object.keys(sharedStore).some((key) =>
      key.startsWith("aiPageTranslatorCacheGeneration:")
    ),
    "the refreshed marker must survive deletion based on the old snapshot"
  );
  assert.ok(
    Object.values(sharedStore).every(
      (value) => value?.text !== "PRUNE-RACE-STALE"
    )
  );
});

test("cache eviction counts actual stored entries even when no index exists", async (t) => {
  const sharedStore = Object.fromEntries(
    Array.from({ length: 3000 }, (_value, index) => [
      `aiPageTranslatorCache:seed:${String(index).padStart(4, "0")}`,
      { text: `cached-${index}`, updatedAt: index + 1 }
    ])
  );
  const harness = createHarness({
    html: `<main><p>A new translation must evict the oldest real cache entry.</p></main>`,
    storageStore: sharedStore
  });
  t.after(harness.close);

  harness.start();
  await waitForTerminalState(harness);
  await waitFor(
    () => Object.values(sharedStore).some(
      (value) => value?.text === "【译文:segment-1】"
    ),
    "the newest cache entry to be stored"
  );
  const cacheKeys = Object.keys(sharedStore).filter((key) =>
    key.startsWith("aiPageTranslatorCache:")
  );
  assert.equal(cacheKeys.length, 3000);
  assert.equal("aiPageTranslatorCache:seed:0000" in sharedStore, false);
});

test("old empty cache-generation tombstones are pruned", async (t) => {
  const oldTimestamp = Date.now() - 2 * 60 * 60 * 1000;
  const sharedStore = Object.fromEntries(
    Array.from({ length: 25 }, (_value, index) => [
      `aiPageTranslatorCacheGeneration:old-${index}:generation-${index}`,
      { updatedAt: oldTimestamp }
    ])
  );
  const harness = createHarness({
    html: `<main><p>Clearing this page also performs generation-metadata maintenance.</p></main>`,
    storageStore: sharedStore
  });
  t.after(harness.close);

  const response = await harness.dispatchAsync({ type: "CLEAR_PAGE_CACHE" });
  assert.equal(response.ok, true, response.error);
  const generationEntries = Object.entries(sharedStore).filter(([key]) =>
    key.startsWith("aiPageTranslatorCacheGeneration:")
  );
  assert.equal(generationEntries.length, 1);
  assert.ok(generationEntries[0][1].updatedAt > oldTimestamp);
});

test("CLEAR_PAGE_CACHE removes real page entries even without the legacy index", async (t) => {
  const sharedStore = {};
  const harness = createHarness({
    html: `<main><p>Unindexed page cache data must still be clearable.</p></main>`,
    storageStore: sharedStore
  });
  t.after(harness.close);
  harness.start();
  await waitForTerminalState(harness);
  await waitFor(
    () => Object.keys(sharedStore).some((key) =>
      key.startsWith("aiPageTranslatorCache:")
    ),
    "the page cache entry to be stored"
  );
  delete sharedStore.aiPageTranslatorCacheIndex;

  const response = await harness.dispatchAsync({ type: "CLEAR_PAGE_CACHE" });
  assert.equal(response.ok, true, response.error);
  assert.deepEqual(
    Object.keys(sharedStore).filter((key) =>
      key.startsWith("aiPageTranslatorCache:")
    ),
    []
  );
});

test("CLEAR_PAGE_CACHE clears only the current page's cached translations", async (t) => {
  const sharedStore = {};
  const pageHtml = `<main><p id="para">Clearing the cache must force this paragraph to be retranslated.</p></main>`;
  const otherHtml = `<main><p id="other">The other page keeps its cached translation untouched.</p></main>`;
  const cacheKeyCount = () =>
    Object.keys(sharedStore).filter((key) =>
      key.startsWith("aiPageTranslatorCache:")
    ).length;

  const other = createHarness({
    html: otherHtml,
    url: "https://example.com/other",
    storageStore: sharedStore
  });
  t.after(other.close);
  other.start();
  const otherState = await waitForTerminalState(other);
  assert.equal(otherState.status, "done", otherState.error);

  const first = createHarness({ html: pageHtml, storageStore: sharedStore });
  t.after(first.close);
  first.start();
  const firstState = await waitForTerminalState(first);
  assert.equal(firstState.status, "done", firstState.error);
  await waitFor(
    () => cacheKeyCount() >= 2,
    "both pages' translations to be cached"
  );

  const cleared = await first.dispatchAsync({ type: "CLEAR_PAGE_CACHE" });
  assert.equal(cleared.ok, true, cleared.error);
  assert.equal(
    cacheKeyCount(),
    1,
    "only the current page's cache entries should be removed"
  );

  const second = createHarness({ html: pageHtml, storageStore: sharedStore });
  t.after(second.close);
  second.start();
  const secondState = await waitForTerminalState(second);
  assert.equal(secondState.status, "done", secondState.error);
  assert.equal(
    second.requestedSegments().length,
    1,
    "the cleared page should be retranslated through the backend"
  );

  const otherAgain = createHarness({
    html: otherHtml,
    url: "https://example.com/other",
    storageStore: sharedStore
  });
  t.after(otherAgain.close);
  otherAgain.start();
  const otherAgainState = await waitForTerminalState(otherAgain);
  assert.equal(otherAgainState.status, "done", otherAgainState.error);
  assert.equal(
    otherAgain.requestedSegments().length,
    0,
    "other pages keep their cache after a scoped clear"
  );
});

test("skips content only when the target script is reliably identifiable", async (t) => {
  const harness = createHarness({
    html: `<main><p id="already-ko">이 문장은 이미 한국어이므로 다시 번역할 필요가 없습니다.</p></main>`
  });
  t.after(harness.close);

  harness.start({ targetLanguage: "ko" });
  const state = await waitForTerminalState(harness);

  assert.equal(state.status, "done", state.error);
  assert.equal(
    harness.requestedSegments().length,
    0,
    "content already in the target language should not be sent for translation"
  );
  assert.equal(
    harness.document.querySelectorAll(TRANSLATION_SELECTOR).length,
    0
  );
});

test("does not mistake Chinese source text for Japanese or another Chinese variant", async (t) => {
  const sourceText = "这是一个需要转换语言的简体中文段落。";
  for (const targetLanguage of ["ja", "zh-TW"]) {
    const harness = createHarness({
      html: `<main><p>${sourceText}</p></main>`
    });
    t.after(harness.close);

    harness.start({ targetLanguage });
    const state = await waitForTerminalState(harness);
    assert.equal(state.status, "done", state.error);
    assert.deepEqual(
      harness.requestedSegments().map(({ text }) => text),
      [sourceText],
      `${targetLanguage} must not silently skip Chinese source text`
    );
  }
});

test("a failed batch reports every paragraph it lost, not just one", async (t) => {
  const paragraphs = [
    "Alpha squad ships reliable production software every single day.",
    "Beta squad reviews every incident with careful attention to detail.",
    "Gamma squad maintains the release pipeline without any manual steps.",
    "Delta squad keeps the documentation aligned with the shipped build."
  ];
  const harness = createHarness({
    html: `<main>${paragraphs
      .map((text, index) => `<p id="p-${index}">${text}</p>`)
      .join("")}</main>`,
    translate: () => ({
      ok: false,
      error: "模型返回缺少 translations 数组",
      code: "MODEL_OUTPUT"
    })
  });
  t.after(harness.close);

  harness.start();
  const state = await waitForTerminalState(harness, 3000);

  assert.equal(state.status, "error");
  const batches = harness.runtimeMessages.filter(
    (message) => message?.type === "TRANSLATE_BATCH"
  );
  assert.ok(
    batches.every((message) => message.segments.length > 1),
    "the paragraphs should share a batch, otherwise this test proves nothing"
  );
  assert.match(
    state.error,
    new RegExp(`^${paragraphs.length} 处内容翻译失败`),
    "the count must be the number of untranslated paragraphs, not failed batches"
  );
  assert.match(
    state.error,
    /模型返回缺少 translations 数组/,
    "the count alone cannot tell a dead backend from a bad model response"
  );
});

test("X rescans report only placements that still fail after the final pass", async (t) => {
  const text = "One social post should count as one failure after every retry.";
  const alwaysFails = createHarness({
    url: "https://x.com/example/status/1",
    html: `<main><article><div data-testid="tweetText">${text}</div></article></main>`,
    timerScale: 0.01,
    translate: () => ({
      ok: false,
      error: "bad model output",
      code: "MODEL_OUTPUT"
    })
  });
  t.after(alwaysFails.close);

  alwaysFails.start();
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(alwaysFails.state().status, "error");
  assert.match(alwaysFails.state().error, /^1 处内容翻译失败/);

  let attempts = 0;
  const recovers = createHarness({
    url: "https://x.com/example/status/2",
    html: `<main><article><div data-testid="tweetText">${text}</div></article></main>`,
    timerScale: 0.01,
    translate(message) {
      attempts += 1;
      return attempts <= 2
        ? { ok: false, error: "temporary failure" }
        : successfulTranslation(message);
    }
  });
  t.after(recovers.close);

  recovers.start();
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(recovers.state().status, "done", recovers.state().error);
  assert.equal(recovers.state().error, "");
  assert.match(
    recovers.document.querySelector("[data-testid='tweetText']").textContent,
    /【译文:/
  );
});

test("caching a page batches persistent value writes", async (t) => {
  const paragraphs = Array.from(
    { length: 10 },
    (_value, index) =>
      `Paragraph number ${index} explains a distinct part of the release process in detail.`
  );
  const store = {};
  let cacheWriteCalls = 0;
  const storageLocal = {
    async get(keys) {
      if (keys === undefined || keys === null) {
        return { ...store };
      }
      const result = {};
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        if (key in store) {
          result[key] = store[key];
        }
      }
      return result;
    },
    async set(items) {
      if (Object.keys(items).some((key) =>
        key.startsWith("aiPageTranslatorCache:")
      )) {
        cacheWriteCalls += 1;
      }
      Object.assign(store, items);
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        delete store[key];
      }
    }
  };
  const harness = createHarness({
    html: `<main>${paragraphs
      .map((text, index) => `<p id="p-${index}">${text}</p>`)
      .join("")}</main>`,
    storageLocal
  });
  t.after(harness.close);

  harness.start();
  const state = await waitForTerminalState(harness, 3000);
  assert.equal(state.status, "done", state.error);

  const cachedEntries = await waitFor(
    () => {
      const keys = Object.keys(store).filter((key) =>
        key.startsWith("aiPageTranslatorCache:")
      );
      return keys.length === paragraphs.length ? keys : null;
    },
    "every paragraph to reach the persistent cache",
    3000
  );

  assert.equal(cachedEntries.length, paragraphs.length);
  assert.ok(
    cacheWriteCalls <= cachedEntries.length / 2,
    `expected writes to be batched below ${cachedEntries.length}, ` +
      `got ${cacheWriteCalls}`
  );
});

test("one batch failing with a malformed model response does not abort the rest of the page", async (t) => {
  const paragraphA =
    "Alpha squad ships reliable production software every single day. ".repeat(
      10
    );
  const paragraphB =
    "Beta squad reviews every incident with careful attention to detail. ".repeat(
      10
    );
  const harness = createHarness({
    html: `
      <main>
        <section><p id="ok">${paragraphA}</p></section>
        <section><p id="broken">${paragraphB}</p></section>
      </main>
    `,
    translate: (message) => {
      const isBrokenBatch = message.segments.some((segment) =>
        segment.text.includes("Beta squad")
      );
      if (isBrokenBatch) {
        return {
          ok: false,
          error: "模型返回缺少 translations 数组",
          code: "MODEL_OUTPUT"
        };
      }
      return successfulTranslation(message);
    }
  });
  t.after(harness.close);

  harness.start();
  const state = await waitForTerminalState(harness, 3000);

  assert.equal(state.status, "error");
  assert.match(state.error, /1 处内容翻译失败/);
  assert.match(
    harness.document.querySelector("#ok").textContent,
    /【译文:/,
    "the successful batch should still be applied even though another batch failed"
  );
  assert.doesNotMatch(
    harness.document.querySelector("#broken").textContent,
    /【译文:/
  );
});

test("translates rich-text paragraphs rendered as div > span without any <p>", async (t) => {
  const first =
    "Unlike a prompt, context is used generally across many requests.";
  const second =
    "This can be surprisingly difficult as the model capabilities evolve.";
  const harness = createHarness({
    html: `
      <main>
        <div data-testid="article-body">
          <div><span><span data-text="true">${first}</span></span></div>
          <div><span><span data-text="true">${second}</span></span></div>
        </div>
      </main>
    `
  });
  t.after(harness.close);

  harness.start();
  const state = await waitForTerminalState(harness);

  assert.equal(state.status, "done", state.error);
  assert.deepEqual(
    new Set(harness.requestedSegments().map(({ text }) => text)),
    new Set([first, second])
  );
  assert.equal(
    harness.document.querySelectorAll(TRANSLATION_SELECTOR).length,
    2
  );
});

test("never re-collects a heading translation on a later rescan", async (t) => {
  const harness = createHarness({
    html: `
      <main id="rescan-root">
        <h2>Unhobbling Claude</h2>
        <p>Overall, we found that we were over-constraining the agent.</p>
      </main>
    `
  });
  t.after(harness.close);

  harness.start();
  const state = await waitForTerminalState(harness);
  assert.equal(state.status, "done", state.error);
  const afterFirstPass = harness.requestedSegments().length;

  // 触发一次增量扫描：标题的译文块是标题的兄弟节点，不在 [MARKER] 子树里，
  // 必须靠 OWNED_MARKER 才能挡住，否则会被当成新正文再翻一遍。
  const late = harness.document.createElement("p");
  late.textContent = "A later paragraph triggers one more incremental scan.";
  harness.document.querySelector("#rescan-root").append(late);
  await new Promise((resolve) => setTimeout(resolve, 260));

  const translatedTexts = harness
    .requestedSegments()
    .map(({ text }) => text);
  assert.deepEqual(
    translatedTexts.filter((text) => text.includes("【译文:")),
    [],
    "the extension must never send its own translation back for translation"
  );
  assert.equal(
    translatedTexts.filter((text) => text === "Unhobbling Claude").length,
    1,
    "the heading must be sent for translation exactly once"
  );
  assert.ok(
    translatedTexts.length > afterFirstPass,
    "the incremental scan should still pick up genuinely new content"
  );
  assert.equal(
    harness.document.querySelectorAll(
      ".ai-page-translator-translation-heading"
    ).length,
    1
  );
});

test("a linked paragraph in a bare div is translated exactly once", async (t) => {
  const paragraph =
    "Some article text with a reference inside it and a trailing explanation.";
  const harness = createHarness({
    html: `
      <main>
        <div>Some article text with <a href="#ref">a reference</a> inside it and a trailing explanation.</div>
      </main>
    `
  });
  t.after(harness.close);

  harness.start();
  const state = await waitForTerminalState(harness);

  assert.equal(state.status, "done", state.error);
  assert.equal(
    harness.document.querySelectorAll(TRANSLATION_SELECTOR).length,
    1,
    "the flow placement and the inline-text-block placement must not both apply"
  );
  assert.deepEqual(
    harness.requestedSegments().map(({ text }) => text),
    [paragraph]
  );
});

test("retranslates a flow placement when its moved source nodes change", async (t) => {
  const initialText =
    "The linked source has a reference inside it and an initial explanation.";
  const updatedText =
    "The updated linked source has a reference inside it and a new explanation.";
  const harness = createHarness({
    html: `
      <main>
        <div id="flow">
          The linked source has
          <a href="#ref">a reference</a>
          inside it and an initial explanation.
        </div>
      </main>
    `,
    translate(message) {
      return {
        ok: true,
        translations: Object.fromEntries(
          message.segments.map((segment) => [
            segment.id,
            `【译文:${segment.text}】`
          ])
        )
      };
    }
  });
  t.after(harness.close);

  harness.start();
  const firstState = await waitForTerminalState(harness);
  assert.equal(firstState.status, "done", firstState.error);

  const flow = harness.document.querySelector("#flow");
  const original = flow.querySelector(`.${"ai-page-translator-original"}`);
  original.firstChild.nodeValue = "The updated linked source has ";
  original.lastChild.nodeValue = " inside it and a new explanation.";

  await waitFor(
    () => flow.textContent.includes(`【译文:${updatedText}】`),
    "the changed flow source to be retranslated",
    1400
  );
  assert.doesNotMatch(flow.textContent, new RegExp(`【译文:${initialText}】`));
  assert.deepEqual(
    harness.requestedSegments().map(({ text }) => text),
    [initialText, updatedText]
  );
  assert.equal(flow.querySelectorAll(TRANSLATION_SELECTOR).length, 1);
});

test("an X-style paragraph with an inline-div link is translated once, without duplicated link text", async (t) => {
  const lead = "But when you send a message to Claude, the prompt is only a small part of the context it gets. We call this ";
  const linkText = "context engineering";
  const tail = ", and it makes a big impact on the results you generate.";
  const harness = createHarness({
    url: "https://x.com/trq212/article/2080710971228918066",
    html: `
      <main>
        <div>
          <div id="para">
            <span><span data-text="true">${lead}</span></span>
            <div style="display:inline"><a href="https://example.com/ctx"><span><span data-text="true">${linkText}</span></span></a></div>
            <span><span data-text="true">${tail}</span></span>
          </div>
        </div>
      </main>
    `
  });
  t.after(harness.close);

  harness.start();
  const state = await waitForTerminalState(harness);
  const requested = harness.requestedSegments().map(({ text }) => text);

  assert.equal(state.status, "done", state.error);
  assert.equal(
    requested.length,
    1,
    `expected one placement, got ${requested.length}`
  );
  assert.equal(
    (requested[0].match(/context engineering/g) || []).length,
    1,
    "the link text must appear exactly once in the source sent for translation"
  );
});

// anthropic.com 的正文编号列表：<li> 里既有行内链接又有脚注 <sup>，
// 它同时被 flow 候选和元素候选选中，两边各插一块译文，页面上就出现了
// 两个「译文」块。
test("a list item with an inline link gets exactly one translation block", async (t) => {
  const harness = createHarness({
    html: `
      <main>
        <article>
          <ol>
            <li>My secondary concern is the risk that powerful AI models may be misused to carry out cyberattacks or biological attacks, and may have <a href="#alignment">serious alignment problems</a>. Open-weights models do potentially present a higher risk than closed models, because it is very difficult to apply guardrails to them, and once weights are released they cannot be withdrawn<sup>2</sup>. But banning the use of these models by US businesses does nothing to address this risk.</li>
          </ol>
        </article>
      </main>
    `
  });
  t.after(harness.close);

  harness.start();
  const state = await waitForTerminalState(harness);
  const requested = harness.requestedSegments().map(({ text }) => text);

  assert.equal(state.status, "done", state.error);
  assert.equal(
    harness.document.querySelectorAll(TRANSLATION_SELECTOR).length,
    1,
    "the flow placement and the element placement must not both apply"
  );
  assert.equal(
    requested.length,
    1,
    `expected one placement, got ${requested.length}: ${JSON.stringify(requested)}`
  );
});

// 重新扫描时，<li> 里已经有 flow 译文块了（MARKER 在后代上，不在 li 上），
// 元素候选的 closest 只往上找，会把整个 li 当成新正文再翻一遍。
test("a rescan does not re-translate a list item that already holds a translation", async (t) => {
  const harness = createHarness({
    html: `
      <main>
        <article id="root">
          <ol>
            <li>My secondary concern is the risk that powerful AI models may be misused to carry out cyberattacks, and may have <a href="#alignment">serious alignment problems</a>. Open-weights models do potentially present a higher risk than closed models, because guardrails are hard to apply.</li>
          </ol>
        </article>
      </main>
    `
  });
  t.after(harness.close);

  harness.start();
  await waitForTerminalState(harness);
  const afterFirstPass =
    harness.document.querySelectorAll(TRANSLATION_SELECTOR).length;

  const dynamicParagraph = harness.document.createElement("p");
  dynamicParagraph.textContent =
    "To address these concerns, I do support the following three measures.";
  harness.document.getElementById("root").append(dynamicParagraph);
  await waitFor(
    () => dynamicParagraph.textContent.includes("【译文:"),
    "the MutationObserver translation",
    1200
  );

  assert.equal(afterFirstPass, 1);
  assert.equal(
    harness.document.querySelectorAll(TRANSLATION_SELECTOR).length,
    2,
    "the rescan must add one block for the new paragraph and none for the list item"
  );
});

// maxSegments 用尽时，谁被丢下不能取决于候选数组的拼装顺序。flow 候选
// （带内联链接的段落/列表项）是第一批入队的，真实站点里动辄成百上千；
// 直接 slice 会让页面顶部的大标题输给页面底部的列表项。
test("a binding placement budget keeps the top of the document, not whatever was collected first", async (t) => {
  const linkedItems = Array.from(
    { length: 40 },
    (_, index) =>
      `<li>Linked list entry ${index} citing <a href="/r${index}">an inline source link</a> plus trailing prose long enough to count as body copy.</li>`
  ).join("");
  const harness = createHarness({
    html: `
      <main>
        <h1>Lead headline: the most important line on this page</h1>
        <p>Lead paragraph sitting at the very top of the document.</p>
        <ul>${linkedItems}</ul>
      </main>
    `
  });
  t.after(harness.close);

  harness.start({ maxSegments: 5 });
  const state = await waitForTerminalState(harness);
  assert.equal(state.status, "done", state.error);

  const requested = harness.requestedSegments().map(({ text }) => text);
  assert.ok(
    requested.some((text) => text.includes("Lead headline")),
    "the headline at the top of the document must fit inside the budget"
  );
  assert.ok(
    requested.some((text) => text.includes("Lead paragraph")),
    "the lead paragraph at the top of the document must fit inside the budget"
  );

  const heading = harness.document.querySelector("h1");
  assert.equal(
    heading.nextElementSibling?.dataset.translatorForHeading,
    "true",
    "the headline must actually receive its translation block"
  );
});

test("a lost background job is renewed instead of stranding the rest of the page", async (t) => {
  const paragraphs = Array.from(
    { length: 60 },
    (_value, index) =>
      `<p>Paragraph number ${index + 1} carries enough prose to be collected.</p>`
  ).join("");
  const lostJobId = "job-content-behavior";
  const seenJobIds = new Set();
  const harness = createHarness({
    html: `<body><article>${paragraphs}</article></body>`,
    translate(message) {
      seenJobIds.add(message.jobId);
      // service worker 被回收后,原任务记录就没了;页面这边整轮才刚开始。
      if (message.jobId === lostJobId) {
        return {
          ok: false,
          canceled: true,
          code: "TRANSLATION_JOB_NOT_FOUND",
          error: "翻译任务不存在或已结束"
        };
      }
      return successfulTranslation(message);
    }
  });
  t.after(harness.close);

  harness.start();
  const state = await waitForTerminalState(harness, 4000);

  assert.equal(state.status, "done", state.error);
  assert.equal(
    harness.document.querySelectorAll(TRANSLATION_SELECTOR).length,
    60,
    "every paragraph must still get a translation"
  );
  assert.equal(
    harness.renewalCount(),
    1,
    "concurrent workers must share one renewal round trip"
  );
  assert.equal(seenJobIds.has("renewed-job-1"), true);
});

test("an abandoned job stays fatal so cancelling still stops the page", async (t) => {
  const paragraphs = Array.from(
    { length: 60 },
    (_value, index) =>
      `<p>Paragraph number ${index + 1} carries enough prose to be collected.</p>`
  ).join("");
  const harness = createHarness({
    html: `<body><article>${paragraphs}</article></body>`,
    translate() {
      return {
        ok: false,
        canceled: true,
        code: "TRANSLATION_CANCELED",
        error: "翻译任务已取消"
      };
    }
  });
  t.after(harness.close);

  harness.start();
  const state = await waitForTerminalState(harness, 4000);

  assert.equal(state.status, "error");
  assert.equal(state.error, "翻译任务已取消");
  assert.equal(
    harness.renewalCount(),
    0,
    "a deliberate cancel must not be resurrected"
  );
});
