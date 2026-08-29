export type WorkspaceCacheSelection = {
  workspaceId?: string;
  workspacePath?: string;
};

export function normalizeWorkspaceCacheSelection(
  selection: WorkspaceCacheSelection | string | undefined,
): WorkspaceCacheSelection {
  if (typeof selection === "string") {
    return selection.trim() ? { workspacePath: selection.trim() } : {};
  }
  return {
    workspaceId: selection?.workspaceId?.trim() || undefined,
    workspacePath: selection?.workspacePath?.trim() || undefined,
  };
}

export function workspaceCacheIdentity(
  selection: WorkspaceCacheSelection | string | undefined,
): string | null {
  const normalized = normalizeWorkspaceCacheSelection(selection);
  if (normalized.workspaceId) {
    return `id:${normalized.workspaceId}`;
  }
  return normalized.workspacePath ?? null;
}

export function workspaceSelectionQuery(
  selection: WorkspaceCacheSelection | string | undefined,
): string {
  const normalized = normalizeWorkspaceCacheSelection(selection);
  const params = new URLSearchParams();
  if (normalized.workspaceId) {
    params.set("workspaceId", normalized.workspaceId);
  }
  if (normalized.workspacePath) {
    params.set("workspacePath", normalized.workspacePath);
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

export function filterThreadsForWorkspace<Thread extends { cwd?: string; workspaceId?: string }>(
  threads: Thread[],
  selection: WorkspaceCacheSelection | string,
): Thread[] {
  const normalized = normalizeWorkspaceCacheSelection(selection);
  return threads.filter((thread) => {
    if (normalized.workspaceId && thread.workspaceId) {
      return thread.workspaceId === normalized.workspaceId;
    }
    return Boolean(normalized.workspacePath && thread.cwd === normalized.workspacePath);
  });
}

export function shouldResetWorkspaceScopedServerState(
  currentSelection: WorkspaceCacheSelection | string | undefined,
  nextSelection: WorkspaceCacheSelection | string,
) {
  const current = normalizeWorkspaceCacheSelection(currentSelection);
  const next = normalizeWorkspaceCacheSelection(nextSelection);
  if (!current.workspaceId && !current.workspacePath) {
    return false;
  }
  if (current.workspaceId && next.workspaceId) {
    return current.workspaceId !== next.workspaceId;
  }
  return Boolean(
    current.workspacePath && next.workspacePath && current.workspacePath !== next.workspacePath,
  );
}
