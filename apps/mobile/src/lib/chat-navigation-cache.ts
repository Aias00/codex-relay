import { createMMKV } from "react-native-mmkv";

export type CachedChatNavigation = {
  activeThreadId?: string;
  workspaceId?: string;
  workspacePath?: string;
};

const storage = createMMKV({ id: "codex-relay-chat-navigation" });
const navigationStorageKey = "selection-v1";

export function readCachedChatNavigation(): CachedChatNavigation {
  return parseCachedChatNavigation(storage.getString(navigationStorageKey));
}

export function cacheChatNavigation(selection: CachedChatNavigation) {
  const normalized = normalizeCachedChatNavigation(selection);
  if (!normalized.activeThreadId && !normalized.workspaceId && !normalized.workspacePath) {
    storage.remove(navigationStorageKey);
    return;
  }
  storage.set(navigationStorageKey, JSON.stringify(normalized));
}

export function clearCachedChatNavigation() {
  storage.remove(navigationStorageKey);
}

export function parseCachedChatNavigation(value: string | undefined): CachedChatNavigation {
  if (!value) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object"
      ? normalizeCachedChatNavigation(parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function normalizeCachedChatNavigation(
  selection: Record<string, unknown> | CachedChatNavigation,
): CachedChatNavigation {
  return {
    activeThreadId: normalizedString(selection.activeThreadId),
    workspaceId: normalizedString(selection.workspaceId),
    workspacePath: normalizedString(selection.workspacePath),
  };
}

function normalizedString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
