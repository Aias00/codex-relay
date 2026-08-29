import type { ThreadSummary } from "codex-relay/api-schema";

import type { WorkspaceCacheSelection } from "./server-state-workspace-cache";

export const threadDetailSwitchStaleTimeMs = 30_000;

export function threadSnapshotFetchOptions(refresh = false): {
  refresh?: boolean;
  staleTime?: number;
} {
  return refresh ? { refresh: true } : { staleTime: threadDetailSwitchStaleTimeMs };
}

export function workspaceSelectionForThread(
  thread: Pick<ThreadSummary, "cwd" | "workspaceId">,
): WorkspaceCacheSelection {
  return {
    workspaceId: thread.workspaceId,
    workspacePath: thread.cwd,
  };
}

export function shouldBlockThreadActivation(cachedDetail: unknown) {
  return cachedDetail === undefined;
}
