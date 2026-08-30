import { describe, expect, it, vi } from "vitest";

import {
  prioritizeThreadPrefetch,
  runBoundedThreadPrefetch,
} from "../../../apps/mobile/src/lib/thread-prefetch.js";

describe("mobile thread prefetch policy", () => {
  it("prioritizes running and substantial recent threads while excluding the active thread", () => {
    const candidates = prioritizeThreadPrefetch(
      [
        { id: "old-small", messageCount: 2, state: "completed", updatedAt: "2026-01-01" },
        { id: "running", messageCount: 1, state: "running", updatedAt: "2026-01-01" },
        { id: "recent-large", messageCount: 100, state: "completed", updatedAt: "2026-02-01" },
        { id: "active", messageCount: 200, state: "running", updatedAt: "2026-03-01" },
      ],
      "active",
      3,
    );

    expect(candidates.map((thread) => thread.id)).toEqual(["running", "recent-large", "old-small"]);
  });

  it("bounds concurrent prefetch work and continues after an individual failure", async () => {
    let active = 0;
    let maximumActive = 0;
    const completed: string[] = [];
    const prefetch = vi.fn<(candidate: string) => Promise<void>>(async (candidate: string) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await Promise.resolve();
      active -= 1;
      if (candidate === "failed") {
        throw new Error("offline");
      }
      completed.push(candidate);
    });

    await runBoundedThreadPrefetch(["one", "failed", "two", "three"], prefetch, 2);

    expect(maximumActive).toBeLessThanOrEqual(2);
    expect(prefetch).toHaveBeenCalledTimes(4);
    expect(completed).toEqual(["one", "two", "three"]);
  });
});
