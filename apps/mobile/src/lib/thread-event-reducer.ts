import {
  StreamThreadRunEventSchema,
  type StreamThreadRunEvent,
  type ThreadEvent,
} from "@aias00/codex-relay/api-schema";

export type ThreadEventCursor = {
  eventId?: string;
  sequence: number;
};

export type ThreadEventApplyResult =
  | { kind: "applied"; cursor: ThreadEventCursor; durable: boolean }
  | { kind: "duplicate"; cursor: ThreadEventCursor }
  | { kind: "gap"; cursor: ThreadEventCursor; expectedSequence: number; receivedSequence: number };

export function isAuthoritativeTerminalThreadEvent(event: StreamThreadRunEvent) {
  return event.type === "thread.state.changed" && event.thread.state !== "running";
}

export class ThreadEventSequenceGapError extends Error {
  expectedSequence: number;
  receivedSequence: number;

  constructor(expectedSequence: number, receivedSequence: number) {
    super(`Thread event sequence gap: expected ${expectedSequence}, received ${receivedSequence}.`);
    this.name = "ThreadEventSequenceGapError";
    this.expectedSequence = expectedSequence;
    this.receivedSequence = receivedSequence;
  }
}

export function applyOrderedThreadEvent(input: {
  applyEvent: (event: StreamThreadRunEvent) => void;
  cursor: ThreadEventCursor;
  event: StreamThreadRunEvent;
}): ThreadEventApplyResult {
  const sequence = input.event.sequence;
  if (sequence === undefined) {
    input.applyEvent(input.event);
    return { kind: "applied", cursor: input.cursor, durable: false };
  }
  if (sequence <= input.cursor.sequence) {
    return { kind: "duplicate", cursor: input.cursor };
  }

  const expectedSequence = input.cursor.sequence + 1;
  if (sequence !== expectedSequence) {
    return {
      kind: "gap",
      cursor: input.cursor,
      expectedSequence,
      receivedSequence: sequence,
    };
  }

  input.applyEvent(input.event);
  return {
    kind: "applied",
    cursor: { eventId: input.event.eventId, sequence },
    durable: true,
  };
}

export function streamEventFromThreadEvent(threadEvent: ThreadEvent) {
  return StreamThreadRunEventSchema.parse({
    ...threadEvent.event,
    eventId: threadEvent.eventId,
    sequence: threadEvent.sequence,
  });
}

export function threadIdFromStreamEvent(event: StreamThreadRunEvent, fallbackThreadId: string) {
  if ("threadId" in event && typeof event.threadId === "string") {
    return event.threadId;
  }
  if ("thread" in event && event.thread) {
    return event.thread.id;
  }
  if ("request" in event) {
    return event.request.threadId;
  }
  return fallbackThreadId;
}
