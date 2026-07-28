import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const chromeContentUrl = new URL("../src/content.js", import.meta.url);
const safariContentUrl = new URL(
  "../safari/网页双语翻译/网页双语翻译 Extension/Resources/src/content.js",
  import.meta.url
);
const chromePopupUrl = new URL("../src/popup/popup.js", import.meta.url);
const chromePopupHtmlUrl = new URL(
  "../src/popup/popup.html",
  import.meta.url
);
const chromePopupCssUrl = new URL(
  "../src/popup/popup.css",
  import.meta.url
);
const safariPopupUrl = new URL(
  "../safari/网页双语翻译/网页双语翻译 Extension/Resources/src/popup/popup.js",
  import.meta.url
);
const safariPopupHtmlUrl = new URL(
  "../safari/网页双语翻译/网页双语翻译 Extension/Resources/src/popup/popup.html",
  import.meta.url
);
const safariPopupCssUrl = new URL(
  "../safari/网页双语翻译/网页双语翻译 Extension/Resources/src/popup/popup.css",
  import.meta.url
);
const chromeSharedUrl = new URL("../src/shared.js", import.meta.url);
const safariSharedUrl = new URL(
  "../safari/网页双语翻译/网页双语翻译 Extension/Resources/src/shared.js",
  import.meta.url
);
const chromeManifestUrl = new URL("../manifest.json", import.meta.url);
const safariManifestUrl = new URL(
  "../safari/网页双语翻译/网页双语翻译 Extension/Resources/manifest.json",
  import.meta.url
);
const chromeBackgroundUrl = new URL("../src/background.js", import.meta.url);

test("src/content.js matches the artifact built from src/content/ modules", async () => {
  const { buildContentScript } = await import(
    "../scripts/build-content.mjs"
  );
  const [built, current] = await Promise.all([
    buildContentScript(),
    readFile(chromeContentUrl, "utf8")
  ]);

  assert.equal(
    current,
    built,
    "src/content.js is generated; edit src/content/ and run npm run build-content"
  );
});

test("Chrome and Safari use the same content script", async () => {
  const [chromeContent, safariContent] = await Promise.all([
    readFile(chromeContentUrl, "utf8"),
    readFile(safariContentUrl, "utf8")
  ]);

  assert.equal(safariContent, chromeContent);
});

test("Chrome and Safari use the same shared translation logic", async () => {
  const [chromeShared, safariShared] = await Promise.all([
    readFile(chromeSharedUrl, "utf8"),
    readFile(safariSharedUrl, "utf8")
  ]);

  assert.equal(safariShared, chromeShared);
});

test("social post bodies are treated as structured translation units", async () => {
  const content = await readFile(chromeContentUrl, "utf8");

  assert.match(content, /\[data-testid='tweetText'\]/);
  assert.match(content, /article \[lang\]\[dir='auto'\]/);
  assert.match(content, /structuredTextElements\.has\(element\)/);
  assert.match(content, /if \(candidate\.structured\)/);
});

test("long structured posts are not silently skipped", async () => {
  const content = await readFile(chromeContentUrl, "utf8");

  assert.match(content, /const STRUCTURED_TEXT_MAX_LENGTH = 4000/);
  assert.match(
    content,
    /structured\s*\?\s*STRUCTURED_TEXT_MAX_LENGTH\s*:\s*DEFAULT_TEXT_MAX_LENGTH/
  );
  assert.match(
    content,
    /isMeaningfulText\(text, maxLength = DEFAULT_TEXT_MAX_LENGTH\)/
  );
});

test("structured translations preserve source line breaks", async () => {
  const content = await readFile(chromeContentUrl, "utf8");

  assert.match(content, /normalizeStructuredText/);
  assert.match(content, /preserveLayout: Boolean\(preserveLayout\)/);
  assert.match(content, /white-space: pre-wrap !important/);
});

