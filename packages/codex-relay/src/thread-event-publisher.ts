import type { StreamThreadRunEvent } from "./api-schema.js";
import type { ThreadEventStore } from "./relay-state-store.js";

export type ThreadEventDelivery = {
  durable: boolean;
  event: StreamThreadRunEvent;
};

type PublishThreadEventInput = {
  deliver(delivery: ThreadEventDelivery): void;
  event: StreamThreadRunEvent;
  eventId?: string;
  threadId: string;
  workspaceId?: string;
};

type PersistenceErrorContext = {
  eventType: StreamThreadRunEvent["type"];
  threadId: string;
};

export type DurableThreadEventPublisher = {
  flush(threadId: string): Promise<void>;
  publish(input: PublishThreadEventInput): void;
};

export function createDurableThreadEventPublisher(input: {
  maxRetainedEvents?: number;
  onPersistenceError?: (error: unknown, context: PersistenceErrorContext) => void;
  store: ThreadEventStore;
}): DurableThreadEventPublisher {
  const tailsByThreadId = new Map<string, Promise<void>>();
  const maxRetainedEvents = input.maxRetainedEvents;
  if (
    maxRetainedEvents !== undefined &&
    (!Number.isInteger(maxRetainedEvents) || maxRetainedEvents < 1)
  ) {
    throw new TypeError("maxRetainedEvents must be a positive integer when configured.");
  }

  return {
    async flush(threadId) {
      while (true) {
        const tail = tailsByThreadId.get(threadId);
        if (!tail) {
          return;
        }
        await tail;
        if (tailsByThreadId.get(threadId) === tail) {
          return;
        }
      }
    },
    publish(publishInput) {
      const previous = tailsByThreadId.get(publishInput.threadId) ?? Promise.resolve();
      const operation = previous.then(async () => {
        let stored;
        try {
          stored = await input.store.appendThreadEvent({
            event: publishInput.event,
            eventId: publishInput.eventId,
            threadId: publishInput.threadId,
            workspaceId: publishInput.workspaceId,
          });
        } catch (error) {
          input.onPersistenceError?.(error, {
            eventType: publishInput.event.type,
            threadId: publishInput.threadId,
          });
          publishInput.deliver({ durable: false, event: publishInput.event });
          return;
        }
        const compactThroughSequence =
          maxRetainedEvents === undefined ? 0 : stored.sequence - maxRetainedEvents;
        if (compactThroughSequence > 0 && input.store.compactThreadEvents) {
          try {
            await input.store.compactThreadEvents({
              threadId: publishInput.threadId,
              throughSequence: compactThroughSequence,
            });
          } catch (error) {
            input.onPersistenceError?.(error, {
              eventType: publishInput.event.type,
              threadId: publishInput.threadId,
            });
          }
        }
        publishInput.deliver({
          durable: true,
          event: {
            ...stored.event,
            eventId: stored.eventId,
            sequence: stored.sequence,
          },
        });
      });
      const tail = operation.catch(() => undefined);
      tailsByThreadId.set(publishInput.threadId, tail);
      void tail.finally(() => {
        if (tailsByThreadId.get(publishInput.threadId) === tail) {
          tailsByThreadId.delete(publishInput.threadId);
        }
      });
    },
  };
}
