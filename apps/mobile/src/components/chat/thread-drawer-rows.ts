import type { ThreadSummary, WorkspaceSummary } from "@aias00/codex-relay/api-schema";

import { workspaceName } from "../../lib/workspace-name";

const collapsedProjectThreadCount = 5;

export type DrawerRow =
  | { id: "pinned"; kind: "pinned" }
  | {
      id: string;
      kind: "project";
      projectKey: string;
      title: string;
      workspacePath?: string;
    }
  | {
      id: string;
      kind: "thread";
      projectKey: string;
      thread: ThreadSummary;
      workspaceTitle?: string;
    }
  | { id: string; kind: "more"; hiddenCount: number; projectKey: string };

type ThreadGroup = {
  title: string;
  threads: ThreadSummary[];
  workspacePath?: string;
};

export function buildDrawerRows(
  threads: ThreadSummary[],
  expandedProjects: Record<string, boolean>,
  activeThreadId: string | undefined,
  pinnedThreadIds: string[] = [],
  forceExpanded = false,
  workspaceSummaries: WorkspaceSummary[] = [],
): DrawerRow[] {
  const uniqueThreads = threadsWithUniqueIds(threads);
  const threadsById = new Map(uniqueThreads.map((thread) => [thread.id, thread]));
  const pinnedThreads = forceExpanded ? [] : pinnedThreadsForIds(pinnedThreadIds, threadsById);
  const pinnedThreadIdsSet = new Set(pinnedThreads.map((thread) => thread.id));
  const groups = new Map<string, ThreadGroup>();
  const summariesByPath = new Map(
    workspaceSummaries.map((summary) => [summary.canonicalPath, summary]),
  );

  if (!forceExpanded) {
    for (const summary of workspaceSummaries) {
      groups.set(summary.workspaceId, {
        title: summary.displayName,
        threads: [],
        workspacePath: summary.canonicalPath,
      });
    }
  }

  for (const thread of uniqueThreads) {
    const summary = thread.cwd ? summariesByPath.get(thread.cwd) : undefined;
    const title = summary?.displayName ?? workspaceName(thread.cwd) ?? "codex-relay";
    const projectKey = summary?.workspaceId ?? thread.workspaceId ?? thread.cwd ?? title;
    const group = groups.get(projectKey);
    if (group) {
      group.threads.push(thread);
    } else {
      groups.set(projectKey, { title, threads: [thread], workspacePath: thread.cwd });
    }
  }

  const rows: DrawerRow[] = [];
  if (pinnedThreads.length > 0) {
    rows.push({ id: "pinned", kind: "pinned" });
    rows.push(
      ...pinnedThreads.map((thread) =>
        threadRow(
          thread,
          projectKeyForThread(thread, summariesByPath),
          workspaceName(thread.cwd) ?? "codex-relay",
        ),
      ),
    );
  }

  for (const [projectKey, group] of groups) {
    const unpinnedThreads = forceExpanded
      ? group.threads
      : group.threads.filter((thread) => !pinnedThreadIdsSet.has(thread.id));
    const isExpanded = forceExpanded || (expandedProjects[projectKey] ?? false);
    const activeThread = activeThreadId
      ? unpinnedThreads.find((thread) => thread.id === activeThreadId)
      : undefined;
    const collapsedThreads = unpinnedThreads.slice(0, collapsedProjectThreadCount);
    const visibleThreads =
      isExpanded || !activeThread || collapsedThreads.includes(activeThread)
        ? isExpanded
          ? unpinnedThreads
          : collapsedThreads
        : [...collapsedThreads.slice(0, collapsedProjectThreadCount - 1), activeThread];
    const hiddenCount = unpinnedThreads.length - visibleThreads.length;

    rows.push({
      id: `project:${projectKey}`,
      kind: "project",
      projectKey,
      title: group.title,
      workspacePath: group.workspacePath,
    });
    rows.push(...visibleThreads.map((thread) => threadRow(thread, projectKey)));

    if (hiddenCount > 0) {
      rows.push({
        id: `more:${projectKey}`,
        kind: "more",
        hiddenCount,
        projectKey,
      });
    }
  }

  return rows;
}

function threadsWithUniqueIds(threads: ThreadSummary[]) {
  const threadIds = new Set<string>();
  return threads.filter((thread) => {
    if (threadIds.has(thread.id)) {
      return false;
    }
    threadIds.add(thread.id);
    return true;
  });
}

function pinnedThreadsForIds(pinnedThreadIds: string[], threadsById: Map<string, ThreadSummary>) {
  const pinnedIds = new Set<string>();
  const pinnedThreads: ThreadSummary[] = [];
  for (const threadId of pinnedThreadIds) {
    if (pinnedIds.has(threadId)) {
      continue;
    }
    pinnedIds.add(threadId);
    const thread = threadsById.get(threadId);
    if (thread) {
      pinnedThreads.push(thread);
    }
  }
  return pinnedThreads;
}

function projectKeyForThread(
  thread: ThreadSummary,
  summariesByPath: Map<string, WorkspaceSummary> = new Map(),
) {
  const summary = thread.cwd ? summariesByPath.get(thread.cwd) : undefined;
  const title = workspaceName(thread.cwd) ?? "codex-relay";
  return summary?.workspaceId ?? thread.workspaceId ?? thread.cwd ?? title;
}

function threadRow(thread: ThreadSummary, projectKey: string, workspaceTitle?: string): DrawerRow {
  return {
    id: `thread:${thread.id}`,
    kind: "thread",
    projectKey,
    thread,
    ...(workspaceTitle ? { workspaceTitle } : {}),
  };
}
