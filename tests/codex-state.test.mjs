import test from "node:test";
import assert from "node:assert/strict";

import {
  applyCodexAppListSnapshot,
  classifySkill,
  filterUserFacingSessions,
  isDesktopVisible,
  isInternalSession,
  isSensitivePath,
  listCleanupCandidates,
  parseSessionIndex,
  parseRolloutMessages,
  planSidebarRepair,
  readRolloutMetadata,
  summarizeGlobalState
} from "../src/shared/codex-state.mjs";

test("applyCodexAppListSnapshot uses official thread list ranks and first page status", () => {
  const sessions = [
    { id: "listed-first", title: "First page", hasRollout: true },
    { id: "listed-late", title: "Late page", hasRollout: true },
    { id: "local-only", title: "Local only", hasRollout: true }
  ];
  const appThreads = Array.from({ length: 77 }, (_, index) => ({
    id: index === 11 ? "listed-first" : index === 63 ? "listed-late" : `thread-${index}`,
    status: index === 63 ? "idle" : "notLoaded"
  }));

  const next = applyCodexAppListSnapshot(sessions, {
    available: true,
    firstPageSize: 50,
    threads: appThreads
  });

  assert.equal(next[0].codexAppStatus, "listed");
  assert.equal(next[0].codexAppListRank, 12);
  assert.equal(next[0].codexAppFirstPage, true);
  assert.equal(next[0].codexAppFirstPagePosition, 12);
  assert.equal(next[1].codexAppStatus, "listed");
  assert.equal(next[1].codexAppListRank, 64);
  assert.equal(next[1].codexAppFirstPage, false);
  assert.equal(next[1].codexAppFirstPagePosition, 0);
  assert.equal(next[1].codexThreadStatus, "idle");
  assert.equal(next[2].codexAppStatus, "local_only");
  assert.equal(next[2].codexAppListRank, null);
});

test("applyCodexAppListSnapshot marks sessions unverified when app-server is unavailable", () => {
  const [session] = applyCodexAppListSnapshot(
    [{ id: "thread-1", title: "Local", hasRollout: true }],
    { available: false, firstPageSize: 50, threads: [] }
  );

  assert.equal(session.codexAppStatus, "unverified");
  assert.equal(session.codexAppListScanned, 0);
});

test("parseSessionIndex ignores invalid jsonl and keeps valid sessions", () => {
  const rows = parseSessionIndex(
    [
      '{"id":"thread-1","thread_name":"Build app","updated_at":"2026-06-03T00:00:00Z"}',
      "not-json",
      '{"id":"thread-2","thread_name":"Repair sidebar","updated_at":"2026-06-03T00:01:00Z"}'
    ].join("\n")
  );

  assert.deepEqual(rows.map((row) => row.id), ["thread-1", "thread-2"]);
  assert.equal(rows[0].title, "Build app");
});

test("summarizeGlobalState finds workspace roots and sidebar hints", () => {
  const summary = summarizeGlobalState({
    "active-workspace-roots": ["/repo/current"],
    "electron-saved-workspace-roots": ["/repo/current", "/repo/other"],
    "project-order": ["/repo/other", "/repo/current"],
    "thread-workspace-root-hints": {
      "thread-1": "/repo/current"
    },
    "pinned-thread-ids": ["thread-2"],
    "heartbeat-thread-permissions-by-id": {
      "thread-1": { approvalPolicy: "on-request" }
    }
  });

  assert.equal(summary.activeWorkspace, "/repo/current");
  assert.equal(summary.savedWorkspaceCount, 2);
  assert.equal(summary.threadHints["thread-1"], "/repo/current");
  assert.equal(summary.pinnedThreadIds.includes("thread-2"), true);
  assert.equal(summary.heartbeatThreadIds.includes("thread-1"), true);
});

