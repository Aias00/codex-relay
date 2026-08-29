import { describe, expect, it } from "vitest";

import {
  claimInputIdentity,
  clearInputIdentity,
  moveInputIdentity,
} from "../../../apps/mobile/src/lib/input-delivery-state.js";

describe("mobile input delivery identity", () => {
  it("reuses an identity for the same restored submission and rotates it after edits", () => {
    const pending = new Map();
    const ids = ["event-1", "event-2"];
    let createCount = 0;
    const createClientEventId = () => {
      createCount += 1;
      return ids.shift()!;
    };

    expect(claimInputIdentity(pending, "thread-1", "same-body", createClientEventId)).toBe(
      "event-1",
    );
    expect(claimInputIdentity(pending, "thread-1", "same-body", createClientEventId)).toBe(
      "event-1",
    );
    expect(claimInputIdentity(pending, "thread-1", "edited-body", createClientEventId)).toBe(
      "event-2",
    );
    expect(createCount).toBe(2);
  });

  it("moves a new-thread identity and only clears the matching accepted event", () => {
    const pending = new Map();
    const clientEventId = claimInputIdentity(pending, "new", "body", () => "event-1");

    moveInputIdentity(pending, "new", "thread-1", clientEventId);
    clearInputIdentity(pending, "thread-1", "another-event");
    expect(pending.get("thread-1")).toEqual({ clientEventId: "event-1", signature: "body" });

    clearInputIdentity(pending, "thread-1", clientEventId);
    expect(pending.size).toBe(0);
  });
});
