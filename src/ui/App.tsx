import {
  Archive,
  Boxes,
  CheckCircle2,
  ChevronRight,
  ClipboardCopy,
  FolderGit2,
  GitBranch,
  History,
  Import,
  Loader2,
  Monitor,
  Moon,
  PackageOpen,
  RefreshCw,
  Search,
  ShieldAlert,
  Sparkles,
  Sun,
  Terminal,
  Trash2,
  Wrench
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../tauri";
import type {
  BackupSummary,
  CleanupCandidate,
  CodexInventory,
  GitStatus,
  OperationPlan,
  OperationAction,
  ProjectSummary,
  SessionDetail,
  SessionSummary,
  SkillSummary
} from "../types";

type View = "sessions" | "repair" | "skills" | "bundles" | "github" | "backups";
type Language = "zh" | "en";
type ThemeMode = "system" | "light" | "dark";
type OperationMode = "repair" | "activeRepair" | "clone" | "migrate" | "cleanup" | "restore";

const navItems: { id: View; icon: typeof History }[] = [
  { id: "sessions", icon: History },
  { id: "repair", icon: Wrench },
  { id: "skills", icon: Sparkles },
  { id: "bundles", icon: Boxes },
  { id: "github", icon: GitBranch },
  { id: "backups", icon: Archive }
];

const terminalOptions = [
  { id: "warp", label: "Warp" },
  { id: "terminal", label: "Terminal.app" },
  { id: "iterm2", label: "iTerm2" }
];

const copy = {
  zh: {
    appSubtitle: "会话管理器",
    nav: {
      sessions: "会话",
      repair: "修复",
      skills: "Skills",
      bundles: "Bundle 迁移",
      github: "GitHub",
      backups: "备份"
    },
    codexHome: "Codex home",
    searchPlaceholder: "搜索标题、cwd、provider、id",
    refresh: "刷新",
    projects: "项目",
    allSessions: "全部会话",
    includeArchived: "包含归档",
    threads: "会话",
    untitled: "未命名",
    sidebarVisible: "侧栏可见",
    sidebarHidden: "未显示",
    codexListed: "Codex App 列表中",
    codexLocalOnly: "本地存在未在列表",
    codexUnverified: "无法验证",
    firstPage: "首屏",
    notFirstPage: "非首屏",
    rank: "rank",
    noSessionSelected: "未选择会话",
    dryRunRepair: "预演修复",
    cloneProvider: "复制到当前 Provider",
    migrateProvider: "迁移到当前 Provider",
    cloneShort: "复制",
    migrateShort: "迁移",
    repairShort: "修复",
    cloneProviderTip: "保留原会话，创建一份使用当前 Provider 的新副本，并记录 cloned_from 关系。",
    migrateProviderTip: "不创建副本，直接把当前会话切换到当前 Provider，并同步修复 Desktop 显示。",
    repairProviderTip: "修复 Codex Desktop 侧栏显示异常：补索引、修 thread_source、修工作区映射、清理侧栏折叠/过滤，并把会话放回最近列表。点击只生成计划，不会直接写入。",
    repairDetailTip: "为当前会话生成修复预案：只修 Desktop 侧栏显示、索引、thread_source 和工作区映射，不会改会话正文。",
    repairPrompt: "检测到问题，可先生成修复预案",
    repairActive: "修复 active 会话",
    operationPanel: "操作预案",
    selectedForOperation: "本次处理的会话",
    currentProvider: "当前 Provider",
    conversation: "最近会话内容",
    cleanupCandidates: "清理候选",
    oldProviderClones: "旧 Provider 副本",
    archivedRollouts: "归档 Rollout",
    duplicateClones: "重复副本",
    planCleanup: "预演清理",
    updated: "更新时间",
    tokens: "Tokens",
    index: "Index",
    rollout: "Rollout",
    threadId: "Thread ID",
    projectCwd: "项目 cwd",
    rolloutPath: "Rollout path",
    resumeCommand: "Resume 命令",
    copyResume: "复制命令",
    openTerminal: "恢复会话",
    terminalType: "终端类型",
    copied: "已复制",
    openTerminalTip: "在所选终端中恢复此会话：会在项目目录生成 .tmpXXXXXX 可执行脚本并运行 codex resume，脚本退出后自清理，不申请辅助功能权限。",
    diagnostics: "诊断",
    rolloutPreview: "Rollout 预览",
    noPreview: "暂无预览。",
    unknown: "未知",
    present: "存在",
    missing: "缺失",
    found: "已找到",
    none: "无",
    yes: "是",
    no: "否",
    repairEyebrow: "先预演 · 必须备份",
    repairWorkbench: "修复工作台",
    planSelectedThread: "为选中会话生成计划",
    repairExplanation: "修复只处理 Codex Desktop 的侧栏显示和索引状态，不会修改会话正文。适用于会话在 Codex App 边栏缺失、thread_source 为空、工作区映射错误、索引缺失或最近列表被旧记录占满的情况；已经能在 Codex App 正常显示的会话通常不需要修复。",
    writeGuard: "写入前需要关闭 Codex App/CLI。当前计划在应用前保持预演状态。",
    forceCloseCodexConfirm: "执行受保护操作前需要关闭 Codex App/CLI。是否强制关闭仍在运行的 Codex 进程？\n\n确认后会先尝试让 Codex App 退出，再结束残留的 Codex CLI/resume/exec 进程；未确认则取消执行。",
    forceCloseCancelled: "已取消执行，未关闭 Codex，也未写入任何文件。",
    danger: "危险",
    applyGuardedOperation: "执行受保护操作",
    selectThreadPlan: "选择一个会话并生成修复计划。",
    skillsEyebrow: "自定义 Skills 与 system/plugin Skills 分离管理",
    skillsManager: "Skills 管理",
    exportCustom: "导出自定义",
    folder: "文件夹",
    bundlesEyebrow: "按机器 · 项目 · 时间归档",
    bundlesMigration: "Bundle 与迁移",
    exportCurrentFilter: "导出当前筛选",
    sensitiveNotice: "auth.json、cookies、tokens、浏览器缓存和 crash dumps 默认排除，只有高级模式显式选择时才会包含。",
    selectedSessions: "已选会话",
    sensitiveDefault: "敏感项默认",
    excluded: "排除",
    cwdMapping: "CWD 映射",
    onImport: "导入时",
    manifest: "Manifest",
    repo: "Repo",
    branch: "Branch",
    dirty: "Dirty",
    aheadBehind: "Ahead/Behind",
    backupsEyebrow: "受保护清理 · 可回退恢复",
    backupsCleanup: "备份与清理",
    archived: "归档",
    protectedIds: "受保护 ID",
    dryRun: "Dry-run",
    required: "必需",
    files: "个文件",
    previewRestore: "预览恢复",
    languageLabel: "界面语言",
    chinese: "中文",
    english: "English",
    themeLabel: "主题",
    themeSystem: "跟随系统",
    themeLight: "浅色",
    themeDark: "深色"
  },
  en: {
    appSubtitle: "Session Manager",
    nav: {
      sessions: "Sessions",
      repair: "Repair",
      skills: "Skills",
      bundles: "Bundles",
      github: "GitHub",
      backups: "Backups"
    },
    codexHome: "Codex home",
    searchPlaceholder: "Search title, cwd, provider, id",
    refresh: "Refresh",
    projects: "Projects",
    allSessions: "All Sessions",
    includeArchived: "Include archived",
    threads: "Threads",
    untitled: "Untitled",
    sidebarVisible: "sidebar",
    sidebarHidden: "hidden",
    codexListed: "In Codex App list",
    codexLocalOnly: "Local only",
    codexUnverified: "Unverified",
    firstPage: "first page",
    notFirstPage: "not first page",
    rank: "rank",
    noSessionSelected: "No session selected",
    dryRunRepair: "Dry-run repair",
    cloneProvider: "Clone to current Provider",
    migrateProvider: "Migrate to current Provider",
    cloneShort: "Clone",
    migrateShort: "Migrate",
    repairShort: "Repair",
    cloneProviderTip: "Keep the original session, create a new copy for the current Provider, and record cloned_from.",
    migrateProviderTip: "Switch this session to the current Provider in place and sync Desktop visibility repairs.",
    repairProviderTip: "Create a dry-run repair plan and open the Repair Workbench; it will not write immediately.",
    repairDetailTip: "Create a repair plan for this session. It only updates Desktop sidebar visibility, index, thread_source, and workspace hints.",
    repairPrompt: "Issues detected. Generate a repair plan first.",
    repairActive: "Repair active sessions",
    operationPanel: "Operation plan",
    selectedForOperation: "Selected sessions",
    currentProvider: "Current Provider",
    conversation: "Recent Conversation",
    cleanupCandidates: "Cleanup Candidates",
    oldProviderClones: "Old Provider Clones",
    archivedRollouts: "Archived Rollouts",
    duplicateClones: "Duplicate Clones",
    planCleanup: "Plan cleanup",
    updated: "Updated",
    tokens: "Tokens",
    index: "Index",
    rollout: "Rollout",
    threadId: "Thread ID",
    projectCwd: "Project cwd",
    rolloutPath: "Rollout path",
    resumeCommand: "Resume command",
    copyResume: "Copy command",
    openTerminal: "Resume session",
    terminalType: "Terminal",
    copied: "Copied",
    openTerminalTip: "Resume this session in the selected terminal by creating and running a .tmpXXXXXX script in the project directory. The script cleans itself up and does not request Accessibility permission.",
    diagnostics: "Diagnostics",
    rolloutPreview: "Rollout Preview",
    noPreview: "No preview available.",
    unknown: "Unknown",
    present: "present",
    missing: "missing",
    found: "found",
    none: "none",
    yes: "yes",
    no: "no",
    repairEyebrow: "Dry-run first · backup required",
    repairWorkbench: "Repair Workbench",
    planSelectedThread: "Plan selected thread",
    repairExplanation: "Repair only updates Codex Desktop sidebar visibility and index state. It does not edit conversation content. Use it when a session is missing from the Codex App sidebar, thread_source is empty, workspace hints are wrong, session_index is missing, or old recent-thread records are crowding the sidebar.",
    writeGuard: "Writes require Codex App/CLI to be closed. This plan is dry-run until applied.",
    forceCloseCodexConfirm: "This guarded operation requires Codex App/CLI to be closed. Force close running Codex processes before applying?\n\nConfirming will ask Codex App to quit, then terminate lingering Codex CLI/resume/exec processes. Cancel keeps everything unchanged.",
    forceCloseCancelled: "Cancelled. Codex was not closed and no files were changed.",
    danger: "danger",
    applyGuardedOperation: "Apply guarded operation",
    selectThreadPlan: "Select a thread and generate a repair plan.",
    skillsEyebrow: "Custom skills separated from system/plugin skills",
    skillsManager: "Skills Manager",
    exportCustom: "Export custom",
    folder: "folder",
    bundlesEyebrow: "Machine · project · time archive",
    bundlesMigration: "Bundles & Migration",
    exportCurrentFilter: "Export current filter",
    sensitiveNotice: "auth.json, cookies, tokens, browser caches, and crash dumps are excluded unless explicitly selected in advanced mode.",
    selectedSessions: "Selected sessions",
    sensitiveDefault: "Sensitive default",
    excluded: "excluded",
    cwdMapping: "CWD mapping",
    onImport: "on import",
    manifest: "Manifest",
    repo: "Repo",
    branch: "Branch",
    dirty: "Dirty",
    aheadBehind: "Ahead/Behind",
    backupsEyebrow: "Protected cleanup · reversible restore",
    backupsCleanup: "Backups & Cleanup",
    archived: "Archived",
    protectedIds: "Protected IDs",
    dryRun: "Dry-run",
    required: "required",
    files: "files",
    previewRestore: "Preview restore",
    languageLabel: "Language",
    chinese: "中文",
    english: "English",
    themeLabel: "Theme",
    themeSystem: "System",
    themeLight: "Light",
    themeDark: "Dark"
  }
} satisfies Record<Language, Record<string, unknown>>;

type Copy = typeof copy.zh;

const formatTime = (value: number, language: Language) => {
  if (!value) return copy[language].unknown;
  return new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : "en-US", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value > 10_000_000_000 ? value : value * 1000));
};