test("planSidebarRepair reports missing sidebar state without mutating input", () => {
  const state = {
    activeWorkspaces: ["/repo/current"],
    savedWorkspaces: ["/repo/current"],
    projectOrder: ["/repo/current"],
    threadHints: {}
  };

  const plan = planSidebarRepair(
    {
      id: "thread-1",
      title: "Repair",
      cwd: "/repo/other",
      rolloutPath: "/home/me/.codex/sessions/rollout.jsonl",
      provider: "codex"
    },
    state
  );

  assert.deepEqual(plan.actions.map((action) => action.kind), [
    "add_saved_workspace",
    "add_project_order",
    "set_thread_workspace_hint",
    "activate_workspace",
    "bring_thread_to_front"
  ]);
  assert.deepEqual(state.savedWorkspaces, ["/repo/current"]);
});

test("sensitive paths are excluded by default", () => {
  assert.equal(isSensitivePath("/Users/me/.codex/auth.json"), true);
  assert.equal(isSensitivePath("/Users/me/Library/Application Support/Codex/Cookies"), true);
  assert.equal(isSensitivePath("/Users/me/.codex/sessions/2026/rollout.jsonl"), false);
});

test("classifySkill separates system, symlink, plugin, and custom skills", () => {
  assert.equal(classifySkill({ name: ".system", path: "/x/.system", isSymlink: false }), "system");
  assert.equal(classifySkill({ name: "foo", path: "/x/foo", isSymlink: true }), "linked");
  assert.equal(classifySkill({ name: "plugin-skill", path: "/x/plugins/plugin-skill", isSymlink: false }), "plugin");
  assert.equal(classifySkill({ name: "custom", path: "/x/custom", isSymlink: false }), "custom");
});

test("filterUserFacingSessions excludes guardian approval records from project counts", () => {
  const sessions = filterUserFacingSessions([
    {
      id: "real",
      title: "开发 Codex Session Manager",
      source: "vscode",
      threadSource: "user",
      cwd: "/repo/app"
    },
    {
      id: "approval",
      title: "The following is the Codex agent history whose request action you are assessing.",
      source: "{\"subagent\":{\"other\":\"guardian\"}}",
      threadSource: "subagent",
      cwd: "/repo/app"
    }
  ]);

  assert.deepEqual(sessions.map((session) => session.id), ["real"]);
  assert.equal(isInternalSession({ source: "{\"subagent\":{\"other\":\"guardian\"}}", threadSource: "subagent" }), true);
});

test("isDesktopVisible treats heartbeat thread as sidebar visible even without project registration", () => {
  assert.equal(
    isDesktopVisible(
      {
        id: "thread-1",
        cwd: "/repo/app",
        archived: false,
        hasRollout: true,
        source: "vscode",
        threadSource: "user",
        inSessionIndex: true
      },
      {
        activeWorkspaces: ["/repo/app"],
        savedWorkspaces: [],
        projectOrder: [],
        threadHints: {},
        heartbeatThreadIds: ["thread-1"]
      }
    ),
    true
  );
});

test("isDesktopVisible does not treat searchable session_index records as openable sidebar threads", () => {
  for (const id of [
    "019e25c3-8fc5-7aa3-87e2-7035d846f4be",
    "019d064c-6496-7b60-9788-8858155abb1d"
  ]) {
    assert.equal(
      isDesktopVisible(
        {
          id,
          cwd: "/repo/app",
          archived: false,
          hasRollout: true,
          source: "vscode",
          threadSource: "",
          inSessionIndex: true
        },
        {
          heartbeatThreadIds: []
        }
      ),
      false
    );
  }
});

test("isDesktopVisible does not mark every rollout-backed thread as sidebar visible", () => {
  assert.equal(
    isDesktopVisible(
      {
        id: "thread-1",
        cwd: "",
        archived: false,
        hasRollout: true,
        source: "vscode",
        threadSource: ""
      },
      {
        activeWorkspaces: [],
        savedWorkspaces: [],
        projectOrder: [],
        threadHints: {}
      }
    ),
    false
  );
});

test("isDesktopVisible does not treat saved project state as per-thread sidebar visibility", () => {
  assert.equal(
    isDesktopVisible(
      {
        id: "thread-1",
        cwd: "/repo/app",
        archived: false,
        hasRollout: true,
        source: "vscode",
        threadSource: "user",
        inSessionIndex: false
      },
      {
        activeWorkspaces: [],
        savedWorkspaces: ["/repo/app"],
        projectOrder: ["/repo/app"],
        threadHints: {}
      }
    ),
    false
  );
});

