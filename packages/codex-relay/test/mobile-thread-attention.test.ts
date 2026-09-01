import { describe, expect, it } from "vitest";

import {
  compareThreadAttention,
  threadAttentionState,
  threadAttentionStates,
} from "../../../apps/mobile/src/lib/thread-attention.js";

describe("mobile thread attention priority", () => {
  it("uses one strict priority ladder", () => {
    expect([...threadAttentionStates].sort(compareThreadAttention)).toEqual([
      "blocked",
      "failed",
      "completed-unseen",
      "paused",
      "working",
      "idle",
      "unknown",
    ]);
  });

  it("derives attention from thread and interaction state", () => {
    expect(threadAttentionState({ hasBlockingRequest: true, threadState: "running" })).toBe(
      "blocked",
    );
    expect(threadAttentionState({ threadState: "failed" })).toBe("failed");
    expect(threadAttentionState({ hasUnseenCompletion: true, threadState: "completed" })).toBe(
      "completed-unseen",
    );
    expect(threadAttentionState({ goalStatus: "paused", threadState: "running" })).toBe("paused");
    expect(threadAttentionState({ threadState: "running" })).toBe("working");
    expect(threadAttentionState({ threadState: "completed" })).toBe("idle");
    expect(threadAttentionState({})).toBe("unknown");
  });
});
