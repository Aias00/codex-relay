import { describe, expect, it } from "vitest";

import {
  isAppHydrationReady,
  isPersistableServerStateQueryKey,
} from "../../../apps/mobile/src/lib/server-state-persistence.js";

describe("mobile server state persistence", () => {
  it("keeps the native splash visible until fonts and the persisted query cache are ready", () => {
    expect(isAppHydrationReady({ fontsLoaded: true, queryCacheRestored: false })).toBe(false);
    expect(isAppHydrationReady({ fontsLoaded: false, queryCacheRestored: true })).toBe(false);
    expect(isAppHydrationReady({ fontsLoaded: true, queryCacheRestored: true })).toBe(true);
  });

  it("persists thread snapshots and cursors but not transient thread state", () => {
    const root = ["codex-relay-server-state", "https://relay.example"];

    expect(
      isPersistableServerStateQueryKey([...root, "thread", "id:workspace-1", "thread-1", "detail"]),
    ).toBe(true);
    expect(
      isPersistableServerStateQueryKey([
        ...root,
        "relay:relay-1",
        "thread",
        "id:workspace-1",
        "thread-1",
        "detail",
      ]),
    ).toBe(true);
    expect(
      isPersistableServerStateQueryKey([
        ...root,
        "relay:relay-1",
        "thread",
        "id:workspace-1",
        "thread-1",
        "event-cursor",
      ]),
    ).toBe(true);
    expect(
      isPersistableServerStateQueryKey([
        ...root,
        "thread",
        "id:workspace-1",
        "thread-1",
        "event-cursor",
      ]),
    ).toBe(true);
    expect(isPersistableServerStateQueryKey([...root, "thread", "thread-1", "detail"])).toBe(true);
    expect(
      isPersistableServerStateQueryKey(["codex-relay-server-state", "event-cursor", "thread-1"]),
    ).toBe(true);
    expect(isPersistableServerStateQueryKey([...root, "thread", "thread-1", "queued-inputs"])).toBe(
      false,
    );
    expect(
      isPersistableServerStateQueryKey([
        ...root,
        "thread",
        "id:workspace-1",
        "thread-1",
        "context-window",
      ]),
    ).toBe(false);
  });
});
