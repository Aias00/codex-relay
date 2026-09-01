import type { PushNotificationData } from "codex-relay/api-schema";

export type PushNotificationTarget = PushNotificationData;

export function parsePushNotificationTarget(data: unknown): PushNotificationTarget | undefined {
  if (!data || typeof data !== "object") {
    return undefined;
  }
  const record = data as Record<string, unknown>;
  const intent = record.intent;
  const threadId = nonemptyString(record.threadId);
  if ((intent !== "turn_terminal" && intent !== "action_required") || !threadId) {
    return undefined;
  }
  return {
    intent,
    threadId,
    ...optionalStringProperty(record, "relayId"),
    ...optionalStringProperty(record, "semanticEventId"),
    ...optionalStringProperty(record, "turnId"),
    ...optionalStringProperty(record, "workspaceId"),
  } satisfies PushNotificationTarget;
}

function optionalStringProperty(
  record: Record<string, unknown>,
  key: "relayId" | "semanticEventId" | "turnId" | "workspaceId",
) {
  const value = nonemptyString(record[key]);
  return value ? { [key]: value } : {};
}

function nonemptyString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function pushNotificationMatchesRelay(
  target: PushNotificationTarget,
  currentRelayId: string | undefined,
) {
  return !target.relayId || !currentRelayId || target.relayId === currentRelayId;
}

export function appendProcessedPushEventId(
  currentEventIds: readonly string[],
  eventId: string,
  limit = 128,
) {
  if (currentEventIds.includes(eventId)) {
    return { claimed: false, eventIds: [...currentEventIds] };
  }
  return {
    claimed: true,
    eventIds: [...currentEventIds, eventId].slice(-Math.max(1, limit)),
  };
}

export function pushNotificationProcessedEventId(target: PushNotificationTarget) {
  return target.semanticEventId
    ? JSON.stringify([
        target.relayId ?? null,
        target.workspaceId ?? null,
        target.threadId,
        target.turnId ?? null,
        target.semanticEventId,
      ])
    : undefined;
}
