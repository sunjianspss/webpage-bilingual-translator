import assert from "node:assert/strict";
import { after, test } from "node:test";
import { readFile } from "node:fs/promises";

const safariBackgroundUrl = new URL(
  "../safari/网页双语翻译/网页双语翻译 Extension/Resources/src/background.js",
  import.meta.url
);
const safariHandlerUrl = new URL(
  "../safari/网页双语翻译/网页双语翻译 Extension/SafariWebExtensionHandler.swift",
  import.meta.url
);

const originalChrome = globalThis.chrome;
const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;

let runtimeListener;
let resolveNativeStarted;
let fetchCalls = 0;
const nativeMessages = [];
const pendingNativeRequests = new Map();

globalThis.chrome = {
  runtime: {
    onMessage: {
      addListener(listener) {
        runtimeListener = listener;
      }
    },
    sendNativeMessage(_host, message) {
      nativeMessages.push(message);

      if (message.type === "CANCEL_HTTP_REQUEST") {
        const pending = pendingNativeRequests.get(message.requestId);
        pendingNativeRequests.delete(message.requestId);
        if (pending) {
          const error = new Error("canceled by native handler");
          error.name = "AbortError";
          pending.reject(error);
        }
        return Promise.resolve({
          ok: true,
          canceled: Boolean(pending),
          requestId: message.requestId
        });
      }

      if (message.type !== "HTTP_REQUEST") {
        return Promise.reject(new Error("unexpected native message"));
      }

      resolveNativeStarted?.(message);
      resolveNativeStarted = undefined;
      return new Promise((resolve, reject) => {
        pendingNativeRequests.set(message.requestId, { resolve, reject });
      });
    }
  },
  commands: {
    onCommand: {
      addListener() {}
    }
  },
  storage: {
    local: {
      async get() {
        return {};
      }
    }
  },
  tabs: {
    async query() {
      return [];
    },
    onRemoved: { addListener() {} },
    onUpdated: { addListener() {} },
    onReplaced: { addListener() {} }
  },
  scripting: {
    async executeScript() {}
  }
};

globalThis.fetch = async () => {
  fetchCalls += 1;
  throw new Error("direct fetch must not run after cancellation");
};

await import(`${safariBackgroundUrl.href}?cancel-test=${Date.now()}`);

after(() => {
  globalThis.chrome = originalChrome;
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalSetTimeout;
});

function translatorSettings() {
  return {
    backend: "local",
    targetLanguage: "en",
    viewMode: "bilingual",
    localBaseUrl: "http://127.0.0.1:1234/v1",
    localModel: "test-model",
    localApiKey: "",
    highQualityReasoning: false,
    deepseekApiKey: "",
    deepseekModel: "deepseek-model",
    maxSegments: 220
  };
}

function dispatch(message, sender = {}) {
  let resolveResponse;
  const response = new Promise((resolve) => {
    resolveResponse = resolve;
  });
  const asynchronous = runtimeListener(message, sender, resolveResponse);
  assert.equal(asynchronous, true);
  return response;
}

function waitForNativeRequest() {
  return new Promise((resolve) => {
    resolveNativeStarted = resolve;
  });
}

async function startPendingBatch(tabId, segmentId) {
  const created = await dispatch({
    type: "CREATE_TRANSLATION_JOB",
    settings: translatorSettings(),
    tabId
  });
  const nativeStarted = waitForNativeRequest();
  const batchResponse = dispatch(
    {
      type: "TRANSLATE_BATCH",
      jobId: created.jobId,
      segments: [{ id: segmentId, text: "Hello" }]
    },
    { tab: { id: tabId } }
  );
  return {
    created,
    batchResponse,
    nativeRequest: await nativeStarted
  };
}

