import assert from "node:assert/strict";
import { after, test } from "node:test";

// MV3 的 service worker 空闲 30s 就被回收，而翻译请求最长允许 45s。SW 在
// fetch 返回前被杀，content 侧只会收到 "message channel closed"，整批丢失。
// 这里验证请求存续期间确实在定期触碰扩展 API，且请求结束后计时器被清掉
// （否则 SW 会被永久保活，白白占资源）。

const originalChrome = globalThis.chrome;
const originalFetch = globalThis.fetch;
const originalSetInterval = globalThis.setInterval;
const originalClearInterval = globalThis.clearInterval;

let runtimeListener;
let platformInfoCalls = 0;
const intervals = new Map();
const clearedIntervals = [];
let nextIntervalId = 1;
let releaseFetch;

globalThis.chrome = {
  runtime: {
    onMessage: {
      addListener(listener) {
        runtimeListener = listener;
      }
    },
    async getPlatformInfo() {
      platformInfoCalls += 1;
      return { os: "mac" };
    }
  },
  commands: { onCommand: { addListener() {} } },
  storage: {
    local: { async get() { return {}; } },
    session: {
      async get() { return {}; },
      async set() {},
      async remove() {}
    }
  },
  tabs: {
    async query() { return []; },
    onRemoved: { addListener() {} },
    onUpdated: { addListener() {} },
    onReplaced: { addListener() {} }
  },
  scripting: { async executeScript() {} }
};

globalThis.setInterval = (fn, ms) => {
  const id = nextIntervalId++;
  intervals.set(id, { fn, ms });
  return id;
};
globalThis.clearInterval = (id) => {
  clearedIntervals.push(id);
  intervals.delete(id);
};

globalThis.fetch = async () =>
  new Promise((resolve) => {
    releaseFetch = () =>
      resolve({
        ok: true,
        status: 200,
        async json() {
          return {
            choices: [
              { message: { content: '{"translations":[{"id":"1","text":"译文"}]}' } }
            ]
          };
        }
      });
  });

await import(`../src/background.js?keepalive-test=${Date.now()}`);

after(() => {
  globalThis.chrome = originalChrome;
  globalThis.fetch = originalFetch;
  globalThis.setInterval = originalSetInterval;
  globalThis.clearInterval = originalClearInterval;
});

function dispatch(message, sender = {}) {
  return new Promise((resolve) => {
    runtimeListener(message, sender, resolve);
  });
}

test("keeps the service worker alive while a translation request is in flight", async () => {
  const created = await dispatch({
    type: "CREATE_TRANSLATION_JOB",
    tabId: 7,
    settings: {
      backend: "local",
      localBaseUrl: "http://127.0.0.1:1234/v1",
      localModel: "test-model"
    }
  });
  assert.ok(created.ok, created.error);

  const pending = dispatch(
    {
      type: "TRANSLATE_BATCH",
      jobId: created.jobId,
      segments: [{ id: "1", text: "Hello there" }]
    },
    { tab: { id: 7 } }
  );

  // 让请求真正起飞
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(
    intervals.size,
    1,
    "in-flight request should hold exactly one keepalive timer"
  );
  const [timer] = [...intervals.values()];
  assert.ok(
    timer.ms > 0 && timer.ms < 30_000,
    `keepalive period ${timer.ms}ms must stay under the 30s idle limit`
  );

  const before = platformInfoCalls;
  timer.fn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(
    platformInfoCalls > before,
    "each keepalive tick must touch an extension API to reset the idle timer"
  );

  releaseFetch();
  const response = await pending;
  assert.ok(response.ok, response.error);

  assert.equal(
    intervals.size,
    0,
    "keepalive must stop once no request is in flight"
  );
  assert.equal(clearedIntervals.length, 1);
});

test("a second concurrent request does not start a second keepalive timer", async () => {
  const created = await dispatch({
    type: "CREATE_TRANSLATION_JOB",
    tabId: 8,
    settings: {
      backend: "local",
      localBaseUrl: "http://127.0.0.1:1234/v1",
      localModel: "test-model"
    }
  });

  const first = dispatch(
    { type: "TRANSLATE_BATCH", jobId: created.jobId, segments: [{ id: "1", text: "one" }] },
    { tab: { id: 8 } }
  );
  await new Promise((resolve) => setImmediate(resolve));
  const releaseFirst = releaseFetch;

  const second = dispatch(
    { type: "TRANSLATE_BATCH", jobId: created.jobId, segments: [{ id: "1", text: "two" }] },
    { tab: { id: 8 } }
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(intervals.size, 1, "concurrent requests share one keepalive timer");

  releaseFirst();
  await first;
  assert.equal(
    intervals.size,
    1,
    "the timer must survive while the other request is still in flight"
  );

  releaseFetch();
  await second;
  assert.equal(intervals.size, 0, "the last request released must stop the timer");
});
