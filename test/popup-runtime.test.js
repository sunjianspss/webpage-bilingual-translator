import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";

const html = await readFile(
  new URL("../src/popup/popup.html", import.meta.url),
  "utf8"
);
let harnessSequence = 0;

async function createPopupHarness(storedSettings = {}) {
  const originalChrome = globalThis.chrome;
  const originalDocument = globalThis.document;
  const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "navigator"
  );
  const originalWindow = globalThis.window;
  const dom = new JSDOM(html, {
    url: "safari-web-extension://test/popup.html"
  });
  Object.defineProperty(dom.window.navigator, "userAgent", {
    configurable: true,
    value: "Mozilla/5.0 Version/18.0 Safari/605.1.15"
  });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: dom.window.navigator
  });

  const runtimeMessages = [];
  const permissionRequests = [];
  const openedTabs = [];
  const storageWrites = [];
  globalThis.chrome = {
    runtime: {
      async sendMessage(message) {
        runtimeMessages.push(message);
        if (message.type === "DETECT_LOCAL_BACKENDS") {
          return {
            ok: true,
            backends: [{
              baseUrl: "http://127.0.0.1:1234/v1",
              label: "LM Studio",
              models: ["model-a"]
            }]
          };
        }
        return { ok: true };
      }
    },
    commands: { async getAll() { return []; } },
    permissions: {
      async contains() { return false; },
      async request(permission) {
        permissionRequests.push(permission);
        return true;
      }
    },
    scripting: { async executeScript() {} },
    storage: {
      local: {
        async get() {
          return Object.keys(storedSettings).length > 0
            ? { translatorSettings: storedSettings }
            : {};
        },
        async set(value) { storageWrites.push(value); }
      }
    },
    tabs: {
      async create(options) { openedTabs.push(options); },
      async query() { return []; }
    }
  };

  harnessSequence += 1;
  await import(
    `../src/popup/popup.js?popup-runtime-test=${harnessSequence}`
  );
  await new Promise((resolve) => setImmediate(resolve));

  return {
    document: dom.window.document,
    openedTabs,
    permissionRequests,
    runtimeMessages,
    storageWrites,
    window: dom.window,
    close() {
      globalThis.chrome = originalChrome;
      globalThis.document = originalDocument;
      if (originalNavigatorDescriptor) {
        Object.defineProperty(
          globalThis,
          "navigator",
          originalNavigatorDescriptor
        );
      } else {
        delete globalThis.navigator;
      }
      globalThis.window = originalWindow;
      dom.window.close();
    }
  };
}

test("local detection never includes the API token", async (t) => {
  const harness = await createPopupHarness();
  t.after(harness.close);
  harness.document.querySelector("#local-api-key").value = "local-secret";
  harness.document.querySelector("#detect-local").click();
  await new Promise((resolve) => setImmediate(resolve));

  const message = harness.runtimeMessages.find(
    ({ type }) => type === "DETECT_LOCAL_BACKENDS"
  );
  assert.deepEqual(message, { type: "DETECT_LOCAL_BACKENDS" });
});

test("changing a custom local endpoint requests permission while the gesture is active", async (t) => {
  const harness = await createPopupHarness();
  t.after(harness.close);
  harness.document.querySelector("#backend").value = "local";
  harness.document.querySelector("#local-api-key").value =
    "previous-endpoint-token";
  harness.document.querySelector("#local-base-url").value =
    "http://192.168.1.23:1234/v1";
  harness.document.querySelector("#local-model").value = "model-a";
  harness.document.querySelector("#local-base-url").dispatchEvent(
    new harness.window.Event("change", { bubbles: true })
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(harness.permissionRequests, [
    { origins: ["http://192.168.1.23:1234/*"] }
  ]);
  assert.equal(harness.document.querySelector("#local-api-key").value, "");
  assert.equal(
    harness.storageWrites.at(-1).translatorSettings.localApiKey,
    ""
  );
});

test("detecting a different endpoint unbinds the previous endpoint token", async (t) => {
  const harness = await createPopupHarness({
    localBaseUrl: "http://192.168.1.23:1234/v1",
    localModel: "old-model",
    localApiKey: "old-endpoint-secret"
  });
  t.after(harness.close);
  harness.document.querySelector("#detect-local").click();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.document.querySelector("#local-base-url").value,
    "http://127.0.0.1:1234/v1");
  assert.equal(harness.document.querySelector("#local-api-key").value, "");
  assert.equal(
    harness.storageWrites.at(-1).translatorSettings.localApiKey,
    "",
    "the old token must not be silently rebound to the detected endpoint"
  );
});

test("Safari shortcut customization does not open a Chrome-only URL", async (t) => {
  const harness = await createPopupHarness();
  t.after(harness.close);
  harness.document.querySelector("#customize-shortcut").click();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(harness.openedTabs, []);
  assert.match(
    harness.document.querySelector("#shortcut-note").textContent,
    /Safari 设置/
  );
});

test("the page limit renders and persists so it is not stuck at the default", async (t) => {
  const harness = await createPopupHarness();
  t.after(harness.close);
  const input = harness.document.querySelector("#max-segments");

  assert.equal(input.value, "220", "the shipped default must be visible");

  input.value = "600";
  input.dispatchEvent(new harness.window.Event("change", { bubbles: true }));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(
    harness.storageWrites.at(-1).translatorSettings.maxSegments,
    600
  );
});

test("an out-of-range page limit is reported instead of silently persisted", async (t) => {
  const harness = await createPopupHarness();
  t.after(harness.close);
  const input = harness.document.querySelector("#max-segments");
  const writesBefore = harness.storageWrites.length;

  input.value = "0";
  input.dispatchEvent(new harness.window.Event("change", { bubbles: true }));
  await new Promise((resolve) => setImmediate(resolve));

  assert.match(
    harness.document.querySelector("#message").textContent,
    /单页翻译上限/
  );
  assert.equal(
    harness.storageWrites.length,
    writesBefore,
    "a rejected limit must not reach storage"
  );
});
