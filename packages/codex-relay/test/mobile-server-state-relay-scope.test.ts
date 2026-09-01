import { describe, expect, it } from "vitest";

import {
  isRelayScopedServerStateQueryKey,
  relayScopedServerStateQueryKey,
  serverStateRootForRelay,
} from "../../../apps/mobile/src/lib/server-state-relay-scope.js";

describe("mobile Relay-scoped server state cache", () => {
  it("adds the stable Relay identity to new cache roots", () => {
    expect(serverStateRootForRelay("https://relay.example", "relay-1")).toEqual([
      "codex-relay-server-state",
      "https://relay.example",
      "relay:relay-1",
    ]);
    expect(serverStateRootForRelay("https://relay.example", undefined)).toEqual([
      "codex-relay-server-state",
      "https://relay.example",
    ]);
  });

  it("promotes URL-only keys into one Relay scope", () => {
    const legacy = [
      "codex-relay-server-state",
      "https://relay.example",
      "thread",
      "id:workspace-1",
      "thread-1",
      "detail",
    ];
    const promoted = relayScopedServerStateQueryKey(legacy, "https://relay.example", "relay-1");

    expect(promoted).toEqual([
      "codex-relay-server-state",
      "https://relay.example",
      "relay:relay-1",
      "thread",
      "id:workspace-1",
      "thread-1",
      "detail",
    ]);
    expect(isRelayScopedServerStateQueryKey(promoted ?? [])).toBe(true);
  });

  it("does not promote another URL or an already scoped key", () => {
    expect(
      relayScopedServerStateQueryKey(
        ["codex-relay-server-state", "https://old.example", "threads", "all"],
        "https://relay.example",
        "relay-1",
      ),
    ).toBeUndefined();
    expect(
      relayScopedServerStateQueryKey(
        ["codex-relay-server-state", "https://relay.example", "relay:relay-old", "threads", "all"],
        "https://relay.example",
        "relay-1",
      ),
    ).toBeUndefined();
  });
});
