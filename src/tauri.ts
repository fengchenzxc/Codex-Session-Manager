import type {
  BackupSummary,
  BundleResult,
  CleanupCandidate,
  CodexInventory,
  GitStatus,
  OperationPlan,
  OperationResult,
  SessionDetail,
  SessionSummary,
  SkillSummary
} from "./types";

let tauriInvoke: null | ((command: string, args?: Record<string, unknown>) => Promise<unknown>) = null;

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const hasTauriRuntime =
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in window;

  if (!hasTauriRuntime) {
    return mockInvoke(command, args) as T;
  }

  if (!tauriInvoke) {
    try {
      const apiModule = await import("@tauri-apps/api/core");
      if (typeof apiModule.invoke !== "function") {
        throw new Error("Tauri invoke is not available in browser preview");
      }
      tauriInvoke = apiModule.invoke;
    } catch {
      return mockInvoke(command, args) as T;
    }
  }
  return (await tauriInvoke(command, args)) as T;
}

const mockSessions: SessionSummary[] = [
  {
    id: "demo-thread-0001",
    title: "Design a sidebar repair workflow",
    provider: "codex",
    source: "vscode",
    threadSource: "",
    cwd: "/Users/demo/Projects/codex-sidebar-repair",
    rolloutPath: "/Users/demo/.codex/sessions/2026/05/31/rollout-demo-0001.jsonl",
    updatedAt: Date.now(),
    createdAt: Date.now() - 7200000,
    archived: false,
    tokensUsed: 18422,
    preview: "Map Desktop thread state to the Codex App thread list",
    inSessionIndex: true,
    hasRollout: true,
    visibleInSidebar: true,
    codexAppStatus: "listed",
    codexThreadStatus: "idle",
    codexAppListRank: 64,
    codexAppListScanned: 77,
    codexAppFirstPage: false,
    codexAppFirstPageSize: 50,
    codexAppFirstPagePosition: 0,
    clonedFrom: undefined,
    desktopStatus: "listed",
    repairFlags: [],
    providerMatchesCurrent: true
  },
  {
    id: "demo-thread-0002",
    title: "Build Codex Session Manager",
    provider: "codex",
    source: "vscode",
    threadSource: "user",
    cwd: "/Users/demo/Projects/codex-session-manager",
    rolloutPath: "/Users/demo/.codex/sessions/2026/06/03/rollout-demo-0002.jsonl",
    updatedAt: Date.now() - 1000,
    createdAt: Date.now() - 3600000,
    archived: false,
    tokensUsed: 9418,
    preview: "Tauri + React desktop workflow implementation",
    inSessionIndex: true,
    hasRollout: true,
    visibleInSidebar: true,
    codexAppStatus: "listed",
    codexThreadStatus: "active",
    codexAppListRank: 1,
    codexAppListScanned: 77,
    codexAppFirstPage: true,
    codexAppFirstPageSize: 50,
    codexAppFirstPagePosition: 1,
    clonedFrom: undefined,
    desktopStatus: "listed",
    repairFlags: [],
    providerMatchesCurrent: true
  }
];

