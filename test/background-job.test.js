import assert from "node:assert/strict";
import { after, test } from "node:test";

const originalChrome = globalThis.chrome;
const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;

let runtimeListener;
let tabRemovedListener;
let storageReads = 0;
let storedSettings = {};
let fetchMode = "success";
let fetchStarted;
let resolveFetchStarted;
const requests = [];
const sessionStorageState = {};

globalThis.chrome = {
  runtime: {
    onMessage: {
      addListener(listener) {
        runtimeListener = listener;
      }
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
        storageReads += 1;
        return { translatorSettings: storedSettings };
      }
    },
    session: {
      async get(keys) {
        if (keys === null || keys === undefined) {
          return structuredClone(sessionStorageState);
        }
        const requestedKeys = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(
          requestedKeys
            .filter((key) => key in sessionStorageState)
            .map((key) => [key, structuredClone(sessionStorageState[key])])
        );
      },
      async set(values) {
        for (const [key, value] of Object.entries(values)) {
          sessionStorageState[key] = structuredClone(value);
        }
      },
      async remove(keys) {
        for (const key of Array.isArray(keys) ? keys : [keys]) {
          delete sessionStorageState[key];
        }
      }
    }
  },
  tabs: {
    async query() {
      return [];
    },
    onRemoved: {
      addListener(listener) {
        tabRemovedListener = listener;
      }
    }
  },
  scripting: {
    async executeScript() {}
  }
};

globalThis.fetch = async (url, options) => {
  requests.push({ url, options });
  resolveFetchStarted?.(options.signal);

  if (fetchMode === "pending") {
    return new Promise((_resolve, reject) => {
      const rejectAsAborted = () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      };
      if (options.signal.aborted) {
        rejectAsAborted();
      } else {
        options.signal.addEventListener("abort", rejectAsAborted, {
          once: true
        });
      }
    });
  }

  return {
    ok: true,
    status: 200,
    async json() {
      return {
        choices: [
          {
            message: {
              content:
                '{"translations":[{"id":"1","text":"译文"}]}'
            }
          }
        ]
      };
    }
  };
};

await import(`../src/background.js?job-test=${Date.now()}`);

after(() => {
  globalThis.chrome = originalChrome;
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalSetTimeout;
});

function translatorSettings(overrides = {}) {
  return {
    backend: "local",
    targetLanguage: "en",
    viewMode: "bilingual",
    localBaseUrl: "http://127.0.0.1:1234/v1",
    localModel: "snapshot-model",
    localApiKey: "snapshot-secret",
    highQualityReasoning: false,
    deepseekApiKey: "deepseek-secret",
    deepseekModel: "deepseek-model",
    maxSegments: 220,
    ...overrides
  };
}

function dispatch(message, sender = {}) {
  let resolveResponse;
  const response = new Promise((resolve) => {
    resolveResponse = resolve;
  });
  const asynchronous = runtimeListener(
    message,
    sender,
    resolveResponse
  );
  assert.equal(
    asynchronous,
    true,
    `${message.type} should keep the message channel open`
  );
  return response;
}

function waitForNextFetch() {
  fetchStarted = new Promise((resolve) => {
    resolveFetchStarted = resolve;
  });
  return fetchStarted;
}

function hasPersistedJob(jobId) {
  return Object.keys(sessionStorageState).some((key) =>
    key.endsWith(jobId)
  );
}

test("translation jobs snapshot settings and keep secrets out of page settings", async () => {
  const suppliedSettings = translatorSettings();
  const created = await dispatch({
    type: "CREATE_TRANSLATION_JOB",
    settings: suppliedSettings,
    tabId: 17
  });

  assert.equal(created.ok, true);
  assert.equal(typeof created.jobId, "string");
  assert.ok(created.jobId.length > 0);
  assert.deepEqual(created.pageSettings, {
    backend: "local",
    targetLanguage: "en",
    viewMode: "bilingual",
    maxSegments: 220
  });
  assert.doesNotMatch(JSON.stringify(created), /snapshot-secret|deepseek-secret/);

  suppliedSettings.localModel = "mutated-model";
  suppliedSettings.localApiKey = "mutated-secret";
  suppliedSettings.targetLanguage = "ja";
  storedSettings = translatorSettings({
    localModel: "storage-model",
    localApiKey: "storage-secret",
    targetLanguage: "ko"
  });

  const translated = await dispatch(
    {
      type: "TRANSLATE_BATCH",
      jobId: created.jobId,
      segments: [{ id: "original-id", text: "Hello" }]
    },
    { tab: { id: 17 } }
  );

  assert.deepEqual(translated, {
    ok: true,
    translations: { "original-id": "译文" }
  });
  assert.equal(storageReads, 0, "batches must not reload settings");

  const request = requests.at(-1);
  const body = JSON.parse(request.options.body);
  assert.equal(body.model, "snapshot-model");
  assert.equal(request.options.headers.Authorization, "Bearer snapshot-secret");
  assert.match(body.messages[0].content, /English/);
  assert.equal(request.options.signal instanceof AbortSignal, true);

  const wrongTab = await dispatch(
    {
      type: "TRANSLATE_BATCH",
      jobId: created.jobId,
      segments: [{ id: "other", text: "Hello" }]
    },
    { tab: { id: 18 } }
  );
  assert.equal(wrongTab.ok, false);
  assert.equal(wrongTab.code, "TRANSLATION_JOB_TAB_MISMATCH");

  const released = await dispatch({
    type: "RELEASE_TRANSLATION_JOB",
    jobId: created.jobId
  });
  assert.equal(released.ok, true);
  assert.equal(hasPersistedJob(created.jobId), false);

  const afterRelease = await dispatch({
    type: "TRANSLATE_BATCH",
    jobId: created.jobId,
    segments: [{ id: "late", text: "Hello" }]
  });
  assert.deepEqual(afterRelease, {
    ok: false,
    canceled: true,
    code: "TRANSLATION_JOB_NOT_FOUND",
    error: "翻译任务不存在或已结束"
  });
});

