import type { ThreadSummary } from "codex-relay/api-schema";
import { createMMKV } from "react-native-mmkv";

export type ThreadSeenState = {
  baselineScopeKeys: string[];
  seenAtByThreadKey: Record<string, string>;
};

const storage = createMMKV({ id: "codex-relay-thread-seen" });
const storageKey = "state-v2";

export function emptyThreadSeenState(): ThreadSeenState {
  return { baselineScopeKeys: [], seenAtByThreadKey: {} };
}

export function readThreadSeenState(): ThreadSeenState {
  const value = storage.getString(storageKey);
  if (!value) {
    return emptyThreadSeenState();
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") {
      return emptyThreadSeenState();
    }
    const record = parsed as Record<string, unknown>;
    return {
      baselineScopeKeys: Array.isArray(record.baselineScopeKeys)
        ? record.baselineScopeKeys.filter(
            (scopeKey): scopeKey is string => typeof scopeKey === "string" && Boolean(scopeKey),
          )
        : [],
      seenAtByThreadKey: normalizedSeenAtRecord(record.seenAtByThreadKey),
    };
  } catch {
    return emptyThreadSeenState();
  }
}

export function persistThreadSeenState(state: ThreadSeenState) {
  storage.set(storageKey, JSON.stringify(state));
}

export function threadSeenKey(
  relayId: string,
  thread: Pick<ThreadSummary, "cwd" | "id" | "workspaceId">,
) {
  return JSON.stringify([threadSeenScopeKey(relayId, thread), thread.id]);
}

export function initializeThreadSeenBaselineState(
  state: ThreadSeenState,
  relayId: string,
  threads: ThreadSummary[],
) {
  const baselineScopeKeys = new Set(state.baselineScopeKeys);
  const seenAtByThreadKey = { ...state.seenAtByThreadKey };
  let changed = false;
  const threadsByScope = new Map<string, ThreadSummary[]>();
  for (const thread of threads) {
    const scopeKey = threadSeenScopeKey(relayId, thread);
    const scopedThreads = threadsByScope.get(scopeKey) ?? [];
    scopedThreads.push(thread);
    threadsByScope.set(scopeKey, scopedThreads);
  }
  for (const [scopeKey, scopedThreads] of threadsByScope) {
    if (baselineScopeKeys.has(scopeKey)) {
      continue;
    }
    changed = true;
    baselineScopeKeys.add(scopeKey);
    for (const thread of scopedThreads) {
      seenAtByThreadKey[threadSeenKey(relayId, thread)] = threadActivityAt(thread);
    }
  }
  if (!changed) {
    return state;
  }
  return {
    baselineScopeKeys: [...baselineScopeKeys],
    seenAtByThreadKey,
  };
}

export function markThreadSeenState(
  state: ThreadSeenState,
  relayId: string,
  thread: ThreadSummary,
) {
  const key = threadSeenKey(relayId, thread);
  const seenAt = threadActivityAt(thread);
  if ((state.seenAtByThreadKey[key] ?? "") >= seenAt) {
    return state;
  }
  return {
    ...state,
    seenAtByThreadKey: { ...state.seenAtByThreadKey, [key]: seenAt },
  };
}

export function isThreadCompletionUnseen(
  state: ThreadSeenState,
  relayId: string,
  thread: ThreadSummary,
) {
  if (
    thread.state !== "completed" ||
    !state.baselineScopeKeys.includes(threadSeenScopeKey(relayId, thread))
  ) {
    return false;
  }
  return (state.seenAtByThreadKey[threadSeenKey(relayId, thread)] ?? "") < threadActivityAt(thread);
}

function threadSeenScopeKey(relayId: string, thread: Pick<ThreadSummary, "cwd" | "workspaceId">) {
  return JSON.stringify([relayId, thread.workspaceId ?? thread.cwd ?? null]);
}

function threadActivityAt(thread: Pick<ThreadSummary, "lastActivityAt" | "updatedAt">) {
  return thread.lastActivityAt ?? thread.updatedAt;
}

function normalizedSeenAtRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string" && Boolean(entry[1]),
    ),
  );
}
