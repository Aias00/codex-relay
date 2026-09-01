import type {
  ListThreadEventsResponse,
  StreamThreadRunEvent,
} from "@aias00/codex-relay/api-schema";

import { streamEventFromThreadEvent } from "./thread-event-reducer";

type FetchThreadEventsPage = (
  threadId: string,
  options: { afterSequence: number; limit: number },
) => Promise<ListThreadEventsResponse>;

export async function replayThreadEventPages(input: {
  afterSequence: number;
  applyEvent: (event: StreamThreadRunEvent) => void;
  fetchPage: FetchThreadEventsPage;
  isReplayUnavailable: (error: unknown) => boolean;
  threadId: string;
}) {
  let afterSequence = input.afterSequence;
  let appliedCount = 0;

  try {
    while (true) {
      const page = await input.fetchPage(input.threadId, { afterSequence, limit: 500 });
      if (page.resetRequired) {
        return {
          appliedCount,
          available: true as const,
          lastSequence: page.lastSequence,
          resetRequired: true as const,
        };
      }
      let nextSequence = afterSequence;
      for (const threadEvent of page.events) {
        if (threadEvent.threadId !== input.threadId) {
          throw new Error(
            `Thread event ${threadEvent.eventId} belongs to ${threadEvent.threadId}, not ${input.threadId}.`,
          );
        }
        input.applyEvent(streamEventFromThreadEvent(threadEvent));
        nextSequence = Math.max(nextSequence, threadEvent.sequence);
        appliedCount += 1;
      }
      if (!page.hasMore) {
        return {
          appliedCount,
          available: true as const,
          lastSequence: nextSequence,
          resetRequired: false as const,
        };
      }
      if (nextSequence <= afterSequence) {
        throw new Error("Thread event replay did not advance its cursor.");
      }
      afterSequence = nextSequence;
    }
  } catch (error) {
    if (input.isReplayUnavailable(error)) {
      return {
        appliedCount: 0,
        available: false as const,
        lastSequence: input.afterSequence,
        resetRequired: false as const,
      };
    }
    throw error;
  }
}
