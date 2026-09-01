import {
  normalizeThreadInputDeliveryPhase,
  type ThreadInputDeliveryState,
  type ThreadSummary,
  type TurnLifecyclePhase,
} from "codex-relay/api-schema";

export type RemoteTurnPhase = "idle" | "reconnecting" | TurnLifecyclePhase;

export function resolveRemoteTurnPhase(input: {
  connection: "checking" | "connected" | "offline";
  deliveryState?: ThreadInputDeliveryState;
  queuedInputCount?: number;
  threadState?: ThreadSummary["state"];
}): RemoteTurnPhase {
  switch (input.threadState) {
    case "failed":
      return "failed";
    case "completed":
      return "completed";
    case "running":
      return input.connection === "connected" ? "running" : "reconnecting";
    case "idle":
      break;
  }

  if (input.deliveryState) {
    return normalizeThreadInputDeliveryPhase(input.deliveryState);
  }
  return (input.queuedInputCount ?? 0) > 0 ? "queued" : "idle";
}

export function isRemoteTurnActive(phase: RemoteTurnPhase) {
  return phase === "dispatching" || phase === "running" || phase === "reconnecting";
}

export function isRunningThreadState(state: ThreadSummary["state"] | undefined) {
  return state === "running";
}
