import type {
  ChatMessage,
  CheckoutWorkspaceBranchRequest,
  CommitPushWorkspaceRequest,
  CreateThreadRequest,
  ListQueuedThreadInputsResponse,
  ListThreadsResponse,
  QueuedThreadInput,
  RenameThreadRequest,
  RewindThreadRequest,
  RunThreadRequest,
  RuntimePreferences,
  RuntimePreferencesResponse,
  StatusResponse,
  StreamThreadRunEvent,
  ThreadDetailResponse,
  ThreadSummary,
  UpdateThreadGoalRequest,
  VersionResponse,
  WorkspaceSelectionRequest,
} from "codex-relay/api-schema";
import type { QueryClient, QueryKey } from "@tanstack/react-query";

import {
  archiveThread,
  checkoutWorkspaceBranch,
  clearThreadGoal,
  commitPushWorkspace,
  createThread,
  getThreadGoal,
  getCodexRelayServerUrl,
  getRateLimits,
  getStatus,
  getThread,
  getThreadContextWindow,
  getVersion,
  getWorkspaceChanges,
  isThreadEventReplayUnavailable,
  listModels,
  listThreadEvents,
  listQueuedThreadInputs,
  listThreads,
  listWorkspaceDirectories,
  removeQueuedThreadInput,
  renameThread,
  rewindThread,
  steerQueuedThreadInput,
  submitThreadInput,
  updateThreadGoal,
  updateRuntimePreferences,
} from "@/lib/codex-relay-api";
import { chatStore$, setWorkspaceSelection } from "@/state/chat-store";
import {
  cacheWorkspaceRuntimePreferences,
  cacheWorkspaceRuntimePreferencesFromStatus,
} from "@/lib/workspace-runtime-preferences-cache";
import {
  filterThreadsForWorkspace,
  normalizeWorkspaceCacheSelection,
  workspaceCacheIdentity,
  type WorkspaceCacheSelection,
} from "./server-state-workspace-cache";
import { serverStateRootKey } from "./server-state-persistence";
import { replayThreadEventPages } from "./thread-event-client";
import {
  applyOrderedThreadEvent,
  ThreadEventSequenceGapError,
  threadIdFromStreamEvent,
  type ThreadEventApplyResult,
  type ThreadEventCursor,
} from "./thread-event-reducer";
import { threadDetailSwitchStaleTimeMs } from "./thread-activation";
import {
  appendOptimisticSteeringMessageToDetail,
  mergeThreadDetailState,
  preferredThreadSnapshot,
  upsertMessage,
} from "./server-state-messages";
import { prioritizeThreadPrefetch, runBoundedThreadPrefetch } from "./thread-prefetch";

export const threadListStaleTimeMs = 30_000;
export const workspaceDirectoryStaleTimeMs = 5 * 60_000;

export const serverStateKeys = {
  all: () => [serverStateRootKey, getCodexRelayServerUrl()] as const,
  contextWindow: (threadId: string, selection?: WorkspaceCacheSelection | string) =>
    [...serverStateKeys.threadScope(threadId, selection), "context-window"] as const,
  models: () => [...serverStateKeys.all(), "models"] as const,
  queuedInputs: (threadId: string, selection?: WorkspaceCacheSelection | string) =>
    [...serverStateKeys.threadScope(threadId, selection), "queued-inputs"] as const,
  rateLimits: () => [...serverStateKeys.all(), "rate-limits"] as const,
  status: (selection?: WorkspaceCacheSelection | string) =>
    [
      ...serverStateKeys.all(),
      "status",
      workspaceCacheIdentity(selection ?? currentWorkspaceSelection()),
    ] as const,
  thread: (threadId: string, selection?: WorkspaceCacheSelection | string) =>
    [...serverStateKeys.threadScope(threadId, selection), "detail"] as const,
  threadEventCursor: (threadId: string, selection?: WorkspaceCacheSelection | string) =>
    [...serverStateKeys.threadScope(threadId, selection), "event-cursor"] as const,
  threadScope: (threadId: string, selection?: WorkspaceCacheSelection | string) =>
    [
      ...serverStateKeys.all(),
      "thread",
      workspaceCacheIdentity(selection ?? currentWorkspaceSelection()),
      threadId,
    ] as const,
  threads: (selection?: WorkspaceCacheSelection | string) =>
    [
      ...serverStateKeys.all(),
      "threads",
      workspaceCacheIdentity(selection ?? currentWorkspaceSelection()),
    ] as const,
  version: () => [...serverStateKeys.all(), "version"] as const,
  workspaceChanges: (selection: WorkspaceCacheSelection | string | undefined) =>
    [...serverStateKeys.all(), "workspace-changes", workspaceCacheIdentity(selection)] as const,
  workspaceDirectories: (path: string | undefined) =>
    [...serverStateKeys.all(), "workspace-directories", path ?? null] as const,
};

export function fetchStatusState(
  queryClient: QueryClient,
  selection?: WorkspaceSelectionRequest | string,
) {
  const normalized = normalizeWorkspaceCacheSelection(selection);
  return queryClient.fetchQuery({
    queryKey: serverStateKeys.status(normalized),
    queryFn: () => getStatus(normalized),
  });
}

