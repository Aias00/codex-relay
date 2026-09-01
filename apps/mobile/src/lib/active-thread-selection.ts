import type { ThreadSummary } from "codex-relay/api-schema";

export function activeThreadAfterRefresh({
  canReplaceMissingActiveThread = true,
  currentActiveThreadId,
  missingActiveThreadRestored,
  preferFirstThread = false,
  threads,
}: {
  canReplaceMissingActiveThread?: boolean;
  currentActiveThreadId: string | undefined;
  missingActiveThreadRestored: boolean;
  preferFirstThread?: boolean;
  threads: ThreadSummary[];
}) {
  if (preferFirstThread && threads[0]) {
    return threads[0].id;
  }
  if (
    currentActiveThreadId &&
    (!canReplaceMissingActiveThread ||
      missingActiveThreadRestored ||
      threads.some((thread) => thread.id === currentActiveThreadId))
  ) {
    return currentActiveThreadId;
  }

  return threads[0]?.id;
}

export function isMissingThreadSnapshotError(error: unknown) {
  return (
    error !== null &&
    typeof error === "object" &&
    "status" in error &&
    error.status === 404 &&
    "code" in error &&
    error.code === "not_found"
  );
}

export function shouldPreferHydratedDefaultThread(
  wasHydratedDefault: boolean,
  pushActivationStatus: "activated" | "deferred" | "rejected" | undefined,
) {
  return wasHydratedDefault && pushActivationStatus !== "activated";
}
