import { copyFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const SAFARI_SRC_DIR =
  "safari/网页双语翻译/网页双语翻译 Extension/Resources/src";

// content.js, shared.js, and the popup are byte-identical between Chrome
// and Safari, so they can be copied directly. background.js is excluded on
// purpose: the Safari copy adds native-messaging proxy code that the Chrome
// service worker doesn't need, so it must be updated by hand.
const SYNCED_FILES = [
  "content.js",
  "shared.js",
  "popup/popup.js",
  "popup/popup.html",
  "popup/popup.css"
];

for (const relativePath of SYNCED_FILES) {
  const source = new URL(`../src/${relativePath}`, import.meta.url);
  const destination = new URL(
    `../${SAFARI_SRC_DIR}/${relativePath}`,
    import.meta.url
  );
  await mkdir(dirname(destination.pathname), { recursive: true });
  await copyFile(source, destination);
  console.log(`synced ${relativePath}`);
}

console.log(
  "\nbackground.js was not touched: port any src/shared.js changes into " +
    `"${SAFARI_SRC_DIR}/background.js" by hand, then rerun \`npm test\` to ` +
    "confirm the shared-logic tests still pass."
);
