import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = new URL("../", import.meta.url);
const SAFARI_PROJECT = "网页双语翻译";
const SAFARI_EXTENSION = "网页双语翻译 Extension";
const SYNCED_FILES = [
  "content.js",
  "shared.js",
  "popup/popup.js",
  "popup/popup.html",
  "popup/popup.css"
];

async function createFixture(t) {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "sync-safari-"));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));

  const scriptSource = await readFile(
    new URL("scripts/sync-safari.mjs", ROOT),
    "utf8"
  );
  const scriptPath = join(fixtureRoot, "scripts", "sync-safari.mjs");
  const safariSourceRoot = join(
    fixtureRoot,
    "safari",
    SAFARI_PROJECT,
    SAFARI_EXTENSION,
    "Resources",
    "src"
  );
  const safariManifestPath = join(
    fixtureRoot,
    "safari",
    SAFARI_PROJECT,
    SAFARI_EXTENSION,
    "Resources",
    "manifest.json"
  );
  await mkdir(join(fixtureRoot, "scripts"), { recursive: true });
  await mkdir(join(fixtureRoot, "src", "popup"), { recursive: true });
  await mkdir(join(safariSourceRoot, "popup"), { recursive: true });
  await writeFile(scriptPath, scriptSource);

  for (const relativePath of SYNCED_FILES) {
    const contents = `fixture:${relativePath}\n`;
    await writeFile(join(fixtureRoot, "src", relativePath), contents);
    await writeFile(join(safariSourceRoot, relativePath), "stale\n");
  }

  await writeFile(
    join(fixtureRoot, "manifest.json"),
    JSON.stringify({ version: "0.1.5", permissions: ["storage"] })
  );
  await writeFile(
    safariManifestPath,
    JSON.stringify({
      version: "0.1.3",
      permissions: ["nativeMessaging", "storage"],
      background: { service_worker: "src/background.js" }
    })
  );

  return {
    fixtureRoot,
    safariManifestPath,
    safariSourceRoot,
    scriptPath
  };
}

test("Safari sync writes only to the real Unicode project path", async (t) => {
  const { fixtureRoot, safariSourceRoot, scriptPath } = await createFixture(t);

  await run(process.execPath, [scriptPath], { cwd: fixtureRoot });

  for (const relativePath of SYNCED_FILES) {
    assert.equal(
      await readFile(join(safariSourceRoot, relativePath), "utf8"),
      `fixture:${relativePath}\n`
    );
  }
  assert.deepEqual(await readdir(join(fixtureRoot, "safari")), [SAFARI_PROJECT]);
});

test("Safari sync aligns the manifest version and preserves Safari fields", async (t) => {
  const { fixtureRoot, safariManifestPath, scriptPath } = await createFixture(t);

  await run(process.execPath, [scriptPath], { cwd: fixtureRoot });

  const safariManifest = JSON.parse(
    await readFile(safariManifestPath, "utf8")
  );
  assert.equal(safariManifest.version, "0.1.5");
  assert.deepEqual(safariManifest.permissions, ["nativeMessaging", "storage"]);
  assert.deepEqual(safariManifest.background, {
    service_worker: "src/background.js"
  });
});
