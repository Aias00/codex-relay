import { describe, expect, it, vi } from "vitest";

import { createInputDeliveryOutbox } from "../../../apps/mobile/src/lib/input-delivery-outbox.js";

describe("mobile input delivery outbox", () => {
  it("reuses a persisted client event after restart without storing request content", async () => {
    const secureValues = new Map<string, string>();
    const secureStore = secureStoreFor(secureValues);
    const first = createInputDeliveryOutbox({ now: () => 1000, secureStore });
    const firstPending = new Map();
    const createFirstId = vi.fn<() => string>(() => "event-1");

    const firstId = await first.claim(
      firstPending,
      "thread-1",
      '{"prompt":"plaintext-outbox-marker"}',
      createFirstId,
    );

    expect(firstId).toBe("event-1");
    expect(JSON.stringify([...secureValues.values()])).not.toContain("plaintext-outbox-marker");

    const restarted = createInputDeliveryOutbox({ now: () => 2000, secureStore });
    const restartedPending = new Map();
    const createRestartedId = vi.fn<() => string>(() => "event-2");
    const restartedId = await restarted.claim(
      restartedPending,
      "thread-1",
      '{"prompt":"plaintext-outbox-marker"}',
      createRestartedId,
    );

    expect(restartedId).toBe("event-1");
    expect(createRestartedId).not.toHaveBeenCalled();
  });

  it("moves identities to a created thread and clears only the matching accepted event", async () => {
    const secureValues = new Map<string, string>();
    const outbox = createInputDeliveryOutbox({
      now: () => 1000,
      secureStore: secureStoreFor(secureValues),
    });
    const pending = new Map();
    const clientEventId = await outbox.claim(pending, "__new_thread__", "body", () => "event-1");

    await outbox.move(pending, "__new_thread__", "thread-1", clientEventId);
    await outbox.clear(pending, "thread-1", "another-event");
    expect(pending.get("thread-1")).toMatchObject({ clientEventId: "event-1" });

    await outbox.clear(pending, "thread-1", clientEventId);
    expect(pending.size).toBe(0);

    const restarted = createInputDeliveryOutbox({
      now: () => 2000,
      secureStore: secureStoreFor(secureValues),
    });
    expect(await restarted.claim(new Map(), "thread-1", "body", () => "event-2")).toBe("event-2");
  });

  it("prunes expired identities instead of reusing them indefinitely", async () => {
    const secureValues = new Map<string, string>();
    const secureStore = secureStoreFor(secureValues);
    const first = createInputDeliveryOutbox({ maxAgeMs: 100, now: () => 1000, secureStore });
    await first.claim(new Map(), "thread-1", "body", () => "event-1");

    const restarted = createInputDeliveryOutbox({ maxAgeMs: 100, now: () => 1200, secureStore });
    expect(await restarted.claim(new Map(), "thread-1", "body", () => "event-2")).toBe("event-2");
  });

  it("orders sign-out clearing before a new claim is persisted", async () => {
    const secureValues = new Map<string, string>();
    let releaseDelete: (() => void) | undefined;
    const deleteReleased = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    let delayNextDelete = false;
    const secureStore = {
      async deleteItemAsync(key: string) {
        if (delayNextDelete) {
          delayNextDelete = false;
          await deleteReleased;
        }
        secureValues.delete(key);
      },
      async getItemAsync(key: string) {
        return secureValues.get(key) ?? null;
      },
      async setItemAsync(key: string, value: string) {
        secureValues.set(key, value);
      },
    };
    const outbox = createInputDeliveryOutbox({ now: () => 1000, secureStore });
    await outbox.claim(new Map(), "thread-old", "old", () => "event-old");

    delayNextDelete = true;
    const clearing = outbox.clearAll();
    const claim = outbox.claim(new Map(), "thread-new", "new", () => "event-new");
    releaseDelete?.();
    await Promise.all([clearing, claim]);

    const restarted = createInputDeliveryOutbox({ now: () => 1100, secureStore });
    expect(await restarted.claim(new Map(), "thread-new", "new", () => "event-replaced")).toBe(
      "event-new",
    );
  });

  it("retries outbox hydration after a transient keychain read failure", async () => {
    let reads = 0;
    const outbox = createInputDeliveryOutbox({
      secureStore: {
        async deleteItemAsync() {},
        async getItemAsync() {
          reads += 1;
          if (reads === 1) {
            throw new Error("keychain temporarily unavailable");
          }
          return null;
        },
        async setItemAsync() {},
      },
    });

    await expect(outbox.initialize()).rejects.toThrow("temporarily unavailable");
    await expect(outbox.initialize()).resolves.toBeUndefined();
  });
});

function secureStoreFor(values: Map<string, string>) {
  return {
    async deleteItemAsync(key: string) {
      values.delete(key);
    },
    async getItemAsync(key: string) {
      return values.get(key) ?? null;
    },
    async setItemAsync(key: string, value: string) {
      values.set(key, value);
    },
  };
}
