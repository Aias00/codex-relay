import { describe, expect, it } from "vitest";

import {
  appendProcessedPushEventId,
  parsePushNotificationTarget,
  pushNotificationMatchesRelay,
  pushNotificationProcessedEventId,
} from "../../../apps/mobile/src/lib/push-notification-routing.js";

describe("mobile push notification routing", () => {
  it("parses exact Relay, workspace, thread, turn, and event identity", () => {
    expect(
      parsePushNotificationTarget({
        intent: "turn_terminal",
        relayId: "relay-1",
        semanticEventId: "turn_terminal:thread-1:turn-1",
        threadId: "thread-1",
        turnId: "turn-1",
        workspaceId: "workspace-1",
      }),
    ).toEqual({
      intent: "turn_terminal",
      relayId: "relay-1",
      semanticEventId: "turn_terminal:thread-1:turn-1",
      threadId: "thread-1",
      turnId: "turn-1",
      workspaceId: "workspace-1",
    });
  });

  it("keeps legacy thread-only payloads compatible", () => {
    expect(
      parsePushNotificationTarget({ intent: "action_required", threadId: "thread-legacy" }),
    ).toEqual({ intent: "action_required", threadId: "thread-legacy" });
  });

  it("rejects an identified notification from another Relay", () => {
    expect(
      pushNotificationMatchesRelay(
        { intent: "turn_terminal", relayId: "relay-old", threadId: "thread-1" },
        "relay-current",
      ),
    ).toBe(false);
    expect(
      pushNotificationMatchesRelay(
        { intent: "turn_terminal", relayId: "relay-current", threadId: "thread-1" },
        "relay-current",
      ),
    ).toBe(true);
    expect(
      pushNotificationMatchesRelay(
        { intent: "turn_terminal", threadId: "thread-legacy" },
        "relay-current",
      ),
    ).toBe(true);
  });

  it("keeps a bounded processed-event history and rejects duplicate claims", () => {
    expect(appendProcessedPushEventId(["event-1"], "event-1", 2)).toEqual({
      claimed: false,
      eventIds: ["event-1"],
    });
    expect(appendProcessedPushEventId(["event-1", "event-2"], "event-3", 2)).toEqual({
      claimed: true,
      eventIds: ["event-2", "event-3"],
    });
  });

  it("scopes processed semantic identities by Relay", () => {
    expect(
      pushNotificationProcessedEventId({
        intent: "turn_terminal",
        relayId: "relay-1",
        semanticEventId: "turn:thread-1",
        threadId: "thread-1",
      }),
    ).not.toBe(
      pushNotificationProcessedEventId({
        intent: "turn_terminal",
        relayId: "relay-2",
        semanticEventId: "turn:thread-1",
        threadId: "thread-1",
      }),
    );
  });

  it("keeps identical semantic labels distinct across exact activation targets", () => {
    const base = {
      intent: "turn_terminal" as const,
      relayId: "relay-1",
      semanticEventId: "terminal-event",
      threadId: "thread-1",
      turnId: "turn-1",
      workspaceId: "workspace-1",
    };
    expect(pushNotificationProcessedEventId(base)).not.toBe(
      pushNotificationProcessedEventId({ ...base, turnId: "turn-2" }),
    );
    expect(pushNotificationProcessedEventId(base)).not.toBe(
      pushNotificationProcessedEventId({ ...base, workspaceId: "workspace-2" }),
    );
  });
});
