import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import {
  DEFAULT_SETTINGS,
  LOCAL_BACKEND_CANDIDATES
} from "../src/shared.js";

const policyUrl = new URL("../PRIVACY.md", import.meta.url);
const manifestUrl = new URL("../manifest.json", import.meta.url);
const stateUrl = new URL("../src/content/state.js", import.meta.url);

// 隐私政策写错会被审核打回，但更糟的是它悄悄过期：有人加了第六个探测
// 端口、改了缓存上限，政策还写着旧数字，就从"说明"变成了"不实陈述"。
// 这些断言把文档钉在代码上。

test("every probed port is disclosed in the privacy policy", async () => {
  const policy = await readFile(policyUrl, "utf8");

  for (const candidate of LOCAL_BACKEND_CANDIDATES) {
    const port = new URL(candidate.baseUrl).port;
    assert.match(
      policy,
      new RegExp(`\`${port}\``),
      `端口 ${port}（${candidate.label}）会被探测，但没有写进隐私政策`
    );
  }
});

test("the policy does not claim a smaller probe list than the code has", async () => {
  const policy = await readFile(policyUrl, "utf8");
  const section = policy.split("## 三、")[1].split("## 四、")[0];
  const disclosed = [...section.matchAll(/`(\d{2,5})`/g)].map(
    (match) => match[1]
  );
  const probed = LOCAL_BACKEND_CANDIDATES.map(
    (candidate) => new URL(candidate.baseUrl).port
  );

  assert.deepEqual(
    [...disclosed].sort(),
    [...probed].sort(),
    "自动检测一节列出的端口必须和代码里的候选完全一致，不能多也不能少"
  );
});

test("the disclosed cache cap matches the code", async () => {
  const [policy, state] = await Promise.all([
    readFile(policyUrl, "utf8"),
    readFile(stateUrl, "utf8")
  ]);

  const cap = state.match(
    /PERSISTENT_CACHE_MAX_ENTRIES\s*=\s*(\d+)/
  )?.[1];
  assert.ok(cap, "找不到缓存上限常量");
  assert.match(
    policy,
    new RegExp(`${cap} 条`),
    `缓存上限是 ${cap}，隐私政策里的数字对不上`
  );
});

test("every permission the manifest asks for is explained", async () => {
  const [policy, manifest] = await Promise.all([
    readFile(policyUrl, "utf8"),
    readFile(manifestUrl, "utf8").then(JSON.parse)
  ]);

  const declared = [
    ...manifest.permissions,
    ...manifest.host_permissions,
    ...manifest.optional_host_permissions
  ];

  for (const permission of declared) {
    assert.ok(
      policy.includes(permission),
      `manifest 申请了 ${permission}，但隐私政策没有解释它`
    );
  }
});

test("the disclosed default local endpoint matches the shipped default", async () => {
  const policy = await readFile(policyUrl, "utf8");

  assert.ok(
    policy.includes(DEFAULT_SETTINGS.localBaseUrl),
    `默认本地地址是 ${DEFAULT_SETTINGS.localBaseUrl}，隐私政策里写的不是这个`
  );
});

// 政策承诺"只有这两个目的地"。这条断言守住那个承诺：任何新的外部主机
// 出现在打包进商店的代码里，都会让这里变红。
test("the shipped code talks to no host the policy does not name", async () => {
  const sources = await Promise.all(
    [
      "../src/background.js",
      "../src/shared.js",
      "../src/content.js",
      "../src/popup/popup.js"
    ].map((path) => readFile(new URL(path, import.meta.url), "utf8"))
  );

  const allowed = new Set(["127.0.0.1", "localhost", "api.deepseek.com"]);
  const hosts = new Set();
  for (const source of sources) {
    for (const match of source.matchAll(/https?:\/\/([a-zA-Z0-9.-]+)/g)) {
      hosts.add(match[1]);
    }
  }

  for (const host of hosts) {
    assert.ok(
      allowed.has(host),
      `代码里出现了新的外部主机 ${host}，隐私政策没有披露它`
    );
  }
});
