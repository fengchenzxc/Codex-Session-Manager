export function parseSessionIndex(content) {
  if (!content || typeof content !== "string") return [];

  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const row = JSON.parse(line);
        if (!row || typeof row.id !== "string") return [];
        return [
          {
            id: row.id,
            title: row.thread_name || row.title || "Untitled",
            updatedAt: row.updated_at || row.updatedAt || null,
            raw: row
          }
        ];
      } catch {
        return [];
      }
    });
}

export function summarizeGlobalState(raw) {
  const state = raw && typeof raw === "object" ? raw : {};
  const persisted = state["electron-persisted-atom-state"] || {};
  const threadHints =
    state["thread-workspace-root-hints"] ||
    persisted["thread-workspace-root-hints"] ||
    {};

  const activeWorkspaces = state["active-workspace-roots"] || persisted["active-workspace-roots"] || [];
  const savedWorkspaces =
    state["electron-saved-workspace-roots"] ||
    persisted["electron-saved-workspace-roots"] ||
    [];
  const projectOrder = state["project-order"] || persisted["project-order"] || [];
  const pinnedThreadIds = state["pinned-thread-ids"] || persisted["pinned-thread-ids"] || [];
  const projectlessThreadIds =
    state["projectless-thread-ids"] || persisted["projectless-thread-ids"] || [];
  const heartbeatThreadIds = Object.keys(
    state["heartbeat-thread-permissions-by-id"] ||
      persisted["heartbeat-thread-permissions-by-id"] ||
      {}
  );

  return {
    activeWorkspace: activeWorkspaces[0] || null,
    activeWorkspaces,
    savedWorkspaceCount: savedWorkspaces.length,
    savedWorkspaces,
    projectOrder,
    threadHints,
    pinnedThreadIds,
    projectlessThreadIds,
    heartbeatThreadIds
  };
}

export function planSidebarRepair(session, state) {
  const actions = [];
  const cwd = session?.cwd;
  const id = session?.id;
  if (!id || !cwd) return { id: `repair-${Date.now()}`, dryRun: true, actions };

  const saved = state?.savedWorkspaces || [];
  const order = state?.projectOrder || [];
  const active = state?.activeWorkspaces || [];
  const hints = state?.threadHints || {};

  if (!saved.includes(cwd)) {
    actions.push({
      kind: "add_saved_workspace",
      target: cwd,
      label: `Add workspace root ${cwd}`
    });
  }
  if (!order.includes(cwd)) {
    actions.push({
      kind: "add_project_order",
      target: cwd,
      label: `Add ${cwd} to sidebar project order`
    });
  }
  if (hints[id] !== cwd) {
    actions.push({
      kind: "set_thread_workspace_hint",
      target: id,
      value: cwd,
      label: `Point thread ${id} to ${cwd}`
    });
  }
  if (active[0] !== cwd) {
    actions.push({
      kind: "activate_workspace",
      target: cwd,
      label: `Make ${cwd} the active workspace`
    });
  }
  actions.push({
    kind: "bring_thread_to_front",
    target: id,
    label: `Move ${id} to the recent thread pool front`
  });

  if (Object.prototype.hasOwnProperty.call(session, "threadSource") && !session.threadSource) {
    actions.push({
      kind: "set_thread_source",
      target: id,
      value: "user",
      label: `Set thread_source for ${id}`
    });
  }
  if (session.inSessionIndex === false) {
    actions.push({
      kind: "upsert_session_index",
      target: id,
      label: `Ensure ${id} is registered in session_index.jsonl`
    });
  }
  if (state?.projectlessThreadIds?.includes?.(id) && cwd) {
    actions.push({
      kind: "remove_projectless_thread",
      target: id,
      label: `Remove ${id} from projectless sidebar filter`
    });
  }
  const collapsedGroups = state?.collapsedGroups || {};
  const collapsedSections = state?.collapsedSections || {};
  if (collapsedGroups[cwd] || collapsedSections.projects || collapsedSections.sessions) {
    actions.push({
      kind: "clear_sidebar_collapsed_state",
      target: cwd,
      label: `Clear collapsed sidebar state for ${cwd}`
    });
  }

  return {
    id: `repair-${id}`,
    dryRun: true,
    sessionId: id,
    title: `Repair Codex sidebar visibility for ${session.title || id}`,
    actions
  };
}

export function isInternalSession(session) {
  const source = String(session?.source || "").toLowerCase();
  const threadSource = String(session?.threadSource || session?.thread_source || "").toLowerCase();
  const title = String(session?.title || "");
  return (
    threadSource === "subagent" ||
    source.includes("\"subagent\"") ||
    title.startsWith("The following is the Codex agent history whose request action you are assessing.")
  );
}

export function filterUserFacingSessions(sessions) {
  return (sessions || []).filter((session) => !isInternalSession(session));
}

export function applyCodexAppListSnapshot(sessions, snapshot = {}) {
  const available = snapshot.available === true;
  const firstPageSize = Number.isFinite(snapshot.firstPageSize) && snapshot.firstPageSize > 0
    ? snapshot.firstPageSize
    : 50;
  const threads = Array.isArray(snapshot.threads) ? snapshot.threads : [];
  const byId = new Map(
    threads
      .filter((thread) => thread?.id)
      .map((thread, index) => [thread.id, { ...thread, rank: index + 1 }])
  );

  return (sessions || []).map((session) => {
    const listed = byId.get(session.id);
    const status = !available ? "unverified" : listed ? "listed" : "local_only";
    const rank = listed?.rank ?? null;
    const firstPage = rank == null ? false : rank <= firstPageSize;
    return {
      ...session,
      visibleInSidebar: status === "listed",
      codexAppStatus: status,
      codexThreadStatus: listed?.status || null,
      codexAppListRank: rank,
      codexAppListScanned: available ? threads.length : 0,
      codexAppFirstPage: firstPage,
      codexAppFirstPageSize: firstPageSize,
      codexAppFirstPagePosition: firstPage ? rank : 0
    };
  });
}

