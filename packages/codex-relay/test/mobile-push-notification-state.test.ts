import { beforeEach, describe, expect, it } from "vitest";

import {
  claimPushNotificationEvent,
  clearPendingPushNotificationTarget,
  isPushNotificationEventProcessed,
  readPendingPushNotificationTarget,
  stagePushNotificationTarget,
  subscribePendingPushNotificationTarget,
} from "../../../apps/mobile/src/lib/push-notification-state.js";

describe("mobile pending push notification state", () => {
  beforeEach(() => {
    clearPendingPushNotificationTarget();
  });

  it("persists and clears an exact pending target", () => {
    const target = pushTarget("relay-state-1", "event-state-1");

    stagePushNotificationTarget(target);
    expect(readPendingPushNotificationTarget()).toEqual(target);
    clearPendingPushNotificationTarget();
    expect(readPendingPushNotificationTarget()).toBeUndefined();
  });

  it("claims a semantic event once per Relay", () => {
    const firstRelay = pushTarget("relay-state-a", "shared-event-state");
    const secondRelay = pushTarget("relay-state-b", "shared-event-state");

    expect(claimPushNotificationEvent(firstRelay)).toBe(true);
    expect(claimPushNotificationEvent(firstRelay)).toBe(false);
    expect(isPushNotificationEventProcessed(firstRelay)).toBe(true);
    expect(claimPushNotificationEvent(secondRelay)).toBe(true);
  });

  it("notifies an already mounted chat screen when a target is staged", () => {
    let notificationCount = 0;
    const unsubscribe = subscribePendingPushNotificationTarget(() => {
      notificationCount += 1;
    });

    stagePushNotificationTarget(pushTarget("relay-state-live", "event-state-live"));
    unsubscribe();
    stagePushNotificationTarget(pushTarget("relay-state-live", "event-state-after"));

    expect(notificationCount).toBe(1);
  });
});

function pushTarget(relayId: string, semanticEventId: string) {
  return {
    intent: "turn_terminal" as const,
    relayId,
    semanticEventId,
    threadId: "thread-state-1",
    turnId: "turn-state-1",
    workspaceId: "workspace-state-1",
  };
}
