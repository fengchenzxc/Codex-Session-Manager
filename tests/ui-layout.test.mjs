import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const appSource = readFileSync(new URL("../src/ui/App.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

test("session detail keeps provider actions in diagnostics instead of title header", () => {
  assert.match(appSource, /className="detailTitle"/);
  assert.match(appSource, /className="diagnosticActions"/);
  assert.match(appSource, /const hasDiagnosticIssue =/);
  assert.match(styles, /\.detailTitle[\s\S]*-webkit-line-clamp:\s*2/);
  assert.match(styles, /\.diagnosticActions/);
});

test("session detail exposes codex resume command with selectable terminal", () => {
  const tauriSource = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
  assert.match(appSource, /resumeCommand/);
  assert.match(appSource, /openResumeTerminal/);
  assert.match(appSource, /copyResumeCommand/);
  assert.match(appSource, /terminalSelect/);
  assert.match(appSource, /codex resume/);
  assert.match(appSource, /恢复会话/);
  assert.match(tauriSource, /create_resume_script/);
  assert.match(tauriSource, /\.tmp/);
  assert.doesNotMatch(tauriSource, /command=\{/);
  assert.doesNotMatch(tauriSource, /System Events|keystroke/);
});

test("repair workbench explains visibility repair in Chinese and localizes plan output", () => {
  assert.match(appSource, /repairExplanation/);
  assert.match(appSource, /修复只处理 Codex Desktop 的侧栏显示和索引状态/);
  assert.match(appSource, /translateActionLabel/);
  assert.match(appSource, /translateWarning/);
  assert.match(appSource, /把会话放回最近列表前排/);
  assert.match(appSource, /写入前需要关闭 Codex App\/CLI/);
});

test("guarded operation asks before force closing Codex processes", () => {
  const tauriSource = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
  assert.match(appSource, /forceCloseCodexConfirm/);
  assert.match(appSource, /window\.confirm/);
  assert.match(appSource, /forceCloseCodex/);
  assert.match(tauriSource, /ApplyOperationRequest/);
  assert.match(tauriSource, /close_codex_processes/);
});

test("repair workbench stages selected sessions beside operation UI", () => {
  assert.match(appSource, /repairDetailTip/);
  assert.match(appSource, /stagedSessions/);
  assert.match(appSource, /operationStage/);
  assert.match(appSource, /operationMode/);
  assert.match(styles, /\.operationStage/);
  assert.match(styles, /animation:\s*stageIn/);
});

test("diagnostic repair action stays to the right of clone and migrate actions", () => {
  assert.match(appSource, /ClipboardCopy[\s\S]*GitBranch[\s\S]*toolButton repair/);
  assert.match(styles, /\.diagnosticActions[\s\S]*flex-wrap:\s*nowrap/);
  assert.match(styles, /\.diagnosticActions[\s\S]*max-width:\s*340px/);
});

test("left sidebar exposes persistent system light dark theme switcher below language switcher", () => {
  assert.match(appSource, /type ThemeMode = "system" \| "light" \| "dark"/);
  assert.match(appSource, /codex-session-manager-theme/);
  assert.match(appSource, /data-theme=\{themeMode\}/);
  assert.match(appSource, /跟随系统/);
  assert.match(appSource, /浅色/);
  assert.match(appSource, /深色/);
  assert.match(appSource, /languageBlock[\s\S]*themeBlock/);
  assert.match(styles, /\[data-theme="dark"\]/);
  assert.match(styles, /prefers-color-scheme:\s*dark/);
  assert.match(styles, /\.themeBlock/);
});
