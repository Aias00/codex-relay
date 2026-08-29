import { describe, expect, it, vi } from "vitest";

import type {
  ListThreadEventsResponse,
  StreamThreadRunEvent,
  ThreadEvent,
} from "../src/api-schema.js";
import { replayThreadEventPages } from "../../../apps/mobile/src/lib/thread-event-client.js";

describe("mobile thread event replay client", () => {
  it("fetches every page and forwards cursor-enriched events", async () => {
    const pages = [page([threadEvent(1)], true), page([threadEvent(2)], false)];
    const fetchPage = vi.fn<FetchPage>(async () => pages.shift()!);
    const applyEvent = vi.fn<(event: StreamThreadRunEvent) => void>();

    const result = await replayThreadEventPages({
      afterSequence: 0,
      applyEvent,
      fetchPage,
      isReplayUnavailable: () => false,
      threadId: "thread-1",
    });

    expect(fetchPage).toHaveBeenNthCalledWith(1, "thread-1", {
      afterSequence: 0,
      limit: 500,
    });
    expect(fetchPage).toHaveBeenNthCalledWith(2, "thread-1", {
      afterSequence: 1,
      limit: 500,
    });
    expect(applyEvent.mock.calls.map(([event]) => [event.eventId, event.sequence])).toEqual([
      ["event-1", 1],
      ["event-2", 2],
    ]);
    expect(result).toEqual({
      appliedCount: 2,
      available: true,
      lastSequence: 2,
      resetRequired: false,
    });
  });

  it("stops replay when the server requires a snapshot reset", async () => {
    const applyEvent = vi.fn<(event: StreamThreadRunEvent) => void>();
    const fetchPage = vi.fn<FetchPage>(async () => ({
      events: [],
      hasMore: false,
      lastSequence: 12,
      resetRequired: true,
    }));

    await expect(
      replayThreadEventPages({
        afterSequence: 3,
        applyEvent,
        fetchPage,
        isReplayUnavailable: () => false,
        threadId: "thread-1",
      }),
    ).resolves.toEqual({
      appliedCount: 0,
      available: true,
      lastSequence: 12,
      resetRequired: true,
    });
    expect(applyEvent).not.toHaveBeenCalled();
  });

  it("falls back cleanly when an older Relay has no replay endpoint", async () => {
    const unavailable = new Error("not supported");
    const applyEvent = vi.fn<(event: StreamThreadRunEvent) => void>();

    const result = await replayThreadEventPages({
      afterSequence: 7,
      applyEvent,
      fetchPage: vi.fn<FetchPage>(async () => {
        throw unavailable;
      }),
      isReplayUnavailable: (error) => error === unavailable,
      threadId: "thread-1",
    });

    expect(result).toEqual({
      appliedCount: 0,
      available: false,
      lastSequence: 7,
      resetRequired: false,
    });
    expect(applyEvent).not.toHaveBeenCalled();
  });
});

type FetchPage = Parameters<typeof replayThreadEventPages>[0]["fetchPage"];

function page(events: ThreadEvent[], hasMore: boolean): ListThreadEventsResponse {
  return {
    events,
    hasMore,
    lastSequence: events.at(-1)?.sequence ?? 0,
    resetRequired: false,
  };
}

function threadEvent(sequence: number): ThreadEvent {
  return {
    createdAt: "2026-08-26T00:00:00.000Z",
    event: {
      type: "thread.state.changed",
      thread: {
        id: "thread-1",
        title: "Thread",
        createdAt: "2026-08-26T00:00:00.000Z",
        updatedAt: "2026-08-26T00:00:00.000Z",
        state: sequence === 1 ? "running" : "completed",
        messageCount: 0,
      },
    },
    eventId: `event-${sequence}`,
    sequence,
    threadId: "thread-1",
  };
}
