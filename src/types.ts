export type SessionSource = "desktop" | "cli" | "vscode" | "unknown" | string;

export type SessionSummary = {
  id: string;
  title: string;
  provider: string;
  source: SessionSource;
  threadSource: string;
  cwd: string;
  rolloutPath: string;
  updatedAt: number;
  createdAt: number;
  archived: boolean;
  tokensUsed: number;
  preview: string;
  inSessionIndex: boolean;
  hasRollout: boolean;
  visibleInSidebar: boolean;
  codexAppStatus: "listed" | "local_only" | "unverified" | string;
  codexThreadStatus?: string | null;
  codexAppListRank?: number | null;
  codexAppListScanned: number;
  codexAppFirstPage: boolean;
  codexAppFirstPageSize: number;
  codexAppFirstPagePosition: number;
  clonedFrom?: string;
  desktopStatus: string;
  repairFlags: string[];
  providerMatchesCurrent: boolean;
};

export type ProjectSummary = {
  path: string;
  sessionCount: number;
  visibleCount: number;
  codexAppRankMin?: number | null;
  codexAppRankMax?: number | null;
  codexAppFirstPageCount: number;
  codexAppFirstPageSize: number;
  latestUpdatedAt: number;
  pinned: boolean;
  active: boolean;
};

export type CodexInventory = {
  codexHome: string;
  desktopDbPath: string;
  sessionIndexPath: string;
  globalStatePath: string;
  totalSessions: number;
  archivedSessions: number;
  visibleSessions: number;
  projects: ProjectSummary[];
  sessions: SessionSummary[];
  archivedRollouts: string[];
  warnings: string[];
};

export type SessionDetail = {
  session: SessionSummary;
  globalState: {
    activeWorkspaces: string[];
    savedWorkspaces: string[];
    projectOrder: string[];
    pinnedThreadIds: string[];
    projectlessThreadIds: string[];
    heartbeatThreadIds: string[];
    threadWorkspaceHint?: string;
  };
  diagnostics: Diagnostic[];
  messages: ConversationItem[];
  rolloutPreview: string[];
};

export type ConversationItem = {
  id: string;
  kind: "message" | "reasoning" | "tool_call" | "tool_output" | "event" | "raw" | string;
  role: "user" | "assistant" | "tool" | "system" | "developer" | "unknown" | string;
  text: string;
  toolName?: string;
  callId?: string;
  timestamp?: string;
};

export type Diagnostic = {
  level: "ok" | "warn" | "danger";
  label: string;
  value: string;
};

export type OperationAction = {
  kind: string;
  label: string;
  target: string;
  value?: string;
  dangerous: boolean;
};

export type OperationPlan = {
  id: string;
  title: string;
  dryRun: boolean;
  requiresCodexClosed: boolean;
  backupRequired: boolean;
  scope?: string;
  affectedSessions: string[];
  backupFiles: string[];
  dryRunDiffs: string[];
  actions: OperationAction[];
  warnings: string[];
};

export type OperationResult = {
  ok: boolean;
  message: string;
  backupPath?: string;
  changedFiles: string[];
};

export type SkillSummary = {
  name: string;
  path: string;
  kind: "custom" | "system" | "linked" | "plugin";
  hasSkillMd: boolean;
  isSymlink: boolean;
  sizeBytes: number;
};

export type BackupSummary = {
  name: string;
  path: string;
  createdAt: number;
  files: string[];
};

export type GitStatus = {
  repoPath: string;
  exists: boolean;
  branch: string;
  dirty: boolean;
  ahead: number;
  behind: number;
  summary: string[];
  remoteUpdatedAt?: string;
};

export type BundleResult = {
  path: string;
  manifestPath: string;
  includedSessions: number;
  includedSkills: number;
  warnings: string[];
};

export type CleanupCandidate = {
  id: string;
  title: string;
  provider: string;
  rolloutPath: string;
  archived: boolean;
  reason: string;
  replacementId?: string;
};