function codexAppStatusLabel(session: SessionSummary, t: Copy) {
  if (session.codexAppStatus === "listed") return t.codexListed;
  if (session.codexAppStatus === "local_only") return t.codexLocalOnly;
  return t.codexUnverified;
}

function codexAppStatusClass(session: SessionSummary) {
  if (session.codexAppStatus === "listed") return "pill ok";
  if (session.codexAppStatus === "local_only") return "pill warn";
  return "pill muted";
}

function codexAppRankLabel(session: SessionSummary, t: Copy) {
  if (session.codexAppStatus === "unverified") return `${t.codexUnverified}`;
  const firstPageSize = session.codexAppFirstPageSize || 50;
  const firstPage = session.codexAppFirstPage
    ? `${t.firstPage} ${session.codexAppFirstPagePosition || 0}/${firstPageSize}`
    : `${t.notFirstPage} 0/${firstPageSize}`;
  const rank = session.codexAppListRank ? `${t.rank} ${session.codexAppListRank}` : `${t.rank} -`;
  return `${firstPage} · ${rank}`;
}

function projectRankLabel(item: ProjectSummary, t: Copy) {
  const firstPageSize = item.codexAppFirstPageSize || 50;
  const firstPage = `first page ${item.codexAppFirstPageCount || 0}/${firstPageSize}`;
  const ranks = item.codexAppRankMin
    ? item.codexAppRankMin === item.codexAppRankMax
      ? `rank ${item.codexAppRankMin}`
      : `ranks ${item.codexAppRankMin}-${item.codexAppRankMax}`
    : "ranks -";
  return t === copy.zh
    ? `${firstPage.replace("first page", "首屏")} · ${ranks}`
    : `${firstPage} · ${ranks}`;
}

