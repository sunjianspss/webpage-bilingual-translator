import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { PACKAGE_FILES, readJson, resolveVersion } from "../scripts/package.mjs";

const ROOT = new URL("../", import.meta.url);

async function readRootFile(relativePath) {
  return readFile(new URL(relativePath, ROOT), "utf8");
}

// 打包用的是白名单。白名单漏掉一个文件,商店包会安静地少装一份资源,而本地
// 「加载已解压的扩展程序」照样能跑 —— 只有用户装了正式包才会发现。这些测试
// 把 manifest、popup 和 import 里实际引用的路径反推出来,和白名单对账。
test("package list covers every file manifest.json references", async () => {
  const manifest = await readJson("manifest.json");
  const referenced = [
    manifest.background.service_worker,
    manifest.action.default_popup,
    ...Object.values(manifest.icons),
    ...Object.values(manifest.action.default_icon)
  ];

  for (const relativePath of referenced) {
    assert.ok(
      PACKAGE_FILES.includes(relativePath),
      `manifest.json 引用了 ${relativePath},但它不在 PACKAGE_FILES 里`
    );
  }
});

test("package list covers every module the packaged scripts import", async () => {
  const entryPoints = PACKAGE_FILES.filter((name) => name.endsWith(".js"));

  for (const entry of entryPoints) {
    const source = await readRootFile(entry);
    const specifiers = [...source.matchAll(/from\s+"(\.[^"]+)"/g)].map(
      (match) => match[1]
    );

    for (const specifier of specifiers) {
      const resolved = new URL(specifier, new URL(entry, ROOT));
      const relativePath = resolved.href.slice(ROOT.href.length);
      assert.ok(
        PACKAGE_FILES.includes(relativePath),
        `${entry} 导入了 ${relativePath},但它不在 PACKAGE_FILES 里`
      );
    }
  }
});

test("package list covers every local asset the popup loads", async () => {
  const html = await readRootFile("src/popup/popup.html");
  const assets = [...html.matchAll(/(?:href|src)="(\.[^"]+)"/g)].map(
    (match) => match[1]
  );

  assert.ok(assets.length > 0, "没有从 popup.html 里解析出任何本地资源");

  for (const asset of assets) {
    const resolved = new URL(asset, new URL("src/popup/popup.html", ROOT));
    const relativePath = resolved.href.slice(ROOT.href.length);
    assert.ok(
      PACKAGE_FILES.includes(relativePath),
      `popup.html 加载了 ${relativePath},但它不在 PACKAGE_FILES 里`
    );
  }
});

test("manifest.json and package.json declare the same version", async () => {
  const { version } = await resolveVersion();
  const manifest = await readJson("manifest.json");
  assert.equal(version, manifest.version);
});
