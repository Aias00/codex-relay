import type { ThreadDetailResponse } from "codex-relay/api-schema";

import type { PushNotificationTarget } from "./push-notification-routing";

export type PushActivationResult =
  | { status: "activated"; detail: ThreadDetailResponse }
  | { status: "deferred"; reason: "relay_unknown" | "thread_unavailable" }
  | {
      status: "rejected";
      reason: "relay_mismatch" | "thread_missing" | "workspace_mismatch";
    };

export async function materializePushActivation(input: {
  activate(detail: ThreadDetailResponse): Promise<void> | void;
  currentRelayId: string | undefined;
  isMissingThread(error: unknown): boolean;
  loadThread(threadId: string): Promise<ThreadDetailResponse>;
  target: PushNotificationTarget;
}): Promise<PushActivationResult> {
  if (input.target.relayId && !input.currentRelayId) {
    return { reason: "relay_unknown", status: "deferred" };
  }
  if (input.target.relayId && input.target.relayId !== input.currentRelayId) {
    return { reason: "relay_mismatch", status: "rejected" };
  }

  let detail: ThreadDetailResponse;
  try {
    detail = await input.loadThread(input.target.threadId);
  } catch (error) {
    return input.isMissingThread(error)
      ? { reason: "thread_missing", status: "rejected" }
      : { reason: "thread_unavailable", status: "deferred" };
  }
  if (input.target.workspaceId && detail.thread.workspaceId !== input.target.workspaceId) {
    return { reason: "workspace_mismatch", status: "rejected" };
  }

  await input.activate(detail);
  return { detail, status: "activated" };
}
