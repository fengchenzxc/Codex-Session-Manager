import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");

test("open-source metadata is present and versioned consistently", () => {
  const packageJson = JSON.parse(read("package.json"));
  const packageLock = JSON.parse(read("package-lock.json"));
  const cargoToml = read("src-tauri/Cargo.toml");
  const tauriConfig = JSON.parse(read("src-tauri/tauri.conf.json"));

  assert.equal(packageJson.version, "0.1.0");
  assert.equal(packageLock.version, packageJson.version);
  assert.equal(packageLock.packages[""].version, packageJson.version);
  assert.match(cargoToml, /version = "0\.1\.0"/);
  assert.equal(tauriConfig.version, packageJson.version);
  assert.equal(packageJson.private, false);
  assert.equal(packageJson.license, "MIT");
  assert.equal(packageJson.scripts.test, "node scripts/run-tests.mjs");
  assert.equal(packageJson.scripts.tauri, "tauri");
  assert.match(cargoToml, /license = "MIT"/);
  assert.match(cargoToml, /repository = "https:\/\/github\.com\/fengchenzxc\/Codex-Session-Manager"/);
  assert.match(read("LICENSE"), /MIT License/);
});

test("README defaults to Chinese and links to the English document", () => {
  const readme = read("README.md");
  const en = read("README.en.md");

  assert.match(readme, /\[English README\]\(README\.en\.md\)/);
  assert.match(readme, /docs\/images\/app-overview\.png/);
  assert.match(readme, /## 功能说明/);
  assert.match(readme, /## macOS 构建方法/);
  assert.match(readme, /## Windows 构建方法/);
  assert.match(en, /## Features/);
  assert.match(en, /## Build On macOS/);
  assert.match(en, /## Build On Windows/);
  assert.equal(existsSync(new URL("README.zh-CN.md", root)), false);
});

test("release workflow builds complete macOS and Windows assets", () => {
  const workflow = read(".github/workflows/release.yml");

  assert.match(workflow, /workflow_dispatch/);
  assert.match(workflow, /tags:\s*\n\s+- "v\*\.\*\.\*"/);
  assert.match(workflow, /macos-15-intel/);
  assert.match(workflow, /macos-15/);
  assert.match(workflow, /windows-2025/);
  assert.match(workflow, /tauri-apps\/tauri-action@v0/);
  assert.match(workflow, /--bundles app,dmg/);
  assert.match(workflow, /--bundles msi,nsis/);
  assert.match(workflow, /scripts\/check-version\.mjs/);
  assert.match(workflow, /GITHUB_TOKEN/);
  assert.match(workflow, /assetNamePattern/);
  assert.doesNotMatch(workflow, /releaseAssetNamePattern/);
});

test("release helpers and ignore rules keep local artifacts out of git", () => {
  const gitignore = read(".gitignore");

  assert.equal(existsSync(new URL("scripts/check-version.mjs", root)), true);
  assert.equal(existsSync(new URL("scripts/run-tests.mjs", root)), true);
  assert.match(gitignore, /node_modules\//);
  assert.match(gitignore, /dist\//);
  assert.match(gitignore, /src-tauri\/target\//);
  assert.match(gitignore, /cc-switch\//);
  assert.match(gitignore, /\.tmp\*/);
  assert.match(gitignore, /ig_\*\.png/);
});
