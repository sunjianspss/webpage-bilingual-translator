import { execFile } from "node:child_process";
import { access, cp, mkdir, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { buildContentScript } from "./build-content.mjs";

const run = promisify(execFile);

const ROOT = new URL("../", import.meta.url);

// 上架包只装浏览器运行时真正读到的文件:manifest 引用的图标和 service
// worker、popup 三件套、executeScript 注入的 content.js,以及它们 import
// 的 shared.js。用白名单而不是排除清单,新增的 test/ 或 scripts/ 目录不会
// 因为忘了加排除规则而混进商店包。
export const PACKAGE_FILES = Object.freeze([
  "manifest.json",
  "LICENSE",
  "icons/icon-16.png",
  "icons/icon-32.png",
  "icons/icon-48.png",
  "icons/icon-128.png",
  "src/background.js",
  "src/content.js",
  "src/shared.js",
  "src/popup/popup.html",
  "src/popup/popup.js",
  "src/popup/popup.css"
]);

// Chrome 的版本号规则:1 到 4 段整数,每段 0-65535,不允许前导零。
const VERSION_PATTERN = /^(0|[1-9]\d*)(\.(0|[1-9]\d*)){0,3}$/;

export async function readJson(relativePath) {
  return JSON.parse(await readFile(new URL(relativePath, ROOT), "utf8"));
}

export async function resolveVersion(expectedVersion) {
  const [pkg, manifest] = await Promise.all([
    readJson("package.json"),
    readJson("manifest.json")
  ]);

  if (pkg.version !== manifest.version) {
    throw new Error(
      `版本号不一致:package.json 是 ${pkg.version},manifest.json 是 ` +
        `${manifest.version}。两处必须相同,商店以 manifest.json 为准。`
    );
  }

  if (!VERSION_PATTERN.test(manifest.version)) {
    throw new Error(
      `manifest.json 的版本号 "${manifest.version}" 不符合 Chrome 的格式要求` +
        "(1-4 段整数,每段 0-65535,无前导零)。"
    );
  }

  if (expectedVersion && expectedVersion !== manifest.version) {
    throw new Error(
      `期望发布 ${expectedVersion},但 manifest.json 里是 ${manifest.version}。` +
        "先更新 manifest.json 和 package.json 再打 tag。"
    );
  }

  return { name: pkg.name, version: manifest.version };
}

// content.js 是生成文件,提交在仓库里。如果有人改了 src/content/ 却忘了跑
// build-content,过期的 content.js 会被原样发到商店,而本地开发时又看不出
// 来。这里重新生成一次做比对,不写盘。
export async function assertContentScriptFresh() {
  const [committed, rebuilt] = await Promise.all([
    readFile(new URL("src/content.js", ROOT), "utf8"),
    buildContentScript()
  ]);

  if (committed !== rebuilt) {
    throw new Error(
      "src/content.js 与 src/content/ 下的模块不同步。先运行 " +
        "`npm run build-content` 并提交结果,再打包。"
    );
  }
}

export async function assertPackageFilesExist() {
  const missing = [];
  for (const relativePath of PACKAGE_FILES) {
    try {
      await access(new URL(relativePath, ROOT));
    } catch {
      missing.push(relativePath);
    }
  }
  if (missing.length > 0) {
    throw new Error(`打包清单里的文件不存在:${missing.join(", ")}`);
  }
}

async function assertZipAvailable() {
  try {
    await run("zip", ["-v"]);
  } catch {
    throw new Error(
      "找不到 zip 命令。macOS 和 GitHub 的 ubuntu runner 自带," +
        "其他环境请先安装。"
    );
  }
}

async function stage(stageDir) {
  await rm(fileURLToPath(stageDir), { recursive: true, force: true });
  for (const relativePath of PACKAGE_FILES) {
    const destination = new URL(relativePath, stageDir);
    await mkdir(dirname(fileURLToPath(destination)), { recursive: true });
    await cp(new URL(relativePath, ROOT), destination);
  }
}

export async function createPackage({ expectedVersion } = {}) {
  const { name, version } = await resolveVersion(expectedVersion);
  await assertContentScriptFresh();
  await assertPackageFilesExist();
  await assertZipAvailable();

  const distDir = new URL("dist/", ROOT);
  const stageDir = new URL("dist/package/", ROOT);
  const zipName = `${name}-${version}.zip`;
  const zipPath = new URL(zipName, distDir);

  await mkdir(fileURLToPath(distDir), { recursive: true });
  await rm(zipPath, { force: true });
  await stage(stageDir);

  // 商店要求 manifest.json 在 zip 根目录,所以从暂存目录内部打包。
  // -X 去掉 macOS 的扩展属性,免得包里多出 __MACOSX 之类的垃圾条目。
  await run("zip", ["-r", "-X", "-q", fileURLToPath(zipPath), "."], {
    cwd: fileURLToPath(stageDir)
  });

  await rm(stageDir, { recursive: true, force: true });

  return { zipPath: fileURLToPath(zipPath), version, fileCount: PACKAGE_FILES.length };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const expectedArg = process.argv
    .slice(2)
    .find((arg) => arg.startsWith("--expect-version="));
  // 发布流水线传的是 git tag,形如 v0.1.4;这里统一去掉前缀 v。
  const expectedVersion = expectedArg
    ? expectedArg.slice("--expect-version=".length).replace(/^v/, "")
    : "";

  try {
    const result = await createPackage({ expectedVersion });
    console.log(
      `packaged ${result.fileCount} files as v${result.version}\n${result.zipPath}`
    );
  } catch (error) {
    console.error(`package failed: ${error.message}`);
    process.exitCode = 1;
  }
}
