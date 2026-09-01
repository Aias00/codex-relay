import { threadAttentionState } from "./thread-attention";

export type ThreadPrefetchCandidate = {
  cwd?: string;
  goal?: { status?: string } | null;
  hasBlockingRequest?: boolean;
  hasUnseenCompletion?: boolean;
  id: string;
  messageCount?: number;
  state?: string;
  updatedAt?: string;
  workspaceId?: string;
};

export function prioritizeThreadPrefetch(
  threads: ThreadPrefetchCandidate[],
  activeThreadId?: string,
  limit = 4,
) {
  const boundedLimit = Math.max(0, Math.floor(limit));
  return threads
    .filter((thread) => thread.id !== activeThreadId)
    .slice()
    .sort((left, right) => {
      const scoreDifference =
        prefetchScore(right, activeThreadId) - prefetchScore(left, activeThreadId);
      if (scoreDifference !== 0) {
        return scoreDifference;
      }
      return (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "");
    })
    .slice(0, boundedLimit);
}

export async function runBoundedThreadPrefetch<T>(
  candidates: T[],
  prefetch: (candidate: T) => Promise<void>,
  concurrency = 2,
) {
  const workerCount = Math.max(1, Math.floor(concurrency));
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(workerCount, candidates.length) }, async () => {
    while (nextIndex < candidates.length) {
      const candidate = candidates[nextIndex++];
      try {
        await prefetch(candidate);
      } catch {
        // Prefetch is opportunistic and must never affect the active screen.
      }
    }
  });
  await Promise.all(workers);
}

export function runCoalescedRequest<Key, Value>(
  requests: Map<Key, Promise<Value>>,
  key: Key,
  request: () => Promise<Value>,
) {
  const existing = requests.get(key);
  if (existing) {
    return existing;
  }
  const pending = Promise.resolve().then(request);
  const tracked = pending.finally(() => {
    if (requests.get(key) === tracked) {
      requests.delete(key);
    }
  });
  requests.set(key, tracked);
  return tracked;
}

function prefetchScore(thread: ThreadPrefetchCandidate, activeThreadId?: string) {
  const attention = threadAttentionState({
    goalStatus: thread.goal?.status,
    hasBlockingRequest: thread.hasBlockingRequest,
    hasUnseenCompletion: thread.hasUnseenCompletion,
    threadState: thread.state,
  });
  const attentionScore = {
    blocked: 600_000,
    failed: 500_000,
    "completed-unseen": 400_000,
    paused: 300_000,
    working: 200_000,
    idle: 100_000,
    unknown: 0,
  }[attention];
  return (
    (thread.id === activeThreadId ? 1_000_000 : 0) +
    attentionScore +
    Math.min(thread.messageCount ?? 0, 10_000)
  );
}
