import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// state.js 必须排在最前:它包含常量、可变状态和消息监听等顶层执行语句,
// 其余文件只含函数声明(提升生效),顺序仅影响可读性。
const PART_FILES = [
  "state.js",
  "session.js",
  "pipeline.js",
  "cache.js",
  "language.js",
  "collect.js",
  "render.js",
  "observer.js",
  "status.js"
];

const OUTPUT_URL = new URL("../src/content.js", import.meta.url);

const BANNER =
  "// 本文件由 scripts/build-content.mjs 从 src/content/ 各模块拼接生成。\n" +
  "// 请勿直接编辑;修改 src/content/ 后运行 npm run build-content。\n";

const HEADER =
  "(() => {\n" +
  "  if (globalThis.__AI_PAGE_TRANSLATOR_LOADED__) {\n" +
  "    return;\n" +
  "  }\n" +
  "  globalThis.__AI_PAGE_TRANSLATOR_LOADED__ = true;\n" +
  "\n";

const FOOTER = "})();\n";

export async function buildContentScript() {
  const parts = await Promise.all(
    PART_FILES.map((name) =>
      readFile(new URL(`../src/content/${name}`, import.meta.url), "utf8")
    )
  );
  const body = parts.map((part) => part.trimEnd()).join("\n\n");
  return `${BANNER}${HEADER}${body}\n${FOOTER}`;
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === process.argv[1]
) {
  const output = await buildContentScript();
  await writeFile(OUTPUT_URL, output);
  console.log(
    `built src/content.js (${output.length} chars, ${PART_FILES.length} parts)`
  );
}
