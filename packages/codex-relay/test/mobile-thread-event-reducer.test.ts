import { describe, expect, it, vi } from "vitest";

import type { StreamThreadRunEvent, ThreadEvent } from "../src/api-schema.js";
import {
  applyOrderedThreadEvent,
  isAuthoritativeTerminalThreadEvent,
  streamEventFromThreadEvent,
} from "../../../apps/mobile/src/lib/thread-event-reducer.js";

describe("mobile thread event reducer", () => {
  it("applies durable events exactly once in sequence order", () => {
    const applyEvent = vi.fn<(event: StreamThreadRunEvent) => void>();
    const first = applyOrderedThreadEvent({
      applyEvent,
      cursor: { sequence: 0 },
      event: stateEvent(1, "running"),
    });
    const duplicate = applyOrderedThreadEvent({
      applyEvent,
      cursor: first.cursor,
      event: stateEvent(1, "running"),
    });

    expect(first).toMatchObject({ kind: "applied", cursor: { sequence: 1 }, durable: true });
    expect(duplicate).toMatchObject({ kind: "duplicate", cursor: { sequence: 1 } });
    expect(applyEvent).toHaveBeenCalledTimes(1);
  });

  it("stops before applying a sequence gap", () => {
    const applyEvent = vi.fn<(event: StreamThreadRunEvent) => void>();
    const result = applyOrderedThreadEvent({
      applyEvent,
      cursor: { sequence: 3 },
      event: stateEvent(5, "completed"),
    });

    expect(result).toEqual({
      kind: "gap",
      cursor: { sequence: 3 },
      expectedSequence: 4,
      receivedSequence: 5,
    });
    expect(applyEvent).not.toHaveBeenCalled();
  });

  it("keeps legacy cursorless stream events compatible", () => {
    const applyEvent = vi.fn<(event: StreamThreadRunEvent) => void>();
    const event = stateEvent(undefined, "running");
    const result = applyOrderedThreadEvent({
      applyEvent,
      cursor: { eventId: "event-4", sequence: 4 },
      event,
    });

    expect(result).toEqual({
      kind: "applied",
      cursor: { eventId: "event-4", sequence: 4 },
      durable: false,
    });
    expect(applyEvent).toHaveBeenCalledWith(event);
  });

  it("adds the outer replay cursor to the stream event", () => {
    const replayEvent: ThreadEvent = {
      createdAt: "2026-08-26T00:00:00.000Z",
      event: stateEvent(undefined, "completed"),
      eventId: "event-8",
      sequence: 8,
      threadId: "thread-1",
    };

    expect(streamEventFromThreadEvent(replayEvent)).toMatchObject({
      eventId: "event-8",
      sequence: 8,
      type: "thread.state.changed",
    });
  });

  it("treats non-running state events as authoritative terminal snapshots", () => {
    expect(isAuthoritativeTerminalThreadEvent(stateEvent(undefined, "idle"))).toBe(true);
    expect(isAuthoritativeTerminalThreadEvent(stateEvent(undefined, "completed"))).toBe(true);
    expect(isAuthoritativeTerminalThreadEvent(stateEvent(undefined, "failed"))).toBe(true);
    expect(isAuthoritativeTerminalThreadEvent(stateEvent(undefined, "running"))).toBe(false);
  });
});

function stateEvent(
  sequence: number | undefined,
  state: "completed" | "failed" | "idle" | "running",
) {
  return {
    type: "thread.state.changed" as const,
    ...(sequence === undefined ? {} : { eventId: `event-${sequence}`, sequence }),
    thread: {
      id: "thread-1",
      title: "Thread",
      createdAt: "2026-08-26T00:00:00.000Z",
      updatedAt: "2026-08-26T00:00:00.000Z",
      state,
      messageCount: 0,
    },
  };
}