async function mockInvoke(command: string, args?: Record<string, unknown>) {
  if (command === "scan_codex_state") {
    return {
      codexHome: "~/.codex",
      desktopDbPath: "~/.codex/state_5.sqlite",
      sessionIndexPath: "~/.codex/session_index.jsonl",
      globalStatePath: "~/.codex/.codex-global-state.json",
      totalSessions: mockSessions.length,
      archivedSessions: 0,
      visibleSessions: 1,
      projects: [
        {
          path: "/Users/demo/Projects/codex-session-manager",
          sessionCount: 1,
          visibleCount: 1,
          codexAppRankMin: 1,
          codexAppRankMax: 1,
          codexAppFirstPageCount: 1,
          codexAppFirstPageSize: 50,
          latestUpdatedAt: mockSessions[1].updatedAt,
          pinned: false,
          active: true
        },
        {
          path: "/Users/demo/Projects/codex-sidebar-repair",
          sessionCount: 1,
          visibleCount: 1,
          codexAppRankMin: 64,
          codexAppRankMax: 64,
          codexAppFirstPageCount: 0,
          codexAppFirstPageSize: 50,
          latestUpdatedAt: mockSessions[0].updatedAt,
          pinned: true,
          active: false
        }
      ],
      sessions: mockSessions,
      archivedRollouts: [],
      warnings: ["Browser preview mode: Tauri backend is not connected."]
    } satisfies CodexInventory;
  }
  if (command === "query_sessions") return mockSessions;
  if (command === "get_session_detail") {
    const id = String(args?.id || "");
    const session = mockSessions.find((item) => item.id === id) || mockSessions[0];
    return {
      session,
      globalState: {
        activeWorkspaces: ["/Users/demo/Projects/codex-session-manager"],
        savedWorkspaces: mockSessions.map((item) => item.cwd),
        projectOrder: mockSessions.map((item) => item.cwd),
        pinnedThreadIds: [],
        projectlessThreadIds: [],
        heartbeatThreadIds: mockSessions.filter((item) => item.visibleInSidebar).map((item) => item.id),
        threadWorkspaceHint: session.visibleInSidebar ? session.cwd : undefined
      },
      diagnostics: [
        {
          level: session.codexAppStatus === "listed" ? "ok" : "warn",
          label: "Codex App thread/list",
          value: session.codexAppStatus === "listed"
            ? `listed, first page ${session.codexAppFirstPagePosition}/${session.codexAppFirstPageSize}, rank ${session.codexAppListRank}, scanned ${session.codexAppListScanned}`
            : `local only, not in thread/list, first page 0/${session.codexAppFirstPageSize}, scanned ${session.codexAppListScanned}`
        }
      ],
      messages: [
        {
          id: "mock-1",
          kind: "message",
          role: "user",
          text: "Please check why this Codex session is missing from the Desktop sidebar."
        },
        {
          id: "mock-2",
          kind: "message",
          role: "assistant",
          text: "The app parses rollout JSONL and renders user, assistant, reasoning, tool call, and tool output events as a conversation stream."
        }
      ],
      rolloutPreview: ["{\"type\":\"session_meta\",\"cwd\":\"" + session.cwd + "\"}"]
    } satisfies SessionDetail;
  }
  if (command === "get_current_provider") return "codex";
  if (command === "open_resume_terminal") {
    const request = (args?.request || {}) as Record<string, unknown>;
    return {
      ok: true,
      message: `Mock resumed ${request.id || "selected thread"} in ${request.terminal || "warp"} via a .tmp script`,
      changedFiles: []
    } satisfies OperationResult;
  }
  if (
    command === "plan_repair" ||
    command === "plan_desktop_repair" ||
    command === "plan_provider_clone" ||
    command === "plan_provider_migrate" ||
    command === "plan_cleanup_operation" ||
    command === "import_bundle" ||
    command === "restore_backup"
  ) {
    return {
      id: "mock-plan",
      title: "Dry-run repair plan",
      dryRun: true,
      requiresCodexClosed: true,
      backupRequired: true,
      scope: "active",
      affectedSessions: [String(args?.id || args?.request || "selected thread")],
      backupFiles: ["state_5.sqlite", ".codex-global-state.json", "session_index.jsonl"],
      dryRunDiffs: ["Mock dry-run diff"],
      actions: [
        {
          kind: "set_thread_workspace_hint",
          label: "Set thread workspace hint",
          target: String(args?.id || "selected thread"),
          value: "selected cwd",
          dangerous: false
        }
      ],
      warnings: ["Mock plan only. Run inside Tauri for real state changes."]
    } satisfies OperationPlan;
  }
  if (command === "apply_operation" || command === "github_pull" || command === "github_push") {
    return {
      ok: false,
      message: "This action requires the Tauri desktop backend.",
      changedFiles: []
    } satisfies OperationResult;
  }
  if (command === "list_skills") return [] satisfies SkillSummary[];
  if (command === "list_backups") return [] satisfies BackupSummary[];
  if (command === "list_cleanup_candidates") return [] satisfies CleanupCandidate[];
  if (command === "github_status") {
    return {
      repoPath: "./codex_bundles",
      exists: false,
      branch: "",
      dirty: false,
      ahead: 0,
      behind: 0,
      summary: ["No Git repo found in browser preview."]
    } satisfies GitStatus;
  }
  if (command === "export_bundle" || command === "export_skills") {
    return {
      path: "./codex_bundles/mock",
      manifestPath: "./codex_bundles/mock/manifest.json",
      includedSessions: 0,
      includedSkills: 0,
      warnings: ["Mock export only."]
    } satisfies BundleResult;
  }
  if (command === "import_skills") {
    return {
      id: "mock-import-skills",
      title: "Import skills dry-run",
      dryRun: true,
      requiresCodexClosed: false,
      backupRequired: true,
      scope: "skills",
      affectedSessions: [],
      backupFiles: [],
      dryRunDiffs: [],
      actions: [],
      warnings: []
    } satisfies OperationPlan;
  }
  throw new Error(`Unknown mock command: ${command}`);
}

