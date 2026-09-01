import { codexRelayStorage } from "./codex-relay-server-url-storage";
import {
  appendProcessedPushEventId,
  parsePushNotificationTarget,
  pushNotificationProcessedEventId,
  type PushNotificationTarget,
} from "./push-notification-routing";

const processedPushEventIdsStorageKey = "codex-relay.processed-push-event-ids";
const pendingPushNotificationTargetStorageKey = "codex-relay.pending-push-target";
const pendingTargetListeners = new Set<() => void>();

export function claimPushNotificationEvent(target: PushNotificationTarget) {
  const eventId = pushNotificationProcessedEventId(target);
  if (!eventId) {
    return true;
  }
  const result = appendProcessedPushEventId(storedProcessedPushEventIds(), eventId);
  if (result.claimed) {
    codexRelayStorage.set(processedPushEventIdsStorageKey, JSON.stringify(result.eventIds));
  }
  return result.claimed;
}

export function isPushNotificationEventProcessed(target: PushNotificationTarget) {
  const eventId = pushNotificationProcessedEventId(target);
  return Boolean(eventId && storedProcessedPushEventIds().includes(eventId));
}

export function stagePushNotificationTarget(target: PushNotificationTarget) {
  codexRelayStorage.set(pendingPushNotificationTargetStorageKey, JSON.stringify(target));
  for (const listener of pendingTargetListeners) {
    listener();
  }
}

export function readPendingPushNotificationTarget() {
  const value = codexRelayStorage.getString(pendingPushNotificationTargetStorageKey);
  if (!value) {
    return undefined;
  }
  try {
    return parsePushNotificationTarget(JSON.parse(value));
  } catch {
    return undefined;
  }
}

export function clearPendingPushNotificationTarget() {
  codexRelayStorage.remove(pendingPushNotificationTargetStorageKey);
}

export function subscribePendingPushNotificationTarget(listener: () => void) {
  pendingTargetListeners.add(listener);
  return () => {
    pendingTargetListeners.delete(listener);
  };
}

function storedProcessedPushEventIds() {
  const value = codexRelayStorage.getString(processedPushEventIdsStorageKey);
  if (!value) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((eventId): eventId is string => typeof eventId === "string")
      : [];
  } catch {
    return [];
  }
}