test("isDesktopVisible treats workspace hint as repair metadata, not current sidebar visibility", () => {
  assert.equal(
    isDesktopVisible(
      {
        id: "thread-1",
        cwd: "/repo/app",
        archived: false,
        hasRollout: true,
        source: "vscode",
        threadSource: "user",
        inSessionIndex: false
      },
      {
        activeWorkspaces: [],
        savedWorkspaces: [],
        projectOrder: [],
        threadHints: { "thread-1": "/repo/app" }
      }
    ),
    false
  );
});

test("isDesktopVisible ignores conflicting workspace hint when heartbeat contains the thread", () => {
  assert.equal(
    isDesktopVisible(
      {
        id: "thread-1",
        cwd: "/repo/app",
        archived: false,
        hasRollout: true,
        source: "vscode",
        threadSource: "user",
        inSessionIndex: true
      },
      {
        savedWorkspaces: ["/repo/app"],
        projectOrder: ["/repo/app"],
        threadHints: { "thread-1": "/repo/other" },
        heartbeatThreadIds: ["thread-1"]
      }
    ),
    true
  );
});

test("isDesktopVisible allows heartbeat history when cwd is missing from projects", () => {
  assert.equal(
    isDesktopVisible(
      {
        id: "019d6c85-44d8-7eb0-b504-09116fcc8506",
        cwd: "/private/tmp/test",
        archived: false,
        hasRollout: true,
        source: "vscode",
        threadSource: "",
        inSessionIndex: true
      },
      {
        activeWorkspaces: [],
        savedWorkspaces: [],
        projectOrder: [],
        threadHints: {},
        heartbeatThreadIds: ["019d6c85-44d8-7eb0-b504-09116fcc8506"]
      }
    ),
    true
  );
});

test("isDesktopVisible keeps Codex App sidebar heartbeat threads visible for project sessions", () => {
  const state = {
    activeWorkspaces: [],
    savedWorkspaces: ["/Users/demo/Projects/diagram-tool"],
    projectOrder: ["/Users/demo/Projects/diagram-tool"],
    projectlessThreadIds: [],
    threadHints: {
      "demo-thread-a": "/Users/demo/Projects/diagram-tool",
      "demo-thread-b": "/Users/demo/Projects/diagram-tool"
    },
    heartbeatThreadIds: [
      "demo-thread-a",
      "demo-thread-b"
    ]
  };

  for (const id of state.heartbeatThreadIds) {
    assert.equal(
      isDesktopVisible(
        {
          id,
          cwd: "/Users/demo/Projects/diagram-tool",
          archived: false,
          hasRollout: true,
          source: "vscode",
          threadSource: "user",
          inSessionIndex: true
        },
        state
      ),
      true
    );
  }
});

test("isDesktopVisible keeps heartbeat threads visible even when workspace hint is absent", () => {
  const state = {
    projectlessThreadIds: [],
    threadHints: {},
    heartbeatThreadIds: [
      "019d4df4-b149-7390-8f41-f5b64459abb3",
      "019d776f-bea2-7e01-afde-a0234ef68fdd"
    ]
  };

  const sessions = [
    {
      id: "019d4df4-b149-7390-8f41-f5b64459abb3",
      cwd: "/private/tmp/classwinter"
    },
    {
      id: "019d776f-bea2-7e01-afde-a0234ef68fdd",
      cwd: "/Users/demo/Projects/archive/classwinter"
    }
  ];

  for (const session of sessions) {
    assert.equal(
      isDesktopVisible(
        {
          ...session,
          archived: false,
          hasRollout: true,
          source: "vscode",
          threadSource: "user",
          inSessionIndex: true
        },
        state
      ),
      true
    );
  }
});

