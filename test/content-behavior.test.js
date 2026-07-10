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
  storageStore = {}
}) {
  const dom = new JSDOM(html, {
    url,
    pretendToBeVisual: true,
    runScripts: "outside-only"
  });
  const { window } = dom;
  const listeners = [];
  const runtimeMessages = [];

  Object.defineProperty(
    window.HTMLElement.prototype,
    "getBoundingClientRect",
    {
      configurable: true,
      value() {
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
        return { ok: true };
      }
    },
    storage: {
      local: createStorageLocalMock(storageStore)
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

async function waitForTerminalState(harness) {
  return waitFor(
    () => {
      const state = harness.state();
      return state.status === "done" || state.status === "error"
        ? state
        : null;
    },
    "translation to finish"
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

test("skips content that already matches the target language without calling the backend", async (t) => {
  const harness = createHarness({
    html: `<main><p id="already-zh">这段内容已经是简体中文，不需要重新翻译。</p></main>`
  });
  t.after(harness.close);

  harness.start({ targetLanguage: "zh-CN" });
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