export function fetchThreadsState(
  queryClient: QueryClient,
  selection?: WorkspaceSelectionRequest | string,
) {
  const normalized = normalizeWorkspaceCacheSelection(selection);
  return queryClient.fetchQuery({
    queryKey: serverStateKeys.threads(normalized),
    queryFn: () => listThreads(normalized),
  });
}

export function prefetchAllThreadsState(queryClient: QueryClient) {
  return queryClient.prefetchQuery({
    queryKey: serverStateKeys.threads({}),
    queryFn: () => listThreads({}),
    staleTime: threadListStaleTimeMs,
  });
}

export function fetchModelsState(queryClient: QueryClient) {
  return queryClient.fetchQuery({
    queryKey: serverStateKeys.models(),
    queryFn: listModels,
  });
}

export function fetchRateLimitsState(queryClient: QueryClient) {
  return queryClient.fetchQuery({
    queryKey: serverStateKeys.rateLimits(),
    queryFn: getRateLimits,
  });
}

export async function fetchThreadState(
  queryClient: QueryClient,
  threadId: string,
  options: { refresh?: boolean; staleTime?: number } = {},
) {
  const response = options.refresh
    ? await getThread(threadId, { refresh: true })
    : await queryClient.fetchQuery({
        queryKey: threadStateKey(queryClient, threadId),
        queryFn: () => getThread(threadId),
        staleTime: options.staleTime,
      });
  setThreadDetailState(
    queryClient,
    response.thread,
    response.messages,
    response.pendingInputRequests,
    {
      hasOlderMessages: response.hasOlderMessages,
      olderMessagesCursor: response.olderMessagesCursor,
      replaceMessages: options.refresh,
    },
  );
  const merged =
    queryClient.getQueryData<ThreadDetailResponse>(threadStateKey(queryClient, threadId)) ??
    response;
  upsertThreadState(queryClient, merged.thread);
  return merged;
}

export async function prefetchThreadDetailsState(
  queryClient: QueryClient,
  threads: ThreadSummary[],
  selection: WorkspaceCacheSelection | string | undefined,
  activeThreadId?: string,
) {
  const normalized = normalizeWorkspaceCacheSelection(selection);
  const candidates = prioritizeThreadPrefetch(threads, activeThreadId, 4);
  await runBoundedThreadPrefetch(candidates, async (candidate) => {
    const threadSelection = selectionForThread(candidate, normalized);
    const response = await queryClient.fetchQuery({
      queryKey: serverStateKeys.thread(candidate.id, threadSelection),
      queryFn: () => getThread(candidate.id),
      staleTime: threadDetailSwitchStaleTimeMs,
    });
    setThreadDetailState(
      queryClient,
      response.thread,
      response.messages,
      response.pendingInputRequests,
      {
        hasOlderMessages: response.hasOlderMessages,
        olderMessagesCursor: response.olderMessagesCursor,
      },
    );
  });
}

export function fetchQueuedInputsState(queryClient: QueryClient, threadId: string) {
  return queryClient.fetchQuery({
    queryKey: serverStateKeys.queuedInputs(threadId, selectionForThreadId(queryClient, threadId)),
    queryFn: () => listQueuedThreadInputs(threadId),
  });
}

export function fetchContextWindowState(queryClient: QueryClient, threadId: string) {
  return queryClient.fetchQuery({
    queryKey: serverStateKeys.contextWindow(threadId, selectionForThreadId(queryClient, threadId)),
    queryFn: () => getThreadContextWindow(threadId),
  });
}

export async function fetchThreadGoalState(queryClient: QueryClient, threadId: string) {
  const response = await getThreadGoal(threadId);
  upsertThreadState(queryClient, response.thread);
  return response;
}

export function fetchWorkspaceChangesState(
  queryClient: QueryClient,
  selection: WorkspaceSelectionRequest | string | undefined,
  options: { staleTime?: number } = {},
) {
  const normalized = normalizeWorkspaceCacheSelection(selection);
  return queryClient.fetchQuery({
    queryKey: serverStateKeys.workspaceChanges(normalized),
    queryFn: () => getWorkspaceChanges(normalized),
    staleTime: options.staleTime,
  });
}

export function fetchWorkspaceDirectoriesState(queryClient: QueryClient, path: string | undefined) {
  return queryClient.fetchQuery({
    queryKey: serverStateKeys.workspaceDirectories(path),
    queryFn: () => listWorkspaceDirectories(path),
    staleTime: workspaceDirectoryStaleTimeMs,
  });
}

function currentWorkspacePath() {
  return chatStore$.workspacePath.peek();
}

function currentWorkspaceSelection(): WorkspaceCacheSelection {
  return {
    workspaceId: chatStore$.workspaceId.peek(),
    workspacePath: chatStore$.workspacePath.peek(),
  };
}

function currentThreadsKey() {
  return serverStateKeys.threads(currentWorkspaceSelection());
}