export const api = {
  scanCodexState: () => invoke<CodexInventory>("scan_codex_state", { config: {} }),
  querySessions: (filter: Record<string, unknown>) => invoke<SessionSummary[]>("query_sessions", { filter }),
  getSessionDetail: (id: string) => invoke<SessionDetail>("get_session_detail", { id }),
  getCurrentProvider: () => invoke<string>("get_current_provider"),
  openResumeTerminal: (request: Record<string, unknown>) => invoke<OperationResult>("open_resume_terminal", { request }),
  planRepair: (id: string) => invoke<OperationPlan>("plan_repair", { request: { id } }),
  planDesktopRepair: (request: Record<string, unknown>) => invoke<OperationPlan>("plan_desktop_repair", { request }),
  planProviderClone: (request: Record<string, unknown>) => invoke<OperationPlan>("plan_provider_clone", { request }),
  planProviderMigrate: (request: Record<string, unknown>) => invoke<OperationPlan>("plan_provider_migrate", { request }),
  listCleanupCandidates: (request: Record<string, unknown>) => invoke<CleanupCandidate[]>("list_cleanup_candidates", { request }),
  planCleanupOperation: (request: Record<string, unknown>) => invoke<OperationPlan>("plan_cleanup_operation", { request }),
  applyOperation: (planId: string, options?: { forceCloseCodex?: boolean }) =>
    invoke<OperationResult>("apply_operation", { request: { planId, forceCloseCodex: options?.forceCloseCodex || false } }),
  exportBundle: (request: Record<string, unknown>) => invoke<BundleResult>("export_bundle", { request }),
  importBundle: (request: Record<string, unknown>) => invoke<OperationPlan>("import_bundle", { request }),
  listSkills: () => invoke<SkillSummary[]>("list_skills"),
  exportSkills: (request: Record<string, unknown>) => invoke<BundleResult>("export_skills", { request }),
  importSkills: (request: Record<string, unknown>) => invoke<OperationPlan>("import_skills", { request }),
  githubStatus: (repoPath: string) => invoke<GitStatus>("github_status", { repoPath }),
  githubPull: (repoPath: string) => invoke<OperationResult>("github_pull", { repoPath }),
  githubPush: (repoPath: string) => invoke<OperationResult>("github_push", { repoPath }),
  listBackups: () => invoke<BackupSummary[]>("list_backups"),
  restoreBackup: (path: string) => invoke<OperationPlan>("restore_backup", { request: { path } })
};
