import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const safariBackgroundUrl = new URL(
  "../safari/网页双语翻译/网页双语翻译 Extension/Resources/src/background.js",
  import.meta.url
);

test("Safari falls back to direct fetch for temporary extensions", async () => {
  const content = await readFile(safariBackgroundUrl, "utf8");

  assert.match(content, /sendNativeMessage/);
  assert.match(content, /return await chrome\.runtime\.sendNativeMessage/);
  assert.match(content, /const response = await fetch\(request\.url/);
  assert.match(content, /原生代理不可用/);
});
