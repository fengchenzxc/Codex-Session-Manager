# Codex Session Manager

Codex Session Manager is a Tauri desktop app for inspecting, repairing, copying, migrating, backing up, and cleaning Codex Desktop/CLI sessions.

It is designed for people who use Codex across multiple projects or providers and need a safer way to understand why a session appears, disappears, or cannot be opened in Codex Desktop.

[中文说明](README.zh-CN.md)

![Codex Session Manager screenshot](docs/images/app-overview.png)

The screenshot above is generated from browser preview mock data. It does not contain real local sessions, paths, or provider data.

## Features

- Browse Codex sessions by project, title, provider, workspace path, and thread id.
- Render rollout JSONL as a conversation stream with user messages, assistant messages, reasoning, tool calls, tool outputs, and folded raw JSON fallback.
- Compare local sessions with the Codex App thread list and show first-page / rank information such as `first page 1/50` or `rank 64`.
- Diagnose Desktop display problems such as missing `thread_source`, broken rollout paths, missing `session_index.jsonl` entries, stale workspace hints, and recent-thread list crowding.
- Generate dry-run repair plans before writing anything.
- Clone a session to the current provider while preserving the old session and recording `cloned_from`.
- Migrate an existing session to the current provider and repair Desktop display metadata.
- Resume a session from the app with a selectable terminal target.
- Manage Codex backups and cleanup candidates.
- Delete archived rollouts under `~/.codex/archived_sessions/`.
- Delete old-provider sessions only when a new-provider clone confirms the relationship through `cloned_from`.
- Keep active rollout indexes when an archived rollout is removed but the same session id still has an active rollout.
- Export/import Codex session bundles and custom skills while excluding sensitive files by default.
- Switch UI language and choose light, dark, or system theme.

## Safety Model

The app works with Codex state files, so write operations are deliberately guarded.

- Dangerous actions start as dry-run plans.
- Applying a plan creates backups first.
- Backups include changed Desktop state, SQLite state, session indexes, and related rollout files.
- Apply is blocked while Codex App or active Codex CLI processes are running.
- The guarded apply flow can optionally close lingering Codex processes after user confirmation.
- Sensitive files are excluded from bundles by default, including `auth.json`, cookies, tokens, browser caches, crash dumps, and files that look like secrets.
- Archived cleanup only targets files under `~/.codex/archived_sessions/`.

## Data Sources

The desktop backend scans and repairs these Codex files:

- `~/.codex/state_5.sqlite`
- `~/.codex/state_5.sqlite-wal`
- `~/.codex/state_5.sqlite-shm`
- `~/.codex/session_index.jsonl`
- `~/.codex/.codex-global-state.json`
- `~/.codex/archived_sessions/`
- `~/.codex/skills/`
- `~/.codex/backups/`
- rollout paths referenced by Desktop thread rows

For Codex App visibility, the app attempts to use the official Codex App server thread list through `codex app-server --stdio`. If that server is unavailable, sessions are shown as unverified instead of guessing too broadly.

## Requirements

- Node.js 20 or newer
- npm
- Rust stable toolchain
- Codex CLI available on `PATH` for the official thread-list check
- Codex Desktop/CLI state in `~/.codex`

Tauri v2 platform requirements also apply.

## Install Dependencies

```bash
npm ci
```

Use `npm install` if you are intentionally updating dependencies.

## Run In Development

Desktop app with the Tauri backend:

```bash
npm run tauri:dev
```

Browser-only preview with mock data:

```bash
npm run dev
```

The browser preview cannot access real Tauri commands. It uses mock sessions from `src/tauri.ts`, which is useful for UI work and screenshots.

## Build On macOS

Install prerequisites:

```bash
xcode-select --install
rustup default stable
npm ci
```

Build the app:

```bash
npm run tauri:build
```

With the current Tauri config, the macOS `.app` bundle is produced at:

```text
src-tauri/target/release/bundle/macos/Codex Session Manager.app
```

If you want a `.dmg`, change `src-tauri/tauri.conf.json` bundle targets from:

```json
["app"]
```

to:

```json
["app", "dmg"]
```

Then run `npm run tauri:build` again.

## Build On Windows

Install prerequisites:

- Node.js 20+
- Rust stable from `rustup`
- Microsoft C++ Build Tools or Visual Studio 2022 with Desktop development with C++
- WebView2 Runtime
- Git for Windows, recommended

Install dependencies:

```powershell
npm ci
rustup default stable
```

For Windows installers, set `bundle.targets` in `src-tauri/tauri.conf.json` to one of:

```json
["msi"]
```

or:

```json
["nsis"]
```

Then build:

```powershell
npm run tauri:build
```

Typical Windows bundle output directories are:

```text
src-tauri\target\release\bundle\msi\
src-tauri\target\release\bundle\nsis\
```

If you only want to test the frontend on Windows, `npm run dev` is enough and uses mock data.

## Usage

1. Start Codex Session Manager.
2. Use the left sidebar to switch between Sessions, Repair, Skills, Bundle Migration, GitHub, and Backups.
3. In Sessions, choose a project in the first pane and a session in the second pane.
4. Read the detail pane for thread id, project cwd, rollout path, current provider, resume command, diagnostics, and rendered conversation content.
5. Use the status label to understand Codex App visibility:
   - `Codex App list`: returned by the Codex App thread list.
   - `Local only`: exists locally, but not in the current Codex App list.
   - `Unverified`: Codex App server thread list was unavailable.
6. Check first-page and rank metadata to understand whether a session is likely to appear in the initial Desktop sidebar list.
7. Use Copy, Migrate, or Repair actions from the diagnostics area. These actions open the operation workbench and do not write immediately.
8. Review the dry-run plan, affected sessions, backup files, warnings, and diffs.
9. Apply only after reviewing the plan and closing Codex App/CLI.
10. Use Resume session to open `codex resume <thread_id>` in the selected terminal. The app uses a temporary script in the project directory and does not request macOS Accessibility permission.

## Provider Clone And Migration

Clone to current provider:

- Keeps the original session.
- Creates a new session id and rollout copy.
- Creates a new Desktop thread row.
- Records `cloned_from` in the new provider copy.

Migrate to current provider:

- Updates the existing session provider in place.
- Updates rollout `session_meta.model_provider`.
- Runs Desktop display repair planning for the same session.

## Cleanup

Cleanup features are intentionally conservative:

- Archived rollout deletion only touches `~/.codex/archived_sessions/`.
- Old-provider cleanup only lists sessions that are confirmed by a new-provider clone's `cloned_from`.
- Legacy duplicate cleanup is planned through dry-run first.
- If the same session id still has an active rollout, the active index is preserved and Desktop thread records are pointed back to the active file.

## Backups

Write operations create backups before modifying Codex state. Backup-related UI helps inspect, manage, and plan restores.

Files commonly backed up before repair or cleanup:

- `state_5.sqlite`
- `state_5.sqlite-wal`
- `state_5.sqlite-shm`
- `.codex-global-state.json`
- `session_index.jsonl`
- affected rollout files

## Tests

```bash
npm test
```

Additional checks:

```bash
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
```

Full desktop build:

```bash
npm run tauri:build
```

## Repository Hygiene

Do not commit generated or local-only directories:

- `node_modules/`
- `dist/`
- `src-tauri/target/`
- `codex_bundles/`
- local comparison repos such as `cc-switch/`
- temporary `.tmp*` resume scripts

The included README screenshot is safe mock data. If you add more screenshots, use browser preview or fixtures rather than real Codex sessions.

## License

Choose and add a license before publishing the repository.
