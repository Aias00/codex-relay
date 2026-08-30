import { describe, expect, it } from "vitest";

import { threadSyncLabel } from "../../../apps/mobile/src/lib/thread-sync-state.js";

describe("mobile thread sync state", () => {
  it("uses concise labels for cache, refresh, history, and fallback states", () => {
    expect(threadSyncLabel("cached")).toBe("Showing cached messages");
    expect(threadSyncLabel("syncing")).toBe("Syncing latest messages");
    expect(threadSyncLabel("hydrating-history")).toBe("Filling older history");
    expect(threadSyncLabel("stale")).toBe("Using cached messages");
    expect(threadSyncLabel("synced")).toBe("Up to date");
  });
});
