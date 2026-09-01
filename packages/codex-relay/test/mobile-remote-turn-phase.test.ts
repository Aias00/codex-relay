import { describe, expect, it } from "vitest";

import {
  isRemoteTurnActive,
  resolveRemoteTurnPhase,
} from "../../../apps/mobile/src/lib/remote-turn-phase.js";

describe("mobile remote turn phase", () => {
  it("distinguishes running from reconnecting without changing the server thread state", () => {
    expect(resolveRemoteTurnPhase({ connection: "connected", threadState: "running" })).toBe(
      "running",
    );
    expect(resolveRemoteTurnPhase({ connection: "checking", threadState: "running" })).toBe(
      "reconnecting",
    );
    expect(resolveRemoteTurnPhase({ connection: "offline", threadState: "running" })).toBe(
      "reconnecting",
    );
  });

  it("normalizes durable input delivery states into one lifecycle", () => {
    expect(resolveRemoteTurnPhase({ connection: "connected", deliveryState: "accepted" })).toBe(
      "queued",
    );
    expect(resolveRemoteTurnPhase({ connection: "connected", deliveryState: "dispatched" })).toBe(
      "dispatching",
    );
    expect(resolveRemoteTurnPhase({ connection: "connected", deliveryState: "cancelled" })).toBe(
      "interrupted",
    );
  });

  it("keeps authoritative terminal thread snapshots ahead of stale queue observations", () => {
    expect(
      resolveRemoteTurnPhase({
        connection: "connected",
        deliveryState: "queued",
        queuedInputCount: 1,
        threadState: "completed",
      }),
    ).toBe("completed");
    expect(
      resolveRemoteTurnPhase({
        connection: "connected",
        deliveryState: "running",
        threadState: "failed",
      }),
    ).toBe("failed");
  });

  it("treats dispatch, run, and reconnect phases as active work", () => {
    expect(isRemoteTurnActive("dispatching")).toBe(true);
    expect(isRemoteTurnActive("running")).toBe(true);
    expect(isRemoteTurnActive("reconnecting")).toBe(true);
    expect(isRemoteTurnActive("queued")).toBe(false);
    expect(isRemoteTurnActive("completed")).toBe(false);
  });
});