function legacyThreadDetailKey(threadId: string) {
  return [...serverStateKeys.all(), "thread", threadId, "detail"] as const;
}

function legacyThreadEventCursorKey(threadId: string) {
  return [serverStateRootKey, "event-cursor", threadId] as const;
}

function selectionForThread(
  thread: Pick<ThreadSummary, "cwd" | "workspaceId"> | undefined,
  fallback: WorkspaceCacheSelection = currentWorkspaceSelection(),
): WorkspaceCacheSelection {
  return {
    workspaceId: thread?.workspaceId ?? fallback.workspaceId,
    workspacePath: thread?.cwd ?? fallback.workspacePath,
  };
}

function findCachedThread(queryClient: QueryClient, threadId: string): ThreadSummary | undefined {
  const currentThread = queryClient
    .getQueryData<ListThreadsResponse>(currentThreadsKey())
    ?.threads.find((candidate) => candidate.id === threadId);
  if (currentThread) {
    return currentThread;
  }
  for (const [, cached] of queryClient.getQueriesData<ListThreadsResponse>({
    queryKey: [...serverStateKeys.all(), "threads"],
  })) {
    const thread = cached?.threads.find((candidate) => candidate.id === threadId);
    if (thread) {
      return thread;
    }
  }
  return undefined;
}

export function getCachedThreadOwnerEpoch(queryClient: QueryClient, threadId: string) {
  const listedEpoch = findCachedThread(queryClient, threadId)?.ownerEpoch;
  if (listedEpoch !== undefined) {
    return listedEpoch;
  }
  for (const [, cached] of queryClient.getQueriesData<ThreadDetailResponse>({
    queryKey: [...serverStateKeys.all(), "thread"],
  })) {
    if (cached?.thread.id === threadId && cached.thread.ownerEpoch !== undefined) {
      return cached.thread.ownerEpoch;
    }
  }
  return undefined;
}

function selectionForThreadId(queryClient: QueryClient, threadId: string) {
  return selectionForThread(findCachedThread(queryClient, threadId));
}

function promoteQueryData(queryClient: QueryClient, from: QueryKey, to: QueryKey) {
  if (queryClient.getQueryData(to) !== undefined) {
    return;
  }
  const cached = queryClient.getQueryData(from);
  if (cached !== undefined) {
    queryClient.setQueryData(to, cached);
  }
}

function promoteThreadListCacheForWorkspace(
  queryClient: QueryClient,
  from: QueryKey,
  to: QueryKey,
  selection: WorkspaceCacheSelection,
) {
  if (queryClient.getQueryData(to) !== undefined) {
    return;
  }
  const source = queryClient.getQueryData<ListThreadsResponse>(from);
  if (!source) {
    return;
  }
  const workspaceThreads = filterThreadsForWorkspace(source.threads, selection);
  if (workspaceThreads.length > 0) {
    queryClient.setQueryData<ListThreadsResponse>(to, {
      ...source,
      threads: workspaceThreads,
    });
  }
}

function promoteThreadCache(
  queryClient: QueryClient,
  thread: ThreadSummary,
  fallback: WorkspaceCacheSelection = currentWorkspaceSelection(),
) {
  const selection = selectionForThread(thread, fallback);
  const detailKey = serverStateKeys.thread(thread.id, selection);
  const cursorKey = serverStateKeys.threadEventCursor(thread.id, selection);
  promoteQueryData(queryClient, legacyThreadDetailKey(thread.id), detailKey);
  promoteQueryData(queryClient, legacyThreadEventCursorKey(thread.id), cursorKey);
  if (thread.workspaceId && thread.cwd) {
    promoteQueryData(queryClient, serverStateKeys.thread(thread.id, thread.cwd), detailKey);
    promoteQueryData(
      queryClient,
      serverStateKeys.threadEventCursor(thread.id, thread.cwd),
      cursorKey,
    );
  }
}

function promoteWorkspaceCache(queryClient: QueryClient, selection: WorkspaceCacheSelection) {
  if (!selection.workspaceId) {
    return;
  }
  const targetThreadsKey = serverStateKeys.threads(selection);
  for (const sourceThreadsKey of [
    serverStateKeys.threads(selection.workspacePath),
    serverStateKeys.threads({}),
  ]) {
    promoteThreadListCacheForWorkspace(queryClient, sourceThreadsKey, targetThreadsKey, selection);
  }
  const threads = queryClient.getQueryData<ListThreadsResponse>(targetThreadsKey)?.threads ?? [];
  for (const thread of threads) {
    promoteThreadCache(queryClient, thread, selection);
  }
}

function threadStateKey(queryClient: QueryClient, threadId: string) {
  return serverStateKeys.thread(threadId, selectionForThreadId(queryClient, threadId));
}

function threadScopeKey(queryClient: QueryClient, threadId: string) {
  return serverStateKeys.threadScope(threadId, selectionForThreadId(queryClient, threadId));
}

function threadEventCursorKey(queryClient: QueryClient, threadId: string) {
  return serverStateKeys.threadEventCursor(threadId, selectionForThreadId(queryClient, threadId));
}

