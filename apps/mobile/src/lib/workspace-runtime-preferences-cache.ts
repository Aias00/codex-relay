import {
  RuntimePreferencesSchema,
  type RuntimePreferences,
  type StatusResponse,
} from "@aias00/codex-relay/api-schema";
import { createMMKV } from "react-native-mmkv";

import {
  normalizeWorkspaceCacheSelection,
  workspaceCacheIdentity,
  type WorkspaceCacheSelection,
} from "./server-state-workspace-cache";

const storage = createMMKV({ id: "codex-relay-workspace-runtime-preferences" });

export function readCachedWorkspaceRuntimePreferences(
  serverUrl: string,
  selection: WorkspaceCacheSelection | string | undefined,
): RuntimePreferences | undefined {
  const normalized = normalizeWorkspaceCacheSelection(selection);
  const identity = workspaceCacheIdentity(normalized);
  if (!identity) {
    return undefined;
  }

  const raw = storage.getString(cacheKey(serverUrl, identity));
  if (!raw && normalized.workspaceId && normalized.workspacePath) {
    const legacyRaw = storage.getString(cacheKey(serverUrl, normalized.workspacePath));
    const legacyPreferences = parseCachedPreferences(legacyRaw);
    if (legacyPreferences) {
      storage.set(cacheKey(serverUrl, identity), JSON.stringify(legacyPreferences));
    }
    return legacyPreferences;
  }
  return parseCachedPreferences(raw);
}

function parseCachedPreferences(raw: string | undefined) {
  if (!raw) {
    return undefined;
  }

  try {
    const parsed = RuntimePreferencesSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function cacheWorkspaceRuntimePreferences(
  serverUrl: string,
  selection: WorkspaceCacheSelection | string | undefined,
  preferences: RuntimePreferences,
) {
  const normalized = normalizeWorkspaceCacheSelection(selection);
  const identity = workspaceCacheIdentity(normalized);
  if (!identity) {
    return;
  }

  const serialized = JSON.stringify(RuntimePreferencesSchema.parse(preferences));
  storage.set(cacheKey(serverUrl, identity), serialized);
  if (normalized.workspaceId && normalized.workspacePath) {
    storage.set(cacheKey(serverUrl, normalized.workspacePath), serialized);
  }
}

export function cacheWorkspaceRuntimePreferencesFromStatus(
  serverUrl: string,
  status: StatusResponse,
) {
  cacheWorkspaceRuntimePreferences(
    serverUrl,
    { workspaceId: status.workspaceId, workspacePath: status.workspacePath },
    status.preferences,
  );
  for (const [workspacePath, preferences] of Object.entries(
    status.runtimePreferencesByWorkspacePath ?? {},
  )) {
    cacheWorkspaceRuntimePreferences(serverUrl, workspacePath, preferences);
  }
}

function cacheKey(serverUrl: string, workspaceIdentity: string) {
  return `${normalizeServerUrl(serverUrl)}::${workspaceIdentity}`;
}

function normalizeServerUrl(serverUrl: string) {
  return serverUrl.trim().replace(/\/$/, "");
}
