import { describe, expect, it } from "vitest";
import type { ThreadSummary } from "../src/api-schema.js";

import {
  emptyThreadSeenState,
  initializeThreadSeenBaselineState,
  isThreadCompletionUnseen,
  markThreadSeenState,
  threadSeenKey,
} from "../../../apps/mobile/src/lib/thread-seen-store.js";

describe("mobile thread seen ledger", () => {
  it("baselines existing history without marking every completed thread unseen", () => {
    const thread = threadSummary("thread-existing", "2026-08-31T00:00:00.000Z");
    const state = initializeThreadSeenBaselineState(emptyThreadSeenState(), "relay-1", [thread]);

    expect(isThreadCompletionUnseen(state, "relay-1", thread)).toBe(false);
  });

  it("marks a background completion unseen until the thread is viewed", () => {
    const existing = threadSummary("thread-existing", "2026-08-31T00:00:00.000Z");
    const state = initializeThreadSeenBaselineState(emptyThreadSeenState(), "relay-1", [existing]);
    const background = threadSummary("thread-background", "2026-08-31T00:01:00.000Z");

    expect(isThreadCompletionUnseen(state, "relay-1", background)).toBe(true);
    const viewed = markThreadSeenState(state, "relay-1", background);
    expect(isThreadCompletionUnseen(viewed, "relay-1", background)).toBe(false);
  });

  it("marks a newer completion unseen after an older version was viewed", () => {
    const previous = threadSummary("thread-repeat", "2026-08-31T00:00:00.000Z");
    const state = markThreadSeenState(
      initializeThreadSeenBaselineState(emptyThreadSeenState(), "relay-1", [previous]),
      "relay-1",
      previous,
    );
    const completedAgain = threadSummary("thread-repeat", "2026-08-31T00:02:00.000Z");

    expect(isThreadCompletionUnseen(state, "relay-1", completedAgain)).toBe(true);
  });

  it("isolates the same thread id by Relay and workspace", () => {
    const thread = threadSummary("thread-1", "2026-08-31T00:00:00.000Z");
    expect(threadSeenKey("relay-1", thread)).not.toBe(threadSeenKey("relay-2", thread));
    expect(threadSeenKey("relay-1", thread)).not.toBe(
      threadSeenKey("relay-1", { ...thread, workspaceId: "workspace-2" }),
    );
  });

  it("baselines each workspace independently within the same Relay", () => {
    const workspaceA = threadSummary("thread-a", "2026-08-31T00:00:00.000Z");
    const workspaceB = {
      ...threadSummary("thread-b", "2026-08-31T00:00:00.000Z"),
      workspaceId: "workspace-2",
    };
    const afterA = initializeThreadSeenBaselineState(emptyThreadSeenState(), "relay-1", [
      workspaceA,
    ]);
    const afterB = initializeThreadSeenBaselineState(afterA, "relay-1", [workspaceB]);

    expect(isThreadCompletionUnseen(afterB, "relay-1", workspaceA)).toBe(false);
    expect(isThreadCompletionUnseen(afterB, "relay-1", workspaceB)).toBe(false);
    const newWorkspaceBCompletion = {
      ...workspaceB,
      id: "thread-b-new",
      updatedAt: "2026-08-31T00:01:00.000Z",
    };
    expect(isThreadCompletionUnseen(afterB, "relay-1", newWorkspaceBCompletion)).toBe(true);
  });
});

function threadSummary(id: string, updatedAt: string): ThreadSummary {
  return {
    createdAt: "2026-08-31T00:00:00.000Z",
    id,
    messageCount: 1,
    state: "completed",
    title: id,
    updatedAt,
    workspaceId: "workspace-1",
  };
}