export function App() {
  const [language, setLanguage] = useState<Language>(() => {
    const stored = typeof localStorage !== "undefined" ? localStorage.getItem("codex-session-manager-language") : null;
    return stored === "en" ? "en" : "zh";
  });
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    const stored = typeof localStorage !== "undefined" ? localStorage.getItem("codex-session-manager-theme") : null;
    return stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
  });
  const [view, setView] = useState<View>("sessions");
  const [inventory, setInventory] = useState<CodexInventory | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [query, setQuery] = useState("");
  const [project, setProject] = useState<string>("all");
  const [showArchived, setShowArchived] = useState(false);
  const [loading, setLoading] = useState(true);
  const [plan, setPlan] = useState<OperationPlan | null>(null);
  const [operationMode, setOperationMode] = useState<OperationMode>("repair");
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [backups, setBackups] = useState<BackupSummary[]>([]);
  const [cleanupCandidates, setCleanupCandidates] = useState<CleanupCandidate[]>([]);
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [currentProvider, setCurrentProvider] = useState("codex");
  const [terminalKind, setTerminalKind] = useState(() => {
    const stored = typeof localStorage !== "undefined" ? localStorage.getItem("codex-session-manager-terminal") : null;
    return stored || "warp";
  });
  const [toast, setToast] = useState("");
  const t = copy[language];

  const setUiLanguage = (next: Language) => {
    setLanguage(next);
    localStorage.setItem("codex-session-manager-language", next);
  };

  const setUiTheme = (next: ThemeMode) => {
    setThemeMode(next);
    localStorage.setItem("codex-session-manager-theme", next);
  };

  const setResumeTerminal = (next: string) => {
    setTerminalKind(next);
    localStorage.setItem("codex-session-manager-terminal", next);
  };

  const refresh = async () => {
    setLoading(true);
    try {
      const nextInventory = await api.scanCodexState();
      setInventory(nextInventory);
      const nextSessions = await api.querySessions({});
      setSessions(nextSessions);
      const first = selectedId || nextSessions[0]?.id || "";
      setSelectedId(first);
      if (first) setDetail(await api.getSessionDetail(first));
      const provider = await api.getCurrentProvider();
      setCurrentProvider(provider);
      setSkills(await api.listSkills());
      setBackups(await api.listBackups());
      setCleanupCandidates(await api.listCleanupCandidates({ kind: "old_provider_clones", includeArchived: false }));
      setGitStatus(await api.githubStatus("./codex_bundles"));
    } catch (error) {
      setToast(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    void api.getSessionDetail(selectedId).then(setDetail).catch((error) => setToast(String(error)));
  }, [selectedId]);

  const filteredSessions = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return sessions.filter((session) => {
      if (!showArchived && session.archived) return false;
      if (project !== "all" && session.cwd !== project) return false;
      if (!needle) return true;
      return [session.title, session.id, session.cwd, session.provider, session.preview]
        .join(" ")
        .toLowerCase()
        .includes(needle);
    });
  }, [sessions, query, project, showArchived]);

  const selected = sessions.find((session) => session.id === selectedId) || filteredSessions[0];

  const runRepairPlan = async (id = selected?.id) => {
    if (!id) return;
    const nextPlan = await api.planRepair(id);
    setNextPlan(nextPlan, "repair");
  };

  const setNextPlan = (nextPlan: OperationPlan, mode: OperationMode = "repair") => {
    setPlan(nextPlan);
    setOperationMode(mode);
    setView("repair");
  };

  const runActiveRepair = async () => {
    setNextPlan(await api.planDesktopRepair({ includeArchived: false }), "activeRepair");
  };

  const runProviderClone = async (id = selected?.id) => {
    if (!id) return;
    setNextPlan(await api.planProviderClone({ id, provider: currentProvider }), "clone");
  };

  const runProviderMigrate = async (id = selected?.id) => {
    if (!id) return;
    setNextPlan(await api.planProviderMigrate({ id, provider: currentProvider }), "migrate");
  };

  const copyResumeCommand = async (id = selected?.id) => {
    if (!id) return;
    const command = `codex resume ${id}`;
    try {
      await navigator.clipboard.writeText(command);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = command;
      textarea.style.position = "fixed";
      textarea.style.left = "-9999px";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
    }
    setToast(`${t.copied}: ${command}`);
  };

  const openResumeTerminal = async (id = selected?.id) => {
    if (!id) return;
    const result = await api.openResumeTerminal({ id, terminal: terminalKind });
    setToast(result.message);
  };

  return (
    <main className="shell" data-theme={themeMode}>
      <aside className="rail">
        <div className="brand">
          <div className="brandMark">C</div>
          <div>
            <strong>Codex</strong>
            <span>{t.appSubtitle}</span>
          </div>
        </div>
        <nav className="nav">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <button className={view === item.id ? "active" : ""} key={item.id} onClick={() => setView(item.id)}>
                <Icon size={17} />
                {t.nav[item.id]}
              </button>
            );
          })}
        </nav>
        <div className="languageBlock" aria-label={t.languageLabel}>
          <button className={language === "zh" ? "active" : ""} onClick={() => setUiLanguage("zh")}>
            {t.chinese}
          </button>
          <button className={language === "en" ? "active" : ""} onClick={() => setUiLanguage("en")}>
            {t.english}
          </button>
        </div>
        <div className="themeBlock" aria-label={t.themeLabel}>
          <button
            className={themeMode === "system" ? "active" : ""}
            onClick={() => setUiTheme("system")}
            title={t.themeSystem}
            aria-label={t.themeSystem}
          >
            <Monitor size={14} />
            <span>{t.themeSystem}</span>
          </button>
          <button
            className={themeMode === "light" ? "active" : ""}
            onClick={() => setUiTheme("light")}
            title={t.themeLight}
            aria-label={t.themeLight}
          >
            <Sun size={14} />
            <span>{t.themeLight}</span>
          </button>
          <button
            className={themeMode === "dark" ? "active" : ""}
            onClick={() => setUiTheme("dark")}
            title={t.themeDark}
            aria-label={t.themeDark}
          >
            <Moon size={14} />
            <span>{t.themeDark}</span>
          </button>
        </div>
        <div className="statusBlock">
          <span>{t.codexHome}</span>
          <strong>{inventory?.codexHome || "~/.codex"}</strong>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div className="search">
            <Search size={16} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t.searchPlaceholder} />
          </div>
          <button className="iconButton" onClick={refresh} title={t.refresh}>
            {loading ? <Loader2 className="spin" size={17} /> : <RefreshCw size={17} />}
          </button>
        </header>

        <section className="content">
          <aside className="projectPane">
            <div className="paneTitle">{t.projects}</div>
            <button className={project === "all" ? "project active" : "project"} onClick={() => setProject("all")}>
              <span>{t.allSessions}</span>
              <b>{inventory?.totalSessions || sessions.length}</b>
            </button>
            {inventory?.projects.map((item) => (
              <button className={project === item.path ? "project active" : "project"} key={item.path} onClick={() => setProject(item.path)}>
                <span title={item.path}>{item.path.split("/").pop() || item.path}</span>
                <small>{projectRankLabel(item, t)}</small>
                <b>{item.visibleCount}/{item.sessionCount}</b>
              </button>
            ))}
            <label className="toggleRow">
              <input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} />
              {t.includeArchived}
            </label>
          </aside>

          {view === "sessions" && (
            <>
              <SessionList sessions={filteredSessions} selectedId={selected?.id || ""} onSelect={setSelectedId} t={t} language={language} />
              <SessionDetailPanel
                currentProvider={currentProvider}
                detail={detail}
                selected={selected}
                terminalKind={terminalKind}
                onTerminalChange={setResumeTerminal}
                onClone={() => runProviderClone()}
                onMigrate={() => runProviderMigrate()}
                onRepair={() => runRepairPlan()}
                onCopyResume={() => copyResumeCommand()}
                onOpenResume={() => openResumeTerminal()}
                t={t}
                language={language}
              />
            </>
          )}

          {view === "repair" && (
            <RepairWorkbench
              plan={plan}
              selected={selected}
              sessions={sessions}
              operationMode={operationMode}
              onPlan={() => runRepairPlan()}
              onActiveRepair={runActiveRepair}
              onToast={setToast}
              t={t}
              language={language}
            />
          )}
          {view === "skills" && <SkillsManager skills={skills} onToast={setToast} t={t} />}
          {view === "bundles" && <BundlesMigration sessions={filteredSessions} onToast={setToast} t={t} />}
          {view === "github" && <GitHubSync status={gitStatus} onToast={setToast} onRefresh={refresh} t={t} />}
          {view === "backups" && (
            <BackupsCleanup
              backups={backups}
              cleanupCandidates={cleanupCandidates}
              sessions={sessions}
              onPlan={setNextPlan}
              onToast={setToast}
              t={t}
            />
          )}
        </section>
      </section>

      {toast && (
        <button className="toast" onClick={() => setToast("")}>
          {toast}
        </button>
      )}
    </main>
  );
}