test("canceling a job aborts its in-flight fetch and returns a structured error", async () => {
  const created = await dispatch({
    type: "CREATE_TRANSLATION_JOB",
    settings: translatorSettings(),
    tabId: 21
  });
  fetchMode = "pending";
  const started = waitForNextFetch();
  const batchResponse = dispatch(
    {
      type: "TRANSLATE_BATCH",
      jobId: created.jobId,
      segments: [{ id: "cancel-me", text: "Hello" }]
    },
    { tab: { id: 21 } }
  );
  const fetchSignal = await started;

  const canceled = await dispatch({
    type: "CANCEL_TRANSLATION_JOB",
    jobId: created.jobId
  });
  assert.deepEqual(canceled, { ok: true, canceled: true });
  assert.equal(hasPersistedJob(created.jobId), false);
  assert.equal(fetchSignal.aborted, true);
  assert.deepEqual(await batchResponse, {
    ok: false,
    canceled: true,
    code: "TRANSLATION_CANCELED",
    error: "翻译任务已取消"
  });
  fetchMode = "success";
});

test("releasing a job also aborts and deletes any in-flight work", async () => {
  const created = await dispatch({
    type: "CREATE_TRANSLATION_JOB",
    settings: translatorSettings(),
    tabId: 23
  });
  fetchMode = "pending";
  const started = waitForNextFetch();
  const batchResponse = dispatch(
    {
      type: "TRANSLATE_BATCH",
      jobId: created.jobId,
      segments: [{ id: "release-me", text: "Hello" }]
    },
    { tab: { id: 23 } }
  );
  const fetchSignal = await started;

  const released = await dispatch({
    type: "RELEASE_TRANSLATION_JOB",
    jobId: created.jobId
  });
  assert.deepEqual(released, { ok: true });
  assert.equal(hasPersistedJob(created.jobId), false);
  assert.equal(fetchSignal.aborted, true);
  assert.deepEqual(await batchResponse, {
    ok: false,
    canceled: true,
    code: "TRANSLATION_CANCELED",
    error: "翻译任务已取消"
  });
  fetchMode = "success";
});

test("closing a bound tab disposes its translation jobs", async () => {
  const created = await dispatch({
    type: "CREATE_TRANSLATION_JOB",
    settings: translatorSettings(),
    tabId: 24
  });

  tabRemovedListener(24);

  const afterClose = await dispatch(
    {
      type: "TRANSLATE_BATCH",
      jobId: created.jobId,
      segments: [{ id: "closed", text: "Hello" }]
    },
    { tab: { id: 24 } }
  );
  assert.deepEqual(afterClose, {
    ok: false,
    canceled: true,
    code: "TRANSLATION_JOB_NOT_FOUND",
    error: "翻译任务不存在或已结束"
  });
  assert.equal(hasPersistedJob(created.jobId), false);
});

test("translation requests fail with a finite timeout", async () => {
  const created = await dispatch({
    type: "CREATE_TRANSLATION_JOB",
    settings: translatorSettings(),
    tabId: 25
  });
  fetchMode = "pending";
  let configuredTimeout;
  globalThis.setTimeout = (callback, delay, ...args) => {
    configuredTimeout = delay;
    return originalSetTimeout(callback, 0, ...args);
  };

  try {
    const timedOut = await dispatch(
      {
        type: "TRANSLATE_BATCH",
        jobId: created.jobId,
        segments: [{ id: "timeout", text: "Hello" }]
      },
      { tab: { id: 25 } }
    );
    assert.deepEqual(timedOut, {
      ok: false,
      code: "TRANSLATION_TIMEOUT",
      error: "翻译服务请求超时"
    });
    assert.equal(configuredTimeout, 45_000);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    fetchMode = "success";
  }
});

test("translation jobs survive an MV3 service-worker restart", async () => {
  const created = await dispatch({
    type: "CREATE_TRANSLATION_JOB",
    settings: translatorSettings({
      localModel: "persisted-model",
      localApiKey: "persisted-secret"
    }),
    tabId: 31
  });

  assert.equal(created.ok, true);
  assert.equal(hasPersistedJob(created.jobId), true);

  await import(`../src/background.js?job-restart=${Date.now()}`);

  const translated = await dispatch(
    {
      type: "TRANSLATE_BATCH",
      jobId: created.jobId,
      segments: [{ id: "after-restart", text: "Hello" }]
    },
    { tab: { id: 31 } }
  );

  assert.deepEqual(translated, {
    ok: true,
    translations: { "after-restart": "译文" }
  });
  const request = requests.at(-1);
  const body = JSON.parse(request.options.body);
  assert.equal(body.model, "persisted-model");
  assert.equal(
    request.options.headers.Authorization,
    "Bearer persisted-secret"
  );

  const released = await dispatch({
    type: "RELEASE_TRANSLATION_JOB",
    jobId: created.jobId
  });
  assert.deepEqual(released, { ok: true });
  assert.equal(hasPersistedJob(created.jobId), false);
});
