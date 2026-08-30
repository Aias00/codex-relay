export type ThreadPrefetchCandidate = {
  cwd?: string;
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

function prefetchScore(thread: ThreadPrefetchCandidate, activeThreadId?: string) {
  return (
    (thread.id === activeThreadId ? 1_000_000 : 0) +
    (thread.state === "running" ? 100_000 : 0) +
    Math.min(thread.messageCount ?? 0, 10_000)
  );
}