function queuedInputsStateKey(queryClient: QueryClient, threadId: string) {
  return serverStateKeys.queuedInputs(threadId, selectionForThreadId(queryClient, threadId));
}

const olderMessageHydrations = new Map<string, Promise<void>>();

function olderMessageHydrationKey(queryClient: QueryClient, threadId: string) {
  return JSON.stringify(threadStateKey(queryClient, threadId));
}

export function hydrateOlderThreadMessagesState(queryClient: QueryClient, threadId: string) {
  const key = olderMessageHydrationKey(queryClient, threadId);
  const active = olderMessageHydrations.get(key);
  if (active) {
    return active;
  }

  const hydration = (async () => {
    let cursor = queryClient.getQueryData<ThreadDetailResponse>(
      threadStateKey(queryClient, threadId),
    )?.olderMessagesCursor;
    while (cursor) {
      const response = await getThread(threadId, { beforeMessageId: cursor });
      if (response.thread.id !== threadId || response.messages.length === 0) {
        return;
      }
      setThreadDetailState(
        queryClient,
        response.thread,
        response.messages,
        response.pendingInputRequests,
        {
          hasOlderMessages: response.hasOlderMessages,
          olderMessagesCursor: response.olderMessagesCursor,
        },
      );
      const nextCursor = response.olderMessagesCursor;
      if (!nextCursor || nextCursor === cursor) {
        return;
      }
      cursor = nextCursor;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  })().finally(() => {
    olderMessageHydrations.delete(key);
  });
  olderMessageHydrations.set(key, hydration);
  return hydration;
}

export const serverStateQueryFns = {
  contextWindow: getThreadContextWindow,
  models: listModels,
  queuedInputs: listQueuedThreadInputs,
  rateLimits: getRateLimits,
  status: getStatus,
  thread: getThread,
  threadEvents: listThreadEvents,
  threads: listThreads,
  version: getVersion,
  workspaceChanges: getWorkspaceChanges,
  workspaceDirectories: listWorkspaceDirectories,
};

export async function createThreadServerState(queryClient: QueryClient, body: CreateThreadRequest) {
  const response = await createThread(body);
  setThreadDetailState(queryClient, response.thread, response.messages);
  return response;
}

export async function archiveThreadServerState(queryClient: QueryClient, threadId: string) {
  const response = await archiveThread(threadId, {
    expectedOwnerEpoch: getCachedThreadOwnerEpoch(queryClient, threadId),
  });
  setThreadsState(queryClient, response.threads, response.source, {});
  removeThreadDetailState(queryClient, response.archivedThreadId);
  return response;
}

export async function renameThreadServerState(
  queryClient: QueryClient,
  threadId: string,
  body: RenameThreadRequest,
) {
  const response = await renameThread(threadId, body);
  upsertThreadState(queryClient, response.thread);
  return response;
}

export async function rewindThreadServerState(
  queryClient: QueryClient,
  threadId: string,
  body: RewindThreadRequest,
) {
  const response = await rewindThread(threadId, {
    ...body,
    expectedOwnerEpoch: body.expectedOwnerEpoch ?? getCachedThreadOwnerEpoch(queryClient, threadId),
  });
  setThreadDetailState(
    queryClient,
    response.thread,
    response.messages,
    response.pendingInputRequests,
    { replaceMessages: true },
  );
  setQueuedInputsState(queryClient, threadId, []);
  return response;
}

export async function submitThreadInputServerState(
  queryClient: QueryClient,
  threadId: string,
  body: RunThreadRequest,
) {
  const response = await submitThreadInput(threadId, body);
  upsertThreadState(queryClient, response.thread);
  return response;
}

export async function removeQueuedThreadInputServerState(
  queryClient: QueryClient,
  threadId: string,
  inputId: string,
  expectedOwnerEpoch?: number,
) {
  const response = await removeQueuedThreadInput(threadId, inputId, { expectedOwnerEpoch });
  upsertThreadState(queryClient, response.thread);
  removeQueuedInputState(queryClient, threadId, inputId);
  return response;
}

export async function steerQueuedThreadInputServerState(
  queryClient: QueryClient,
  threadId: string,
  inputId: string,
  expectedOwnerEpoch?: number,
) {
  const response = await steerQueuedThreadInput(threadId, inputId, { expectedOwnerEpoch });
  upsertThreadState(queryClient, response.thread);
  removeQueuedInputState(queryClient, threadId, inputId);
  return response;
}

export async function checkoutWorkspaceBranchServerState(
  queryClient: QueryClient,
  body: CheckoutWorkspaceBranchRequest,
) {
  const response = await checkoutWorkspaceBranch(body);
  await queryClient.invalidateQueries({
    queryKey: serverStateKeys.workspaceChanges(body),
  });
  return response;
}

export async function commitPushWorkspaceServerState(
  queryClient: QueryClient,
  body: CommitPushWorkspaceRequest,
) {
  const response = await commitPushWorkspace(body);
  await queryClient.invalidateQueries({
    queryKey: serverStateKeys.workspaceChanges(body),
  });
  return response;
}

export function updateRuntimePreferencesServerState(
  body: Parameters<typeof updateRuntimePreferences>[0],
) {
  return updateRuntimePreferences(body);
}

export async function updateThreadGoalServerState(
  queryClient: QueryClient,
  threadId: string,
  body: UpdateThreadGoalRequest,
) {
  const response = await updateThreadGoal(threadId, {
    ...body,
    expectedOwnerEpoch: body.expectedOwnerEpoch ?? getCachedThreadOwnerEpoch(queryClient, threadId),
  });
  upsertThreadState(queryClient, response.thread);
  return response;
}

export async function clearThreadGoalServerState(queryClient: QueryClient, threadId: string) {
  const response = await clearThreadGoal(threadId, {
    expectedOwnerEpoch: getCachedThreadOwnerEpoch(queryClient, threadId),
  });
  upsertThreadState(queryClient, response.thread);
  return response;
}

export function clearServerState(queryClient: QueryClient) {
  queryClient.removeQueries({ queryKey: [serverStateRootKey] });
}

export function setStatusState(queryClient: QueryClient, status: StatusResponse) {
  const nextSelection = {
    workspaceId: status.workspaceId,
    workspacePath: status.workspacePath,
  };
  promoteWorkspaceCache(queryClient, nextSelection);
  setWorkspaceSelection(nextSelection);
  cacheWorkspaceRuntimePreferencesFromStatus(getCodexRelayServerUrl(), status);
  queryClient.setQueryData(serverStateKeys.status(nextSelection), status);
  if (status.workspaceId) {
    queryClient.setQueryData(serverStateKeys.status(status.workspacePath), status);
  }
}

export function setVersionState(queryClient: QueryClient, version: VersionResponse) {
  queryClient.setQueryData(serverStateKeys.version(), version);
}

export function setRuntimePreferencesState(
  queryClient: QueryClient,
  preferences: RuntimePreferences,
) {
  queryClient.setQueryData<StatusResponse>(
    serverStateKeys.status(currentWorkspaceSelection()),
    (current) => (current ? { ...current, preferences } : current),
  );
}

export function setRuntimePreferencesResponseState(
  queryClient: QueryClient,
  response: RuntimePreferencesResponse,
) {
  const workspacePreferences = response.workspacePath
    ? response.runtimePreferencesByWorkspacePath[response.workspacePath]
    : undefined;
  if (response.workspacePath && workspacePreferences) {
    cacheWorkspaceRuntimePreferences(
      getCodexRelayServerUrl(),
      { workspaceId: response.workspaceId, workspacePath: response.workspacePath },
      workspacePreferences,
    );
    setWorkspaceRuntimePreferencesState(
      queryClient,
      { workspaceId: response.workspaceId, workspacePath: response.workspacePath },
      workspacePreferences,
    );
  }
  queryClient.setQueryData<StatusResponse>(
    serverStateKeys.status(
      response.workspacePath
        ? {
            workspaceId:
              response.workspaceId ??
              (response.workspacePath === currentWorkspacePath()
                ? currentWorkspaceSelection().workspaceId
                : undefined),
            workspacePath: response.workspacePath,
          }
        : currentWorkspaceSelection(),
    ),
    (current) => {
      if (!current) {
        return current;
      }
      const responseMatchesCurrentWorkspace =
        !response.workspacePath || response.workspacePath === current.workspacePath;
      const nextPreferences = responseMatchesCurrentWorkspace
        ? response.preferences
        : response.workspacePath === current.workspacePath && workspacePreferences
          ? workspacePreferences
          : current.preferences;
      return {
        ...current,
        preferences: nextPreferences,
        runtimePreferencesByWorkspacePath: response.runtimePreferencesByWorkspacePath,
        workspacePath: response.workspacePath ?? current.workspacePath,
      };
    },
  );
}

export function setWorkspaceRuntimePreferencesState(
  queryClient: QueryClient,
  selection: WorkspaceCacheSelection | string,
  preferences: RuntimePreferences,
) {
  const normalized = normalizeWorkspaceCacheSelection(selection);
  const workspacePath = normalized.workspacePath;
  if (!workspacePath) {
    return;
  }
  cacheWorkspaceRuntimePreferences(getCodexRelayServerUrl(), normalized, preferences);
  queryClient.setQueryData<StatusResponse>(serverStateKeys.status(normalized), (current) =>
    current
      ? {
          ...current,
          preferences: workspacePath === current.workspacePath ? preferences : current.preferences,
          runtimePreferencesByWorkspacePath: {
            ...current.runtimePreferencesByWorkspacePath,
            [workspacePath]: preferences,
          },
        }
      : current,
  );
}

export function setThreadRunningState(
  queryClient: QueryClient,
  threadId: string | undefined,
  isRunning: boolean,
) {
  if (!threadId) {
    return;
  }
  patchThreadState(queryClient, threadId, {
    state: isRunning ? "running" : "completed",
    updatedAt: new Date().toISOString(),
  });
}

export function setThreadsState(
  queryClient: QueryClient,
  threads: ThreadSummary[],
  source: ListThreadsResponse["source"] = "memory",
  selection?: WorkspaceCacheSelection | string,
) {
  for (const thread of threads) {
    promoteThreadCache(queryClient, thread);
  }
  const queryKey =
    selection === undefined ? currentThreadsKey() : serverStateKeys.threads(selection);
  queryClient.setQueryData<ListThreadsResponse>(queryKey, {
    source,
    threads: sortThreads(threads),
  });
}

export function upsertThreadState(queryClient: QueryClient, thread: ThreadSummary) {
  promoteThreadCache(queryClient, thread);
  queryClient.setQueryData<ListThreadsResponse>(currentThreadsKey(), (current) => {
    const threads = current?.threads ?? [];
    const existing = threads.find((candidate) => candidate.id === thread.id);
    return {
      source: current?.source ?? "memory",
      threads: sortThreads(
        upsertById(threads, existing ? preferredThreadSnapshot(existing, thread) : thread),
      ),
    };
  });
  queryClient.setQueryData<ThreadDetailResponse>(
    serverStateKeys.thread(thread.id, selectionForThread(thread)),
    (current) =>
      current ? { ...current, thread: preferredThreadSnapshot(current.thread, thread) } : current,
  );
}

export function setThreadDetailState(
  queryClient: QueryClient,
  thread: ThreadSummary,
  messages: ChatMessage[],
  pendingInputRequests: ThreadDetailResponse["pendingInputRequests"] = [],
  options: {
    hasOlderMessages?: boolean;
    olderMessagesCursor?: string;
    replaceMessages?: boolean;
  } = {},
) {
  upsertThreadState(queryClient, thread);
  const response: ThreadDetailResponse = {
    thread,
    messages,
    pendingInputRequests,
    hasOlderMessages: options.hasOlderMessages ?? false,
    ...(options.olderMessagesCursor ? { olderMessagesCursor: options.olderMessagesCursor } : {}),
  };
  queryClient.setQueryData<ThreadDetailResponse>(
    serverStateKeys.thread(thread.id, selectionForThread(thread)),
    (current) => (options.replaceMessages ? response : mergeThreadDetailState(current, response)),
  );
}

export function removeThreadDetailState(queryClient: QueryClient, threadId: string) {
  queryClient.removeQueries({ queryKey: threadScopeKey(queryClient, threadId) });
}

export type OptimisticArchiveThreadSnapshot = {
  threadsKey: QueryKey;
  threadScopeQueries: [QueryKey, unknown][];
  threads?: ListThreadsResponse;
};

export async function optimisticallyArchiveThreadState(
  queryClient: QueryClient,
  threadId: string,
  selection?: WorkspaceCacheSelection | string,
): Promise<OptimisticArchiveThreadSnapshot> {
  const threadsKey =
    selection === undefined ? currentThreadsKey() : serverStateKeys.threads(selection);
  await Promise.all([
    queryClient.cancelQueries({ queryKey: threadsKey }),
    queryClient.cancelQueries({ queryKey: threadScopeKey(queryClient, threadId) }),
  ]);
  const snapshot: OptimisticArchiveThreadSnapshot = {
    threadsKey,
    threadScopeQueries: queryClient.getQueriesData({
      queryKey: threadScopeKey(queryClient, threadId),
    }),
    threads: queryClient.getQueryData<ListThreadsResponse>(threadsKey),
  };
  queryClient.setQueryData<ListThreadsResponse>(threadsKey, (current) =>
    current
      ? {
          ...current,
          threads: current.threads.filter((thread) => thread.id !== threadId),
        }
      : current,
  );
  removeThreadDetailState(queryClient, threadId);
  return snapshot;
}

export function restoreOptimisticArchiveThreadState(
  queryClient: QueryClient,
  snapshot: OptimisticArchiveThreadSnapshot | undefined,
) {
  if (!snapshot) {
    return;
  }
  if (snapshot.threads) {
    queryClient.setQueryData(snapshot.threadsKey, snapshot.threads);
  }
  for (const [queryKey, data] of snapshot.threadScopeQueries) {
    queryClient.setQueryData(queryKey, data);
  }
}

export function setQueuedInputsState(
  queryClient: QueryClient,
  threadId: string,
  inputs: QueuedThreadInput[],
  queueLength = inputs.length,
) {
  queryClient.setQueryData<ListQueuedThreadInputsResponse>(
    queuedInputsStateKey(queryClient, threadId),
    {
      inputs,
      queueLength,
    },
  );
}

export function markMessageApprovalResolvedState(
  queryClient: QueryClient,
  threadId: string,
  messageId: string,
  decision: string,
) {
  queryClient.setQueryData<ThreadDetailResponse>(threadStateKey(queryClient, threadId), (current) =>
    current
      ? {
          ...current,
          messages: current.messages.map((message) =>
            message.id === messageId
              ? {
                  ...message,
                  details: {
                    ...message.details,
                    approvalDecision: decision,
                    approvalResolved: true,
                  },
                  updatedAt: new Date().toISOString(),
                }
              : message,
          ),
        }
      : current,
  );
}

export function removeQueuedInputState(
  queryClient: QueryClient,
  threadId: string,
  inputId: string,
) {
  queryClient.setQueryData<ListQueuedThreadInputsResponse>(
    queuedInputsStateKey(queryClient, threadId),
    (current) => {
      if (!current) {
        return current;
      }
      const inputs = current.inputs.filter((input) => input.id !== inputId);
      return {
        inputs,
        queueLength:
          inputs.length === current.inputs.length
            ? current.queueLength
            : Math.max(0, current.queueLength - 1),
      };
    },
  );
}

export type OptimisticSteerQueuedInputSnapshot = {
  hadThreadDetail: boolean;
  queuedInputs?: ListQueuedThreadInputsResponse;
  threadDetail?: ThreadDetailResponse;
  threads?: ListThreadsResponse;
};

export async function optimisticallySteerQueuedInputState(
  queryClient: QueryClient,
  threadId: string,
  input: QueuedThreadInput,
): Promise<OptimisticSteerQueuedInputSnapshot> {
  const queuedInputsKey = queuedInputsStateKey(queryClient, threadId);
  const threadKey = threadStateKey(queryClient, threadId);
  await Promise.all([
    queryClient.cancelQueries({ queryKey: queuedInputsKey }),
    queryClient.cancelQueries({ queryKey: threadKey }),
  ]);
  const snapshot: OptimisticSteerQueuedInputSnapshot = {
    hadThreadDetail: queryClient.getQueryData<ThreadDetailResponse>(threadKey) ? true : false,
    queuedInputs: queryClient.getQueryData<ListQueuedThreadInputsResponse>(queuedInputsKey),
    threadDetail: queryClient.getQueryData<ThreadDetailResponse>(threadKey),
    threads: queryClient.getQueryData<ListThreadsResponse>(currentThreadsKey()),
  };
  removeQueuedInputState(queryClient, threadId, input.id);
  appendOptimisticSteeringMessageState(queryClient, threadId, input);
  setThreadRunningState(queryClient, threadId, true);
  return snapshot;
}

export function restoreOptimisticSteerQueuedInputState(
  queryClient: QueryClient,
  threadId: string,
  snapshot: OptimisticSteerQueuedInputSnapshot | undefined,
) {
  if (!snapshot) {
    return;
  }
  const queuedInputsKey = queuedInputsStateKey(queryClient, threadId);
  const threadKey = threadStateKey(queryClient, threadId);
  if (snapshot.queuedInputs) {
    queryClient.setQueryData(queuedInputsKey, snapshot.queuedInputs);
  }
  if (snapshot.threadDetail) {
    queryClient.setQueryData(threadKey, snapshot.threadDetail);
  } else if (!snapshot.hadThreadDetail) {
    queryClient.removeQueries({ queryKey: threadKey });
  }
  if (snapshot.threads) {
    queryClient.setQueryData(currentThreadsKey(), snapshot.threads);
  }
}

export function applyStreamEventToServerState(
  queryClient: QueryClient,
  event: StreamThreadRunEvent,
) {
  switch (event.type) {
    case "thread.message.created":
      upsertThreadState(queryClient, event.thread);
      upsertMessageState(queryClient, event.thread, event.message);
      return;
    case "thread.message.delta":
      appendMessageDeltaState(queryClient, event.threadId, event.messageId, event.delta);
      return;
    case "thread.message.completed":
      upsertThreadState(queryClient, event.thread);
      upsertMessageState(queryClient, event.thread, event.message);
      return;
    case "thread.state.changed":
      upsertThreadState(queryClient, event.thread);
      return;
    case "thread.goal.updated":
      upsertThreadState(queryClient, event.thread);
      return;
    case "thread.error":
      if (event.thread) {
        upsertThreadState(queryClient, event.thread);
      }
      return;
    case "thread.preview_target.detected":
      return;
    case "thread.input_request.created":
      upsertThreadState(queryClient, event.thread);
      upsertPendingInputRequestState(queryClient, event.request);
      return;
    case "thread.input_request.resolved":
      removePendingInputRequestState(queryClient, event.threadId, event.requestId);
      return;
  }
}

export function applyOrderedThreadEventToServerState(
  queryClient: QueryClient,
  fallbackThreadId: string,
  event: StreamThreadRunEvent,
): ThreadEventApplyResult {
  const threadId = threadIdFromStreamEvent(event, fallbackThreadId);
  const cursor = queryClient.getQueryData<ThreadEventCursor>(
    threadEventCursorKey(queryClient, threadId),
  ) ?? { sequence: 0 };
  const result = applyOrderedThreadEvent({
    applyEvent: (orderedEvent) => applyStreamEventToServerState(queryClient, orderedEvent),
    cursor,
    event,
  });
  if (result.kind === "applied" && result.durable) {
    queryClient.setQueryData(threadEventCursorKey(queryClient, threadId), result.cursor);
  }
  return result;
}

export async function replayThreadEventsState(queryClient: QueryClient, threadId: string) {
  const cursor = queryClient.getQueryData<ThreadEventCursor>(
    threadEventCursorKey(queryClient, threadId),
  ) ?? { sequence: 0 };
  const result = await replayThreadEventPages({
    afterSequence: cursor.sequence,
    applyEvent(event) {
      const result = applyOrderedThreadEventToServerState(queryClient, threadId, event);
      if (result.kind === "gap") {
        throw new ThreadEventSequenceGapError(result.expectedSequence, result.receivedSequence);
      }
    },
    fetchPage: listThreadEvents,
    isReplayUnavailable: isThreadEventReplayUnavailable,
    threadId,
  });
  if (result.resetRequired) {
    queryClient.setQueryData(threadEventCursorKey(queryClient, threadId), {
      sequence: result.lastSequence,
    });
  }
  return result;
}

export function removePendingInputRequestState(
  queryClient: QueryClient,
  threadId: string,
  requestId: string,
) {
  queryClient.setQueryData<ThreadDetailResponse>(threadStateKey(queryClient, threadId), (current) =>
    current
      ? {
          ...current,
          pendingInputRequests: (current.pendingInputRequests ?? []).filter(
            (request) => request.id !== requestId,
          ),
        }
      : current,
  );
}

function upsertPendingInputRequestState(
  queryClient: QueryClient,
  request: NonNullable<ThreadDetailResponse["pendingInputRequests"]>[number],
) {
  queryClient.setQueryData<ThreadDetailResponse>(
    threadStateKey(queryClient, request.threadId),
    (current) =>
      current
        ? {
            ...current,
            pendingInputRequests: upsertById(current.pendingInputRequests ?? [], request),
          }
        : current,
  );
}

function upsertMessageState(queryClient: QueryClient, thread: ThreadSummary, message: ChatMessage) {
  queryClient.setQueryData<ThreadDetailResponse>(
    serverStateKeys.thread(thread.id, selectionForThread(thread)),
    (current) => ({
      thread,
      messages: upsertMessage(current?.messages ?? [], message),
      pendingInputRequests: current?.pendingInputRequests ?? [],
      hasOlderMessages: current?.hasOlderMessages ?? false,
      ...(current?.olderMessagesCursor ? { olderMessagesCursor: current.olderMessagesCursor } : {}),
    }),
  );
}

function appendOptimisticSteeringMessageState(
  queryClient: QueryClient,
  threadId: string,
  input: QueuedThreadInput,
) {
  queryClient.setQueryData<ThreadDetailResponse>(
    threadStateKey(queryClient, threadId),
    (current) => {
      return appendOptimisticSteeringMessageToDetail(current, {
        input,
        nowIso: new Date().toISOString(),
        thread: optimisticSteeringThread(queryClient, threadId),
        threadId,
      });
    },
  );
}

function optimisticSteeringThread(queryClient: QueryClient, threadId: string) {
  const detailThread = queryClient.getQueryData<ThreadDetailResponse>(
    threadStateKey(queryClient, threadId),
  )?.thread;
  return (
    detailThread ??
    queryClient
      .getQueryData<ListThreadsResponse>(currentThreadsKey())
      ?.threads.find((thread) => thread.id === threadId)
  );
}

function appendMessageDeltaState(
  queryClient: QueryClient,
  threadId: string,
  messageId: string,
  delta: string,
) {
  queryClient.setQueryData<ThreadDetailResponse>(
    threadStateKey(queryClient, threadId),
    (current) => {
      if (!current) {
        return current;
      }
      return {
        ...current,
        messages: current.messages.map((message) =>
          message.id === messageId
            ? message.state === "completed"
              ? message
              : {
                  ...message,
                  content: `${message.content}${normalizeStreamDelta(message.content, delta)}`,
                  state: "streaming",
                  updatedAt: new Date().toISOString(),
                }
            : message,
        ),
      };
    },
  );
}

function normalizeStreamDelta(existingContent: string, incomingDelta: string) {
  if (!existingContent || !incomingDelta.startsWith(existingContent)) {
    return incomingDelta;
  }
  return incomingDelta.slice(existingContent.length);
}

function patchThreadState(
  queryClient: QueryClient,
  threadId: string,
  patch: Partial<ThreadSummary>,
) {
  queryClient.setQueryData<ListThreadsResponse>(currentThreadsKey(), (current) =>
    current
      ? {
          ...current,
          threads: sortThreads(
            current.threads.map((thread) =>
              thread.id === threadId ? { ...thread, ...patch } : thread,
            ),
          ),
        }
      : current,
  );
  queryClient.setQueryData<ThreadDetailResponse>(threadStateKey(queryClient, threadId), (current) =>
    current
      ? {
          ...current,
          thread: {
            ...current.thread,
            ...patch,
          },
        }
      : current,
  );
}

function upsertById<T extends { id: string }>(items: T[], item: T) {
  const existingIndex = items.findIndex((candidate) => candidate.id === item.id);
  if (existingIndex === -1) {
    return [...items, item];
  }
  return items.map((candidate) => (candidate.id === item.id ? item : candidate));
}

function sortThreads(threads: ThreadSummary[]) {
  return threads.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
