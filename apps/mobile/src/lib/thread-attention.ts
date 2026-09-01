export const threadAttentionStates = [
  "blocked",
  "failed",
  "completed-unseen",
  "paused",
  "working",
  "idle",
  "unknown",
] as const;

export type ThreadAttentionState = (typeof threadAttentionStates)[number];

const attentionRanks: Record<ThreadAttentionState, number> = {
  blocked: 6,
  failed: 5,
  "completed-unseen": 4,
  paused: 3,
  working: 2,
  idle: 1,
  unknown: 0,
};

export function threadAttentionState(input: {
  goalStatus?: string;
  hasBlockingRequest?: boolean;
  hasUnseenCompletion?: boolean;
  threadState?: string;
}): ThreadAttentionState {
  if (
    input.hasBlockingRequest ||
    input.goalStatus === "blocked" ||
    input.goalStatus === "usageLimited" ||
    input.goalStatus === "budgetLimited"
  ) {
    return "blocked";
  }
  if (input.threadState === "failed") {
    return "failed";
  }
  if (input.hasUnseenCompletion && input.threadState === "completed") {
    return "completed-unseen";
  }
  if (input.goalStatus === "paused") {
    return "paused";
  }
  if (input.threadState === "running") {
    return "working";
  }
  if (input.threadState === "idle" || input.threadState === "completed") {
    return "idle";
  }
  return "unknown";
}

export function compareThreadAttention(left: ThreadAttentionState, right: ThreadAttentionState) {
  return attentionRanks[right] - attentionRanks[left];
}

export function threadAttentionLabel(state: ThreadAttentionState) {
  switch (state) {
    case "blocked":
      return "Needs attention";
    case "failed":
      return "Failed";
    case "completed-unseen":
      return "Completed";
    case "paused":
      return "Paused";
    case "working":
      return "Working";
    case "idle":
      return "Idle";
    case "unknown":
      return "Unknown";
  }
}
