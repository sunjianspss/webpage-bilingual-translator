import assert from "node:assert/strict";
import { after, test } from "node:test";

const originalChrome = globalThis.chrome;
const originalFetch = globalThis.fetch;

let commandListener;
let fetchCalls = 0;
const permissionChecks = [];
const tabMessages = [];
let errorShown;

globalThis.chrome = {
  runtime: {
    onMessage: { addListener() {} },
    async getPlatformInfo() { return { os: "mac" }; }
  },
  commands: {
    onCommand: {
      addListener(listener) {
        commandListener = listener;
      }
    }
  },
  permissions: {
    async contains(permission) {
      permissionChecks.push(permission);
      return false;
    }
  },
  scripting: { async executeScript() {} },
  storage: {
    local: {
      async get() {
        return {
          translatorSettings: {
            backend: "local",
            localBaseUrl: "http://192.168.1.23:1234/v1",
            localModel: "test-model"
          }
        };
      }
    },
    session: {
      async get() { return {}; },
      async set() {},
      async remove() {}
    }
  },
  tabs: {
    async query() {
      return [{ id: 9, url: "https://example.com/article" }];
    },
    async sendMessage(tabId, message) {
      tabMessages.push({ tabId, message });
      if (message.type === "SHOW_TRANSLATION_ERROR") {
        errorShown?.();
      }
      return { ok: true };
    },
    onRemoved: { addListener() {} },
    onUpdated: { addListener() {} },
    onReplaced: { addListener() {} }
  }
};

globalThis.fetch = async () => {
  fetchCalls += 1;
  throw new Error("the endpoint must not be contacted without permission");
};

await import(`../src/background.js?shortcut-permission-test=${Date.now()}`);

after(() => {
  globalThis.chrome = originalChrome;
  globalThis.fetch = originalFetch;
});

test("shortcut stops before fetch when a custom endpoint permission is missing", async () => {
  const shown = new Promise((resolve) => {
    errorShown = resolve;
  });

  commandListener("translate-current-page");
  await shown;

  assert.deepEqual(permissionChecks, [
    { origins: ["http://192.168.1.23:1234/*"] }
  ]);
  assert.equal(fetchCalls, 0);
  assert.equal(
    tabMessages.some(({ message }) => message.type === "TRANSLATE_PAGE"),
    false
  );
  assert.match(
    tabMessages.at(-1).message.error,
    /先打开扩展.*允许访问/
  );
});
