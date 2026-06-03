use chrono::Utc;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    env,
    fs::{self, File},
    io::{BufRead, BufReader, Read, Seek, SeekFrom, Write},
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{mpsc, Mutex},
    thread,
    time::Duration,
};
use tauri::State;
use uuid::Uuid;
use walkdir::WalkDir;

#[derive(Default)]
struct AppState {
    plans: Mutex<HashMap<String, OperationPlan>>,
}

#[derive(Debug, thiserror::Error)]
enum AppError {
    #[error("{0}")]
    Message(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

type AppResult<T> = Result<T, AppError>;

const DETAIL_MAX_MESSAGES: usize = 180;
const DETAIL_TAIL_BYTES: u64 = 2 * 1024 * 1024;
const DETAIL_MAX_TAIL_LINES: usize = 4_000;
const DETAIL_MAX_TEXT_CHARS: usize = 12_000;
const METADATA_SCAN_LINES: usize = 24;
const CODEX_APP_FIRST_PAGE_SIZE: usize = 50;
const CODEX_APP_LIST_PAGE_SIZE: usize = 100;
const CODEX_APP_LIST_MAX_THREADS: usize = 1_000;

#[derive(Debug, Deserialize)]
struct ScanConfig {
    codex_home: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
struct SessionFilter {
    query: Option<String>,
    project: Option<String>,
    include_archived: Option<bool>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SessionSummary {
    id: String,
    title: String,
    provider: String,
    source: String,
    thread_source: String,
    cwd: String,
    rollout_path: String,
    updated_at: i64,
    created_at: i64,
    archived: bool,
    tokens_used: i64,
    preview: String,
    in_session_index: bool,
    has_rollout: bool,
    visible_in_sidebar: bool,
    codex_app_status: String,
    codex_thread_status: Option<String>,
    codex_app_list_rank: Option<usize>,
    codex_app_list_scanned: usize,
    codex_app_first_page: bool,
    codex_app_first_page_size: usize,
    codex_app_first_page_position: usize,
    cloned_from: Option<String>,
    desktop_status: String,
    repair_flags: Vec<String>,
    provider_matches_current: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectSummary {
    path: String,
    session_count: usize,
    visible_count: usize,
    codex_app_rank_min: Option<usize>,
    codex_app_rank_max: Option<usize>,
    codex_app_first_page_count: usize,
    codex_app_first_page_size: usize,
    latest_updated_at: i64,
    pinned: bool,
    active: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CodexInventory {
    codex_home: String,
    desktop_db_path: String,
    session_index_path: String,
    global_state_path: String,
    total_sessions: usize,
    archived_sessions: usize,
    visible_sessions: usize,
    projects: Vec<ProjectSummary>,
    sessions: Vec<SessionSummary>,
    archived_rollouts: Vec<String>,
    warnings: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionDetail {
    session: SessionSummary,
    global_state: GlobalStateView,
    diagnostics: Vec<Diagnostic>,
    messages: Vec<ConversationItem>,
    rollout_preview: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConversationItem {
    id: String,
    kind: String,
    role: String,
    text: String,
    tool_name: Option<String>,
    call_id: Option<String>,
    timestamp: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GlobalStateView {
    active_workspaces: Vec<String>,
    saved_workspaces: Vec<String>,
    project_order: Vec<String>,
    pinned_thread_ids: Vec<String>,
    projectless_thread_ids: Vec<String>,
    heartbeat_thread_ids: Vec<String>,
    collapsed_groups: BTreeMap<String, Value>,
    collapsed_sections: BTreeMap<String, Value>,
    thread_workspace_hint: Option<String>,
}

#[derive(Debug, Serialize)]
struct Diagnostic {
    level: String,
    label: String,
    value: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct OperationAction {
    kind: String,
    label: String,
    target: String,
    value: Option<String>,
    dangerous: bool,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct OperationPlan {
    id: String,
    title: String,
    dry_run: bool,
    requires_codex_closed: bool,
    backup_required: bool,
    scope: Option<String>,
    affected_sessions: Vec<String>,
    backup_files: Vec<String>,
    dry_run_diffs: Vec<String>,
    actions: Vec<OperationAction>,
    warnings: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OperationResult {
    ok: bool,
    message: String,
    backup_path: Option<String>,
    changed_files: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SkillSummary {
    name: String,
    path: String,
    kind: String,
    has_skill_md: bool,
    is_symlink: bool,
    size_bytes: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BackupSummary {
    name: String,
    path: String,
    created_at: i64,
    files: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GitStatus {
    repo_path: String,
    exists: bool,
    branch: String,
    dirty: bool,
    ahead: i64,
    behind: i64,
    summary: Vec<String>,
    remote_updated_at: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BundleResult {
    path: String,
    manifest_path: String,
    included_sessions: usize,
    included_skills: usize,
    warnings: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct RepairRequest {
    id: String,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct DesktopRepairRequest {
    id: Option<String>,
    include_archived: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderRequest {
    id: String,
    provider: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResumeTerminalRequest {
    id: String,
    terminal: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct CleanupRequest {
    kind: String,
    include_archived: Option<bool>,
    ids: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApplyOperationRequest {
    plan_id: String,
    force_close_codex: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CleanupCandidate {
    id: String,
    title: String,
    provider: String,
    rollout_path: String,
    archived: bool,
    reason: String,
    replacement_id: Option<String>,
}

#[derive(Debug, Default, Clone)]
struct RolloutMetadata {
    cloned_from: Option<String>,
    cwd: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BundleRequest {
    session_ids: Option<Vec<String>>,
    include_sensitive: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct RestoreRequest {
    path: String,
}

#[derive(Debug, Deserialize)]
struct ImportRequest {
    path: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SkillExportRequest {
    kinds: Option<Vec<String>>,
}

fn codex_home(config: Option<&ScanConfig>) -> AppResult<PathBuf> {
    if let Some(path) = config.and_then(|item| item.codex_home.clone()) {
        return Ok(expand_tilde(path));
    }
    let home = dirs::home_dir().ok_or_else(|| AppError::Message("Unable to resolve home directory".into()))?;
    Ok(home.join(".codex"))
}

fn expand_tilde(path: String) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    PathBuf::from(path)
}

fn read_json(path: &Path) -> AppResult<Value> {
    if !path.exists() {
        return Ok(Value::Object(Map::new()));
    }
    Ok(serde_json::from_str(&fs::read_to_string(path)?)?)
}

fn persisted_state_mut(value: &mut Value) -> &mut Map<String, Value> {
    if !value.is_object() {
        *value = Value::Object(Map::new());
    }
    let root = value.as_object_mut().expect("object initialized");
    let entry = root
        .entry("electron-persisted-atom-state")
        .or_insert_with(|| Value::Object(Map::new()));
    if !entry.is_object() {
        *entry = Value::Object(Map::new());
    }
    entry.as_object_mut().expect("persisted object initialized")
}

fn array_strings(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(ToOwned::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn object_string_map(value: Option<&Value>) -> HashMap<String, String> {
    value
        .and_then(Value::as_object)
        .map(|map| {
            map.iter()
                .filter_map(|(key, value)| value.as_str().map(|v| (key.clone(), v.to_owned())))
                .collect()
        })
        .unwrap_or_default()
}

fn object_value_map(value: Option<&Value>) -> BTreeMap<String, Value> {
    value
        .and_then(Value::as_object)
        .map(|map| map.iter().map(|(key, value)| (key.clone(), value.clone())).collect())
        .unwrap_or_default()
}

fn object_keys(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_object)
        .map(|map| map.keys().cloned().collect())
        .unwrap_or_default()
}

fn global_view(global: &Value, thread_id: Option<&str>) -> GlobalStateView {
    let persisted = global
        .get("electron-persisted-atom-state")
        .and_then(Value::as_object);
    let pick = |key: &str| -> Option<&Value> {
        global.get(key).or_else(|| persisted.and_then(|map| map.get(key)))
    };
    let hints = object_string_map(pick("thread-workspace-root-hints"));
    GlobalStateView {
        active_workspaces: array_strings(pick("active-workspace-roots")),
        saved_workspaces: array_strings(pick("electron-saved-workspace-roots")),
        project_order: array_strings(pick("project-order")),
        pinned_thread_ids: array_strings(pick("pinned-thread-ids")),
        projectless_thread_ids: array_strings(pick("projectless-thread-ids")),
        heartbeat_thread_ids: object_keys(pick("heartbeat-thread-permissions-by-id")),
        collapsed_groups: object_value_map(pick("sidebar-collapsed-groups")),
        collapsed_sections: object_value_map(pick("sidebar-collapsed-sections-v1")),
        thread_workspace_hint: thread_id.and_then(|id| hints.get(id).cloned()),
    }
}

fn current_provider(codex: &Path) -> String {
    fs::read_to_string(codex.join("config.toml"))
        .ok()
        .and_then(|content| {
            content.lines().find_map(|line| {
                let trimmed = line.trim();
                trimmed
                    .strip_prefix("model_provider")
                    .and_then(|rest| rest.split_once('='))
                    .map(|(_, value)| value.trim().trim_matches('"').to_string())
            })
        })
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "codex".into())
}

fn url_encode_query_value(value: &str) -> String {
    value
        .as_bytes()
        .iter()
        .map(|byte| match *byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                (*byte as char).to_string()
            }
            _ => format!("%{:02X}", byte),
        })
        .collect()
}

fn shell_quote(value: &str) -> String {
    if value.is_empty() {
        return "''".into();
    }
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn run_checked(mut command: Command, label: &str) -> AppResult<()> {
    let output = command.output()?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let message = if stderr.is_empty() { stdout } else { stderr };
    Err(AppError::Message(format!("{} failed: {}", label, message)))
}

fn create_resume_script(cwd: &Path, session_id: &str) -> AppResult<PathBuf> {
    let script_name = format!(".tmp{}", Uuid::new_v4().simple().to_string().chars().take(6).collect::<String>());
    let script_path = cwd.join(script_name);
    let script = format!(
        r#"#!/bin/zsh
set +e
cd {cwd}
codex resume {session_id}
status=$?
rm -f "$0"
if [ "$status" -ne 0 ]; then
  echo ""
  echo "codex resume exited with status $status"
  echo "Press Enter to close this window..."
  read _unused
fi
exit "$status"
"#,
        cwd = shell_quote(&cwd.to_string_lossy()),
        session_id = shell_quote(session_id)
    );
    fs::write(&script_path, script)?;
    let mut permissions = fs::metadata(&script_path)?.permissions();
    permissions.set_mode(0o700);
    fs::set_permissions(&script_path, permissions)?;
    Ok(script_path)
}

fn open_resume_in_terminal(terminal: &str, script_path: &Path) -> AppResult<String> {
    let script_string = script_path.to_string_lossy();
    match terminal.to_lowercase().as_str() {
        "warp" => {
            let mut open_command = Command::new("open");
            open_command.arg("-a").arg("Warp");
            open_command.arg(format!("warp://action/new_tab?path={}", url_encode_query_value(&script_string)));
            run_checked(open_command, "open Warp")?;
            Ok("Warp".into())
        }
        "iterm" | "iterm2" => {
            let mut open_command = Command::new("open");
            open_command.arg("-a").arg("iTerm").arg(script_path.as_os_str());
            run_checked(open_command, "open iTerm2")?;
            Ok("iTerm2".into())
        }
        _ => {
            let mut open_command = Command::new("open");
            open_command.arg("-a").arg("Terminal").arg(script_path.as_os_str());
            run_checked(open_command, "open Terminal")?;
            Ok("Terminal".into())
        }
    }
}

fn read_rollout_metadata(path: &str) -> RolloutMetadata {
    if path.is_empty() {
        return RolloutMetadata::default();
    }
    let Ok(file) = File::open(path) else {
        return RolloutMetadata::default();
    };
    for line in BufReader::new(file).lines().take(METADATA_SCAN_LINES).flatten().filter(|line| !line.trim().is_empty()) {
        let Ok(row) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let payload = row.get("payload").unwrap_or(&row);
        if row.get("type").and_then(Value::as_str) == Some("session_meta")
            || payload.get("type").and_then(Value::as_str) == Some("session_meta")
        {
            return RolloutMetadata {
                cloned_from: payload
                    .get("cloned_from")
                    .or_else(|| payload.get("clonedFrom"))
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned),
                cwd: payload
                    .get("cwd")
                    .or_else(|| payload.get("working_directory"))
                    .or_else(|| payload.get("workdir"))
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned),
            };
        }
    }
    RolloutMetadata::default()
}

fn parse_rollout_messages(path: &str) -> Vec<ConversationItem> {
    if path.is_empty() {
        return Vec::new();
    }
    let Ok(lines) = tail_rollout_lines(path, DETAIL_TAIL_BYTES, DETAIL_MAX_TAIL_LINES) else {
        return Vec::new();
    };
    let mut messages: Vec<ConversationItem> = lines
        .iter()
        .enumerate()
        .filter_map(|(index, line)| {
            if line.trim().is_empty() {
                return None;
            }
            let row = serde_json::from_str::<Value>(line).ok()?;
            normalize_rollout_row(&row, index)
        })
        .collect();
    if messages.len() > DETAIL_MAX_MESSAGES {
        messages = messages.split_off(messages.len() - DETAIL_MAX_MESSAGES);
    }
    for message in &mut messages {
        message.text = truncate_text(&message.text, DETAIL_MAX_TEXT_CHARS);
    }
    messages
}

fn tail_rollout_lines(path: &str, max_bytes: u64, max_lines: usize) -> AppResult<Vec<String>> {
    let mut file = File::open(path)?;
    let len = file.metadata()?.len();
    let start = len.saturating_sub(max_bytes);
    file.seek(SeekFrom::Start(start))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    let mut content = String::from_utf8_lossy(&bytes).into_owned();
    if start > 0 {
        if let Some((_, rest)) = content.split_once('\n') {
            content = rest.to_string();
        }
    }
    let mut lines: Vec<String> = content.lines().map(ToOwned::to_owned).collect();
    if lines.len() > max_lines {
        lines = lines.split_off(lines.len() - max_lines);
    }
    Ok(lines)
}

fn normalize_rollout_row(row: &Value, index: usize) -> Option<ConversationItem> {
    let payload = row.get("payload").unwrap_or(row);
    if row.get("type").and_then(Value::as_str) == Some("session_meta")
        || payload.get("type").and_then(Value::as_str) == Some("session_meta")
    {
        return None;
    }
    let payload_type = payload.get("type").and_then(Value::as_str).unwrap_or("");
    let timestamp = row
        .get("timestamp")
        .or_else(|| payload.get("timestamp"))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);

    if payload_type == "message" || payload.get("role").is_some() {
        let text = content_text(payload.get("content"));
        if text.is_empty() {
            return None;
        }
        return Some(conversation_item(
            index,
            "message",
            payload.get("role").and_then(Value::as_str).unwrap_or("unknown"),
            text,
            None,
            None,
            timestamp,
        ));
    }
    if payload_type == "reasoning" {
        let text = content_text(payload.get("summary").or_else(|| payload.get("content")).or_else(|| payload.get("text")));
        if text.is_empty() {
            return None;
        }
        return Some(conversation_item(index, "reasoning", "assistant", text, None, None, timestamp));
    }
    if payload_type == "function_call" || payload_type == "tool_call" {
        let name = payload.get("name").and_then(Value::as_str).unwrap_or("").to_string();
        let args = payload
            .get("arguments")
            .map(|value| value.as_str().map(ToOwned::to_owned).unwrap_or_else(|| value.to_string()))
            .unwrap_or_default();
        return Some(conversation_item(
            index,
            "tool_call",
            "tool",
            [name.as_str(), args.as_str()].into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join("\n"),
            Some(name),
            payload.get("call_id").or_else(|| payload.get("id")).and_then(Value::as_str).map(ToOwned::to_owned),
            timestamp,
        ));
    }
    if payload_type == "function_call_output" || payload_type == "tool_output" {
        return Some(conversation_item(
            index,
            "tool_output",
            "tool",
            content_text(payload.get("output").or_else(|| payload.get("content"))),
            None,
            payload.get("call_id").or_else(|| payload.get("id")).and_then(Value::as_str).map(ToOwned::to_owned),
            timestamp,
        ));
    }
    if row.get("type").and_then(Value::as_str) == Some("event_msg") {
        if let Some(message) = payload.get("message").and_then(Value::as_str) {
            return Some(conversation_item(index, "event", "system", message.to_string(), None, None, timestamp));
        }
    }
    Some(conversation_item(index, "raw", "system", row.to_string(), None, None, timestamp))
}

fn content_text(value: Option<&Value>) -> String {
    let Some(value) = value else {
        return String::new();
    };
    if let Some(text) = value.as_str() {
        return text.to_string();
    }
    if let Some(array) = value.as_array() {
        return array
            .iter()
            .filter_map(|item| {
                item.as_str().map(ToOwned::to_owned).or_else(|| {
                    item.get("text")
                        .or_else(|| item.get("content"))
                        .or_else(|| item.get("summary"))
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned)
                })
            })
            .collect::<Vec<_>>()
            .join("\n");
    }
    value
        .get("text")
        .or_else(|| value.get("content"))
        .or_else(|| value.get("summary"))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| value.to_string())
}

fn truncate_text(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let truncated = text.chars().take(max_chars).collect::<String>();
    format!("{}\n...[truncated {} chars]", truncated, text.chars().count().saturating_sub(max_chars))
}

fn conversation_item(
    index: usize,
    kind: &str,
    role: &str,
    text: String,
    tool_name: Option<String>,
    call_id: Option<String>,
    timestamp: Option<String>,
) -> ConversationItem {
    ConversationItem {
        id: index.to_string(),
        kind: kind.into(),
        role: role.into(),
        text,
        tool_name,
        call_id,
        timestamp,
    }
}

fn is_internal_session(source: &str, thread_source: &str, title: &str) -> bool {
    let source = source.to_lowercase();
    let thread_source = thread_source.to_lowercase();
    thread_source == "subagent"
        || source.contains("\"subagent\"")
        || title.starts_with("The following is the Codex agent history whose request action you are assessing.")
}

fn is_desktop_visible(session: &SessionSummary, global: &GlobalStateView) -> bool {
    if is_internal_session(&session.source, &session.thread_source, &session.title)
        || session.archived
        || !session.has_rollout
        || session.id.is_empty()
    {
        return false;
    }
    if global.projectless_thread_ids.contains(&session.id) {
        return false;
    }
    global.heartbeat_thread_ids.contains(&session.id)
}

fn codex_app_status_value(session: &SessionSummary) -> String {
    match session.codex_app_status.as_str() {
        "listed" => {
            let rank = session
                .codex_app_list_rank
                .map(|value| value.to_string())
                .unwrap_or_else(|| "?".into());
            let first_page = if session.codex_app_first_page {
                format!(
                    "first page {}/{}",
                    session.codex_app_first_page_position, session.codex_app_first_page_size
                )
            } else {
                format!("first page 0/{}", session.codex_app_first_page_size)
            };
            format!(
                "listed, {}, rank {}, scanned {}",
                first_page, rank, session.codex_app_list_scanned
            )
        }
        "local_only" => format!(
            "local only, not in thread/list, first page 0/{}, scanned {}",
            session.codex_app_first_page_size, session.codex_app_list_scanned
        ),
        _ => "unverified, app-server thread/list unavailable".into(),
    }
}

fn parse_session_index(path: &Path) -> AppResult<HashSet<String>> {
    if !path.exists() {
        return Ok(HashSet::new());
    }
    let mut ids = HashSet::new();
    for line in fs::read_to_string(path)?.lines() {
        if let Ok(value) = serde_json::from_str::<Value>(line) {
            if let Some(id) = value.get("id").and_then(Value::as_str) {
                ids.insert(id.to_owned());
            }
        }
    }
    Ok(ids)
}

#[derive(Debug, Clone)]
struct CodexAppThreadInfo {
    rank: usize,
    status: Option<String>,
}

#[derive(Debug, Default)]
struct CodexAppListSnapshot {
    available: bool,
    scanned: usize,
    first_page_size: usize,
    threads: HashMap<String, CodexAppThreadInfo>,
    warning: Option<String>,
}

fn app_server_response(
    rx: &mpsc::Receiver<String>,
    id: i64,
    timeout: Duration,
) -> AppResult<Value> {
    loop {
        let line = rx
            .recv_timeout(timeout)
            .map_err(|_| AppError::Message(format!("Timed out waiting for app-server response {}", id)))?;
        let value: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(_) => continue,
        };
        if value.get("id").and_then(Value::as_i64) != Some(id) {
            continue;
        }
        if let Some(error) = value.get("error") {
            return Err(AppError::Message(format!("app-server error: {}", error)));
        }
        return Ok(value.get("result").cloned().unwrap_or(Value::Null));
    }
}

fn status_type(value: &Value) -> Option<String> {
    value
        .get("type")
        .and_then(Value::as_str)
        .or_else(|| value.as_str())
        .map(str::to_owned)
}

fn augmented_path() -> String {
    let current = env::var("PATH").unwrap_or_default();
    let additions = [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
    ];
    let mut parts: Vec<String> = additions.iter().map(|value| value.to_string()).collect();
    parts.extend(current.split(':').filter(|value| !value.is_empty()).map(str::to_owned));
    parts.dedup();
    parts.join(":")
}

fn codex_cli_path() -> PathBuf {
    if let Ok(path) = env::var("CODEX_CLI") {
        let candidate = PathBuf::from(path);
        if candidate.exists() {
            return candidate;
        }
    }
    for candidate in [
        "/opt/homebrew/bin/codex",
        "/usr/local/bin/codex",
        "/usr/bin/codex",
    ] {
        let path = PathBuf::from(candidate);
        if path.exists() {
            return path;
        }
    }
    PathBuf::from("codex")
}

fn query_codex_app_thread_list() -> CodexAppListSnapshot {
    let mut snapshot = CodexAppListSnapshot {
        first_page_size: CODEX_APP_FIRST_PAGE_SIZE,
        ..Default::default()
    };
    let result = (|| -> AppResult<CodexAppListSnapshot> {
        let mut child = Command::new(codex_cli_path())
            .args(["app-server", "--stdio"])
            .env("PATH", augmented_path())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;
        if let Some(stderr) = child.stderr.take() {
            thread::spawn(move || {
                let mut reader = BufReader::new(stderr);
                let mut sink = String::new();
                let _ = reader.read_to_string(&mut sink);
            });
        }
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| AppError::Message("app-server stdout unavailable".into()))?;
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| AppError::Message("app-server stdin unavailable".into()))?;
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) {
                let _ = tx.send(line);
            }
        });

        writeln!(
            stdin,
            "{}",
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "clientInfo": { "name": "codex-session-manager", "version": env!("CARGO_PKG_VERSION") },
                    "capabilities": { "experimentalApi": true }
                }
            })
        )?;
        stdin.flush()?;
        let _ = app_server_response(&rx, 1, Duration::from_secs(5))?;

        let mut threads = HashMap::new();
        let mut cursor: Option<String> = None;
        let mut rank = 0usize;
        let mut request_id = 2i64;
        loop {
            let limit = if cursor.is_none() {
                CODEX_APP_FIRST_PAGE_SIZE
            } else {
                CODEX_APP_LIST_PAGE_SIZE
            };
            let mut params = Map::new();
            params.insert("limit".into(), json!(limit));
            params.insert("archived".into(), json!(false));
            params.insert("sortKey".into(), json!("updated_at"));
            params.insert("sortDirection".into(), json!("desc"));
            if let Some(cursor_value) = cursor.clone() {
                params.insert("cursor".into(), json!(cursor_value));
            }
            writeln!(
                stdin,
                "{}",
                json!({
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "method": "thread/list",
                    "params": Value::Object(params)
                })
            )?;
            stdin.flush()?;
            let response = app_server_response(&rx, request_id, Duration::from_secs(8))?;
            request_id += 1;
            if let Some(data) = response.get("data").and_then(Value::as_array) {
                for item in data {
                    if let Some(id) = item.get("id").and_then(Value::as_str) {
                        rank += 1;
                        threads.entry(id.to_owned()).or_insert_with(|| CodexAppThreadInfo {
                            rank,
                            status: item.get("status").and_then(status_type),
                        });
                    }
                }
            }
            cursor = response.get("nextCursor").and_then(Value::as_str).map(str::to_owned);
            if cursor.is_none() || rank >= CODEX_APP_LIST_MAX_THREADS {
                break;
            }
        }
        let _ = child.kill();
        let _ = child.wait();
        Ok(CodexAppListSnapshot {
            available: true,
            scanned: rank,
            first_page_size: CODEX_APP_FIRST_PAGE_SIZE,
            threads,
            warning: None,
        })
    })();

    match result {
        Ok(snapshot) => snapshot,
        Err(error) => {
            snapshot.warning = Some(format!("Codex app-server thread/list unavailable: {}", error));
            snapshot
        }
    }
}

fn apply_codex_app_list_snapshot(sessions: &mut [SessionSummary], snapshot: &CodexAppListSnapshot) {
    for session in sessions {
        let info = snapshot.threads.get(&session.id);
        session.codex_app_list_scanned = if snapshot.available { snapshot.scanned } else { 0 };
        session.codex_app_first_page_size = snapshot.first_page_size;
        session.codex_app_status = if !snapshot.available {
            "unverified".into()
        } else if info.is_some() {
            "listed".into()
        } else {
            "local_only".into()
        };
        session.codex_thread_status = info.and_then(|item| item.status.clone());
        session.codex_app_list_rank = info.map(|item| item.rank);
        session.codex_app_first_page = info
            .map(|item| item.rank <= snapshot.first_page_size)
            .unwrap_or(false);
        session.codex_app_first_page_position = if session.codex_app_first_page {
            session.codex_app_list_rank.unwrap_or_default()
        } else {
            0
        };
        session.visible_in_sidebar = session.codex_app_status == "listed";
        session.desktop_status = session.codex_app_status.clone();
        if session.codex_app_status == "local_only" {
            session.repair_flags.push("not_in_codex_app_thread_list".into());
        }
        if session.codex_app_status == "unverified" {
            session.repair_flags.push("codex_app_list_unverified".into());
        }
    }
}

fn scan_sessions(codex_home: &Path) -> AppResult<Vec<SessionSummary>> {
    let db_path = codex_home.join("state_5.sqlite");
    let index_ids = parse_session_index(&codex_home.join("session_index.jsonl"))?;
    let global = read_json(&codex_home.join(".codex-global-state.json"))?;
    let global_view = global_view(&global, None);
    let provider = current_provider(codex_home);
    let hints = object_string_map(
        global
            .get("electron-persisted-atom-state")
            .and_then(|v| v.get("thread-workspace-root-hints"))
            .or_else(|| global.get("thread-workspace-root-hints")),
    );

    let mut sessions = Vec::new();
    if db_path.exists() {
        let conn = Connection::open(&db_path)?;
        let mut stmt = conn.prepare(
            "SELECT id, title, model_provider, source, cwd, rollout_path, updated_at, created_at,
             archived, tokens_used, preview, updated_at_ms, created_at_ms, COALESCE(thread_source, '')
             FROM threads ORDER BY COALESCE(updated_at_ms, updated_at * 1000) DESC",
        )?;
        let rows = stmt.query_map([], |row| {
            let id: String = row.get(0)?;
            let title: String = row.get(1)?;
            let row_provider: String = row.get(2)?;
            let source: String = row.get(3)?;
            let row_cwd: String = row.get(4)?;
            let rollout_path: String = row.get(5)?;
            let updated_at: i64 = row.get::<_, Option<i64>>(11)?.unwrap_or(row.get::<_, i64>(6)? * 1000);
            let created_at: i64 = row.get::<_, Option<i64>>(12)?.unwrap_or(row.get::<_, i64>(7)? * 1000);
            let thread_source: String = row.get(13)?;
            if is_internal_session(&source, &thread_source, &title) {
                return Ok(None);
            }
            let metadata = read_rollout_metadata(&rollout_path);
            let cwd = if row_cwd.is_empty() {
                metadata
                    .cwd
                    .clone()
                    .or_else(|| hints.get(&id).cloned())
                    .unwrap_or_default()
            } else {
                row_cwd
            };
            let has_rollout = !rollout_path.is_empty() && Path::new(&rollout_path).exists();
            let in_session_index = index_ids.contains(&id);
            let mut repair_flags = Vec::new();
            if thread_source.is_empty() {
                repair_flags.push("thread_source_empty".into());
            }
            if !in_session_index && row.get::<_, i64>(8)? == 0 {
                repair_flags.push("missing_session_index".into());
            }
            if !has_rollout {
                repair_flags.push("missing_rollout".into());
            }
            if hints.get(&id).map(|hint| hint != &cwd).unwrap_or(false) {
                repair_flags.push("conflicting_workspace_hint".into());
            }
            if global_view.projectless_thread_ids.contains(&id) && !cwd.is_empty() {
                repair_flags.push("projectless_filter".into());
            }
            if global_view.collapsed_groups.contains_key(&cwd)
                || global_view.collapsed_sections.contains_key("projects")
                || global_view.collapsed_sections.contains_key("sessions")
            {
                repair_flags.push("sidebar_collapsed_state".into());
            }
            let mut session = SessionSummary {
                id: id.clone(),
                title,
                provider: row_provider.clone(),
                source,
                thread_source,
                cwd,
                rollout_path,
                updated_at,
                created_at,
                archived: row.get::<_, i64>(8)? != 0,
                tokens_used: row.get::<_, i64>(9)?,
                preview: row.get::<_, String>(10)?,
                in_session_index,
                has_rollout,
                visible_in_sidebar: false,
                codex_app_status: "unverified".into(),
                codex_thread_status: None,
                codex_app_list_rank: None,
                codex_app_list_scanned: 0,
                codex_app_first_page: false,
                codex_app_first_page_size: CODEX_APP_FIRST_PAGE_SIZE,
                codex_app_first_page_position: 0,
                cloned_from: metadata.cloned_from,
                desktop_status: String::new(),
                repair_flags,
                provider_matches_current: row_provider == provider,
            };
            let visible = is_desktop_visible(&session, &global_view);
            session.visible_in_sidebar = visible;
            session.desktop_status = if visible {
                "visible".into()
            } else if session.has_rollout {
                "repairable".into()
            } else {
                "broken".into()
            };
            Ok(Some(session))
        })?;
        for row in rows {
            if let Some(session) = row? {
                sessions.push(session);
            }
        }
    }
    let snapshot = query_codex_app_thread_list();
    apply_codex_app_list_snapshot(&mut sessions, &snapshot);
    Ok(sessions)
}

fn scan_sessions_with_app_warning(codex_home: &Path) -> AppResult<(Vec<SessionSummary>, Option<String>)> {
    let db_path = codex_home.join("state_5.sqlite");
    let index_ids = parse_session_index(&codex_home.join("session_index.jsonl"))?;
    let global = read_json(&codex_home.join(".codex-global-state.json"))?;
    let global_view = global_view(&global, None);
    let provider = current_provider(codex_home);
    let hints = object_string_map(
        global
            .get("electron-persisted-atom-state")
            .and_then(|v| v.get("thread-workspace-root-hints"))
            .or_else(|| global.get("thread-workspace-root-hints")),
    );

    let mut sessions = Vec::new();
    if db_path.exists() {
        let conn = Connection::open(&db_path)?;
        let mut stmt = conn.prepare(
            "SELECT id, title, model_provider, source, cwd, rollout_path, updated_at, created_at,
             archived, tokens_used, preview, updated_at_ms, created_at_ms, COALESCE(thread_source, '')
             FROM threads ORDER BY COALESCE(updated_at_ms, updated_at * 1000) DESC",
        )?;
        let rows = stmt.query_map([], |row| {
            let id: String = row.get(0)?;
            let title: String = row.get(1)?;
            let row_provider: String = row.get(2)?;
            let source: String = row.get(3)?;
            let row_cwd: String = row.get(4)?;
            let rollout_path: String = row.get(5)?;
            let updated_at: i64 = row.get::<_, Option<i64>>(11)?.unwrap_or(row.get::<_, i64>(6)? * 1000);
            let created_at: i64 = row.get::<_, Option<i64>>(12)?.unwrap_or(row.get::<_, i64>(7)? * 1000);
            let thread_source: String = row.get(13)?;
            if is_internal_session(&source, &thread_source, &title) {
                return Ok(None);
            }
            let metadata = read_rollout_metadata(&rollout_path);
            let cwd = if row_cwd.is_empty() {
                metadata
                    .cwd
                    .clone()
                    .or_else(|| hints.get(&id).cloned())
                    .unwrap_or_default()
            } else {
                row_cwd
            };
            let has_rollout = !rollout_path.is_empty() && Path::new(&rollout_path).exists();
            let in_session_index = index_ids.contains(&id);
            let mut repair_flags = Vec::new();
            if thread_source.is_empty() {
                repair_flags.push("thread_source_empty".into());
            }
            if !in_session_index && row.get::<_, i64>(8)? == 0 {
                repair_flags.push("missing_session_index".into());
            }
            if !has_rollout {
                repair_flags.push("missing_rollout".into());
            }
            if hints.get(&id).map(|hint| hint != &cwd).unwrap_or(false) {
                repair_flags.push("conflicting_workspace_hint".into());
            }
            if global_view.projectless_thread_ids.contains(&id) && !cwd.is_empty() {
                repair_flags.push("projectless_filter".into());
            }
            if global_view.collapsed_groups.contains_key(&cwd)
                || global_view.collapsed_sections.contains_key("projects")
                || global_view.collapsed_sections.contains_key("sessions")
            {
                repair_flags.push("sidebar_collapsed_state".into());
            }
            Ok(Some(SessionSummary {
                id,
                title,
                provider: row_provider.clone(),
                source,
                thread_source,
                cwd,
                rollout_path,
                updated_at,
                created_at,
                archived: row.get::<_, i64>(8)? != 0,
                tokens_used: row.get::<_, i64>(9)?,
                preview: row.get::<_, String>(10)?,
                in_session_index,
                has_rollout,
                visible_in_sidebar: false,
                codex_app_status: "unverified".into(),
                codex_thread_status: None,
                codex_app_list_rank: None,
                codex_app_list_scanned: 0,
                codex_app_first_page: false,
                codex_app_first_page_size: CODEX_APP_FIRST_PAGE_SIZE,
                codex_app_first_page_position: 0,
                cloned_from: metadata.cloned_from,
                desktop_status: "unverified".into(),
                repair_flags,
                provider_matches_current: row_provider == provider,
            }))
        })?;
        for row in rows {
            if let Some(session) = row? {
                sessions.push(session);
            }
        }
    }
    let snapshot = query_codex_app_thread_list();
    let warning = snapshot.warning.clone();
    apply_codex_app_list_snapshot(&mut sessions, &snapshot);
    Ok((sessions, warning))
}

fn archived_rollouts(codex_home: &Path) -> Vec<String> {
    let dir = codex_home.join("archived_sessions");
    fs::read_dir(dir)
        .ok()
        .into_iter()
        .flat_map(|entries| entries.flatten())
        .filter_map(|entry| entry.path().to_str().map(ToOwned::to_owned))
        .collect()
}

fn build_projects(sessions: &[SessionSummary], global: &GlobalStateView) -> Vec<ProjectSummary> {
    let mut map: BTreeMap<String, ProjectSummary> = BTreeMap::new();
    for session in sessions {
        let entry = map.entry(session.cwd.clone()).or_insert_with(|| ProjectSummary {
            path: session.cwd.clone(),
            session_count: 0,
            visible_count: 0,
            codex_app_rank_min: None,
            codex_app_rank_max: None,
            codex_app_first_page_count: 0,
            codex_app_first_page_size: CODEX_APP_FIRST_PAGE_SIZE,
            latest_updated_at: 0,
            pinned: false,
            active: false,
        });
        entry.session_count += 1;
        if session.visible_in_sidebar {
            entry.visible_count += 1;
        }
        if let Some(rank) = session.codex_app_list_rank {
            entry.codex_app_rank_min = Some(entry.codex_app_rank_min.map(|value| value.min(rank)).unwrap_or(rank));
            entry.codex_app_rank_max = Some(entry.codex_app_rank_max.map(|value| value.max(rank)).unwrap_or(rank));
        }
        if session.codex_app_first_page {
            entry.codex_app_first_page_count += 1;
        }
        entry.codex_app_first_page_size = session.codex_app_first_page_size;
        entry.latest_updated_at = entry.latest_updated_at.max(session.updated_at);
    }
    for item in map.values_mut() {
        item.pinned = global.pinned_thread_ids.iter().any(|id| {
            sessions
                .iter()
                .any(|session| &session.id == id && session.cwd == item.path)
        });
        item.active = global.active_workspaces.first().map(|path| path == &item.path).unwrap_or(false);
    }
    let mut projects: Vec<_> = map.into_values().collect();
    projects.sort_by_key(|item| -item.latest_updated_at);
    projects
}

#[tauri::command]
fn scan_codex_state(config: ScanConfig) -> Result<CodexInventory, String> {
    (|| -> AppResult<CodexInventory> {
        let codex = codex_home(Some(&config))?;
        let (sessions, app_warning) = scan_sessions_with_app_warning(&codex)?;
        let global_path = codex.join(".codex-global-state.json");
        let global = read_json(&global_path)?;
        let global_view = global_view(&global, None);
        let projects = build_projects(&sessions, &global_view);
        let mut warnings: Vec<String> = [
            ("state_5.sqlite", codex.join("state_5.sqlite")),
            ("session_index.jsonl", codex.join("session_index.jsonl")),
            (".codex-global-state.json", global_path.clone()),
        ]
        .into_iter()
        .filter_map(|(label, path)| (!path.exists()).then(|| format!("Missing {}", label)))
        .collect();
        if let Some(warning) = app_warning {
            warnings.push(warning);
        }
        Ok(CodexInventory {
            codex_home: codex.to_string_lossy().to_string(),
            desktop_db_path: codex.join("state_5.sqlite").to_string_lossy().to_string(),
            session_index_path: codex.join("session_index.jsonl").to_string_lossy().to_string(),
            global_state_path: global_path.to_string_lossy().to_string(),
            total_sessions: sessions.len(),
            archived_sessions: sessions.iter().filter(|session| session.archived).count(),
            visible_sessions: sessions.iter().filter(|session| session.visible_in_sidebar).count(),
            projects,
            sessions,
            archived_rollouts: archived_rollouts(&codex),
            warnings,
        })
    })()
    .map_err(|error| error.to_string())
}

#[tauri::command]
fn query_sessions(filter: SessionFilter) -> Result<Vec<SessionSummary>, String> {
    (|| -> AppResult<Vec<SessionSummary>> {
        let codex = codex_home(None)?;
        let mut sessions = scan_sessions(&codex)?;
        if !filter.include_archived.unwrap_or(false) {
            sessions.retain(|session| !session.archived);
        }
        if let Some(project) = filter.project {
            if project != "all" {
                sessions.retain(|session| session.cwd == project);
            }
        }
        if let Some(query) = filter.query {
            let needle = query.to_lowercase();
            sessions.retain(|session| {
                format!(
                    "{} {} {} {} {}",
                    session.title, session.id, session.cwd, session.provider, session.preview
                )
                .to_lowercase()
                .contains(&needle)
            });
        }
        Ok(sessions)
    })()
    .map_err(|error| error.to_string())
}

#[tauri::command]
fn get_session_detail(id: String) -> Result<SessionDetail, String> {
    (|| -> AppResult<SessionDetail> {
        let codex = codex_home(None)?;
        let session = scan_sessions(&codex)?
            .into_iter()
            .find(|session| session.id == id)
            .ok_or_else(|| AppError::Message(format!("Session not found: {}", id)))?;
        let global = read_json(&codex.join(".codex-global-state.json"))?;
        let global_state = global_view(&global, Some(&session.id));
        let mut diagnostics = Vec::new();
        diagnostics.push(Diagnostic {
            level: if session.in_session_index { "ok" } else { "warn" }.into(),
            label: "session_index.jsonl".into(),
            value: if session.in_session_index { "present" } else { "missing" }.into(),
        });
        diagnostics.push(Diagnostic {
            level: if session.has_rollout { "ok" } else { "danger" }.into(),
            label: "rollout file".into(),
            value: if session.has_rollout { "found" } else { "missing" }.into(),
        });
        diagnostics.push(Diagnostic {
            level: match session.codex_app_status.as_str() {
                "listed" => "ok",
                "local_only" => "warn",
                _ => "warn",
            }
            .into(),
            label: "Codex App thread/list".into(),
            value: codex_app_status_value(&session),
        });
        if session.thread_source.is_empty() {
            diagnostics.push(Diagnostic {
                level: "warn".into(),
                label: "thread_source".into(),
                value: "missing".into(),
            });
        }
        if !session.provider_matches_current {
            diagnostics.push(Diagnostic {
                level: "warn".into(),
                label: "Provider".into(),
                value: format!("{} != current", session.provider),
            });
        }
        let messages = if session.has_rollout {
            parse_rollout_messages(&session.rollout_path)
        } else {
            Vec::new()
        };
        let rollout_preview = if session.has_rollout {
            fs::read_to_string(&session.rollout_path)?
                .lines()
                .take(12)
                .map(ToOwned::to_owned)
                .collect()
        } else {
            Vec::new()
        };
        Ok(SessionDetail {
            session,
            global_state,
            diagnostics,
            messages,
            rollout_preview,
        })
    })()
    .map_err(|error| error.to_string())
}

#[tauri::command]
fn plan_repair(request: RepairRequest, state: State<AppState>) -> Result<OperationPlan, String> {
    plan_desktop_repair(
        DesktopRepairRequest {
            id: Some(request.id),
            include_archived: Some(false),
        },
        state,
    )
}

#[tauri::command]
fn plan_desktop_repair(request: DesktopRepairRequest, state: State<AppState>) -> Result<OperationPlan, String> {
    (|| -> AppResult<OperationPlan> {
        let codex = codex_home(None)?;
        let global = read_json(&codex.join(".codex-global-state.json"))?;
        let include_archived = request.include_archived.unwrap_or(false);
        let sessions: Vec<_> = scan_sessions(&codex)?
            .into_iter()
            .filter(|session| {
                request
                    .id
                    .as_ref()
                    .map(|id| &session.id == id)
                    .unwrap_or_else(|| include_archived || !session.archived)
            })
            .collect();
        if sessions.is_empty() {
            return Err(AppError::Message("No matching sessions found for repair.".into()));
        }
        let mut actions = Vec::new();
        let mut diffs = Vec::new();
        for session in &sessions {
            let view = global_view(&global, Some(&session.id));
            let before = actions.len();
            append_repair_actions(&mut actions, session, &view);
            if actions.len() > before {
                diffs.push(format!("{}: {} repair actions", session.id, actions.len() - before));
            }
        }
        actions.sort_by(|a, b| a.kind.cmp(&b.kind).then(a.target.cmp(&b.target)));
        actions.dedup_by(|a, b| a.kind == b.kind && a.target == b.target && a.value == b.value);
        let affected_sessions = sessions.iter().map(|session| session.id.clone()).collect::<Vec<_>>();
        let plan = OperationPlan {
            id: Uuid::new_v4().to_string(),
            title: if request.id.is_some() {
                format!("Repair Desktop visibility for {}", sessions[0].title)
            } else {
                format!("Repair Desktop visibility for {} sessions", sessions.len())
            },
            dry_run: true,
            requires_codex_closed: true,
            backup_required: true,
            scope: Some(if include_archived { "active+archived" } else { "active" }.into()),
            affected_sessions,
            backup_files: default_backup_files(),
            dry_run_diffs: diffs,
            actions,
            warnings: vec![
                "Codex App/CLI should be closed before applying writes.".into(),
                "A backup of state_5.sqlite, WAL/SHM, session_index.jsonl, and global state will be created.".into(),
            ],
        };
        state.plans.lock().unwrap().insert(plan.id.clone(), plan.clone());
        Ok(plan)
    })()
    .map_err(|error| error.to_string())
}

fn append_repair_actions(actions: &mut Vec<OperationAction>, session: &SessionSummary, view: &GlobalStateView) {
    if !view.saved_workspaces.contains(&session.cwd) {
        actions.push(action("add_saved_workspace", "Add workspace root", &session.cwd, None, false));
    }
    if !view.project_order.contains(&session.cwd) {
        actions.push(action("add_project_order", "Add project to sidebar order", &session.cwd, None, false));
    }
    if view.thread_workspace_hint.as_deref() != Some(&session.cwd) {
        actions.push(action(
            "set_thread_workspace_hint",
            "Set thread workspace hint",
            &session.id,
            Some(session.cwd.clone()),
            false,
        ));
    }
    if view.active_workspaces.first().map(|path| path != &session.cwd).unwrap_or(true) {
        actions.push(action("activate_workspace", "Activate workspace", &session.cwd, None, false));
    }
    actions.push(action("bring_thread_to_front", "Bring thread to recent front", &session.id, None, false));
    if session.thread_source.is_empty() {
        actions.push(action("set_thread_source", "Set thread source", &session.id, Some("user".into()), false));
    }
    if !session.in_session_index && !session.archived {
        actions.push(action("upsert_session_index", "Register active session index", &session.id, None, false));
    }
    if view.projectless_thread_ids.contains(&session.id) && !session.cwd.is_empty() {
        actions.push(action("remove_projectless_thread", "Remove projectless sidebar filter", &session.id, None, false));
    }
    if view.collapsed_groups.contains_key(&session.cwd)
        || view.collapsed_sections.contains_key("projects")
        || view.collapsed_sections.contains_key("sessions")
    {
        actions.push(action("clear_sidebar_collapsed_state", "Clear sidebar collapsed state", &session.cwd, None, false));
    }
}

fn default_backup_files() -> Vec<String> {
    vec![
        "state_5.sqlite".into(),
        "state_5.sqlite-wal".into(),
        "state_5.sqlite-shm".into(),
        "session_index.jsonl".into(),
        ".codex-global-state.json".into(),
    ]
}

fn action(kind: &str, label: &str, target: &str, value: Option<String>, dangerous: bool) -> OperationAction {
    OperationAction {
        kind: kind.into(),
        label: format!("{}: {}", label, target),
        target: target.into(),
        value,
        dangerous,
    }
}

#[tauri::command]
fn get_current_provider() -> Result<String, String> {
    codex_home(None)
        .map(|codex| current_provider(&codex))
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn open_resume_terminal(request: ResumeTerminalRequest) -> Result<OperationResult, String> {
    (|| -> AppResult<OperationResult> {
        if request.id.trim().is_empty() {
            return Err(AppError::Message("Missing session id".into()));
        }
        let codex = codex_home(None)?;
        let session = scan_sessions(&codex)?
            .into_iter()
            .find(|session| session.id == request.id)
            .ok_or_else(|| AppError::Message(format!("Session not found: {}", request.id)))?;
        let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"));
        let cwd = if session.cwd.is_empty() || !Path::new(&session.cwd).is_dir() {
            home
        } else {
            PathBuf::from(&session.cwd)
        };
        let script_path = create_resume_script(&cwd, &session.id)?;
        let resume_command = format!("codex resume {}", session.id);
        let terminal = open_resume_in_terminal(request.terminal.as_deref().unwrap_or("warp"), &script_path)?;
        Ok(OperationResult {
            ok: true,
            message: format!("Opened {} to run {} via {}", terminal, resume_command, script_path.to_string_lossy()),
            backup_path: None,
            changed_files: Vec::new(),
        })
    })()
    .map_err(|error| error.to_string())
}

#[tauri::command]
fn plan_provider_clone(request: ProviderRequest, state: State<AppState>) -> Result<OperationPlan, String> {
    (|| -> AppResult<OperationPlan> {
        let codex = codex_home(None)?;
        let provider = request.provider.unwrap_or_else(|| current_provider(&codex));
        let session = scan_sessions(&codex)?
            .into_iter()
            .find(|session| session.id == request.id)
            .ok_or_else(|| AppError::Message(format!("Session not found: {}", request.id)))?;
        let new_id = Uuid::new_v4().to_string();
        let value = json!({
            "old_id": session.id,
            "new_id": new_id,
            "provider": provider
        })
        .to_string();
        let mut actions = vec![action("clone_provider_session", "Clone session to provider", &session.id, Some(value), false)];
        let global = read_json(&codex.join(".codex-global-state.json"))?;
        let mut clone_preview = session.clone();
        clone_preview.id = new_id.clone();
        clone_preview.provider = provider.clone();
        clone_preview.cloned_from = Some(session.id.clone());
        append_repair_actions(&mut actions, &clone_preview, &global_view(&global, Some(&new_id)));
        let plan = OperationPlan {
            id: Uuid::new_v4().to_string(),
            title: format!("Clone {} to provider {}", session.title, provider),
            dry_run: true,
            requires_codex_closed: true,
            backup_required: true,
            scope: Some("provider-clone".into()),
            affected_sessions: vec![session.id.clone(), new_id],
            backup_files: default_backup_files(),
            dry_run_diffs: vec![format!("Create provider clone from {} and preserve original", session.id)],
            actions,
            warnings: vec!["Clone preserves the old provider session and creates a new cloned_from relation.".into()],
        };
        state.plans.lock().unwrap().insert(plan.id.clone(), plan.clone());
        Ok(plan)
    })()
    .map_err(|error| error.to_string())
}

#[tauri::command]
fn plan_provider_migrate(request: ProviderRequest, state: State<AppState>) -> Result<OperationPlan, String> {
    (|| -> AppResult<OperationPlan> {
        let codex = codex_home(None)?;
        let provider = request.provider.unwrap_or_else(|| current_provider(&codex));
        let session = scan_sessions(&codex)?
            .into_iter()
            .find(|session| session.id == request.id)
            .ok_or_else(|| AppError::Message(format!("Session not found: {}", request.id)))?;
        let mut actions = vec![action(
            "migrate_provider_session",
            "Migrate existing session provider",
            &session.id,
            Some(provider.clone()),
            false,
        )];
        let global = read_json(&codex.join(".codex-global-state.json"))?;
        let mut migrated = session.clone();
        migrated.provider = provider.clone();
        append_repair_actions(&mut actions, &migrated, &global_view(&global, Some(&session.id)));
        let plan = OperationPlan {
            id: Uuid::new_v4().to_string(),
            title: format!("Migrate {} to provider {}", session.title, provider),
            dry_run: true,
            requires_codex_closed: true,
            backup_required: true,
            scope: Some("provider-migrate".into()),
            affected_sessions: vec![session.id.clone()],
            backup_files: default_backup_files(),
            dry_run_diffs: vec![format!("Change {} provider {} -> {}", session.id, session.provider, provider)],
            actions,
            warnings: vec!["Migration changes the existing session provider and repairs Desktop visibility.".into()],
        };
        state.plans.lock().unwrap().insert(plan.id.clone(), plan.clone());
        Ok(plan)
    })()
    .map_err(|error| error.to_string())
}

#[tauri::command]
fn list_cleanup_candidates(request: CleanupRequest) -> Result<Vec<CleanupCandidate>, String> {
    (|| -> AppResult<Vec<CleanupCandidate>> {
        let codex = codex_home(None)?;
        let provider = current_provider(&codex);
        let sessions = scan_sessions(&codex)?;
        let mut replacement_by_old = HashMap::new();
        for session in &sessions {
            if session.provider == provider {
                if let Some(old_id) = &session.cloned_from {
                    replacement_by_old.insert(old_id.clone(), session.id.clone());
                }
            }
        }
        let mut candidates = Vec::new();
        for session in &sessions {
            if !request.include_archived.unwrap_or(false) && session.archived {
                continue;
            }
            match request.kind.as_str() {
                "old_provider_clones" => {
                    if session.provider != provider {
                        if let Some(replacement_id) = replacement_by_old.get(&session.id) {
                            candidates.push(cleanup_candidate(session, "confirmed cloned_from replacement", Some(replacement_id.clone())));
                        }
                    }
                }
                "archived_rollouts" => {
                    if session.archived || session.rollout_path.contains("/archived_sessions/") {
                        candidates.push(cleanup_candidate(session, "archived rollout", None));
                    }
                }
                "duplicate_clones" => {
                    if session.cloned_from.is_some() && session.provider == provider {
                        candidates.push(cleanup_candidate(session, "provider clone", session.cloned_from.clone()));
                    }
                }
                _ => {}
            }
        }
        Ok(candidates)
    })()
    .map_err(|error| error.to_string())
}

fn cleanup_candidate(session: &SessionSummary, reason: &str, replacement_id: Option<String>) -> CleanupCandidate {
    CleanupCandidate {
        id: session.id.clone(),
        title: session.title.clone(),
        provider: session.provider.clone(),
        rollout_path: session.rollout_path.clone(),
        archived: session.archived,
        reason: reason.into(),
        replacement_id,
    }
}

#[tauri::command]
fn plan_cleanup_operation(request: CleanupRequest, state: State<AppState>) -> Result<OperationPlan, String> {
    (|| -> AppResult<OperationPlan> {
        let ids: HashSet<String> = request.ids.clone().unwrap_or_default().into_iter().collect();
        let candidates = list_cleanup_candidates(CleanupRequest {
            kind: request.kind.clone(),
            include_archived: request.include_archived,
            ids: None,
        })
        .map_err(AppError::Message)?;
        let selected: Vec<_> = candidates
            .into_iter()
            .filter(|candidate| ids.is_empty() || ids.contains(&candidate.id))
            .collect();
        let mut actions = Vec::new();
        for candidate in &selected {
            let kind = match request.kind.as_str() {
                "archived_rollouts" => "delete_archived_rollout",
                "old_provider_clones" => "delete_old_provider_session",
                "duplicate_clones" => "delete_duplicate_clone",
                _ => "preview_cleanup",
            };
            actions.push(action(kind, "Cleanup candidate", &candidate.id, Some(candidate.rollout_path.clone()), true));
        }
        let plan = OperationPlan {
            id: Uuid::new_v4().to_string(),
            title: format!("Cleanup {} candidates", selected.len()),
            dry_run: true,
            requires_codex_closed: true,
            backup_required: true,
            scope: Some(request.kind),
            affected_sessions: selected.iter().map(|candidate| candidate.id.clone()).collect(),
            backup_files: default_backup_files(),
            dry_run_diffs: selected.iter().map(|candidate| format!("{}: {}", candidate.id, candidate.reason)).collect(),
            actions,
            warnings: vec!["Cleanup uses confirmed candidates only and creates a backup before deleting.".into()],
        };
        state.plans.lock().unwrap().insert(plan.id.clone(), plan.clone());
        Ok(plan)
    })()
    .map_err(|error| error.to_string())
}

#[tauri::command]
fn apply_operation(request: ApplyOperationRequest, state: State<AppState>) -> Result<OperationResult, String> {
    (|| -> AppResult<OperationResult> {
        let plan = state
            .plans
            .lock()
            .unwrap()
            .get(&request.plan_id)
            .cloned()
            .ok_or_else(|| AppError::Message("Operation plan not found. Generate a dry-run plan first.".into()))?;
        if plan.requires_codex_closed && codex_process_running() {
            if request.force_close_codex.unwrap_or(false) {
                close_codex_processes()?;
                thread::sleep(Duration::from_millis(700));
            }
        }
        if plan.requires_codex_closed && codex_process_running() {
            return Ok(OperationResult {
                ok: false,
                message: "Codex 仍在运行。请关闭 Codex App/CLI，或在确认后使用强制关闭再执行受保护操作。".into(),
                backup_path: None,
                changed_files: vec![],
            });
        }
        let codex = codex_home(None)?;
        let backup = create_backup_for_plan(&codex, "operation", &plan)?;
        let global_path = codex.join(".codex-global-state.json");
        let mut global = read_json(&global_path)?;
        let persisted = persisted_state_mut(&mut global);
        for item in &plan.actions {
            match item.kind.as_str() {
                "add_saved_workspace" => push_unique_array(persisted, "electron-saved-workspace-roots", item.target.clone()),
                "add_project_order" => push_unique_array(persisted, "project-order", item.target.clone()),
                "activate_workspace" => {
                    persisted.insert("active-workspace-roots".into(), json!([item.target]));
                }
                "set_thread_workspace_hint" => {
                    let hints = persisted
                        .entry("thread-workspace-root-hints")
                        .or_insert_with(|| Value::Object(Map::new()));
                    if !hints.is_object() {
                        *hints = Value::Object(Map::new());
                    }
                    hints
                        .as_object_mut()
                        .unwrap()
                        .insert(item.target.clone(), Value::String(item.value.clone().unwrap_or_default()));
                }
                "bring_thread_to_front" => touch_thread(&codex.join("state_5.sqlite"), &item.target)?,
                "set_thread_source" => set_thread_source(&codex.join("state_5.sqlite"), &item.target, item.value.as_deref().unwrap_or("user"))?,
                "upsert_session_index" => ensure_session_index(&codex, &item.target)?,
                "remove_projectless_thread" => remove_array_string(persisted, "projectless-thread-ids", &item.target),
                "clear_sidebar_collapsed_state" => clear_sidebar_collapsed_state(persisted, &item.target),
                "clone_provider_session" => {
                    if let Some(value) = &item.value {
                        let value: Value = serde_json::from_str(value)?;
                        let old_id = value.get("old_id").and_then(Value::as_str).unwrap_or(&item.target);
                        let new_id = value
                            .get("new_id")
                            .and_then(Value::as_str)
                            .ok_or_else(|| AppError::Message("Missing clone new_id".into()))?;
                        let provider = value
                            .get("provider")
                            .and_then(Value::as_str)
                            .ok_or_else(|| AppError::Message("Missing clone provider".into()))?;
                        clone_provider_session(&codex, old_id, new_id, provider)?;
                    }
                }
                "migrate_provider_session" => {
                    migrate_provider_session(&codex, &item.target, item.value.as_deref().unwrap_or(&current_provider(&codex)))?;
                }
                "delete_archived_rollout" => delete_archived_rollout(&codex, &item.target, item.value.as_deref().unwrap_or_default())?,
                "delete_old_provider_session" | "delete_duplicate_clone" => {
                    delete_thread_and_rollout(&codex, &item.target, item.value.as_deref().unwrap_or_default())?;
                }
                _ => {}
            }
        }
        fs::write(&global_path, serde_json::to_string_pretty(&global)?)?;
        Ok(OperationResult {
            ok: true,
            message: format!("Applied {} actions.", plan.actions.len()),
            backup_path: Some(backup.to_string_lossy().to_string()),
            changed_files: vec![global_path.to_string_lossy().to_string(), codex.join("state_5.sqlite").to_string_lossy().to_string()],
        })
    })()
    .map_err(|error| error.to_string())
}

fn push_unique_array(map: &mut Map<String, Value>, key: &str, value: String) {
    let entry = map.entry(key).or_insert_with(|| Value::Array(Vec::new()));
    if !entry.is_array() {
        *entry = Value::Array(Vec::new());
    }
    let array = entry.as_array_mut().unwrap();
    if !array.iter().any(|item| item.as_str() == Some(&value)) {
        array.insert(0, Value::String(value));
    }
}

fn remove_array_string(map: &mut Map<String, Value>, key: &str, value: &str) {
    if let Some(array) = map.get_mut(key).and_then(Value::as_array_mut) {
        array.retain(|item| item.as_str() != Some(value));
    }
}

fn clear_sidebar_collapsed_state(map: &mut Map<String, Value>, cwd: &str) {
    if let Some(groups) = map.get_mut("sidebar-collapsed-groups").and_then(Value::as_object_mut) {
        groups.remove(cwd);
    }
    if let Some(sections) = map.get_mut("sidebar-collapsed-sections-v1").and_then(Value::as_object_mut) {
        sections.remove("projects");
        sections.remove("sessions");
    }
}

fn touch_thread(db_path: &Path, id: &str) -> AppResult<()> {
    if !db_path.exists() {
        return Ok(());
    }
    let conn = Connection::open(db_path)?;
    let now_ms = Utc::now().timestamp_millis();
    let now = now_ms / 1000;
    conn.execute(
        "UPDATE threads SET updated_at = ?1, updated_at_ms = ?2 WHERE id = ?3",
        (&now, &now_ms, id),
    )?;
    Ok(())
}

fn set_thread_source(db_path: &Path, id: &str, source: &str) -> AppResult<()> {
    if !db_path.exists() {
        return Ok(());
    }
    let conn = Connection::open(db_path)?;
    conn.execute("UPDATE threads SET thread_source = ?1 WHERE id = ?2", (source, id))?;
    Ok(())
}

fn thread_row(db_path: &Path, id: &str) -> AppResult<Value> {
    let conn = Connection::open(db_path)?;
    let mut stmt = conn.prepare(
        "SELECT id, rollout_path, created_at, updated_at, source, model_provider, cwd, title,
         sandbox_policy, approval_mode, tokens_used, has_user_event, archived, archived_at,
         git_sha, git_branch, git_origin_url, cli_version, first_user_message, agent_nickname,
         agent_role, memory_mode, model, reasoning_effort, agent_path, created_at_ms, updated_at_ms,
         thread_source, preview
         FROM threads WHERE id = ?1",
    )?;
    stmt.query_row([id], |row| {
        Ok(json!({
            "id": row.get::<_, String>(0)?,
            "rollout_path": row.get::<_, String>(1)?,
            "created_at": row.get::<_, i64>(2)?,
            "updated_at": row.get::<_, i64>(3)?,
            "source": row.get::<_, String>(4)?,
            "model_provider": row.get::<_, String>(5)?,
            "cwd": row.get::<_, String>(6)?,
            "title": row.get::<_, String>(7)?,
            "sandbox_policy": row.get::<_, String>(8)?,
            "approval_mode": row.get::<_, String>(9)?,
            "tokens_used": row.get::<_, i64>(10)?,
            "has_user_event": row.get::<_, i64>(11)?,
            "archived": row.get::<_, i64>(12)?,
            "archived_at": row.get::<_, Option<i64>>(13)?,
            "git_sha": row.get::<_, Option<String>>(14)?,
            "git_branch": row.get::<_, Option<String>>(15)?,
            "git_origin_url": row.get::<_, Option<String>>(16)?,
            "cli_version": row.get::<_, String>(17)?,
            "first_user_message": row.get::<_, String>(18)?,
            "agent_nickname": row.get::<_, Option<String>>(19)?,
            "agent_role": row.get::<_, Option<String>>(20)?,
            "memory_mode": row.get::<_, String>(21)?,
            "model": row.get::<_, Option<String>>(22)?,
            "reasoning_effort": row.get::<_, Option<String>>(23)?,
            "agent_path": row.get::<_, Option<String>>(24)?,
            "created_at_ms": row.get::<_, Option<i64>>(25)?,
            "updated_at_ms": row.get::<_, Option<i64>>(26)?,
            "thread_source": row.get::<_, Option<String>>(27)?,
            "preview": row.get::<_, String>(28)?,
        }))
    })
    .map_err(AppError::from)
}

fn ensure_session_index(codex: &Path, id: &str) -> AppResult<()> {
    let sessions = scan_sessions(codex)?;
    let Some(session) = sessions.into_iter().find(|session| session.id == id) else {
        return Ok(());
    };
    if session.archived {
        return Ok(());
    }
    let path = codex.join("session_index.jsonl");
    let mut lines = fs::read_to_string(&path).unwrap_or_default();
    let exists = lines.lines().any(|line| {
        serde_json::from_str::<Value>(line)
            .ok()
            .and_then(|value| value.get("id").and_then(Value::as_str).map(|s| s == id))
            .unwrap_or(false)
    });
    if !exists {
        if !lines.ends_with('\n') && !lines.is_empty() {
            lines.push('\n');
        }
        lines.push_str(
            &json!({
                "id": session.id,
                "thread_name": session.title,
                "updated_at": session.updated_at,
                "rollout_path": session.rollout_path
            })
            .to_string(),
        );
        lines.push('\n');
        fs::write(path, lines)?;
    }
    Ok(())
}

fn clone_provider_session(codex: &Path, old_id: &str, new_id: &str, provider: &str) -> AppResult<()> {
    let db_path = codex.join("state_5.sqlite");
    let row = thread_row(&db_path, old_id)?;
    let old_rollout = row.get("rollout_path").and_then(Value::as_str).unwrap_or_default();
    let new_rollout = cloned_rollout_path(codex, old_rollout, new_id);
    copy_rollout_with_metadata(old_rollout, &new_rollout, new_id, provider, Some(old_id))?;
    let conn = Connection::open(&db_path)?;
    conn.execute(
        "INSERT OR REPLACE INTO threads (
            id, rollout_path, created_at, updated_at, source, model_provider, cwd, title,
            sandbox_policy, approval_mode, tokens_used, has_user_event, archived, archived_at,
            git_sha, git_branch, git_origin_url, cli_version, first_user_message, agent_nickname,
            agent_role, memory_mode, model, reasoning_effort, agent_path, created_at_ms, updated_at_ms,
            thread_source, preview
        ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 0, NULL,
            ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27
        )",
        params![
            new_id,
            new_rollout.to_string_lossy().to_string(),
            row["created_at"].as_i64().unwrap_or_default(),
            Utc::now().timestamp(),
            row["source"].as_str().unwrap_or("vscode"),
            provider,
            row["cwd"].as_str().unwrap_or_default(),
            row["title"].as_str().unwrap_or("Untitled"),
            row["sandbox_policy"].as_str().unwrap_or_default(),
            row["approval_mode"].as_str().unwrap_or_default(),
            row["tokens_used"].as_i64().unwrap_or_default(),
            row["has_user_event"].as_i64().unwrap_or_default(),
            row["git_sha"].as_str(),
            row["git_branch"].as_str(),
            row["git_origin_url"].as_str(),
            row["cli_version"].as_str().unwrap_or_default(),
            row["first_user_message"].as_str().unwrap_or_default(),
            row["agent_nickname"].as_str(),
            row["agent_role"].as_str(),
            row["memory_mode"].as_str().unwrap_or("enabled"),
            row["model"].as_str(),
            row["reasoning_effort"].as_str(),
            row["agent_path"].as_str(),
            row["created_at_ms"].as_i64(),
            Some(Utc::now().timestamp_millis()),
            row["thread_source"].as_str().unwrap_or("user"),
            row["preview"].as_str().unwrap_or_default(),
        ],
    )?;
    ensure_session_index(codex, new_id)?;
    Ok(())
}

fn cloned_rollout_path(codex: &Path, old_rollout: &str, new_id: &str) -> PathBuf {
    let base = Path::new(old_rollout)
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| codex.join("sessions").join(Utc::now().format("%Y/%m/%d").to_string()));
    base.join(format!("rollout-clone-{}-{}.jsonl", Utc::now().format("%Y-%m-%dT%H-%M-%S"), new_id))
}

fn copy_rollout_with_metadata(old_rollout: &str, new_rollout: &Path, new_id: &str, provider: &str, cloned_from: Option<&str>) -> AppResult<()> {
    let content = fs::read_to_string(old_rollout)?;
    if let Some(parent) = new_rollout.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut out = String::new();
    let mut changed_meta = false;
    for line in content.lines() {
        if !changed_meta {
            if let Ok(mut row) = serde_json::from_str::<Value>(line) {
                let is_meta = row.get("type").and_then(Value::as_str) == Some("session_meta")
                    || row
                        .get("payload")
                        .and_then(|payload| payload.get("type"))
                        .and_then(Value::as_str)
                        == Some("session_meta");
                if is_meta {
                    if let Some(payload) = metadata_payload_mut(&mut row) {
                        payload.insert("id".into(), Value::String(new_id.into()));
                        payload.insert("model_provider".into(), Value::String(provider.into()));
                        if let Some(old_id) = cloned_from {
                            payload.insert("cloned_from".into(), Value::String(old_id.into()));
                        }
                    }
                    out.push_str(&serde_json::to_string(&row)?);
                    out.push('\n');
                    changed_meta = true;
                    continue;
                }
            }
        }
        out.push_str(line);
        out.push('\n');
    }
    fs::write(new_rollout, out)?;
    Ok(())
}

fn migrate_provider_session(codex: &Path, id: &str, provider: &str) -> AppResult<()> {
    let db_path = codex.join("state_5.sqlite");
    let row = thread_row(&db_path, id)?;
    let rollout_path = row.get("rollout_path").and_then(Value::as_str).unwrap_or_default();
    if !rollout_path.is_empty() && Path::new(rollout_path).exists() {
        rewrite_rollout_provider(rollout_path, provider, None)?;
    }
    let conn = Connection::open(db_path)?;
    conn.execute("UPDATE threads SET model_provider = ?1, thread_source = COALESCE(NULLIF(thread_source, ''), 'user') WHERE id = ?2", (provider, id))?;
    ensure_session_index(codex, id)?;
    Ok(())
}

fn rewrite_rollout_provider(rollout_path: &str, provider: &str, cloned_from: Option<&str>) -> AppResult<()> {
    let content = fs::read_to_string(rollout_path)?;
    let mut out = String::new();
    let mut changed_meta = false;
    for line in content.lines() {
        if !changed_meta {
            if let Ok(mut row) = serde_json::from_str::<Value>(line) {
                let is_meta = row.get("type").and_then(Value::as_str) == Some("session_meta")
                    || row
                        .get("payload")
                        .and_then(|payload| payload.get("type"))
                        .and_then(Value::as_str)
                        == Some("session_meta");
                if is_meta {
                    if let Some(payload) = metadata_payload_mut(&mut row) {
                        payload.insert("model_provider".into(), Value::String(provider.into()));
                        if let Some(old_id) = cloned_from {
                            payload.insert("cloned_from".into(), Value::String(old_id.into()));
                        }
                    }
                    out.push_str(&serde_json::to_string(&row)?);
                    out.push('\n');
                    changed_meta = true;
                    continue;
                }
            }
        }
        out.push_str(line);
        out.push('\n');
    }
    fs::write(rollout_path, out)?;
    Ok(())
}

fn metadata_payload_mut(row: &mut Value) -> Option<&mut Map<String, Value>> {
    if row.get("payload").is_some() {
        return row.get_mut("payload").and_then(Value::as_object_mut);
    }
    row.as_object_mut()
}

fn delete_archived_rollout(codex: &Path, id: &str, rollout_path: &str) -> AppResult<()> {
    if !rollout_path.contains("/archived_sessions/") {
        return Ok(());
    }
    if Path::new(rollout_path).exists() {
        fs::remove_file(rollout_path)?;
    }
    let conn = Connection::open(codex.join("state_5.sqlite"))?;
    conn.execute("DELETE FROM threads WHERE id = ?1 AND archived = 1", [id])?;
    Ok(())
}

fn delete_thread_and_rollout(codex: &Path, id: &str, rollout_path: &str) -> AppResult<()> {
    let current = current_provider(codex);
    let sessions = scan_sessions(codex)?;
    let confirmed = sessions
        .iter()
        .any(|session| session.provider == current && session.cloned_from.as_deref() == Some(id));
    if !confirmed {
        return Ok(());
    }
    if !rollout_path.is_empty() && Path::new(rollout_path).exists() {
        fs::remove_file(rollout_path)?;
    }
    let conn = Connection::open(codex.join("state_5.sqlite"))?;
    conn.execute("DELETE FROM threads WHERE id = ?1", [id])?;
    remove_session_index(codex, id)?;
    Ok(())
}

fn remove_session_index(codex: &Path, id: &str) -> AppResult<()> {
    let path = codex.join("session_index.jsonl");
    if !path.exists() {
        return Ok(());
    }
    let content = fs::read_to_string(&path)?;
    let kept = content
        .lines()
        .filter(|line| {
            serde_json::from_str::<Value>(line)
                .ok()
                .and_then(|value| value.get("id").and_then(Value::as_str).map(|row_id| row_id != id))
                .unwrap_or(true)
        })
        .collect::<Vec<_>>()
        .join("\n");
    fs::write(path, if kept.is_empty() { kept } else { format!("{}\n", kept) })?;
    Ok(())
}

fn codex_process_running() -> bool {
    !codex_process_ids().is_empty()
}

fn close_codex_processes() -> AppResult<()> {
    let _ = Command::new("osascript")
        .args(["-e", "tell application id \"com.openai.codex\" to quit"])
        .output();
    thread::sleep(Duration::from_millis(500));

    for pid in codex_process_ids() {
        let _ = Command::new("kill").args(["-TERM", &pid.to_string()]).output();
    }
    thread::sleep(Duration::from_millis(900));
    for pid in codex_process_ids() {
        let _ = Command::new("kill").args(["-KILL", &pid.to_string()]).output();
    }
    Ok(())
}

fn codex_process_ids() -> Vec<u32> {
    let output = Command::new("ps").args(["-axo", "pid=,comm=,args="]).output();
    let Ok(output) = output else {
        return Vec::new();
    };
    let current_pid = std::process::id();
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim_start();
            let mut parts = trimmed.splitn(2, char::is_whitespace);
            let pid_text = parts.next()?;
            let rest = parts.next().unwrap_or_default();
            let pid = pid_text.parse::<u32>().ok()?;
            if pid == current_pid || !is_codex_process_line(rest) {
                return None;
            }
            Some(pid)
        })
        .collect()
}

fn is_codex_process_line(line: &str) -> bool {
    let lower = line.to_lowercase();
    if lower.contains("codex-session-manager")
        || lower.contains("codex session manager")
        || lower.contains("codexsessionmanager")
    {
        return false;
    }
    lower.contains("/codex.app/contents/macos/codex")
        || lower.contains("com.openai.codex")
        || lower.contains(" codex resume")
        || lower.contains(" codex exec")
}

fn create_backup(codex: &Path, label: &str) -> AppResult<PathBuf> {
    let backup = codex
        .join("backups")
        .join(format!("{}-{}", label, Utc::now().format("%Y%m%d-%H%M%S")));
    fs::create_dir_all(&backup)?;
    for file in [
        "session_index.jsonl",
        "state_5.sqlite",
        "state_5.sqlite-wal",
        "state_5.sqlite-shm",
        ".codex-global-state.json",
    ] {
        let src = codex.join(file);
        if src.exists() {
            fs::copy(src, backup.join(file))?;
        }
    }
    Ok(backup)
}

fn create_backup_for_plan(codex: &Path, label: &str, plan: &OperationPlan) -> AppResult<PathBuf> {
    let backup = create_backup(codex, label)?;
    let rollout_dir = backup.join("rollouts");
    for action in &plan.actions {
        let mut paths = Vec::new();
        if matches!(
            action.kind.as_str(),
            "delete_archived_rollout" | "delete_old_provider_session" | "delete_duplicate_clone"
        ) {
            if let Some(value) = &action.value {
                paths.push(value.clone());
            }
        }
        if matches!(action.kind.as_str(), "clone_provider_session") {
            if let Some(value) = &action.value {
                if let Ok(value) = serde_json::from_str::<Value>(value) {
                    if let Some(old_id) = value.get("old_id").and_then(Value::as_str) {
                        if let Ok(row) = thread_row(&codex.join("state_5.sqlite"), old_id) {
                            if let Some(path) = row.get("rollout_path").and_then(Value::as_str) {
                                paths.push(path.to_string());
                            }
                        }
                    }
                }
            }
        }
        if matches!(action.kind.as_str(), "migrate_provider_session") {
            if let Ok(row) = thread_row(&codex.join("state_5.sqlite"), &action.target) {
                if let Some(path) = row.get("rollout_path").and_then(Value::as_str) {
                    paths.push(path.to_string());
                }
            }
        }
        for path in paths {
            let src = PathBuf::from(&path);
            if src.exists() && src.is_file() {
                fs::create_dir_all(&rollout_dir)?;
                let name = src
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("rollout.jsonl");
                fs::copy(&src, rollout_dir.join(name))?;
            }
        }
    }
    Ok(backup)
}

#[tauri::command]
fn list_skills() -> Result<Vec<SkillSummary>, String> {
    (|| -> AppResult<Vec<SkillSummary>> {
        let codex = codex_home(None)?;
        let dir = codex.join("skills");
        let mut skills = Vec::new();
        if !dir.exists() {
            return Ok(skills);
        }
        for entry in fs::read_dir(dir)?.flatten() {
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path)?;
            let name = entry.file_name().to_string_lossy().to_string();
            let is_symlink = metadata.file_type().is_symlink();
            let kind = if name == ".system" {
                "system"
            } else if is_symlink {
                "linked"
            } else if path.to_string_lossy().contains("/plugins/") {
                "plugin"
            } else {
                "custom"
            };
            skills.push(SkillSummary {
                name,
                path: path.to_string_lossy().to_string(),
                kind: kind.into(),
                has_skill_md: path.join("SKILL.md").exists(),
                is_symlink,
                size_bytes: dir_size(&path),
            });
        }
        skills.sort_by(|a, b| a.kind.cmp(&b.kind).then(a.name.cmp(&b.name)));
        Ok(skills)
    })()
    .map_err(|error| error.to_string())
}

fn dir_size(path: &Path) -> u64 {
    if path.is_file() {
        return path.metadata().map(|m| m.len()).unwrap_or(0);
    }
    WalkDir::new(path)
        .into_iter()
        .flatten()
        .filter_map(|entry| entry.metadata().ok())
        .map(|metadata| metadata.len())
        .sum()
}

#[tauri::command]
fn export_skills(request: SkillExportRequest) -> Result<BundleResult, String> {
    (|| -> AppResult<BundleResult> {
        let kinds = request.kinds.unwrap_or_else(|| vec!["custom".into(), "linked".into()]);
        let codex = codex_home(None)?;
        let out = std::env::current_dir()?.join("codex_bundles").join(format!("skills-{}", Utc::now().format("%Y%m%d-%H%M%S")));
        fs::create_dir_all(&out)?;
        let mut included = 0;
        for skill in list_skills().map_err(AppError::Message)? {
            if kinds.contains(&skill.kind) {
                copy_path(Path::new(&skill.path), &out.join(&skill.name))?;
                included += 1;
            }
        }
        let manifest = json!({
            "schema_version": 1,
            "type": "skills",
            "source_codex_home": codex.to_string_lossy().to_string(),
            "exported_at": Utc::now().to_rfc3339(),
            "included_skills": included,
            "sensitive_default": "excluded"
        });
        let manifest_path = out.join("manifest.json");
        fs::write(&manifest_path, serde_json::to_string_pretty(&manifest)?)?;
        Ok(BundleResult {
            path: out.to_string_lossy().to_string(),
            manifest_path: manifest_path.to_string_lossy().to_string(),
            included_sessions: 0,
            included_skills: included,
            warnings: Vec::new(),
        })
    })()
    .map_err(|error| error.to_string())
}

#[tauri::command]
fn import_skills(request: ImportRequest, state: State<AppState>) -> Result<OperationPlan, String> {
    create_import_plan("Import skills", request.path, false, state)
}

#[tauri::command]
fn export_bundle(request: BundleRequest) -> Result<BundleResult, String> {
    (|| -> AppResult<BundleResult> {
        let codex = codex_home(None)?;
        let sessions = scan_sessions(&codex)?;
        let selected: HashSet<String> = request.session_ids.unwrap_or_default().into_iter().collect();
        let include_sensitive = request.include_sensitive.unwrap_or(false);
        let out = std::env::current_dir()?.join("codex_bundles").join(format!("bundle-{}", Utc::now().format("%Y%m%d-%H%M%S")));
        let sessions_dir = out.join("sessions");
        let state_dir = out.join("state");
        fs::create_dir_all(&sessions_dir)?;
        fs::create_dir_all(&state_dir)?;
        let mut included = 0;
        let mut manifest_sessions = Vec::new();
        for session in sessions.iter().filter(|session| selected.is_empty() || selected.contains(&session.id)) {
            if !session.rollout_path.is_empty() && Path::new(&session.rollout_path).exists() && (include_sensitive || !is_sensitive_path(&session.rollout_path)) {
                fs::copy(&session.rollout_path, sessions_dir.join(format!("{}.jsonl", session.id)))?;
            }
            manifest_sessions.push(json!({
                "id": session.id,
                "title": session.title,
                "cwd": session.cwd,
                "provider": session.provider,
                "source": session.source,
                "rollout_path": session.rollout_path,
                "updated_at": session.updated_at
            }));
            included += 1;
        }
        fs::write(state_dir.join("session_index_fragment.json"), serde_json::to_string_pretty(&manifest_sessions)?)?;
        let included_thread_ids: Vec<String> = manifest_sessions
            .iter()
            .filter_map(|value| value.get("id").and_then(Value::as_str).map(ToOwned::to_owned))
            .collect();
        let manifest = json!({
            "schema_version": 1,
            "type": "codex-session-bundle",
            "source_machine": std::env::var("HOSTNAME").unwrap_or_else(|_| "local".into()),
            "source_codex_home": codex.to_string_lossy().to_string(),
            "exported_at": Utc::now().to_rfc3339(),
            "included_thread_ids": included_thread_ids,
            "sensitive": {
                "default": "excluded",
                "manual_include": include_sensitive
            }
        });
        let manifest_path = out.join("manifest.json");
        fs::write(&manifest_path, serde_json::to_string_pretty(&manifest)?)?;
        write_checksums(&out)?;
        Ok(BundleResult {
            path: out.to_string_lossy().to_string(),
            manifest_path: manifest_path.to_string_lossy().to_string(),
            included_sessions: included,
            included_skills: 0,
            warnings: if include_sensitive { vec!["Advanced sensitive inclusion was requested.".into()] } else { Vec::new() },
        })
    })()
    .map_err(|error| error.to_string())
}

#[tauri::command]
fn import_bundle(request: ImportRequest, state: State<AppState>) -> Result<OperationPlan, String> {
    create_import_plan("Import bundle", request.path, true, state)
}

fn create_import_plan(title: &str, path: Option<String>, requires_codex_closed: bool, state: State<AppState>) -> Result<OperationPlan, String> {
    let plan = OperationPlan {
        id: Uuid::new_v4().to_string(),
        title: title.into(),
        dry_run: true,
        requires_codex_closed,
        backup_required: true,
        scope: Some("import".into()),
        affected_sessions: Vec::new(),
        backup_files: default_backup_files(),
        dry_run_diffs: vec![format!("Preview import from {}", path.as_deref().unwrap_or("not selected"))],
        actions: vec![action(
            "preview_import",
            "Preview import source",
            path.as_deref().unwrap_or("not selected"),
            None,
            false,
        )],
        warnings: vec!["Import is planned only. Apply will create a backup before copying any files.".into()],
    };
    state.plans.lock().unwrap().insert(plan.id.clone(), plan.clone());
    Ok(plan)
}

fn is_sensitive_path(path: &str) -> bool {
    let path = path.to_lowercase();
    ["/auth.json", "/cookies", "/login data", "/crashpad/", "/cache/", "token", "secret"]
        .iter()
        .any(|needle| path.contains(needle))
}

fn copy_path(src: &Path, dst: &Path) -> AppResult<()> {
    if src.is_dir() {
        fs::create_dir_all(dst)?;
        for entry in fs::read_dir(src)?.flatten() {
            copy_path(&entry.path(), &dst.join(entry.file_name()))?;
        }
    } else if src.is_file() {
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(src, dst)?;
    } else if fs::symlink_metadata(src).map(|m| m.file_type().is_symlink()).unwrap_or(false) {
        let target = fs::read_link(src)?;
        fs::write(dst.with_extension("symlink.txt"), target.to_string_lossy().as_bytes())?;
    }
    Ok(())
}

fn write_checksums(root: &Path) -> AppResult<()> {
    let mut map = Map::new();
    for entry in WalkDir::new(root).into_iter().flatten().filter(|entry| entry.path().is_file()) {
        if entry.file_name() == "checksums.json" {
            continue;
        }
        let bytes = fs::read(entry.path())?;
        let hash = Sha256::digest(bytes);
        let relative = entry.path().strip_prefix(root).unwrap_or(entry.path()).to_string_lossy().to_string();
        map.insert(relative, Value::String(format!("{:x}", hash)));
    }
    fs::write(root.join("checksums.json"), serde_json::to_string_pretty(&Value::Object(map))?)?;
    Ok(())
}

#[tauri::command]
fn list_backups() -> Result<Vec<BackupSummary>, String> {
    (|| -> AppResult<Vec<BackupSummary>> {
        let codex = codex_home(None)?;
        let dir = codex.join("backups");
        let mut backups = Vec::new();
        if !dir.exists() {
            return Ok(backups);
        }
        for entry in fs::read_dir(dir)?.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let files = fs::read_dir(&path)
                .ok()
                .into_iter()
                .flat_map(|items| items.flatten())
                .filter_map(|file| file.file_name().to_str().map(ToOwned::to_owned))
                .collect();
            let created_at = entry
                .metadata()
                .ok()
                .and_then(|metadata| metadata.modified().ok())
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis() as i64)
                .unwrap_or(0);
            backups.push(BackupSummary {
                name: entry.file_name().to_string_lossy().to_string(),
                path: path.to_string_lossy().to_string(),
                created_at,
                files,
            });
        }
        backups.sort_by_key(|item| -item.created_at);
        Ok(backups)
    })()
    .map_err(|error| error.to_string())
}

#[tauri::command]
fn restore_backup(request: RestoreRequest, state: State<AppState>) -> Result<OperationPlan, String> {
    let backup = PathBuf::from(&request.path);
    let mut actions = Vec::new();
    if let Ok(entries) = fs::read_dir(&backup) {
        for entry in entries.flatten() {
            actions.push(action(
                "restore_file",
                "Restore backup file",
                &entry.file_name().to_string_lossy(),
                None,
                true,
            ));
        }
    }
    let plan = OperationPlan {
        id: Uuid::new_v4().to_string(),
        title: format!("Restore backup {}", backup.file_name().and_then(|s| s.to_str()).unwrap_or("selected")),
        dry_run: true,
        requires_codex_closed: true,
        backup_required: true,
        scope: Some("restore".into()),
        affected_sessions: Vec::new(),
        backup_files: default_backup_files(),
        dry_run_diffs: actions.iter().map(|action| format!("Restore {}", action.target)).collect(),
        actions,
        warnings: vec!["Restore is destructive and will create a fresh backup first.".into()],
    };
    state.plans.lock().unwrap().insert(plan.id.clone(), plan.clone());
    Ok(plan)
}

#[tauri::command]
fn github_status(repo_path: String) -> Result<GitStatus, String> {
    let repo = PathBuf::from(&repo_path);
    let exists = repo.join(".git").exists();
    if !exists {
        return Ok(GitStatus {
            repo_path,
            exists: false,
            branch: String::new(),
            dirty: false,
            ahead: 0,
            behind: 0,
            summary: vec!["No Git repository found. Initialize or clone ./codex_bundles first.".into()],
            remote_updated_at: None,
        });
    }
    let branch = git_output(&repo, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap_or_default();
    let porcelain = git_output(&repo, &["status", "--porcelain"]).unwrap_or_default();
    let ahead_behind = git_output(&repo, &["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]).unwrap_or_default();
    let parts: Vec<_> = ahead_behind.split_whitespace().collect();
    Ok(GitStatus {
        repo_path,
        exists: true,
        branch,
        dirty: !porcelain.trim().is_empty(),
        ahead: parts.first().and_then(|v| v.parse().ok()).unwrap_or(0),
        behind: parts.get(1).and_then(|v| v.parse().ok()).unwrap_or(0),
        summary: porcelain.lines().map(ToOwned::to_owned).collect(),
        remote_updated_at: git_output(&repo, &["log", "-1", "--format=%cI", "@{upstream}"]).ok(),
    })
}

#[tauri::command]
fn github_pull(repo_path: String) -> Result<OperationResult, String> {
    git_guarded(repo_path, &["pull", "--ff-only"], true)
}

#[tauri::command]
fn github_push(repo_path: String) -> Result<OperationResult, String> {
    git_guarded(repo_path, &["push"], false)
}

fn git_guarded(repo_path: String, args: &[&str], block_dirty: bool) -> Result<OperationResult, String> {
    let repo = PathBuf::from(&repo_path);
    if !repo.join(".git").exists() {
        return Ok(OperationResult {
            ok: false,
            message: "No Git repository found at bundle path.".into(),
            backup_path: None,
            changed_files: vec![],
        });
    }
    if block_dirty && !git_output(&repo, &["status", "--porcelain"]).unwrap_or_default().trim().is_empty() {
        return Ok(OperationResult {
            ok: false,
            message: "Pull blocked because the bundle repository has local changes.".into(),
            backup_path: None,
            changed_files: vec![],
        });
    }
    let output = Command::new("git").args(args).current_dir(repo).output().map_err(|e| e.to_string())?;
    Ok(OperationResult {
        ok: output.status.success(),
        message: String::from_utf8_lossy(if output.status.success() { &output.stdout } else { &output.stderr }).trim().to_string(),
        backup_path: None,
        changed_files: vec![],
    })
}

fn git_output(repo: &Path, args: &[&str]) -> AppResult<String> {
    let output = Command::new("git").args(args).current_dir(repo).output()?;
    if !output.status.success() {
        return Err(AppError::Message(String::from_utf8_lossy(&output.stderr).trim().to_string()));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

pub fn run() {
    std::panic::set_hook(Box::new(|info| {
        let _ = fs::write(
            "/private/tmp/codex-session-manager-panic.log",
            format!("{}\n", info),
        );
    }));

    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            scan_codex_state,
            query_sessions,
            get_session_detail,
            get_current_provider,
            open_resume_terminal,
            plan_repair,
            plan_desktop_repair,
            plan_provider_clone,
            plan_provider_migrate,
            list_cleanup_candidates,
            plan_cleanup_operation,
            apply_operation,
            export_bundle,
            import_bundle,
            list_skills,
            export_skills,
            import_skills,
            github_status,
            github_pull,
            github_push,
            list_backups,
            restore_backup
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
