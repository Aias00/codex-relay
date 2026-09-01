import type { ThreadSummary } from "@aias00/codex-relay/api-schema";

import { workspaceSelectionForThread } from "./thread-activation";

export function promptRunEarlyStreamLossAction(recoveredState: ThreadSummary["state"] | undefined) {
  if (recoveredState === "running") {
    return {
      kind: "reconnect",
      restorePrompt: false,
      showFailureToast: false,
    } as const;
  }

  if (recoveredState) {
    return {
      kind: "settle",
      restorePrompt: false,
      showFailureToast: false,
      terminalState: recoveredState,
    } as const;
  }

  return {
    kind: "restore-prompt",
    restorePrompt: true,
    showFailureToast: true,
  } as const;
}

export function queuedMutationReconciliationAction(input: {
  inputStillQueued: boolean;
  threadState: ThreadSummary["state"] | undefined;
}) {
  if (input.inputStillQueued) {
    return "unconfirmed" as const;
  }
  return input.threadState === "running" ? ("settled-reconnect" as const) : ("settled" as const);
}

export function interruptMutationReconciliationAction(
  threadState: ThreadSummary["state"] | undefined,
) {
  if (!threadState) {
    return "unconfirmed" as const;
  }
  return threadState === "running" ? ("reconnect" as const) : ("settled" as const);
}

export function approvalMutationReconciliationAction(input: {
  approvalStillPending: boolean;
  threadState: ThreadSummary["state"] | undefined;
}) {
  if (input.approvalStillPending || !input.threadState) {
    return "unconfirmed" as const;
  }
  return input.threadState === "running" ? ("settled-reconnect" as const) : ("settled" as const);
}

export function shouldRestoreQueuedPromptAfterReconciliation(
  result: { settled: boolean; started: boolean } | false | undefined,
) {
  return Boolean(result && result.settled && !result.started);
}

export function archivedActiveThreadReplacement(input: {
  activeThreadId: string | undefined;
  archivedThreadId: string;
  previousSelection?: { threadId?: string; workspaceId?: string; workspacePath?: string };
  threads: ThreadSummary[];
}) {
  if (input.activeThreadId !== input.archivedThreadId) {
    return undefined;
  }

  const replacement = input.threads.find((thread) => thread.id !== input.archivedThreadId);
  return {
    previousSelection: input.previousSelection,
    replacement,
    replacementSelection: replacement ? workspaceSelectionForThread(replacement) : undefined,
  };
}