test("Safari keeps direct fetch fallback while wiring native cancellation", async () => {
  const content = await readFile(safariBackgroundUrl, "utf8");

  assert.match(content, /sendNativeMessage/);
  assert.match(content, /const response = await fetch\(request\.url/);
  assert.match(content, /body: request\.body,\s*signal/);
  assert.match(content, /type: "CANCEL_HTTP_REQUEST"/);
  assert.match(content, /requestId/);
  assert.match(content, /原生代理不可用/);
});

test("canceling a Safari job cancels the matching native task without fetch fallback", async () => {
  fetchCalls = 0;
  nativeMessages.length = 0;
  const { created, batchResponse, nativeRequest } =
    await startPendingBatch(41, "cancel-safari");

  assert.equal(nativeRequest.type, "HTTP_REQUEST");
  assert.equal(typeof nativeRequest.requestId, "string");
  assert.ok(nativeRequest.requestId.length > 0);

  const canceled = await dispatch({
    type: "CANCEL_TRANSLATION_JOB",
    jobId: created.jobId
  });
  assert.deepEqual(canceled, { ok: true, canceled: true });

  const nativeCancel = nativeMessages.find(
    (message) => message.type === "CANCEL_HTTP_REQUEST"
  );
  assert.deepEqual(nativeCancel, {
    type: "CANCEL_HTTP_REQUEST",
    requestId: nativeRequest.requestId
  });
  assert.equal(fetchCalls, 0);
  assert.deepEqual(await batchResponse, {
    ok: false,
    canceled: true,
    code: "TRANSLATION_CANCELED",
    error: "翻译任务已取消"
  });
});

test("timed-out Safari native requests are canceled and normalized without fallback", async () => {
  fetchCalls = 0;
  nativeMessages.length = 0;
  let configuredTimeout;
  globalThis.setTimeout = (callback, delay, ...args) => {
    configuredTimeout = delay;
    return originalSetTimeout(callback, 0, ...args);
  };

  try {
    const { created, batchResponse, nativeRequest } =
      await startPendingBatch(42, "timeout-safari");
    assert.deepEqual(await batchResponse, {
      ok: false,
      code: "TRANSLATION_TIMEOUT",
      error: "翻译服务请求超时"
    });
    assert.equal(configuredTimeout, 45_000);
    assert.equal(fetchCalls, 0);
    assert.ok(
      nativeMessages.some(
        (message) =>
          message.type === "CANCEL_HTTP_REQUEST" &&
          message.requestId === nativeRequest.requestId
      )
    );
    await dispatch({
      type: "RELEASE_TRANSLATION_JOB",
      jobId: created.jobId
    });
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("Safari native handler uses a locked task registry and removes completed tasks", async () => {
  const content = await readFile(safariHandlerUrl, "utf8");

  assert.match(content, /final class HTTPTaskRegistry/);
  assert.match(content, /private let lock = NSLock\(\)/);
  assert.match(content, /tasks\[requestId\] = task/);
  assert.match(content, /tasks\.removeValue\(forKey: requestId\)/);
  assert.match(content, /task\?\.cancel\(\)/);
  assert.match(content, /case "CANCEL_HTTP_REQUEST"/);
  assert.match(content, /Self\.taskRegistry\.remove\(requestId\)/);
});

test("Safari probes the local backend through the native host, not fetch", async () => {
  fetchCalls = 0;
  nativeMessages.length = 0;
  const nativeStarted = waitForNativeRequest();
  const checkResponse = dispatch({
    type: "CHECK_TRANSLATION_BACKEND",
    settings: translatorSettings()
  });
  const probeRequest = await nativeStarted;

  assert.equal(probeRequest.type, "HTTP_REQUEST");
  assert.equal(probeRequest.method, "GET");
  assert.equal(probeRequest.url, "http://127.0.0.1:1234/v1/models");

  pendingNativeRequests.get(probeRequest.requestId).resolve({
    ok: true,
    status: 200,
    payload: { data: [{ id: "some-other-model" }] }
  });

  const checked = await checkResponse;
  assert.equal(checked.ok, false);
  assert.equal(checked.code, "LOCAL_MODEL_NOT_FOUND");
  assert.match(checked.error, /some-other-model/);
  assert.equal(fetchCalls, 0);
});
