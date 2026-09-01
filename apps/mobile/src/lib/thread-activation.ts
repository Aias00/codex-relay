import type { ThreadSummary } from "codex-relay/api-schema";

import type { WorkspaceCacheSelection } from "./server-state-workspace-cache";

export const threadDetailSwitchStaleTimeMs = 30_000;

export function threadActivationTiming(input: {
  currentThreadId?: string;
  hasTargetDetail: boolean;
  targetThreadId?: string;
}) {
  return input.targetThreadId &&
    input.targetThreadId !== input.currentThreadId &&
    !input.hasTargetDetail
    ? ("after-snapshot" as const)
    : ("before-snapshot" as const);
}

export function threadSnapshotFetchOptions(
  refresh = false,
  isRunning = false,
): {
  refresh?: boolean;
  staleTime?: number;
} {
  if (refresh) {
    return { refresh: true };
  }
  return { staleTime: isRunning ? 0 : threadDetailSwitchStaleTimeMs };
}

export function isAuthoritativeThreadSnapshot(state: ThreadSummary["state"], refresh = false) {
  return refresh || state !== "running";
}

export function shouldAttachRunningThreadStream(thread: Pick<ThreadSummary, "state"> | undefined) {
  return thread?.state === "running";
}

export function runningThreadRecoveryMode(
  thread: Pick<ThreadSummary, "source" | "state"> | undefined,
  afterStreamFailure = false,
) {
  if (!shouldAttachRunningThreadStream(thread)) {
    return "none" as const;
  }
  return afterStreamFailure && thread?.source !== "app" ? ("poll" as const) : ("stream" as const);
}

export function workspaceSelectionForThread(
  thread: Pick<ThreadSummary, "cwd" | "workspaceId">,
): WorkspaceCacheSelection {
  return {
    workspaceId: thread.workspaceId,
    workspacePath: thread.cwd,
  };
}

export function shouldBlockThreadActivation(cachedDetail: unknown, isRunning = false) {
  return cachedDetail === undefined || isRunning;
}
