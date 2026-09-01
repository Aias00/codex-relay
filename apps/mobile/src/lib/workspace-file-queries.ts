import type { WorkspaceSelectionRequest } from "@aias00/codex-relay/api-schema";

import { workspaceCacheIdentity } from "./server-state-workspace-cache";

export const workspaceFileContentQueryKey = (
  serverUrl: string,
  selection: WorkspaceSelectionRequest,
  path: string | null,
) =>
  [
    "codex-relay-workspace-preview-file",
    serverUrl,
    workspaceCacheIdentity(selection),
    path,
  ] as const;

export const workspaceFilesQueryKeyPrefix = (
  serverUrl: string,
  selection: WorkspaceSelectionRequest,
) => ["codex-relay-workspace-preview-files", serverUrl, workspaceCacheIdentity(selection)] as const;
