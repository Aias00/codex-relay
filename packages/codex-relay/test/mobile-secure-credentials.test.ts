import { describe, expect, it, vi } from "vitest";

import { createSecureCredentialState } from "../../../apps/mobile/src/lib/secure-credentials.js";

describe("mobile secure credentials", () => {
  it("migrates a legacy plaintext token into secure storage", async () => {
    let legacyToken: string | undefined = "legacy-client-token";
    const secureValues = new Map<string, string>();
    const state = createSecureCredentialState({
      deleteLegacy: () => {
        legacyToken = undefined;
      },
      legacyValue: () => legacyToken,
      secureStore: {
        deleteItemAsync: vi.fn<(key: string) => Promise<void>>(async (key) => {
          secureValues.delete(key);
        }),
        getItemAsync: vi.fn<(key: string) => Promise<string | null>>(
          async (key) => secureValues.get(key) ?? null,
        ),
        setItemAsync: vi.fn<(key: string, value: string) => Promise<void>>(async (key, value) => {
          secureValues.set(key, value);
        }),
      },
      storageKey: "codex-relay.client-token",
    });

    await state.initialize();

    expect(state.get()).toBe("legacy-client-token");
    expect(legacyToken).toBeUndefined();
    expect(secureValues.get("codex-relay.client-token")).toBe("legacy-client-token");
  });

  it("updates memory only after secure persistence succeeds", async () => {
    const state = createSecureCredentialState({
      deleteLegacy: () => undefined,
      legacyValue: () => undefined,
      secureStore: {
        deleteItemAsync: vi.fn<(key: string) => Promise<void>>(async () => undefined),
        getItemAsync: vi.fn<(key: string) => Promise<string | null>>(async () => null),
        setItemAsync: vi.fn<(key: string, value: string) => Promise<void>>(async () => {
          throw new Error("keychain unavailable");
        }),
      },
      storageKey: "codex-relay.client-token",
    });

    await expect(state.set("new-token")).rejects.toThrow("keychain unavailable");
    expect(state.get()).toBeUndefined();
  });

  it("orders sign-out deletion before a replacement token is saved", async () => {
    const secureValues = new Map<string, string>([["codex-relay.client-token", "old-token"]]);
    let releaseDelete: (() => void) | undefined;
    const deleteReleased = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    const state = createSecureCredentialState({
      deleteLegacy: () => undefined,
      legacyValue: () => undefined,
      secureStore: {
        async deleteItemAsync(key) {
          await deleteReleased;
          secureValues.delete(key);
        },
        async getItemAsync(key) {
          return secureValues.get(key) ?? null;
        },
        async setItemAsync(key, value) {
          secureValues.set(key, value);
        },
      },
      storageKey: "codex-relay.client-token",
    });
    await state.initialize();

    const clearing = state.clear();
    const replacing = state.set("new-token");
    releaseDelete?.();
    await Promise.all([clearing, replacing]);

    expect(state.get()).toBe("new-token");
    expect(secureValues.get("codex-relay.client-token")).toBe("new-token");
  });

  it("retries credential hydration after a transient keychain read failure", async () => {
    let reads = 0;
    const state = createSecureCredentialState({
      deleteLegacy: () => undefined,
      legacyValue: () => undefined,
      secureStore: {
        async deleteItemAsync() {},
        async getItemAsync() {
          reads += 1;
          if (reads === 1) {
            throw new Error("keychain temporarily unavailable");
          }
          return "restored-token";
        },
        async setItemAsync() {},
      },
      storageKey: "codex-relay.client-token",
    });

    await expect(state.initialize()).rejects.toThrow("temporarily unavailable");
    await expect(state.initialize()).resolves.toBeUndefined();
    expect(state.get()).toBe("restored-token");
  });
});
