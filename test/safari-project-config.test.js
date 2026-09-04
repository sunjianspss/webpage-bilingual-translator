import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const PROJECT_FILE = new URL(
  "../safari/网页双语翻译/网页双语翻译.xcodeproj/project.pbxproj",
  import.meta.url
);

function buildSettingValues(project, name) {
  const pattern = new RegExp(`\\b${name} = ([^;]+);`, "g");
  return [...project.matchAll(pattern)].map((match) => match[1]);
}

test("Safari targets support macOS 10.14 and later", async () => {
  const project = await readFile(PROJECT_FILE, "utf8");
  const deploymentTargets = buildSettingValues(
    project,
    "MACOSX_DEPLOYMENT_TARGET"
  );

  assert.ok(deploymentTargets.length > 0, "missing deployment target");
  assert.deepEqual([...new Set(deploymentTargets)], ["10.14"]);
});

test("Safari app and extension report release version 0.1.5", async () => {
  const project = await readFile(PROJECT_FILE, "utf8");
  const marketingVersions = buildSettingValues(project, "MARKETING_VERSION");

  assert.ok(marketingVersions.length > 0, "missing marketing version");
  assert.deepEqual([...new Set(marketingVersions)], ["0.1.5"]);
});
