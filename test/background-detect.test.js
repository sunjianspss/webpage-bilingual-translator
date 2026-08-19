import assert from "node:assert/strict";
import { after, test } from "node:test";

import {
  LOCAL_BACKEND_CANDIDATES,
  chatModelIds
} from "../src/shared.js";

const originalChrome = globalThis.chrome;
const originalFetch = globalThis.fetch;

let runtimeListener;
// 每个候选端口的应答由测试逐个指定，键是端口号。
let portResponses = {};
const requests = [];
let inFlight = 0;
let peakInFlight = 0;
let releaseProbes = null;

globalThis.chrome = {
  runtime: {
    onMessage: {
      addListener(listener) {
        runtimeListener = listener;
      }
    }
  },
  commands: { onCommand: { addListener() {} } },
  tabs: {
    onRemoved: { addListener() {} },
    onUpdated: { addListener() {} },
    onReplaced: { addListener() {} }
  },
  storage: {
    local: { async get() { return {}; } },
    session: {
      async get() { return {}; },
      async set() {},
      async remove() {}
    }
  }
};

globalThis.fetch = async (url, options) => {
  requests.push({ url, options });
  inFlight += 1;
  peakInFlight = Math.max(peakInFlight, inFlight);
  try {
    if (releaseProbes) {
      await releaseProbes;
    }
    const port = new URL(String(url)).port;
    const responder = portResponses[port];
    if (!responder) {
      throw new Error("connection refused");
    }
    return responder();
  } finally {
    inFlight -= 1;
  }
};

await import(`../src/background.js?detect-test=${Date.now()}`);

after(() => {
  globalThis.chrome = originalChrome;
  globalThis.fetch = originalFetch;
});

test("reports only the ports that answer, and probes every candidate", async () => {
  reset({ 1234: modelsResponse(["qwen/qwen3.5-35b-a3b"]) });

  const response = await detect();

  assert.equal(response.ok, true);
  assert.deepEqual(response.backends, [
    {
      baseUrl: "http://127.0.0.1:1234/v1",
      label: "LM Studio",
      models: ["qwen/qwen3.5-35b-a3b"]
    }
  ]);
  assert.equal(
    requests.length,
    LOCAL_BACKEND_CANDIDATES.length,
    "every candidate port should be probed"
  );
});

test("a refused port does not fail the whole detection", async () => {
  reset({ 11434: modelsResponse(["llama3:latest"]) });

  const response = await detect();

  assert.deepEqual(
    response.backends.map((backend) => backend.label),
    ["Ollama"]
  );
});

test("embedding and reranker models are kept out of the model list", async () => {
  reset({
    1234: modelsResponse([
      "qwen/qwen3.5-35b-a3b",
      "text-embedding-nomic-embed-text-v1.5",
      "bge-reranker-v2-m3"
    ])
  });

  const response = await detect();

  assert.deepEqual(response.backends[0].models, ["qwen/qwen3.5-35b-a3b"]);
});

// 这两种情况在界面上必须说成不同的话：一个是"服务没起来"，另一个是
// "服务起来了但没加载模型"，后者用户只要去 LM Studio 里点一下加载。
test("a running service with no model loaded is still reported", async () => {
  reset({ 1234: modelsResponse([]) });

  const response = await detect();

  assert.deepEqual(response.backends, [
    {
      baseUrl: "http://127.0.0.1:1234/v1",
      label: "LM Studio",
      models: []
    }
  ]);
});

// 本机 :5000 上就蹲着一个返回 403 的东西，它不是 OpenAI 兼容服务。
test("a non-2xx answer is not reported as a backend", async () => {
  reset({ 8000: modelsResponse([], 403) });

  const response = await detect();

  assert.deepEqual(response.backends, []);
});

test("the API token is sent to every probe", async () => {
  reset({ 1234: modelsResponse(["m"]) });

  await detect("local-secret");

  assert.equal(requests.length, LOCAL_BACKEND_CANDIDATES.length);
  for (const request of requests) {
    assert.equal(
      request.options.headers.Authorization,
      "Bearer local-secret"
    );
  }
});

// 串行探测时，没人监听的端口要各等一次超时；候选有五个，最坏要等到
// 五倍超时之后才出结果。并发是这个功能可用的前提，不是优化。
test("all candidates are probed concurrently, not one after another", async () => {
  let release;
  reset({ 1234: modelsResponse(["m"]) });
  releaseProbes = new Promise((resolve) => {
    release = resolve;
  });

  const pending = detect();
  await Promise.resolve();
  release();
  await pending;

  assert.equal(
    peakInFlight,
    LOCAL_BACKEND_CANDIDATES.length,
    "every probe should be in flight at the same time"
  );
});

test("chatModelIds falls back to the full list rather than returning nothing", () => {
  assert.deepEqual(
    chatModelIds(["text-embedding-3-large", "my-embedder"]),
    ["text-embedding-3-large", "my-embedder"]
  );
});

function reset(responses) {
  portResponses = responses;
  requests.length = 0;
  inFlight = 0;
  peakInFlight = 0;
  releaseProbes = null;
}

function detect(apiKey = "") {
  let resolveResponse;
  const response = new Promise((resolve) => {
    resolveResponse = resolve;
  });
  const asynchronous = runtimeListener(
    { type: "DETECT_LOCAL_BACKENDS", apiKey },
    {},
    resolveResponse
  );
  assert.equal(asynchronous, true);
  return response;
}

function modelsResponse(ids, status = 200) {
  return () => ({
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return { object: "list", data: ids.map((id) => ({ id })) };
    }
  });
}