test("isDesktopVisible excludes subagent approval records", () => {
  assert.equal(
    isDesktopVisible(
      {
        id: "approval",
        cwd: "/repo/app",
        archived: false,
        hasRollout: true,
        source: "{\"subagent\":{\"other\":\"guardian\"}}",
        threadSource: "subagent"
      },
      {
        savedWorkspaces: ["/repo/app"],
        projectOrder: ["/repo/app"],
        threadHints: {}
      }
    ),
    false
  );
});

test("parseRolloutMessages renders Codex-style conversation items", () => {
  const rows = [
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "请修复滚动" }]
      }
    },
    {
      type: "response_item",
      payload: {
        type: "reasoning",
        summary: [{ text: "Need inspect layout" }]
      }
    },
    {
      type: "response_item",
      payload: {
        type: "function_call",
        name: "rg",
        arguments: "{\"query\":\"overflow\"}",
        call_id: "call-1"
      }
    },
    {
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call-1",
        output: "body overflow hidden"
      }
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "已找到问题。" }]
      }
    }
  ].map((row) => JSON.stringify(row)).join("\n");

  const messages = parseRolloutMessages(rows);

  assert.deepEqual(messages.map((message) => message.kind), ["message", "reasoning", "tool_call", "tool_output", "message"]);
  assert.equal(messages[0].role, "user");
  assert.equal(messages[0].text, "请修复滚动");
  assert.equal(messages[4].role, "assistant");
});

test("parseRolloutMessages limits rendered items and truncates huge text", () => {
  const rows = Array.from({ length: 20 }, (_, index) =>
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: `call-${index}`,
        output: `${index}: ${"x".repeat(80)}`
      }
    })
  ).join("\n");

  const messages = parseRolloutMessages(rows, { maxMessages: 5, maxTextChars: 24 });

  assert.equal(messages.length, 5);
  assert.equal(messages[0].callId, "call-15");
  assert.equal(messages[0].text.length < 80, true);
  assert.match(messages[0].text, /truncated/);
});

test("readRolloutMetadata detects provider and cloned_from relation", () => {
  const metadata = readRolloutMetadata(
    [
      JSON.stringify({
        type: "session_meta",
        payload: {
          id: "new-session",
          model_provider: "codex",
          cloned_from: "old-session"
        }
      }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: "hello" } })
    ].join("\n")
  );

  assert.equal(metadata.id, "new-session");
  assert.equal(metadata.provider, "codex");
  assert.equal(metadata.clonedFrom, "old-session");
});

test("planSidebarRepair includes desktop state, source, and index repairs", () => {
  const plan = planSidebarRepair(
    {
      id: "thread-1",
      title: "Repair",
      cwd: "/repo/other",
      rolloutPath: "/home/me/.codex/sessions/rollout.jsonl",
      provider: "codex",
      threadSource: "",
      inSessionIndex: false,
      hasRollout: true
    },
    {
      activeWorkspaces: ["/repo/current"],
      savedWorkspaces: ["/repo/current"],
      projectOrder: ["/repo/current"],
      threadHints: {},
      projectlessThreadIds: ["thread-1"],
      collapsedGroups: { "/repo/other": true },
      collapsedSections: { projects: true }
    }
  );

  assert.deepEqual(plan.actions.map((action) => action.kind), [
    "add_saved_workspace",
    "add_project_order",
    "set_thread_workspace_hint",
    "activate_workspace",
    "bring_thread_to_front",
    "set_thread_source",
    "upsert_session_index",
    "remove_projectless_thread",
    "clear_sidebar_collapsed_state"
  ]);
});

test("listCleanupCandidates only returns old provider sessions with confirmed clones", () => {
  const candidates = listCleanupCandidates([
    { id: "old-1", provider: "kkcode", archived: false, rolloutPath: "/x/old-1.jsonl" },
    { id: "old-2", provider: "kkcode", archived: false, rolloutPath: "/x/old-2.jsonl" },
    { id: "new-1", provider: "codex", archived: false, clonedFrom: "old-1", rolloutPath: "/x/new-1.jsonl" }
  ], "codex");

  assert.deepEqual(candidates.map((item) => item.id), ["old-1"]);
  assert.equal(candidates[0].replacementId, "new-1");
});
