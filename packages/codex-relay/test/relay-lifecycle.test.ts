import { describe, expect, it, vi } from "vitest";

import { createRelayLifecycle } from "../src/relay-lifecycle.js";

describe("Relay lifecycle", () => {
  it("runs quiesce, drain, and close in order and reuses one shutdown", async () => {
    const order: string[] = [];
    const lifecycle = createRelayLifecycle({ drainTimeoutMs: 1_000 });
    lifecycle.onQuiesce(() => {
      order.push("quiesce");
    });
    lifecycle.onDrain(async () => {
      order.push("drain");
    });
    lifecycle.onClose(() => {
      order.push("close");
    });

    const first = lifecycle.shutdown();
    const second = lifecycle.shutdown();

    expect(first).toBe(second);
    expect(lifecycle.isQuiescing()).toBe(true);
    await expect(first).resolves.toEqual({ drainTimedOut: false, errors: [] });
    expect(order).toEqual(["quiesce", "drain", "close"]);
    expect(lifecycle.phase()).toBe("closed");
  });

  it("still closes after drain timeout and records hook errors", async () => {
    vi.useFakeTimers();
    const close = vi.fn<() => void>();
    const lifecycle = createRelayLifecycle({ drainTimeoutMs: 25 });
    lifecycle.onQuiesce(() => {
      throw new Error("quiesce failed");
    });
    lifecycle.onDrain(() => new Promise<void>(() => undefined));
    lifecycle.onClose(close);

    const shutdown = lifecycle.shutdown();
    await vi.advanceTimersByTimeAsync(25);

    await expect(shutdown).resolves.toEqual({
      drainTimedOut: true,
      errors: [{ message: "quiesce failed", phase: "quiescing" }],
    });
    expect(close).toHaveBeenCalledOnce();
    expect(lifecycle.phase()).toBe("closed");
    vi.useRealTimers();
  });
});
