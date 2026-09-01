import { describe, expect, it } from "vitest";
import type { ChatMessage, QueuedThreadInput, ThreadSummary } from "../src/api-schema.js";

import {
  appendOptimisticRunMessageToDetail,
  appendOptimisticSteeringMessageToDetail,
  mergeThreadDetailState,
  upsertMessage,
} from "../../../apps/mobile/src/lib/server-state-messages.js";

describe("mobile optimistic queued-input steering state", () => {
  it("shows a normal prompt immediately and replaces it with canonical data", () => {
    const thread = threadSummary("thread-optimistic-run");
    const input = queuedInput("client-event-1", "Show this immediately");
    const optimisticDetail = appendOptimisticRunMessageToDetail(undefined, {
      input,
      nowIso: "2026-06-06T00:00:00.000Z",
      thread,
      threadId: thread.id,
    });
    const canonical = {
      ...chatMessage("canonical-run-user", thread.id, "Show this immediately\n\n[attachment]"),
      createdAt: "2026-06-06T00:00:01.000Z",
      semanticEventId: input.clientEventId,
    };

    expect(optimisticDetail?.messages).toHaveLength(1);
    expect(optimisticDetail?.messages[0]?.semanticEventId).toBe(input.clientEventId);
    expect(upsertMessage(optimisticDetail?.messages ?? [], canonical)).toEqual([canonical]);
  });

  it("does not let a late optimistic message replace its semantic canonical message", () => {
    const thread = threadSummary("thread-semantic-replay");
    const input = queuedInput("client-event-replay", "Keep the canonical message");
    const optimistic = appendOptimisticRunMessageToDetail(undefined, {
      input,
      nowIso: "2026-06-06T00:00:00.000Z",
      thread,
      threadId: thread.id,
    })?.messages[0];
    const canonical = {
      ...chatMessage("canonical-semantic-user", thread.id, "Keep the canonical message"),
      createdAt: "2026-06-06T00:00:01.000Z",
      semanticEventId: input.clientEventId,
    };

    expect(optimistic).toBeDefined();
    expect(upsertMessage([canonical], optimistic!)).toEqual([canonical]);
    expect(
      mergeThreadDetailState(
        { thread, messages: [canonical], pendingInputRequests: [], hasOlderMessages: false },
        {
          thread,
          messages: [optimistic!],
          pendingInputRequests: [],
          hasOlderMessages: false,
        },
      ).messages,
    ).toEqual([canonical]);
  });

  it("shows a steered queued prompt immediately when thread detail is not cached", async () => {
    const thread = threadSummary("thread-steering");
    const input = queuedInput("queued-goal", "/goal Add tests before editing");

    const detail = appendOptimisticSteeringMessageToDetail(undefined, {
      input,
      nowIso: "2026-06-06T00:00:00.000Z",
      thread,
      threadId: thread.id,
    });

    expect(detail?.thread.id).toBe(thread.id);
    expect(detail?.messages.map((message) => [message.role, message.content])).toEqual([
      ["user", input.prompt],
    ]);
  });

  it("replaces the optimistic steering prompt when stream and refresh data arrive", async () => {
    const thread = threadSummary("thread-steering-merge");
    const input = queuedInput("queued-merge", "/goal Keep one message");
    const canonicalMessage = chatMessage("server-user", thread.id, input.prompt);
    const optimisticDetail = appendOptimisticSteeringMessageToDetail(undefined, {
      input,
      nowIso: "2026-06-06T00:00:00.000Z",
      thread,
      threadId: thread.id,
    });

    const streamedMessages = upsertMessage(optimisticDetail?.messages ?? [], canonicalMessage);
    const refreshedDetail = mergeThreadDetailState(
      { hasOlderMessages: false, thread, messages: streamedMessages, pendingInputRequests: [] },
      { hasOlderMessages: false, thread, messages: [canonicalMessage], pendingInputRequests: [] },
    );

    expect(refreshedDetail.messages).toHaveLength(1);
    expect(refreshedDetail.messages[0]).toMatchObject({
      content: input.prompt,
      id: canonicalMessage.id,
      role: "user",
    });
  });

  it("does not let a late thread snapshot replace a completed streamed message", () => {
    const completedThread = {
      ...threadSummary("thread-late-snapshot"),
      state: "completed" as const,
      updatedAt: "2026-06-06T00:00:03.000Z",
    };
    const staleThread = {
      ...completedThread,
      state: "running" as const,
      updatedAt: "2026-06-06T00:00:01.000Z",
    };
    const completedMessage = {
      ...chatMessage("assistant-late-snapshot", completedThread.id, "Hello world"),
      role: "assistant" as const,
      state: "completed" as const,
      updatedAt: "2026-06-06T00:00:03.000Z",
    };
    const staleMessage = {
      ...completedMessage,
      content: "Hello",
      state: "streaming" as const,
      updatedAt: "2026-06-06T00:00:01.000Z",
    };

    const merged = mergeThreadDetailState(
      {
        thread: completedThread,
        messages: [completedMessage],
        pendingInputRequests: [],
        hasOlderMessages: false,
      },
      {
        thread: staleThread,
        messages: [staleMessage],
        pendingInputRequests: [],
        hasOlderMessages: false,
      },
    );

    expect(merged.thread).toMatchObject({ state: "completed" });
    expect(merged.messages).toEqual([completedMessage]);
  });

  it("does not reopen a terminal thread whose message cache is still empty", () => {
    const completedThread = {
      ...threadSummary("thread-empty-terminal"),
      state: "completed" as const,
      updatedAt: "2026-06-06T00:00:03.000Z",
    };
    const staleRunningThread = {
      ...completedThread,
      state: "running" as const,
      updatedAt: "2026-06-06T00:00:01.000Z",
    };

    const merged = mergeThreadDetailState(
      { thread: completedThread, messages: [], pendingInputRequests: [], hasOlderMessages: false },
      {
        thread: staleRunningThread,
        messages: [],
        pendingInputRequests: [],
        hasOlderMessages: false,
      },
    );

    expect(merged.thread.state).toBe("completed");
  });

  it("lets an authoritative refresh clear a newer local running state", () => {
    const runningThread = {
      ...threadSummary("thread-authoritative-terminal"),
      state: "running" as const,
      updatedAt: "2026-06-06T00:00:03.000Z",
    };
    const completedThread = {
      ...runningThread,
      state: "completed" as const,
      updatedAt: "2026-06-06T00:00:01.000Z",
    };
    const current = {
      thread: runningThread,
      messages: [],
      pendingInputRequests: [],
      hasOlderMessages: false,
    };
    const response = {
      thread: completedThread,
      messages: [],
      pendingInputRequests: [],
      hasOlderMessages: false,
    };

    expect(mergeThreadDetailState(current, response).thread.state).toBe("running");
    expect(mergeThreadDetailState(current, response, true).thread.state).toBe("completed");
  });

  it("preserves older-history pagination after an incremental refresh", () => {
    const thread = threadSummary("thread-incremental-history");
    const older = chatMessage("older-message", thread.id, "Older");
    const current = chatMessage("current-message", thread.id, "Current");
    const newer = chatMessage("newer-message", thread.id, "Newer");

    const merged = mergeThreadDetailState(
      {
        thread,
        messages: [older, current],
        pendingInputRequests: [],
        hasOlderMessages: true,
        olderMessagesCursor: older.id,
        messageCursor: current.id,
      },
      {
        thread,
        messages: [newer],
        pendingInputRequests: [],
        hasOlderMessages: false,
        messageCursor: newer.id,
      },
    );

    expect(merged).toMatchObject({
      hasOlderMessages: true,
      messageCursor: newer.id,
      olderMessagesCursor: older.id,
    });
    expect(merged.messages.map((message) => message.id)).toEqual([older.id, current.id, newer.id]);
  });

  it("sorts late-created messages by their server creation time", () => {
    const thread = threadSummary("thread-message-order");
    const newer = {
      ...chatMessage("message-newer", thread.id, "newer"),
      createdAt: "2026-06-06T00:00:02.000Z",
    };
    const older = {
      ...chatMessage("message-older", thread.id, "older"),
      createdAt: "2026-06-06T00:00:01.000Z",
    };

    expect(upsertMessage([newer], older).map((message) => message.id)).toEqual([
      "message-older",
      "message-newer",
    ]);
  });

  it("does not regress a completed message when its creation event is replayed", () => {
    const thread = threadSummary("thread-replayed-message");
    const completed = {
      ...chatMessage("assistant-replayed", thread.id, "Final answer"),
      role: "assistant" as const,
      state: "completed" as const,
      updatedAt: "2026-06-06T00:00:03.000Z",
    };
    const replayedCreation = {
      ...completed,
      content: "",
      state: "streaming" as const,
      updatedAt: "2026-06-06T00:00:01.000Z",
    };

    expect(upsertMessage([completed], replayedCreation)).toEqual([completed]);
  });

  it("does not restore a local message after its canonical replacement arrives", () => {
    const thread = threadSummary("thread-replacement-replay");
    const localMessage = chatMessage("local-user", thread.id, "Keep one copy");
    const canonicalMessage = {
      ...chatMessage("canonical-user", thread.id, "Keep one copy"),
      details: { replacesMessageId: localMessage.id },
    };
    const canonicalDetail = {
      thread,
      messages: [canonicalMessage],
      pendingInputRequests: [],
      hasOlderMessages: false,
    };

    expect(upsertMessage([canonicalMessage], localMessage)).toEqual([canonicalMessage]);
    expect(
      mergeThreadDetailState(canonicalDetail, {
        thread,
        messages: [localMessage],
        pendingInputRequests: [],
        hasOlderMessages: false,
      }).messages,
    ).toEqual([canonicalMessage]);
  });

  it("removes a replaced local message when replacement metadata arrives after canonical data", () => {
    const thread = threadSummary("thread-late-replacement-metadata");
    const localMessage = chatMessage("local-user", thread.id, "Keep one copy");
    const canonicalWithoutReplacement = chatMessage("canonical-user", thread.id, "Keep one copy");
    const canonicalWithReplacement = {
      ...canonicalWithoutReplacement,
      details: { replacesMessageId: localMessage.id },
      updatedAt: "2026-06-06T00:00:01.000Z",
    };

    expect(
      upsertMessage([localMessage, canonicalWithoutReplacement], canonicalWithReplacement),
    ).toEqual([canonicalWithReplacement]);
  });

  it("deduplicates a transient user message before replacement metadata arrives", () => {
    const thread = threadSummary("thread-transient-canonical-user");
    const transient = chatMessage(
      "msg-a4a55e53-78bf-4e22-8aeb-7a5e32d40b97",
      thread.id,
      "Send this once",
    );
    const canonical = {
      ...chatMessage("canonical-user", thread.id, "Send this once"),
      createdAt: "2026-06-06T00:00:01.000Z",
    };

    expect(upsertMessage([transient], canonical)).toEqual([canonical]);
    expect(upsertMessage([canonical], transient)).toEqual([canonical]);
    expect(
      mergeThreadDetailState(
        {
          thread,
          messages: [transient],
          pendingInputRequests: [],
          hasOlderMessages: false,
        },
        {
          thread,
          messages: [canonical],
          pendingInputRequests: [],
          hasOlderMessages: false,
        },
      ).messages,
    ).toEqual([canonical]);
  });

  it("keeps two legitimate repeated prompts with canonical msg IDs", () => {
    const thread = threadSummary("thread-repeated-canonical-users");
    const first = chatMessage("msg-canonical-one", thread.id, "Repeat this");
    const second = {
      ...chatMessage("msg-canonical-two", thread.id, "Repeat this"),
      createdAt: "2026-06-06T00:00:01.000Z",
    };

    expect(upsertMessage([first], second)).toEqual([first, second]);
    expect(
      mergeThreadDetailState(
        { thread, messages: [first], pendingInputRequests: [], hasOlderMessages: false },
        { thread, messages: [second], pendingInputRequests: [], hasOlderMessages: false },
      ).messages,
    ).toEqual([first, second]);
  });
});

function threadSummary(id: string): ThreadSummary {
  const now = "2026-06-06T00:00:00.000Z";
  return {
    id,
    title: id,
    createdAt: now,
    updatedAt: now,
    state: "running",
    messageCount: 0,
  };
}

function queuedInput(id: string, prompt: string): QueuedThreadInput {
  return {
    attachments: [],
    clientEventId: id,
    id,
    prompt,
    skills: [],
  };
}

function chatMessage(id: string, threadId: string, content: string): ChatMessage {
  return {
    id,
    threadId,
    role: "user",
    kind: "chat",
    content,
    createdAt: "2026-06-06T00:00:00.000Z",
    state: "completed",
  };
}