function SessionList({
  sessions,
  selectedId,
  onSelect,
  t,
  language
}: {
  sessions: SessionSummary[];
  selectedId: string;
  onSelect: (id: string) => void;
  t: Copy;
  language: Language;
}) {
  return (
    <section className="listPane">
      <div className="paneTitle">{t.threads}</div>
      <div className="sessionList">
        {sessions.map((session) => (
          <button className={selectedId === session.id ? "session active" : "session"} key={session.id} onClick={() => onSelect(session.id)}>
            <span className="sessionTitle">{session.title || t.untitled}</span>
            <span className="sessionMeta">
              {session.provider} · {formatTime(session.updatedAt, language)}
            </span>
            <span className="sessionCwd">{session.cwd}</span>
            <span className={codexAppStatusClass(session)}>{codexAppStatusLabel(session, t)}</span>
            <span className="sessionListRank">{codexAppRankLabel(session, t)}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

function SessionDetailPanel({
  currentProvider,
  detail,
  selected,
  terminalKind,
  onTerminalChange,
  onClone,
  onMigrate,
  onRepair,
  onCopyResume,
  onOpenResume,
  t,
  language
}: {
  currentProvider: string;
  detail: SessionDetail | null;
  selected?: SessionSummary;
  terminalKind: string;
  onTerminalChange: (value: string) => void;
  onClone: () => void;
  onMigrate: () => void;
  onRepair: () => void;
  onCopyResume: () => void;
  onOpenResume: () => void;
  t: Copy;
  language: Language;
}) {
  if (!selected) return <EmptyPanel title={t.noSessionSelected} />;
  const diagnostics = detail?.diagnostics || [];
  const hasDiagnosticIssue = diagnostics.some((item) => item.level !== "ok");
  const resumeCommand = `codex resume ${selected.id}`;

  return (
    <section className="detailPane">
      <div className="detailHeader">
        <div className="detailTitleBlock">
          <p className="eyebrow" title={`${selected.source} · ${selected.provider}`}>{selected.source} · {selected.provider}</p>
          <h1 className="detailTitle" title={selected.title}>{selected.title}</h1>
        </div>
      </div>

      <div className="metricGrid">
        <Metric label={t.updated} value={formatTime(selected.updatedAt, language)} />
        <Metric label={t.tokens} value={String(selected.tokensUsed || 0)} />
        <Metric label={t.index} value={selected.inSessionIndex ? t.present : t.missing} />
        <Metric label={t.rollout} value={selected.hasRollout ? t.found : t.missing} />
      </div>

      <InfoRow label={t.threadId} value={selected.id} />
      <InfoRow label={t.projectCwd} value={selected.cwd || t.unknown} />
      <InfoRow label={t.rolloutPath} value={selected.rolloutPath || t.unknown} />
      <InfoRow label={t.currentProvider} value={currentProvider} />
      <div className="resumeBox">
        <div className="resumeCommand">
          <Terminal size={16} />
          <span>{t.resumeCommand}</span>
          <code>{resumeCommand}</code>
        </div>
        <button className="iconButton compact" onClick={onCopyResume} title={t.copyResume} aria-label={t.copyResume}>
          <ClipboardCopy size={16} />
        </button>
        <select
          className="terminalSelect"
          value={terminalKind}
          onChange={(event) => onTerminalChange(event.target.value)}
          title={t.terminalType}
          aria-label={t.terminalType}
        >
          {terminalOptions.map((option) => (
            <option key={option.id} value={option.id}>{option.label}</option>
          ))}
        </select>
        <button className="secondary resumeButton" onClick={onOpenResume} title={t.openTerminalTip}>
          <Terminal size={16} />
          {t.openTerminal}
        </button>
      </div>

      <div className="sectionHeader diagnosticsHeader">
        <div className="sectionHeadingBlock">
          <div className="sectionTitle">{t.diagnostics}</div>
          {hasDiagnosticIssue && <span className="repairPrompt">{t.repairPrompt}</span>}
        </div>
        <div className="diagnosticActions">
          <button
            className="toolButton"
            onClick={onClone}
            title={`${t.cloneProvider}\n${t.currentProvider}: ${currentProvider}\n${t.cloneProviderTip}`}
            aria-label={t.cloneProvider}
          >
            <ClipboardCopy size={15} />
            <span>{t.cloneShort}</span>
          </button>
          <button
            className="toolButton"
            onClick={onMigrate}
            title={`${t.migrateProvider}\n${t.currentProvider}: ${currentProvider}\n${t.migrateProviderTip}`}
            aria-label={t.migrateProvider}
          >
            <GitBranch size={15} />
            <span>{t.migrateShort}</span>
          </button>
          {hasDiagnosticIssue && (
            <button
              className="toolButton repair"
              onClick={onRepair}
              title={`${t.dryRunRepair}\n${t.repairDetailTip}`}
              aria-label={t.dryRunRepair}
            >
              <Wrench size={15} />
              <span>{t.repairShort}</span>
            </button>
          )}
        </div>
      </div>
      <div className="diagnostics">
        {diagnostics.map((item) => (
          <div className={`diagnostic ${item.level}`} key={item.label}>
            {item.level === "ok" ? <CheckCircle2 size={15} /> : <ShieldAlert size={15} />}
            <span>{translateDiagnosticLabel(item.label, t)}</span>
            <b>{translateValue(item.value, t)}</b>
          </div>
        ))}
      </div>

      <div className="sectionTitle">{t.conversation}</div>
      <Conversation messages={detail?.messages || []} fallback={detail?.rolloutPreview.join("\n") || t.noPreview} />
    </section>
  );
}

function Conversation({ messages, fallback }: { messages: SessionDetail["messages"]; fallback: string }) {
  if (!messages.length) return <pre className="rolloutPreview">{fallback}</pre>;
  return (
    <div className="conversation">
      {messages.map((message) => (
        <article className={`message ${message.role} ${message.kind}`} key={message.id}>
          <div className="messageHeader">
            {message.kind === "tool_call" || message.kind === "tool_output" ? <Terminal size={15} /> : <History size={15} />}
            <strong>{message.kind === "message" ? message.role : message.kind}</strong>
            {message.toolName && <span>{message.toolName}</span>}
          </div>
          {message.kind === "raw" ? (
            <details>
              <summary>raw JSON</summary>
              <pre>{message.text}</pre>
            </details>
          ) : (
            <pre>{message.text}</pre>
          )}
        </article>
      ))}
    </div>
  );
}

function RepairWorkbench({
  plan,
  selected,
  sessions,
  operationMode,
  onActiveRepair,
  onPlan,
  onToast,
  t,
  language
}: {
  plan: OperationPlan | null;
  selected?: SessionSummary;
  sessions: SessionSummary[];
  operationMode: OperationMode;
  onActiveRepair: () => void;
  onPlan: () => void;
  onToast: (message: string) => void;
  t: Copy;
  language: Language;
}) {
  const stagedSessions = getStagedSessions(plan, selected, sessions);

  const apply = async () => {
    if (!plan) return;
    let forceCloseCodex = false;
    if (plan.requiresCodexClosed) {
      forceCloseCodex = window.confirm(t.forceCloseCodexConfirm);
      if (!forceCloseCodex) {
        onToast(t.forceCloseCancelled);
        return;
      }
    }
    const result = await api.applyOperation(plan.id, { forceCloseCodex });
    onToast(result.message);
  };

  return (
    <section className="widePane">
      <div className="detailHeader">
        <div>
          <p className="eyebrow">{t.repairEyebrow}</p>
          <h1>{operationTitle(operationMode, t)}</h1>
        </div>
        <div className="buttonGroup wrap">
          <button className="secondary" onClick={onActiveRepair}>
            <RefreshCw size={16} />
            {t.repairActive}
          </button>
          <button className="primary" onClick={onPlan} disabled={!selected}>
            <Wrench size={16} />
            {t.planSelectedThread}
          </button>
        </div>
      </div>
      {plan ? (
        <div className="operationStage">
          <aside className="stagedSessions">
            <div className="sectionTitle">{t.selectedForOperation}</div>
            {stagedSessions.map((session) => (
              <div className="stagedSessionCard" key={session.id}>
                <strong title={session.title}>{session.title || t.untitled}</strong>
                <span title={session.cwd}>{session.cwd || t.unknown}</span>
                <span>{formatTime(session.updatedAt, language)}</span>
                <code>{session.id}</code>
                <b className={codexAppStatusClass(session)}>{codexAppStatusLabel(session, t)}</b>
                <span>{codexAppRankLabel(session, t)}</span>
              </div>
            ))}
          </aside>
          <div className="plan">
            <div className="sectionTitle">{t.operationPanel}</div>
            <div className="callout repairExplanation">
              <Wrench size={18} />
              <span>{t.repairExplanation}</span>
            </div>
            <div className="callout">
              <ShieldAlert size={18} />
              <span>{t.writeGuard}</span>
            </div>
            {plan.actions.map((action) => (
              <div className="actionRow" key={`${action.kind}-${action.target}`}>
                <ChevronRight size={15} />
                <div>
                  <strong>{translateActionLabel(action, t)}</strong>
                  <span>{action.kind} · {action.target}</span>
                </div>
                {action.dangerous && <b className="pill danger">{t.danger}</b>}
              </div>
            ))}
            {!!plan.dryRunDiffs.length && (
              <div className="diffList">
                {plan.dryRunDiffs.map((diff) => (
                  <code key={diff}>{translateDryRunDiff(diff, t)}</code>
                ))}
              </div>
            )}
            {plan.warnings.map((warning) => (
              <div className="warning" key={warning}>{translateWarning(warning, t)}</div>
            ))}
            <button className="secondary" onClick={apply}>{t.applyGuardedOperation}</button>
          </div>
        </div>
      ) : (
        <div className="operationStage emptyStage">
          <aside className="stagedSessions">
            <div className="sectionTitle">{t.selectedForOperation}</div>
            {selected ? (
              <div className="stagedSessionCard">
                <strong title={selected.title}>{selected.title || t.untitled}</strong>
                <span title={selected.cwd}>{selected.cwd || t.unknown}</span>
                <span>{formatTime(selected.updatedAt, language)}</span>
                <code>{selected.id}</code>
              </div>
            ) : (
              <EmptyPanel title={t.noSessionSelected} />
            )}
          </aside>
          <div className="plan emptyPlan">
            <EmptyPanel title={t.selectThreadPlan} />
            <div className="buttonGroup wrap">
              <button className="secondary" onClick={onActiveRepair}>
                <RefreshCw size={16} />
                {t.repairActive}
              </button>
              <button className="primary" onClick={onPlan} disabled={!selected}>
                <Wrench size={16} />
                {t.planSelectedThread}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function getStagedSessions(plan: OperationPlan | null, selected: SessionSummary | undefined, sessions: SessionSummary[]) {
  const ids = plan?.affectedSessions?.length ? plan.affectedSessions : selected ? [selected.id] : [];
  const seen = new Set<string>();
  const staged = ids
    .filter((id) => {
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .map((id) => sessions.find((session) => session.id === id))
    .filter((session): session is SessionSummary => Boolean(session));
  if (!staged.length && selected) return [selected];
  return staged;
}

function operationTitle(mode: OperationMode, t: Copy) {
  const titles: Record<OperationMode, string> = {
    repair: t.repairWorkbench,
    activeRepair: t.repairActive,
    clone: t.cloneProvider,
    migrate: t.migrateProvider,
    cleanup: t.backupsCleanup,
    restore: t.previewRestore
  };
  return titles[mode];
}

function SkillsManager({ skills, onToast, t }: { skills: SkillSummary[]; onToast: (message: string) => void; t: Copy }) {
  const exportCustom = async () => {
    const result = await api.exportSkills({ kinds: ["custom", "linked"] });
    onToast(`${t.skillsManager}: ${result.path}`);
  };

  return (
    <section className="widePane">
      <div className="detailHeader">
        <div>
          <p className="eyebrow">{t.skillsEyebrow}</p>
          <h1>{t.skillsManager}</h1>
        </div>
        <button className="primary" onClick={exportCustom}>
          <PackageOpen size={16} />
          {t.exportCustom}
        </button>
      </div>
      <div className="table">
        {skills.map((skill) => (
          <div className="tableRow" key={skill.path}>
            <Sparkles size={16} />
            <strong>{skill.name}</strong>
            <span>{skill.kind}</span>
            <span>{skill.hasSkillMd ? "SKILL.md" : t.folder}</span>
            <span>{skill.path}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function BundlesMigration({ sessions, onToast, t }: { sessions: SessionSummary[]; onToast: (message: string) => void; t: Copy }) {
  const exportProject = async () => {
    const result = await api.exportBundle({ sessionIds: sessions.map((session) => session.id), includeSensitive: false });
    onToast(`Bundle: ${result.path}`);
  };

  return (
    <section className="widePane">
      <div className="detailHeader">
        <div>
          <p className="eyebrow">{t.bundlesEyebrow}</p>
          <h1>{t.bundlesMigration}</h1>
        </div>
        <button className="primary" onClick={exportProject}>
          <Import size={16} />
          {t.exportCurrentFilter}
        </button>
      </div>
      <div className="callout">
        <ShieldAlert size={18} />
        <span>{t.sensitiveNotice}</span>
      </div>
      <div className="metricGrid">
        <Metric label={t.selectedSessions} value={String(sessions.length)} />
        <Metric label={t.sensitiveDefault} value={t.excluded} />
        <Metric label={t.cwdMapping} value={t.onImport} />
        <Metric label={t.manifest} value="schema v1" />
      </div>
    </section>
  );
}

function GitHubSync({
  status,
  onToast,
  onRefresh,
  t
}: {
  status: GitStatus | null;
  onToast: (message: string) => void;
  onRefresh: () => void;
  t: Copy;
}) {
  const pull = async () => {
    const result = await api.githubPull("./codex_bundles");
    onToast(result.message);
    onRefresh();
  };
  const push = async () => {
    const result = await api.githubPush("./codex_bundles");
    onToast(result.message);
    onRefresh();
  };

  return (
    <section className="widePane">
      <div className="detailHeader">
        <div>
          <p className="eyebrow">./codex_bundles</p>
          <h1>GitHub Sync</h1>
        </div>
        <div className="buttonGroup">
          <button className="secondary" onClick={pull}>Pull</button>
          <button className="primary" onClick={push}>Push</button>
        </div>
      </div>
      <div className="metricGrid">
        <Metric label={t.repo} value={status?.exists ? t.found : t.missing} />
        <Metric label={t.branch} value={status?.branch || t.none} />
        <Metric label={t.dirty} value={status?.dirty ? t.yes : t.no} />
        <Metric label={t.aheadBehind} value={`${status?.ahead || 0}/${status?.behind || 0}`} />
      </div>
      <div className="table">
        {(status?.summary || []).map((line) => (
          <div className="tableRow" key={line}>
            <FolderGit2 size={16} />
            <span>{line}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function BackupsCleanup({
  backups,
  cleanupCandidates,
  sessions,
  onPlan,
  onToast,
  t
}: {
  backups: BackupSummary[];
  cleanupCandidates: CleanupCandidate[];
  sessions: SessionSummary[];
  onPlan: (plan: OperationPlan, mode?: OperationMode) => void;
  onToast: (message: string) => void;
  t: Copy;
}) {
  const restore = async (path: string) => {
    const plan = await api.restoreBackup(path);
    onToast(`${plan.title}: ${plan.actions.length} planned actions`);
  };
  const planCleanup = async (kind: string, ids?: string[]) => {
    const plan = await api.planCleanupOperation({ kind, ids, includeArchived: kind === "archived_rollouts" });
    onPlan(plan, "cleanup");
  };

  return (
    <section className="widePane">
      <div className="detailHeader">
        <div>
          <p className="eyebrow">{t.backupsEyebrow}</p>
          <h1>{t.backupsCleanup}</h1>
        </div>
      </div>
      <div className="metricGrid">
        <Metric label={t.nav.backups} value={String(backups.length)} />
        <Metric label={t.archived} value={String(sessions.filter((session) => session.archived).length)} />
        <Metric label={t.protectedIds} value={String(sessions.filter((session) => !session.archived).length)} />
        <Metric label={t.dryRun} value={t.required} />
      </div>
      <div className="buttonGroup wrap maintenanceActions">
        <button className="secondary" onClick={() => planCleanup("old_provider_clones", cleanupCandidates.map((item) => item.id))}>
          <Trash2 size={16} />
          {t.oldProviderClones}
        </button>
        <button className="secondary" onClick={() => planCleanup("archived_rollouts")}>
          <Archive size={16} />
          {t.archivedRollouts}
        </button>
        <button className="secondary" onClick={() => planCleanup("duplicate_clones")}>
          <Trash2 size={16} />
          {t.duplicateClones}
        </button>
      </div>
      <div className="sectionTitle">{t.cleanupCandidates}</div>
      <div className="table compact">
        {cleanupCandidates.map((candidate) => (
          <div className="tableRow" key={candidate.id}>
            <Trash2 size={16} />
            <strong>{candidate.title}</strong>
            <span>{candidate.provider}</span>
            <span>{candidate.replacementId || candidate.reason}</span>
            <button className="mini" onClick={() => planCleanup("old_provider_clones", [candidate.id])}>{t.planCleanup}</button>
          </div>
        ))}
      </div>
      <div className="sectionTitle">{t.nav.backups}</div>
      <div className="table">
        {backups.map((backup) => (
          <div className="tableRow" key={backup.path}>
            <Archive size={16} />
            <strong>{backup.name}</strong>
            <span>{backup.files.length} {t.files}</span>
            <span>{backup.path}</span>
            <button className="mini" onClick={() => restore(backup.path)}>{t.previewRestore}</button>
          </div>
        ))}
      </div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="infoRow">
      <span>{label}</span>
      <code>{value}</code>
    </div>
  );
}

function EmptyPanel({ title }: { title: string }) {
  return (
    <section className="emptyPanel">
      <PackageOpen size={28} />
      <strong>{title}</strong>
    </section>
  );
}

function translateActionLabel(action: OperationAction, t: Copy) {
  const labels: Record<string, string> = {
    add_saved_workspace: "登记工作区根目录",
    add_project_order: "加入侧栏项目顺序",
    set_thread_workspace_hint: "修复会话工作区映射",
    activate_workspace: "激活工作区",
    bring_thread_to_front: "把会话放回最近列表前排",
    set_thread_source: "修复 thread_source",
    upsert_session_index: "补回 active 会话索引",
    remove_projectless_thread: "移除项目过滤遮挡",
    clear_sidebar_collapsed_state: "清理侧栏折叠/筛选状态",
    clone_provider_session: "复制会话到当前 Provider",
    migrate_provider_session: "迁移会话到当前 Provider",
    delete_archived_rollout: "删除归档 rollout",
    delete_old_provider_session: "删除已确认复制的旧 Provider 会话",
    delete_duplicate_clone: "清理旧版重复副本",
    preview_cleanup: "预演清理候选"
  };

  if (t === copy.en) {
    return action.label;
  }
  return labels[action.kind] || action.label;
}

function translateWarning(warning: string, t: Copy) {
  if (t === copy.en) return warning;
  const normalized = warning.toLowerCase();
  if (normalized.includes("codex app/cli should be closed") || normalized.includes("codex appears to be running")) {
    return "写入前需要关闭 Codex App/CLI。";
  }
  if (normalized.includes("backup of state_5.sqlite") || normalized.includes("creates a backup")) {
    return "写入前会先备份 state_5.sqlite、WAL/SHM、session_index.jsonl、全局状态和相关 rollout 文件。";
  }
  if (normalized.includes("clone preserves")) {
    return "复制会保留旧 Provider 会话，并在新副本中记录 cloned_from 关系。";
  }
  if (normalized.includes("migration changes")) {
    return "迁移会直接修改现有会话的 Provider，并同步执行 Desktop 显示修复。";
  }
  if (normalized.includes("cleanup uses confirmed candidates")) {
    return "清理只处理已确认的候选项，并且删除前会创建备份。";
  }
  if (normalized.includes("mock plan")) {
    return "浏览器预览里的模拟计划；真实写入需要在 Tauri 桌面应用中执行。";
  }
  return warning;
}

function translateDryRunDiff(diff: string, t: Copy) {
  if (t === copy.en) return diff;
  const repairMatch = diff.match(/^(.+): (\d+) repair actions$/);
  if (repairMatch) {
    return `${repairMatch[1]}：计划执行 ${repairMatch[2]} 个修复动作`;
  }
  if (diff.includes("Create provider clone from")) {
    return diff.replace("Create provider clone from", "创建 Provider 副本，来源会话").replace("and preserve original", "，并保留原会话");
  }
  if (diff.includes("Change") && diff.includes("provider")) {
    return diff.replace("Change", "修改").replace("provider", "Provider");
  }
  if (diff === "Mock dry-run diff") {
    return "模拟预演变更";
  }
  return diff;
}

function translateValue(value: string, t: Copy) {
  const normalized = value.toLowerCase();
  const map: Record<string, string> = {
    present: t.present,
    missing: t.missing,
    found: t.found,
    visible: t.sidebarVisible,
    "needs workspace hint/order": t.sidebarHidden,
    "missing workspace hint": t.sidebarHidden,
    "indexed but not in current thread list": t === copy.zh ? "已索引，但不在当前侧栏线程清单" : "indexed, not in current sidebar thread list",
    "not in current thread list": t === copy.zh ? "不在当前侧栏线程清单" : "not in current sidebar thread list",
    "unverified, app-server thread/list unavailable": t === copy.zh ? "无法验证：Codex app-server thread/list 不可用" : "unverified: app-server thread/list unavailable"
  };
  if (normalized.startsWith("listed,")) {
    return t === copy.zh
      ? value.replace("listed", "Codex App 列表中").replace("first page", "首屏").replace("scanned", "已扫描")
      : value;
  }
  if (normalized.startsWith("local only,")) {
    return t === copy.zh
      ? value.replace("local only, not in thread/list", "本地存在但未在 Codex App 列表中").replace("first page", "首屏").replace("scanned", "已扫描")
      : value;
  }
  return map[normalized] || value;
}

function translateDiagnosticLabel(label: string, t: Copy) {
  const map: Record<string, string> = {
    "Sidebar visibility": t.nav.sessions,
    "Codex sidebar": "Codex sidebar",
    "Codex App thread/list": "Codex App thread/list",
    "session_index.jsonl": "session_index.jsonl",
    "rollout file": "rollout file"
  };
  return map[label] || label;
}
