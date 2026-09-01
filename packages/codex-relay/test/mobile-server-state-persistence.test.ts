import { describe, expect, it, vi } from "vitest";
import * as MMKV from "react-native-mmkv";
import * as SecureStore from "expo-secure-store";

import {
  isAppHydrationReady,
  isPersistableServerStateQueryKey,
} from "../../../apps/mobile/src/lib/server-state-persistence.js";
import { queryClientPersister } from "../../../apps/mobile/src/lib/query-persistence.js";

type MockMMKVModule = {
  __getMockMMKVStore(id: string): Map<string, string | number> | undefined;
};

describe("mobile server state persistence", () => {
  it("keeps the native splash visible until fonts and the persisted query cache are ready", () => {
    expect(
      isAppHydrationReady({
        fontsLoaded: true,
        queryCacheRestored: false,
        secureStateRestored: true,
      }),
    ).toBe(false);
    expect(
      isAppHydrationReady({
        fontsLoaded: false,
        queryCacheRestored: true,
        secureStateRestored: true,
      }),
    ).toBe(false);
    expect(
      isAppHydrationReady({
        fontsLoaded: true,
        queryCacheRestored: true,
        secureStateRestored: false,
      }),
    ).toBe(false);
    expect(
      isAppHydrationReady({
        fontsLoaded: true,
        queryCacheRestored: true,
        secureStateRestored: true,
      }),
    ).toBe(true);
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

  it("encrypts persisted thread detail instead of storing message content in plaintext", async () => {
    const persisted = {
      buster: "test",
      clientState: {
        mutations: [],
        queries: [
          {
            dehydratedAt: Date.now(),
            queryHash: "thread-detail",
            queryKey: [
              "codex-relay-server-state",
              "https://relay.example",
              "thread",
              "id:workspace-1",
              "thread-1",
              "detail",
            ],
            state: {
              data: { messages: [{ content: "plaintext-conversation-marker" }] },
              dataUpdateCount: 1,
              dataUpdatedAt: Date.now(),
              error: null,
              errorUpdateCount: 0,
              errorUpdatedAt: 0,
              fetchFailureCount: 0,
              fetchFailureReason: null,
              fetchMeta: null,
              fetchStatus: "idle",
              isInvalidated: false,
              status: "success",
            },
          },
        ],
      },
      timestamp: Date.now(),
    } as Parameters<typeof queryClientPersister.persistClient>[0];

    await queryClientPersister.persistClient(persisted);

    const raw = (MMKV as unknown as MockMMKVModule)
      .__getMockMMKVStore("codex-relay-query-cache")
      ?.get("codex-relay.react-query");
    expect(String(raw)).not.toContain("plaintext-conversation-marker");
    await expect(queryClientPersister.restoreClient()).resolves.toEqual(persisted);
  });

  it("keeps encrypted cache bytes after a transient keychain read failure", async () => {
    const raw = JSON.stringify({
      ciphertext: "AAAA",
      nonce: "AAAAAAAAAAAAAAAA",
      version: 1,
    });
    const store = (MMKV as unknown as MockMMKVModule).__getMockMMKVStore(
      "codex-relay-query-cache",
    )!;
    store.set("codex-relay.react-query", raw);
    const getSpy = vi
      .spyOn(SecureStore, "getItemAsync")
      .mockRejectedValueOnce(new Error("keychain temporarily unavailable"));
    vi.resetModules();
    const { queryClientPersister: freshPersister } =
      await import("../../../apps/mobile/src/lib/query-persistence.js");

    await Promise.resolve(freshPersister.restoreClient?.()).catch(() => undefined);

    expect(store.get("codex-relay.react-query")).toBe(raw);
    getSpy.mockRestore();
  });
});
