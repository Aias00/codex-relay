import { describe, expect, it } from "vitest";
import type { ThreadSummary } from "../src/api-schema.js";

import {
  activeThreadAfterRefresh,
  isMissingThreadSnapshotError,
  shouldPreferHydratedDefaultThread,
} from "../../../apps/mobile/src/lib/active-thread-selection.js";

describe("mobile active thread refresh selection", () => {
  it("keeps the current thread when it remains in the refreshed list", () => {
    expect(
      activeThreadAfterRefresh({
        currentActiveThreadId: "thread-current",
        missingActiveThreadRestored: false,
        threads: [threadSummary("thread-current"), threadSummary("thread-other")],
      }),
    ).toBe("thread-current");
  });

  it("keeps a newly created active thread when detail restore succeeds before the list catches up", () => {
    expect(
      activeThreadAfterRefresh({
        currentActiveThreadId: "thread-new",
        missingActiveThreadRestored: true,
        threads: [threadSummary("thread-older")],
      }),
    ).toBe("thread-new");
  });

  it("falls back to the first refreshed thread only when the current thread cannot be restored", () => {
    expect(
      activeThreadAfterRefresh({
        currentActiveThreadId: "thread-missing",
        missingActiveThreadRestored: false,
        threads: [threadSummary("thread-fallback")],
      }),
    ).toBe("thread-fallback");
  });

  it("keeps the cached active thread while its authoritative snapshot is not materialized", () => {
    expect(
      activeThreadAfterRefresh({
        canReplaceMissingActiveThread: false,
        currentActiveThreadId: "thread-cached",
        missingActiveThreadRestored: false,
        threads: [threadSummary("thread-fallback")],
      }),
    ).toBe("thread-cached");
  });

  it("replaces a cache-hydrated default with the first fresh server thread", () => {
    expect(
      activeThreadAfterRefresh({
        currentActiveThreadId: "thread-stale-default",
        missingActiveThreadRestored: false,
        preferFirstThread: true,
        threads: [threadSummary("thread-fresh-default"), threadSummary("thread-stale-default")],
      }),
    ).toBe("thread-fresh-default");
  });

  it("distinguishes an authoritative missing thread from transient refresh errors", () => {
    expect(isMissingThreadSnapshotError({ code: "not_found", status: 404 })).toBe(true);
    expect(isMissingThreadSnapshotError({ code: "not_found", status: 503 })).toBe(false);
    expect(isMissingThreadSnapshotError(new Error("Request timed out."))).toBe(false);
  });

  it("does not let a hydrated default override a materialized push target", () => {
    expect(shouldPreferHydratedDefaultThread(true, "activated")).toBe(false);
    expect(shouldPreferHydratedDefaultThread(true, "deferred")).toBe(true);
    expect(shouldPreferHydratedDefaultThread(true, undefined)).toBe(true);
  });
});

function threadSummary(id: string): ThreadSummary {
  const now = "2026-05-19T00:00:00.000Z";
  return {
    id,
    title: id,
    createdAt: now,
    updatedAt: now,
    state: "completed",
    messageCount: 0,
  };
}