export function isDesktopVisible(session, state) {
  if (!session || isInternalSession(session)) return false;
  if (session.archived || session.hasRollout === false) return false;
  const id = session.id;
  if (!id) return false;
  if (state?.projectlessThreadIds?.includes?.(id)) return false;
  return state?.heartbeatThreadIds?.includes?.(id) === true;
}

export function readRolloutMetadata(content) {
  const meta = {};
  if (!content || typeof content !== "string") return meta;
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      const payload = row?.payload || row;
      if (row?.type === "session_meta" || payload?.type === "session_meta") {
        meta.id = payload.id || meta.id;
        meta.provider = payload.model_provider || payload.provider || meta.provider;
        meta.source = payload.source || meta.source;
        meta.cwd = payload.cwd || meta.cwd;
        meta.clonedFrom = payload.cloned_from || payload.clonedFrom || meta.clonedFrom;
        return meta;
      }
    } catch {
      // Ignore malformed rollout rows.
    }
  }
  return meta;
}

export function parseRolloutMessages(content, options = {}) {
  if (!content || typeof content !== "string") return [];
  const maxMessages = options.maxMessages ?? Number.POSITIVE_INFINITY;
  const maxTextChars = options.maxTextChars ?? Number.POSITIVE_INFINITY;
  const messages = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line, index) => {
      try {
        return normalizeRolloutRow(JSON.parse(line), index);
      } catch {
        return [];
      }
    });
  return messages
    .slice(Math.max(0, messages.length - maxMessages))
    .map((message) => ({
      ...message,
      text: truncateText(message.text, maxTextChars)
    }));
}

function normalizeRolloutRow(row, index) {
  const payload = row?.payload || row;
  if (!payload || row?.type === "session_meta" || payload.type === "session_meta") return [];

  if (payload.type === "message" || payload.role) {
    const text = extractContentText(payload.content);
    if (!text) return [];
    return [{
      id: `${index}`,
      kind: "message",
      role: payload.role || "unknown",
      text,
      timestamp: row.timestamp || payload.timestamp || ""
    }];
  }

  if (payload.type === "reasoning") {
    const text = extractContentText(payload.summary || payload.content || payload.text);
    if (!text) return [];
    return [{ id: `${index}`, kind: "reasoning", role: "assistant", text, timestamp: row.timestamp || "" }];
  }

  if (payload.type === "function_call" || payload.type === "tool_call") {
    return [{
      id: `${index}`,
      kind: "tool_call",
      role: "tool",
      text: [payload.name, payload.arguments].filter(Boolean).join("\n"),
      toolName: payload.name || "",
      callId: payload.call_id || payload.id || "",
      timestamp: row.timestamp || ""
    }];
  }

  if (payload.type === "function_call_output" || payload.type === "tool_output") {
    return [{
      id: `${index}`,
      kind: "tool_output",
      role: "tool",
      text: extractContentText(payload.output || payload.content),
      callId: payload.call_id || payload.id || "",
      timestamp: row.timestamp || ""
    }];
  }

  if (row.type === "event_msg" && payload.message) {
    return [{ id: `${index}`, kind: "event", role: "system", text: String(payload.message), timestamp: row.timestamp || "" }];
  }

  return [{
    id: `${index}`,
    kind: "raw",
    role: "system",
    text: JSON.stringify(row),
    timestamp: row.timestamp || ""
  }];
}

function extractContentText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return item;
        return item?.text || item?.content || item?.summary || "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (typeof content === "object") {
    return content.text || content.content || content.summary || JSON.stringify(content);
  }
  return String(content);
}

function truncateText(text, maxChars) {
  if (!Number.isFinite(maxChars) || !text || text.length <= maxChars) return text || "";
  return `${text.slice(0, maxChars)}\n...[truncated ${text.length - maxChars} chars]`;
}

export function listCleanupCandidates(sessions, currentProvider) {
  const replacements = new Map();
  for (const session of sessions || []) {
    if (session.provider === currentProvider && session.clonedFrom) {
      replacements.set(session.clonedFrom, session.id);
    }
  }
  return (sessions || [])
    .filter((session) => session.provider !== currentProvider && replacements.has(session.id))
    .map((session) => ({
      id: session.id,
      provider: session.provider,
      rolloutPath: session.rolloutPath,
      archived: Boolean(session.archived),
      replacementId: replacements.get(session.id)
    }));
}

export function isSensitivePath(path) {
  const normalized = String(path || "").toLowerCase();
  return [
    "/auth.json",
    "/cookies",
    "/login data",
    "/crashpad/",
    "/cache/",
    "/gpucache/",
    "/session storage/",
    "/local storage/",
    "token",
    "secret"
  ].some((pattern) => normalized.includes(pattern));
}

export function classifySkill(entry) {
  if (!entry) return "custom";
  if (entry.name === ".system" || entry.path?.includes("/.system")) return "system";
  if (entry.isSymlink) return "linked";
  if (entry.path?.includes("/plugins/") || entry.path?.includes("/plugin")) return "plugin";
  return "custom";
}
