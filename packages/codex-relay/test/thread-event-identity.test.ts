import { describe, expect, it } from "vitest";
import type { StreamThreadRunEvent } from "../src/api-schema.js";

import { semanticThreadEventId } from "../src/thread-event-identity.js";

describe("durable thread semantic event identity", () => {
  it("separates accepted and canonical user-message lifecycle stages", () => {
    const accepted = userEvent("local-user", "client-event-1");
    const canonical = userEvent("canonical-user", "client-event-1", {
      replacesMessageId: "local-user",
    });

    expect(semanticThreadEventId("thread-1", accepted)).toBe(
      "semantic:v1:thread-1:input:client-event-1:user:accepted",
    );
    expect(semanticThreadEventId("thread-1", canonical)).toBe(
      "semantic:v1:thread-1:input:client-event-1:user:canonical",
    );
    expect(semanticThreadEventId("thread-1", canonical)).not.toBe(
      semanticThreadEventId("thread-2", canonical),
    );
  });

  it("gives created and resolved input requests distinct stable identities", () => {
    const created = {
      type: "thread.input_request.created" as const,
      thread: threadSummary(),
      request: {
        id: "approval-1",
        isBlocking: true,
        questions: [{ id: "scope", question: "Continue?" }],
        threadId: "thread-1",
      },
    };
    const resolved = {
      type: "thread.input_request.resolved" as const,
      requestId: "approval-1",
      threadId: "thread-1",
    };

    expect(semanticThreadEventId("thread-1", created)).toBe(
      "semantic:v1:thread-1:input-request:approval-1:created",
    );
    expect(semanticThreadEventId("thread-1", resolved)).toBe(
      "semantic:v1:thread-1:input-request:approval-1:resolved",
    );
  });

  it("does not collapse deltas or state transitions", () => {
    expect(
      semanticThreadEventId("thread-1", {
        type: "thread.message.delta",
        delta: "same text may be emitted twice",
        messageId: "assistant-1",
        threadId: "thread-1",
      }),
    ).toBeUndefined();
    expect(
      semanticThreadEventId("thread-1", {
        type: "thread.state.changed",
        thread: threadSummary(),
      }),
    ).toBeUndefined();
  });
});

function userEvent(
  id: string,
  semanticEventId: string,
  details?: Record<string, unknown>,
): StreamThreadRunEvent {
  return {
    type: "thread.message.created",
    thread: threadSummary(),
    message: {
      content: "Continue",
      createdAt: "2026-08-31T00:00:00.000Z",
      details,
      id,
      kind: "chat",
      role: "user",
      semanticEventId,
      state: "completed",
      threadId: "thread-1",
    },
  };
}

function threadSummary() {
  return {
    createdAt: "2026-08-31T00:00:00.000Z",
    id: "thread-1",
    messageCount: 1,
    state: "running" as const,
    title: "Thread",
    updatedAt: "2026-08-31T00:00:00.000Z",
  };
}