test("dynamic social pages apply batches as concurrent workers and rescan", async () => {
  const content = await readFile(chromeContentUrl, "utf8");

  assert.match(content, /const DYNAMIC_RESCAN_DELAYS = \[0, 400, 900\]/);
  assert.match(content, /const LOCAL_TRANSLATION_BATCH_CONCURRENCY = 4/);
  assert.match(content, /const REMOTE_TRANSLATION_BATCH_CONCURRENCY = 6/);
  assert.match(content, /const LOCAL_BATCH_SEGMENT_LIMIT = 18/);
  assert.match(content, /const LOCAL_BATCH_CHARACTER_LIMIT = 4200/);
  assert.match(content, /shouldRescanDynamicContent\(\)/);
  assert.match(content, /const batches = makeBatches\(candidates, settings\)/);
  assert.match(
    content,
    /translateCandidateBatches\(\s*batches,\s*getTranslationBatchConcurrency\(settings\),\s*shouldWarmupFirstBatch\(settings\)/
  );
  assert.match(content, /settings\?\.backend === "deepseek"/);
  assert.match(content, /function shouldWarmupFirstBatch\(settings\)/);
  assert.match(content, /const response = await requestTranslationBatch\(batches\[0\], taskId\)/);
  assert.match(content, /Array\.from\(\{ length: workerCount \}/);
  assert.match(content, /requestTranslationBatch\(batch, taskId\)/);
  assert.match(content, /for \(let attempt = 0; attempt < 2/);
  assert.match(content, /element\.closest\(`\[\$\{MARKER\}\]`\)/);
  assert.match(content, /return true;\s*\n\s*}\s*\n\s*\n\s*function applyFlowTranslation/);
});

test("first translation batch is intentionally small for faster first paint", async () => {
  const content = await readFile(chromeContentUrl, "utf8");

  assert.match(content, /const LOCAL_FIRST_BATCH_SEGMENT_LIMIT = 5/);
  assert.match(content, /const LOCAL_FIRST_BATCH_CHARACTER_LIMIT = 1400/);
  assert.match(content, /const REMOTE_FIRST_BATCH_SEGMENT_LIMIT = 4/);
  assert.match(content, /const REMOTE_FIRST_BATCH_CHARACTER_LIMIT = 900/);
  assert.match(content, /const isFirstBatch = batches\.length === 0/);
});

test("social pages focus on structured post text instead of surrounding UI", async () => {
  const content = await readFile(chromeContentUrl, "utf8");

  assert.match(content, /const isSocialPage = shouldRescanDynamicContent\(\)/);
  assert.match(content, /const secondarySelector = isSocialPage\s*\?\s*""/);
  assert.match(content, /const useFocusedSocialExtraction =\s*isSocialPage && structuredTextElements\.size > 0/);
  assert.match(content, /const flowCandidates = useFocusedSocialExtraction\s*\?\s*\[\]/);
});

test("page translation continues after the popup closes", async () => {
  const content = await readFile(chromeContentUrl, "utf8");

  assert.match(content, /startTranslation\(message\.settings\)/);
  assert.match(
    content,
    /sendResponse\(\{ ok: true, started: true, state \}\)/
  );
  assert.doesNotMatch(
    content,
    /translatePage\(message\.settings\)\s*\.then\(\(\) => sendResponse/
  );
});

test("popup persists settings before creating a translation job", async () => {
  const [chromePopup, safariPopup] = await Promise.all([
    readFile(chromePopupUrl, "utf8"),
    readFile(safariPopupUrl, "utf8")
  ]);

  assert.equal(safariPopup, chromePopup);
  assert.match(
    chromePopup,
    /await chrome\.storage\.local\.set\([\s\S]*const job = await createTranslationJob\(settings\)/
  );
  assert.match(chromePopup, /type: "CREATE_TRANSLATION_JOB"/);
  assert.match(
    chromePopup,
    /type: "TRANSLATE_PAGE",\s*jobId,\s*pageSettings: job\.pageSettings/
  );
  assert.match(chromePopup, /if \(jobId && !pageStarted\)/);
  assert.match(chromePopup, /type: "CANCEL_TRANSLATION_JOB"/);
  assert.doesNotMatch(
    chromePopup,
    /type: "TRANSLATE_PAGE",\s*settings:/
  );
});

test("Chrome and Safari use the same popup files", async () => {
  const [
    chromePopup,
    safariPopup,
    chromeHtml,
    safariHtml,
    chromeCss,
    safariCss
  ] = await Promise.all([
    readFile(chromePopupUrl, "utf8"),
    readFile(safariPopupUrl, "utf8"),
    readFile(chromePopupHtmlUrl, "utf8"),
    readFile(safariPopupHtmlUrl, "utf8"),
    readFile(chromePopupCssUrl, "utf8"),
    readFile(safariPopupCssUrl, "utf8")
  ]);

  assert.equal(safariPopup, chromePopup);
  assert.equal(safariHtml, chromeHtml);
  assert.equal(safariCss, chromeCss);
});

test("popup includes shortcut customization controls", async () => {
  const [html, css, popup] = await Promise.all([
    readFile(chromePopupHtmlUrl, "utf8"),
    readFile(chromePopupCssUrl, "utf8"),
    readFile(chromePopupUrl, "utf8")
  ]);

  assert.match(html, /<span class="section-label">快捷键<\/span>/);
  assert.match(html, /id="shortcut-value"/);
  assert.match(html, /id="customize-shortcut"/);
  assert.match(css, /\.shortcut-row/);
  assert.match(css, /kbd \{/);
  assert.match(popup, /chrome\.commands\?\.getAll/);
  assert.match(popup, /const SHORTCUTS_URL = "chrome:\/\/extensions\/shortcuts"/);
  assert.match(popup, /chrome\.tabs\.create\(\{ url: SHORTCUTS_URL \}\)/);
});

test("popup follows translation progress instead of freezing at the first reply", async () => {
  const popup = await readFile(chromePopupUrl, "utf8");

  assert.match(popup, /const PROGRESS_POLL_INTERVAL_MS = \d+/);
  assert.match(popup, /function startProgressPolling\(\)/);
  assert.match(popup, /function stopProgressPolling\(\)/);
  assert.match(
    popup,
    /window\.setInterval\(/,
    "progress must be re-read on a timer, the first reply is always 0 / 0"
  );
  assert.match(
    popup,
    /sendToPage\(\{ type: "GET_PAGE_STATE" \}\)/,
    "the poll has to ask the page for its current state"
  );
  assert.match(
    popup,
    /if \(pageState\.status === "translating"\) \{\s*startProgressPolling\(\);\s*\} else \{\s*stopProgressPolling\(\);\s*\}/,
    "polling must start while translating and stop on every terminal state"
  );
});

test("popup offers a clear-cache retranslate action", async () => {
  const [html, popup, content] = await Promise.all([
    readFile(chromePopupHtmlUrl, "utf8"),
    readFile(chromePopupUrl, "utf8"),
    readFile(chromeContentUrl, "utf8")
  ]);

  assert.match(html, /id="retranslate"/);
  assert.match(popup, /type: "CLEAR_PAGE_CACHE"/);
  assert.match(popup, /type: "RESTORE_PAGE"/);
  assert.match(content, /message\?\.type === "CLEAR_PAGE_CACHE"/);
  assert.match(content, /function clearPagePersistentCache\(\)/);
});

test("local background compacts segment ids and restores original ids", async () => {
  const content = await readFile(
    chromeBackgroundUrl,
    "utf8"
  );

  assert.match(content, /const requestSegments = isDeepSeek\s*\?\s*segments\s*:\s*compactSegmentIds\(segments\)/);
  assert.match(content, /parseTranslations\(content, requestSegments\)/);
  assert.match(content, /restoreSegmentIds\(translations, segments\)/);
  assert.match(content, /id: String\(index \+ 1\)/);
});

test("manifest defines a shortcut command for translating the current page", async () => {
  const [chromeManifest, safariManifest] = await Promise.all([
    readFile(chromeManifestUrl, "utf8").then(JSON.parse),
    readFile(safariManifestUrl, "utf8").then(JSON.parse)
  ]);
  const chromeCommand =
    chromeManifest.commands?.["translate-current-page"];
  const safariCommand =
    safariManifest.commands?.["translate-current-page"];

  assert.equal(chromeCommand.description, "翻译当前网页");
  assert.deepEqual(chromeCommand.suggested_key, {
    default: "Ctrl+Shift+Y",
    mac: "Command+Shift+Y"
  });
  assert.deepEqual(safariCommand, chromeCommand);
});

test("both manifests ship toolbar and store icons", async () => {
  const [chromeManifest, safariManifest] = await Promise.all([
    readFile(chromeManifestUrl, "utf8").then(JSON.parse),
    readFile(safariManifestUrl, "utf8").then(JSON.parse)
  ]);
  const expected = {
    16: "icons/icon-16.png",
    32: "icons/icon-32.png",
    48: "icons/icon-48.png",
    128: "icons/icon-128.png"
  };

  assert.deepEqual(chromeManifest.icons, expected);
  assert.deepEqual(chromeManifest.action.default_icon, expected);
  assert.deepEqual(safariManifest.icons, expected);
  assert.deepEqual(safariManifest.action.default_icon, expected);

  await Promise.all(
    Object.values(expected).map((relativePath) =>
      readFile(new URL(`../${relativePath}`, import.meta.url))
    )
  );
});

test("background shortcut command injects the content script and starts translation", async () => {
  const content = await readFile(chromeBackgroundUrl, "utf8");

  assert.match(content, /const TRANSLATE_COMMAND = "translate-current-page"/);
  assert.match(content, /chrome\.commands\?\.onCommand\?\.addListener/);
  assert.match(content, /translateActiveTabFromCommand\(\)/);
  assert.match(content, /chrome\.scripting\.executeScript\(\{/);
  assert.match(content, /files: \["src\/content\.js"\]/);
  assert.match(content, /type: "TRANSLATE_PAGE"/);
  assert.match(
    content,
    /createTranslationJob\(\s*await loadTranslatorSettings\(\),\s*tab\.id\s*\)/
  );
  assert.match(content, /jobId: job\.jobId/);
  assert.match(content, /pageSettings: job\.pageSettings/);
});
