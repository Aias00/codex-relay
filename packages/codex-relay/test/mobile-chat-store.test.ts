import { beforeEach, describe, expect, it } from "vitest";
import type { ChatMessage, ThreadSummary } from "../src/api-schema.js";

import {
  activateWorkspaceThread,
  activateThreadSnapshot,
  applyStreamEvent,
  chatStore$,
  clearQueuedPrompts,
  getCollaborationMode,
  moveNewThreadCollaborationMode,
  mergeActiveThreadInto,
  replaceMessages,
  replaceThreads,
  resetChatSessionState,
  setActiveThread,
  setCollaborationMode,
  setComposerAttachments,
  setComposerDraft,
  setContextWindowUsage,
  setQueuedPrompts,
  setThreadCollaborationMode,
  setWorkspaceRuntimePreferences,
  stopThreadLocally,
} from "../../../apps/mobile/src/state/chat-store.js";
import { readCachedChatNavigation } from "../../../apps/mobile/src/lib/chat-navigation-cache.js";

describe("mobile chat store stream handling", () => {
  beforeEach(() => {
    resetChatSessionState();
  });

  it("applies a normal active-thread stream into visible messages and running state", () => {
    const runningThread = threadSummary("thread-1", "running");
    replaceThreads([runningThread]);
    setActiveThread(runningThread.id);

    applyStreamEvent({
      type: "thread.message.created",
      thread: runningThread,
      message: chatMessage("user-1", runningThread.id, "user", "hello"),
    });
    applyStreamEvent({
      type: "thread.message.created",
      thread: runningThread,
      message: chatMessage("assistant-1", runningThread.id, "assistant", "", "streaming"),
    });
    applyStreamEvent({
      type: "thread.message.delta",
      threadId: runningThread.id,
      messageId: "assistant-1",
      delta: "reply",
    });
    applyStreamEvent({
      type: "thread.message.completed",
      thread: threadSummary(runningThread.id, "completed"),
      message: chatMessage("assistant-1", runningThread.id, "assistant", "reply", "completed"),
    });

    const messages = chatStore$.messagesByThreadId[runningThread.id].peek();
    expect(chatStore$.activeThreadId.peek()).toBe(runningThread.id);
    expect(chatStore$.threadsById[runningThread.id].state.peek()).toBe("completed");
    expect(messages.map((message) => [message.role, message.content])).toEqual([
      ["user", "hello"],
      ["assistant", "reply"],
    ]);
  });

  it("normalizes cumulative message deltas into only the new suffix", () => {
    const runningThread = threadSummary("thread-cumulative-delta", "running");
    replaceThreads([runningThread]);
    setActiveThread(runningThread.id);

    applyStreamEvent({
      type: "thread.message.created",
      thread: runningThread,
      message: chatMessage("assistant-cumulative", runningThread.id, "assistant", "", "streaming"),
    });
    applyStreamEvent({
      type: "thread.message.delta",
      threadId: runningThread.id,
      messageId: "assistant-cumulative",
      delta: "Hello",
    });
    applyStreamEvent({
      type: "thread.message.delta",
      threadId: runningThread.id,
      messageId: "assistant-cumulative",
      delta: "Hello world",
    });

    const messages = chatStore$.messagesByThreadId[runningThread.id].peek();
    expect(messages.find((message) => message.id === "assistant-cumulative")?.content).toBe(
      "Hello world",
    );
  });

  it("replaces a local stream message when the server sends its canonical id", () => {
    const runningThread = threadSummary("thread-replace", "running");
    replaceThreads([runningThread]);
    setActiveThread(runningThread.id);

    applyStreamEvent({
      type: "thread.message.created",
      thread: runningThread,
      message: chatMessage("msg-local-user", runningThread.id, "user", "hello"),
    });
    applyStreamEvent({
      type: "thread.message.created",
      thread: runningThread,
      message: chatMessage("app-user-1", runningThread.id, "user", "hello", "completed", {
        replacesMessageId: "msg-local-user",
      }),
    });

    const messages = chatStore$.messagesByThreadId[runningThread.id].peek();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      id: "app-user-1",
      content: "hello",
      role: "user",
    });
  });

  it("keeps running state in sync when thread lists replace the active thread", () => {
    const activeThread = threadSummary("active-thread", "running");
    replaceThreads([activeThread]);
    setActiveThread(activeThread.id);
    expect(chatStore$.threadsById[activeThread.id].state.peek()).toBe("running");

    replaceThreads([
      threadSummary(activeThread.id, "completed"),
      threadSummary("other", "running"),
    ]);
    expect(chatStore$.activeThreadId.peek()).toBe(activeThread.id);
    expect(chatStore$.threadsById[activeThread.id].state.peek()).toBe("completed");

    replaceThreads([threadSummary("replacement", "running")]);
    expect(chatStore$.activeThreadId.peek()).toBe("replacement");
    expect(chatStore$.threadsById.replacement.state.peek()).toBe("running");
  });

  it("clears stale running state when activating a completed thread snapshot", () => {
    setActiveThread("stale-running");

    activateThreadSnapshot(threadSummary("new-chat", "completed"), []);

    expect(chatStore$.activeThreadId.peek()).toBe("new-chat");
    expect(chatStore$.threadsById["new-chat"].state.peek()).toBe("completed");
    expect(chatStore$.messagesByThreadId["new-chat"].peek()).toEqual([]);
  });

  it("persists an atomic workspace thread activation for cold starts", () => {
    activateWorkspaceThread("thread-workspace", {
      workspaceId: "workspace-1",
      workspacePath: "/workspace/one",
    });

    expect(chatStore$.activeThreadId.peek()).toBe("thread-workspace");
    expect(chatStore$.workspaceId.peek()).toBe("workspace-1");
    expect(chatStore$.workspacePath.peek()).toBe("/workspace/one");
    expect(readCachedChatNavigation()).toEqual({
      activeThreadId: "thread-workspace",
      workspaceId: "workspace-1",
      workspacePath: "/workspace/one",
    });
  });

  it("optimistically clears running UI state when stopping the active thread", () => {
    const runningThread = threadSummary("thread-stop", "running");
    replaceThreads([runningThread]);
    setActiveThread(runningThread.id);

    stopThreadLocally(runningThread.id);

    expect(chatStore$.threadsById[runningThread.id].state.peek()).toBe("completed");
  });

  it("keeps background stream events from reactivating the visible thread", () => {
    const backgroundThread = threadSummary("thread-a", "running");
    const activeThread = threadSummary("thread-b", "completed");
    replaceThreads([backgroundThread, activeThread]);
    setActiveThread(activeThread.id);

    applyStreamEvent(
      {
        type: "thread.message.created",
        thread: backgroundThread,
        message: chatMessage("a-user", backgroundThread.id, "user", "background"),
      },
      { sourceThreadId: backgroundThread.id },
    );
    applyStreamEvent(
      {
        type: "thread.state.changed",
        thread: backgroundThread,
      },
      { sourceThreadId: backgroundThread.id },
    );

    expect(chatStore$.activeThreadId.peek()).toBe(activeThread.id);
    expect(chatStore$.threadsById[activeThread.id].state.peek()).toBe("completed");
    expect(chatStore$.messagesByThreadId[backgroundThread.id].peek()).toEqual([
      expect.objectContaining({ content: "background", threadId: backgroundThread.id }),
    ]);

    applyStreamEvent(
      {
        type: "thread.state.changed",
        thread: threadSummary(activeThread.id, "running"),
      },
      { sourceThreadId: activeThread.id },
    );
    expect(chatStore$.activeThreadId.peek()).toBe(activeThread.id);
    expect(chatStore$.threadsById[activeThread.id].state.peek()).toBe("running");
  });

  it("keeps queued composer prompts isolated per thread", () => {
    setQueuedPrompts("thread-a", [queuedPrompt("a-1", "Run A")]);
    setQueuedPrompts("thread-b", [queuedPrompt("b-1", "Run B")]);

    clearQueuedPrompts("thread-a");

    expect(chatStore$.queuedPromptsByThreadId.peek()).toEqual({
      "thread-b": [queuedPrompt("b-1", "Run B")],
    });
  });

  it("keeps runtime preferences isolated per workspace", () => {
    setWorkspaceRuntimePreferences("/workspace/a", {
      model: "gpt-5.5",
      reasoningEffort: "high",
      runtimeMode: "full-access",
    });
    setWorkspaceRuntimePreferences("/workspace/b", {
      model: "gpt-5.4",
      reasoningEffort: "low",
      runtimeMode: "auto",
    });

    expect(chatStore$.runtimePreferencesByWorkspacePath.peek()).toEqual({
      "/workspace/a": {
        model: "gpt-5.5",
        reasoningEffort: "high",
        runtimeMode: "full-access",
      },
      "/workspace/b": {
        model: "gpt-5.4",
        reasoningEffort: "low",
        runtimeMode: "auto",
      },
    });
  });

  it("keeps collaboration mode isolated per thread", () => {
    replaceThreads([
      threadSummary("thread-a", "completed"),
      threadSummary("thread-b", "completed"),
    ]);

    setActiveThread("thread-a");
    setCollaborationMode("plan");
    setActiveThread("thread-b");

    expect(getCollaborationMode("thread-a")).toBe("plan");
    expect(getCollaborationMode("thread-b")).toBe("default");
    expect(getCollaborationMode()).toBe("default");
  });

  it("reads collaboration mode from thread metadata", () => {
    replaceThreads([
      {
        ...threadSummary("thread-plan", "completed"),
        collaborationMode: "plan",
      },
    ]);
    setActiveThread("thread-plan");

    expect(getCollaborationMode()).toBe("plan");
  });

  it("moves new-thread collaboration mode to the created thread", () => {
    setThreadCollaborationMode(undefined, "plan");

    moveNewThreadCollaborationMode("thread-created");

    expect(getCollaborationMode()).toBe("default");
    expect(getCollaborationMode("thread-created")).toBe("plan");
  });

  it("moves active thread-scoped UI state when the thread id changes", () => {
    const localThread = threadSummary("local-thread", "running");
    const sdkThread = threadSummary("sdk-thread", "running");
    replaceThreads([localThread]);
    setActiveThread(localThread.id);
    replaceMessages(localThread.id, [chatMessage("local-user", localThread.id, "user", "hello")]);
    setComposerDraft("next prompt", localThread.id);
    setComposerAttachments([attachment("image-1")], localThread.id);
    setCollaborationMode("plan");
    setContextWindowUsage(localThread.id, { tokenLimit: 100, tokensUsed: 12 });
    setQueuedPrompts(localThread.id, [queuedPrompt("queued-1", "queued prompt")]);

    mergeActiveThreadInto(sdkThread);

    expect(chatStore$.messagesByThreadId[localThread.id].peek()).toBeUndefined();
    expect(chatStore$.messagesByThreadId[sdkThread.id].peek()).toEqual([
      expect.objectContaining({ threadId: sdkThread.id, content: "hello" }),
    ]);
    expect(chatStore$.composerDraftByThreadId[localThread.id].peek()).toBeUndefined();
    expect(chatStore$.composerDraftByThreadId[sdkThread.id].peek()).toBe("next prompt");
    expect(chatStore$.composerAttachmentsByThreadId[sdkThread.id].peek()).toEqual([
      attachment("image-1"),
    ]);
    expect(getCollaborationMode(sdkThread.id)).toBe("plan");
    expect(chatStore$.contextUsageByThreadId[sdkThread.id].peek()).toEqual({
      tokenLimit: 100,
      tokensUsed: 12,
    });
    expect(chatStore$.queuedPromptsByThreadId[sdkThread.id].peek()).toEqual([
      queuedPrompt("queued-1", "queued prompt"),
    ]);
  });
});

function threadSummary(id: string, state: ThreadSummary["state"]): ThreadSummary {
  const now = "2026-04-29T00:00:00.000Z";
  return {
    id,
    title: id,
    createdAt: now,
    updatedAt: now,
    state,
    messageCount: 0,
  };
}

function chatMessage(
  id: string,
  threadId: string,
  role: ChatMessage["role"],
  content: string,
  state?: ChatMessage["state"],
  details?: ChatMessage["details"],
): ChatMessage {
  return {
    id,
    threadId,
    role,
    kind: "chat",
    content,
    createdAt: "2026-04-29T00:00:00.000Z",
    details,
    state,
  };
}

function queuedPrompt(id: string, prompt: string) {
  return { attachments: [], id, prompt, skills: [] };
}

function attachment(id: string) {
  return {
    id,
    mimeType: "image/png",
    path: `/tmp/${id}.png`,
    uri: `file://${id}.png`,
    url: `/v1/attachments/images/${id}.png`,
  };
}
