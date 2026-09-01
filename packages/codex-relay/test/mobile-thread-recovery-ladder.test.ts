import { describe, expect, it, vi } from "vitest";

import { runThreadRecoveryLadder } from "../../../apps/mobile/src/lib/thread-recovery-ladder.js";

describe("mobile thread recovery ladder", () => {
  it("stops after gap-free event replay", async () => {
    const input = recoveryInput();

    await expect(runThreadRecoveryLadder(input)).resolves.toMatchObject({ source: "events" });
    expect(input.refreshFromMessageCursor).not.toHaveBeenCalled();
    expect(input.refreshRecentSnapshot).not.toHaveBeenCalled();
  });

  it("uses the message cursor when durable replay is unavailable", async () => {
    const input = recoveryInput({
      replayEvents: async () => ({ available: false, lastSequence: 4, resetRequired: false }),
    });

    await expect(runThreadRecoveryLadder(input)).resolves.toMatchObject({
      source: "message-cursor",
    });
    expect(input.refreshFromMessageCursor).toHaveBeenCalledOnce();
    expect(input.refreshRecentSnapshot).not.toHaveBeenCalled();
  });

  it("uses a fresh baseline snapshot before starting another history refresh", async () => {
    const baselineSnapshot = { hasOlderMessages: true };
    const input = recoveryInput({
      baselineSnapshot,
      replayEvents: async () => ({ available: false, lastSequence: 4, resetRequired: false }),
    });

    const result = await runThreadRecoveryLadder(input);
    await result.olderHistory;

    expect(result).toMatchObject({ snapshot: baselineSnapshot, source: "snapshot" });
    expect(input.refreshFromMessageCursor).not.toHaveBeenCalled();
    expect(input.refreshRecentSnapshot).not.toHaveBeenCalled();
  });

  it("materializes a recent snapshot before advancing a reset cursor", async () => {
    const order: string[] = [];
    const input = recoveryInput({
      replayEvents: async () => ({ available: true, lastSequence: 40, resetRequired: true }),
      refreshRecentSnapshot: async () => {
        order.push("snapshot");
        return { hasOlderMessages: true };
      },
      setEventCursor: () => order.push("cursor"),
    });

    const result = await runThreadRecoveryLadder(input);
    await result.olderHistory;

    expect(result.source).toBe("snapshot");
    expect(order).toEqual(["snapshot", "cursor"]);
    expect(input.hydrateOlderHistory).toHaveBeenCalledOnce();
  });

  it("uses a recent snapshot for a sequence gap or failed message-cursor refresh", async () => {
    const gapInput = recoveryInput({
      replayEvents: async () => {
        throw new SequenceGap();
      },
    });
    await expect(runThreadRecoveryLadder(gapInput)).resolves.toMatchObject({
      source: "snapshot",
    });

    const unavailableInput = recoveryInput({
      refreshFromMessageCursor: async () => {
        throw new Error("cursor rejected");
      },
      replayEvents: async () => ({ available: false, lastSequence: 0, resetRequired: false }),
    });
    await expect(runThreadRecoveryLadder(unavailableInput)).resolves.toMatchObject({
      source: "snapshot",
    });
  });
});

class SequenceGap extends Error {}

function recoveryInput(overrides: Partial<Parameters<typeof runThreadRecoveryLadder>[0]> = {}) {
  return {
    hydrateOlderHistory: vi.fn<() => Promise<void>>(async () => undefined),
    isSequenceGap: (error: unknown) => error instanceof SequenceGap,
    refreshFromMessageCursor: vi.fn<() => Promise<{ hasOlderMessages: boolean }>>(async () => ({
      hasOlderMessages: false,
    })),
    refreshRecentSnapshot: vi.fn<() => Promise<{ hasOlderMessages: boolean }>>(async () => ({
      hasOlderMessages: false,
    })),
    replayEvents: vi.fn<() => Promise<ThreadReplayResult>>(async () => ({
      available: true,
      lastSequence: 4,
      resetRequired: false,
    })),
    setEventCursor: vi.fn<(sequence: number) => void>(),
    ...overrides,
  };
}

type ThreadReplayResult = {
  available: boolean;
  lastSequence: number;
  resetRequired: boolean;
};
