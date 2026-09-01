import type { ListThreadsResponse } from "codex-relay/api-schema";
import type { QueryClient } from "@tanstack/react-query";

import { promoteLegacyRelayServerState, serverStateKeys } from "@/lib/server-state";
import { filterThreadsForWorkspace } from "@/lib/server-state-workspace-cache";
import { chatStore$, initializeThreadSeenBaseline, setActiveThread } from "@/state/chat-store";

let hydratedDefaultThreadId: string | undefined;

export function restoreChatStoreFromQueryCache(queryClient: QueryClient) {
  promoteLegacyRelayServerState(queryClient);
  const workspaceId = chatStore$.workspaceId.peek();
  const workspacePath = chatStore$.workspacePath.peek();
  const targetKey = serverStateKeys.threads({ workspaceId, workspacePath });
  let threads = queryClient.getQueryData<ListThreadsResponse>(targetKey);
  if (!threads && workspaceId) {
    for (const sourceKey of [serverStateKeys.threads(workspacePath), serverStateKeys.threads({})]) {
      const source = queryClient.getQueryData<ListThreadsResponse>(sourceKey);
      const workspaceThreads = source
        ? filterThreadsForWorkspace(source.threads, { workspaceId, workspacePath })
        : [];
      if (source && workspaceThreads.length > 0) {
        threads = { ...source, threads: workspaceThreads };
        break;
      }
    }
    if (threads) {
      queryClient.setQueryData(targetKey, threads);
    }
  }
  if (!chatStore$.activeThreadId.peek() && threads?.threads[0]) {
    hydratedDefaultThreadId = threads.threads[0].id;
    setActiveThread(threads.threads[0].id);
  }
  if (threads) {
    initializeThreadSeenBaseline(threads.threads);
  }
}

export function consumeHydratedDefaultThread(threadId: string | undefined) {
  const wasHydratedDefault = Boolean(threadId && threadId === hydratedDefaultThreadId);
  hydratedDefaultThreadId = undefined;
  return wasHydratedDefault;
}
