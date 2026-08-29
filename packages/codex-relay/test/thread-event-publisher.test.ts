import { describe, expect, it, vi } from "vitest";

import type { StreamThreadRunEvent, ThreadEvent } from "../src/api-schema.js";
import {
  createDurableThreadEventPublisher,
  type ThreadEventDelivery,
} from "../src/thread-event-publisher.js";
import type { ThreadEventStore } from "../src/relay-state-store.js";

describe("durable thread event publisher", () => {
  it("delivers an event only after persistence commits", async () => {
    let commit!: (event: ThreadEvent) => void;
    const store = createStore({
      appendThreadEvent: vi.fn<ThreadEventStore["appendThreadEvent"]>(
        () =>
          new Promise<ThreadEvent>((resolve) => {
            commit = resolve;
          }),
      ),
    });
    const publisher = createDurableThreadEventPublisher({ store });
    const delivered: ThreadEventDelivery[] = [];
    const event = stateEvent("thread-1", "running");

    publisher.publish({
      deliver: (delivery) => delivered.push(delivery),
      event,
      threadId: "thread-1",
    });

    expect(delivered).toEqual([]);
    await Promise.resolve();
    commit(storedEvent("event-1", 1, event));
    await publisher.flush("thread-1");

    expect(delivered).toEqual([
      {
        durable: true,
        event: { ...event, eventId: "event-1", sequence: 1 },
      },
    ]);
  });

  it("serializes persistence and delivery per thread", async () => {
    let activeWrites = 0;
    let maximumActiveWrites = 0;
    let sequence = 0;
    const store = createStore({
      async appendThreadEvent(input) {
        activeWrites += 1;
        maximumActiveWrites = Math.max(maximumActiveWrites, activeWrites);
        await Promise.resolve();
        sequence += 1;
        activeWrites -= 1;
        return storedEvent(`event-${sequence}`, sequence, input.event);
      },
    });
    const publisher = createDurableThreadEventPublisher({ store });
    const delivered: number[] = [];

    for (const state of ["running", "completed"] as const) {
      publisher.publish({
        deliver: ({ event }) => delivered.push(event.sequence ?? -1),
        event: stateEvent("thread-1", state),
        threadId: "thread-1",
      });
    }
    await publisher.flush("thread-1");

    expect(maximumActiveWrites).toBe(1);
    expect(delivered).toEqual([1, 2]);
  });

  it("forwards an explicit idempotency identity to the event store", async () => {
    const appendThreadEvent = vi.fn<ThreadEventStore["appendThreadEvent"]>(async (input) =>
      storedEvent(input.eventId ?? "missing", 1, input.event),
    );
    const publisher = createDurableThreadEventPublisher({
      store: createStore({ appendThreadEvent }),
    });

    publisher.publish({
      deliver: () => undefined,
      event: stateEvent("thread-1", "running"),
      eventId: "recovery-event-1",
      threadId: "thread-1",
    });
    await publisher.flush("thread-1");

    expect(appendThreadEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: "recovery-event-1", threadId: "thread-1" }),
    );
  });

  it("compacts only events older than the configured retention window", async () => {
    const compactThreadEvents = vi.fn<NonNullable<ThreadEventStore["compactThreadEvents"]>>();
    const store = createStore({
      appendThreadEvent: vi.fn<ThreadEventStore["appendThreadEvent"]>(async (input) =>
        storedEvent("event-3", 3, input.event),
      ),
      compactThreadEvents,
    });
    const publisher = createDurableThreadEventPublisher({ maxRetainedEvents: 2, store });

    publisher.publish({
      deliver: () => undefined,
      event: stateEvent("thread-1", "completed"),
      threadId: "thread-1",
    });
    await publisher.flush("thread-1");

    expect(compactThreadEvents).toHaveBeenCalledWith({ threadId: "thread-1", throughSequence: 1 });
  });

  it("delivers the persisted event when compaction fails", async () => {
    const error = new Error("compaction unavailable");
    const onPersistenceError =
      vi.fn<
        (
          error: unknown,
          context: { eventType: StreamThreadRunEvent["type"]; threadId: string },
        ) => void
      >();
    const event = stateEvent("thread-1", "completed");
    const publisher = createDurableThreadEventPublisher({
      maxRetainedEvents: 1,
      onPersistenceError,
      store: createStore({
        appendThreadEvent: vi.fn<ThreadEventStore["appendThreadEvent"]>(async () =>
          storedEvent("event-2", 2, event),
        ),
        compactThreadEvents: vi.fn<NonNullable<ThreadEventStore["compactThreadEvents"]>>(
          async () => {
            throw error;
          },
        ),
      }),
    });
    const delivered: ThreadEventDelivery[] = [];

    publisher.publish({
      deliver: (delivery) => delivered.push(delivery),
      event,
      threadId: "thread-1",
    });
    await publisher.flush("thread-1");

    expect(onPersistenceError).toHaveBeenCalledWith(error, {
      eventType: "thread.state.changed",
      threadId: "thread-1",
    });
    expect(delivered).toEqual([
      { durable: true, event: { ...event, eventId: "event-2", sequence: 2 } },
    ]);
  });

  it("delivers the persisted payload when an explicit event identity is reused", async () => {
    let stored: ThreadEvent | undefined;
    const store = createStore({
      appendThreadEvent: vi.fn<ThreadEventStore["appendThreadEvent"]>(async (input) => {
        stored ??= storedEvent(input.eventId ?? "missing", 1, input.event);
        return stored;
      }),
    });
    const publisher = createDurableThreadEventPublisher({ store });
    const delivered: ThreadEventDelivery[] = [];

    publisher.publish({
      deliver: (delivery) => delivered.push(delivery),
      event: stateEvent("thread-1", "running"),
      eventId: "recovery-state",
      threadId: "thread-1",
    });
    await publisher.flush("thread-1");
    publisher.publish({
      deliver: (delivery) => delivered.push(delivery),
      event: stateEvent("thread-1", "completed"),
      eventId: "recovery-state",
      threadId: "thread-1",
    });
    await publisher.flush("thread-1");

    expect(delivered).toHaveLength(2);
    expect(delivered[1]).toEqual({
      durable: true,
      event: { ...stateEvent("thread-1", "running"), eventId: "recovery-state", sequence: 1 },
    });
  });

  it("falls back to the legacy event when persistence fails", async () => {
    const error = new Error("database unavailable");
    const onPersistenceError =
      vi.fn<
        (
          error: unknown,
          context: { eventType: StreamThreadRunEvent["type"]; threadId: string },
        ) => void
      >();
    const store = createStore({
      appendThreadEvent: vi.fn<ThreadEventStore["appendThreadEvent"]>(async () => {
        throw error;
      }),
    });
    const publisher = createDurableThreadEventPublisher({ onPersistenceError, store });
    const delivered: ThreadEventDelivery[] = [];
    const event = stateEvent("thread-1", "running");

    publisher.publish({
      deliver: (delivery) => delivered.push(delivery),
      event,
      threadId: "thread-1",
    });
    await publisher.flush("thread-1");

    expect(onPersistenceError).toHaveBeenCalledWith(error, {
      eventType: "thread.state.changed",
      threadId: "thread-1",
    });
    expect(delivered).toEqual([{ durable: false, event }]);
  });
});

function createStore(overrides: Partial<ThreadEventStore>): ThreadEventStore {
  return {
    appendThreadEvent: vi.fn<ThreadEventStore["appendThreadEvent"]>(),
    listThreadEvents: vi.fn<ThreadEventStore["listThreadEvents"]>(),
    ...overrides,
  };
}

function storedEvent(eventId: string, sequence: number, event: StreamThreadRunEvent): ThreadEvent {
  return {
    createdAt: "2026-08-26T00:00:00.000Z",
    event,
    eventId,
    sequence,
    threadId: "thread-1",
  };
}

function stateEvent(threadId: string, state: "running" | "completed") {
  const timestamp = "2026-08-26T00:00:00.000Z";
  return {
    type: "thread.state.changed" as const,
    thread: {
      id: threadId,
      title: "Thread",
      createdAt: timestamp,
      updatedAt: timestamp,
      state,
      messageCount: 0,
    },
  };
}
