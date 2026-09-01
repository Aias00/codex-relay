import { describe, expect, it, vi } from "vitest";

import {
  ListThreadEventsResponseSchema,
  StreamThreadRunEventSchema,
  apiPaths,
  type StreamThreadRunEvent,
} from "../src/api-schema.js";
import { createApp } from "../src/app.js";
import type { CodexClient } from "../src/codex.js";
import { createRelayStateStore, type ThreadEventStore } from "../src/relay-state-store.js";

describe("thread event replay API", () => {
  it("returns persisted events without mutating the thread", async () => {
    const events = await createRelayStateStore(":memory:");
    const app = createApp({ codex: createMockCodex(), threadEvents: events });
    const created = await app.request(apiPaths.threads, {
      body: JSON.stringify({ title: "Replay" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const createdBody = await created.json();
    const threadId = String(createdBody.thread.id);
    await events.appendThreadEvent({
      eventId: "event-1",
      threadId,
      event: {
        type: "thread.state.changed",
        thread: createdBody.thread,
      },
    });

    const before = await (await app.request(apiPaths.thread(threadId))).json();
    const response = await app.request(
      `${apiPaths.threadEvents(threadId)}?afterSequence=0&limit=50`,
    );
    const replay = ListThreadEventsResponseSchema.parse(await response.json());
    const after = await (await app.request(apiPaths.thread(threadId))).json();

    expect(response.status).toBe(200);
    expect(replay).toMatchObject({
      events: [{ eventId: "event-1", sequence: 1, threadId }],
      hasMore: false,
      lastSequence: 1,
      resetRequired: false,
    });
    expect(after).toEqual(before);
  });

  it("requires clients with a compacted cursor to reset from the thread detail snapshot", async () => {
    const events = await createRelayStateStore(":memory:");
    const app = createApp({ codex: createMockCodex(), threadEvents: events });
    const created = await createThreadResponse(app, "Compacted replay");
    const threadId = created.thread.id;
    await events.appendThreadEvent({
      eventId: "event-1",
      threadId,
      event: { type: "thread.state.changed", thread: { ...created.thread, state: "running" } },
    });
    await events.appendThreadEvent({
      eventId: "event-2",
      threadId,
      event: { type: "thread.state.changed", thread: created.thread },
    });
    await events.compactThreadEvents!({ threadId, throughSequence: 1 });

    const response = await app.request(`${apiPaths.threadEvents(threadId)}?afterSequence=0`);

    expect(response.status).toBe(200);
    expect(ListThreadEventsResponseSchema.parse(await response.json())).toEqual({
      events: [],
      hasMore: false,
      lastSequence: 2,
      resetRequired: true,
    });
  });

  it("rejects invalid cursors without affecting existing thread APIs", async () => {
    const events = await createRelayStateStore(":memory:");
    const app = createApp({ codex: createMockCodex(), threadEvents: events });
    const created = await app.request(apiPaths.threads, {
      body: JSON.stringify({ title: "Replay" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const threadId = String((await created.json()).thread.id);

    const invalid = await app.request(`${apiPaths.threadEvents(threadId)}?afterSequence=-1`);
    const detail = await app.request(apiPaths.thread(threadId));

    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: { code: "invalid_request" } });
    expect(detail.status).toBe(200);
  });

  it("reports replay as unavailable when the optional store is not configured", async () => {
    const app = createApp({ codex: createMockCodex() });
    const created = await app.request(apiPaths.threads, {
      body: JSON.stringify({ title: "Legacy" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const threadId = String((await created.json()).thread.id);

    const replay = await app.request(apiPaths.threadEvents(threadId));
    const detail = await app.request(apiPaths.thread(threadId));

    expect(replay.status).toBe(503);
    expect(await replay.json()).toMatchObject({ error: { code: "event_replay_unavailable" } });
    expect(detail.status).toBe(200);
  });

  it("replays and follows durable events until a terminal event", async () => {
    const events = await createRelayStateStore(":memory:");
    const appendThreadEvent = vi.spyOn(events, "appendThreadEvent");
    const app = createApp({ codex: createMockCodex(), threadEvents: events });
    const created = await createThreadResponse(app, "Durable event stream");
    const threadId = created.thread.id;
    await events.appendThreadEvent({
      eventId: "event-running",
      threadId,
      event: {
        type: "thread.state.changed",
        thread: { ...created.thread, state: "running" },
      },
    });

    const response = await app.request(`${apiPaths.threadEventsStream(threadId)}?afterSequence=0`);
    const reader = response.body!.getReader();
    const firstEvent = await readNextSseEvent(reader);

    await events.appendThreadEvent({
      eventId: "event-completed",
      threadId,
      event: {
        type: "thread.state.changed",
        thread: { ...created.thread, state: "completed" },
      },
    });
    const remainingEvents = parseSseEvents(await readRemainingStream(reader));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(firstEvent).toMatchObject({
      eventId: "event-running",
      sequence: 1,
      type: "thread.state.changed",
      thread: { state: "running" },
    });
    expect(remainingEvents).toEqual([
      expect.objectContaining({
        eventId: "event-completed",
        sequence: 2,
        type: "thread.state.changed",
        thread: expect.objectContaining({ state: "completed" }),
      }),
    ]);
    expect(appendThreadEvent).toHaveBeenCalledTimes(2);
  });

  it("cancels only the durable event subscriber", async () => {
    const events = await createRelayStateStore(":memory:");
    const app = createApp({ codex: createMockCodex(), threadEvents: events });
    const created = await createThreadResponse(app, "Cancelled subscriber");
    const threadId = created.thread.id;
    await events.appendThreadEvent({
      threadId,
      event: {
        type: "thread.state.changed",
        thread: { ...created.thread, state: "running" },
      },
    });
    const firstResponse = await app.request(
      `${apiPaths.threadEventsStream(threadId)}?afterSequence=0`,
    );
    const firstReader = firstResponse.body!.getReader();
    await readNextSseEvent(firstReader);
    await firstReader.cancel("mobile disconnected");

    await events.appendThreadEvent({
      eventId: "terminal-after-cancel",
      threadId,
      event: {
        type: "thread.state.changed",
        thread: { ...created.thread, state: "completed" },
      },
    });
    const secondResponse = await app.request(
      `${apiPaths.threadEventsStream(threadId)}?afterSequence=1`,
    );
    const streamedEvents = parseSseEvents(await secondResponse.text());

    expect(secondResponse.status).toBe(200);
    expect(streamedEvents).toEqual([
      expect.objectContaining({ eventId: "terminal-after-cancel", sequence: 2 }),
    ]);
  });

  it("reports durable event streaming as unavailable without an event store", async () => {
    const app = createApp({ codex: createMockCodex() });
    const threadId = await createThread(app, "Legacy event stream");

    const response = await app.request(apiPaths.threadEventsStream(threadId));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "event_replay_unavailable" },
    });
  });

  it("persists prompt stream events in the same order before delivering cursor metadata", async () => {
    const events = await createRelayStateStore(":memory:");
    const workspace = await events.registerWorkspace({
      path: process.cwd(),
      source: "relay_startup",
    });
    const app = createApp({
      codex: createMockCodex(),
      threadEvents: events,
      workspaceRegistry: events,
    });
    const created = await app.request(apiPaths.threads, {
      body: JSON.stringify({ title: "Durable stream", workspaceId: workspace.workspaceId }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const threadId = String((await created.json()).thread.id);

    const response = await app.request(apiPaths.threadRunStream(threadId), {
      body: JSON.stringify({ prompt: "Persist this" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const streamedEvents = parseSseEvents(await response.text());
    const replayResponse = await app.request(
      `${apiPaths.threadEvents(threadId)}?afterSequence=0&limit=50`,
    );
    const replay = ListThreadEventsResponseSchema.parse(await replayResponse.json());

    expect(response.status).toBe(200);
    expect(streamedEvents.length).toBeGreaterThan(0);
    expect(streamedEvents.map((event) => event.sequence)).toEqual(
      streamedEvents.map((_, index) => index + 1),
    );
    expect(streamedEvents.every((event) => Boolean(event.eventId))).toBe(true);
    expect(replay.events.map((event) => event.sequence)).toEqual(
      streamedEvents.map((event) => event.sequence),
    );
    expect(replay.events.map((event) => event.eventId)).toEqual(
      streamedEvents.map((event) => event.eventId),
    );
    expect(replay.events.every((event) => event.workspaceId === workspace.workspaceId)).toBe(true);
    expect(replay.events.map((event) => event.event.type)).toEqual(
      streamedEvents.map((event) => event.type),
    );
    expect(new Set(streamedEvents.map((event) => event.sequence)).size).toBe(streamedEvents.length);
  });

  it("keeps legacy prompt streams working when durable replay is not configured", async () => {
    const app = createApp({ codex: createMockCodex() });
    const threadId = await createThread(app, "Legacy stream");

    const response = await app.request(apiPaths.threadRunStream(threadId), {
      body: JSON.stringify({ prompt: "Legacy" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const streamedEvents = parseSseEvents(await response.text());

    expect(response.status).toBe(200);
    expect(streamedEvents.map((event) => event.type)).toContain("thread.message.completed");
    expect(streamedEvents.every((event) => event.eventId === undefined)).toBe(true);
    expect(streamedEvents.every((event) => event.sequence === undefined)).toBe(true);
  });

  it("falls back to the legacy stream when event persistence fails", async () => {
    const threadEvents: ThreadEventStore = {
      appendThreadEvent: vi.fn<ThreadEventStore["appendThreadEvent"]>(async () => {
        throw new Error("relay state unavailable");
      }),
      listThreadEvents: vi.fn<ThreadEventStore["listThreadEvents"]>(async () => ({
        events: [],
        hasMore: false,
        lastSequence: 0,
      })),
    };
    const app = createApp({ codex: createMockCodex(), threadEvents });
    const threadId = await createThread(app, "Fallback stream");

    const response = await app.request(apiPaths.threadRunStream(threadId), {
      body: JSON.stringify({ prompt: "Still deliver" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const streamedEvents = parseSseEvents(await response.text());

    expect(response.status).toBe(200);
    expect(threadEvents.appendThreadEvent).toHaveBeenCalled();
    expect(streamedEvents.map((event) => event.type)).toContain("thread.message.completed");
    expect(
      streamedEvents.some(
        (event) => event.type === "thread.state.changed" && event.thread.state === "completed",
      ),
    ).toBe(true);
    expect(streamedEvents.every((event) => event.eventId === undefined)).toBe(true);
    expect(streamedEvents.every((event) => event.sequence === undefined)).toBe(true);
  });

  it("continues persisting the run after the mobile SSE connection is cancelled", async () => {
    const events = await createRelayStateStore(":memory:");
    let continueRun!: () => void;
    const runGate = new Promise<void>((resolve) => {
      continueRun = resolve;
    });
    const codex = createMockCodex({ runGate });
    const app = createApp({ codex, threadEvents: events });
    const threadId = await createThread(app, "Disconnected stream");
    const response = await app.request(apiPaths.threadRunStream(threadId), {
      body: JSON.stringify({ prompt: "Finish after disconnect" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const reader = response.body?.getReader();

    expect(reader).toBeDefined();
    await reader!.read();
    await reader!.cancel("mobile disconnected");
    continueRun();

    const replay = await waitForCompletedReplay(events, threadId);
    const completed = replay.find(
      (item) =>
        item.event.type === "thread.state.changed" && item.event.thread.state === "completed",
    );
    const assistant = replay.find(
      (item) =>
        item.event.type === "thread.message.completed" && item.event.message.role === "assistant",
    );

    expect(completed).toBeDefined();
    expect(assistant?.event).toMatchObject({ message: { content: "first second" } });
  });

  it("continues persisting app-server notifications after the mobile run stream is cancelled", async () => {
    const events = await createRelayStateStore(":memory:");
    const notificationHandlers = new Set<(notification: unknown) => void>();
    const now = Date.now() / 1000;
    const threadId = "app-thread-disconnected-stream";
    let subscribed = false;
    let markTurnStarted!: () => void;
    const turnStarted = new Promise<void>((resolve) => {
      markTurnStarted = resolve;
    });
    const appThread = {
      id: threadId,
      createdAt: now,
      cwd: process.cwd(),
      modelProvider: "gpt-5.5",
      name: "Disconnected app-server stream",
      preview: "Existing TUI message",
      source: "cli",
      status: { type: "idle" },
      turns: [],
      updatedAt: now,
    };
    const appServer = {
      isThreadSubscribed: () => subscribed,
      onNotification(handler: (notification: unknown) => void) {
        notificationHandlers.add(handler);
        return () => notificationHandlers.delete(handler);
      },
      onRequest() {
        return () => undefined;
      },
      readThread: async () => appThread,
      async resumeThread() {
        subscribed = true;
        return appThread;
      },
      async startTurn() {
        markTurnStarted();
        return {
          id: "turn-disconnected-stream",
          items: [],
          status: "inProgress",
          startedAt: now,
          completedAt: null,
        };
      },
    };
    const app = createApp({ appServer: appServer as never, threadEvents: events });
    const response = await app.request(apiPaths.threadRunStream(threadId), {
      body: JSON.stringify({ prompt: "Finish after disconnect" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const reader = response.body?.getReader();

    expect(reader).toBeDefined();
    await reader!.read();
    await turnStarted;
    await reader!.cancel("mobile switched to durable events");
    for (const handler of notificationHandlers) {
      handler({
        method: "item/agentMessage/delta",
        params: {
          delta: "app-server reply after disconnect",
          itemId: "assistant-disconnected-stream",
          threadId,
          turnId: "turn-disconnected-stream",
        },
      });
      handler({
        method: "turn/completed",
        params: {
          threadId,
          turn: {
            id: "turn-disconnected-stream",
            items: [],
            status: "completed",
            error: null,
            startedAt: now,
            completedAt: now,
          },
        },
      });
    }

    const replay = await waitForCompletedReplay(events, threadId);
    expect(replay).toContainEqual(
      expect.objectContaining({
        event: expect.objectContaining({
          type: "thread.message.delta",
          delta: "app-server reply after disconnect",
        }),
      }),
    );
  });

  it("keeps attach streams live without recording duplicate durable events", async () => {
    const events = await createRelayStateStore(":memory:");
    const appendThreadEvent = vi.spyOn(events, "appendThreadEvent");
    const notificationHandlers = new Set<(notification: never) => void>();
    const now = Date.now() / 1000;
    const appServerThread = {
      id: "attached-thread",
      createdAt: now,
      cwd: process.cwd(),
      modelProvider: "gpt-5.5",
      name: "Attached thread",
      preview: "Attached thread",
      source: "app",
      status: { type: "active" },
      turns: [],
      updatedAt: now,
    };
    const appServer = {
      onNotification(handler: (notification: never) => void) {
        notificationHandlers.add(handler);
        return () => notificationHandlers.delete(handler);
      },
      onRequest() {
        return () => undefined;
      },
      async readThread() {
        queueMicrotask(() => {
          for (const handler of notificationHandlers) {
            handler({
              method: "thread/status/changed",
              params: { status: { type: "idle" }, threadId: appServerThread.id },
            } as never);
          }
        });
        return appServerThread;
      },
    };
    const app = createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      threadEvents: events,
    });

    const response = await app.request(apiPaths.threadRunStream(appServerThread.id), {
      body: JSON.stringify({}),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const streamedEvents = parseSseEvents(await response.text());
    const replay = await events.listThreadEvents({ threadId: appServerThread.id });

    expect(response.status).toBe(200);
    expect(streamedEvents.map((event) => event.type)).toContain("thread.state.changed");
    expect(appendThreadEvent).not.toHaveBeenCalled();
    expect(replay.events).toEqual([]);
  });

  it("persists terminal events for externally owned app-server turns", async () => {
    const events = await createRelayStateStore(":memory:");
    const notificationHandlers = new Set<(notification: never) => void>();
    const now = Date.now() / 1000;
    const threadId = "external-tui-thread";
    const completedTurn = {
      id: "external-tui-turn",
      items: [
        {
          id: "external-tui-assistant",
          text: "External turn completed",
          type: "agentMessage",
        },
      ],
      status: "completed",
      error: null,
      startedAt: now,
      completedAt: now,
    };
    const appServerThread = {
      id: threadId,
      createdAt: now,
      cwd: process.cwd(),
      modelProvider: "gpt-5.5",
      name: "External TUI thread",
      preview: "External TUI thread",
      source: "cli",
      status: { type: "active" },
      turns: [],
      updatedAt: now,
    };
    const appServer = {
      onNotification(handler: (notification: never) => void) {
        notificationHandlers.add(handler);
        return () => notificationHandlers.delete(handler);
      },
      onRequest() {
        return () => undefined;
      },
      async readThread() {
        return appServerThread;
      },
    };
    createApp({
      appServer: appServer as never,
      codex: createMockCodex(),
      threadEvents: events,
    });

    appServerThread.status = { type: "idle" };
    appServerThread.turns = [completedTurn] as never;
    for (const handler of notificationHandlers) {
      const notification = {
        method: "turn/completed",
        params: { threadId, turn: completedTurn },
      } as never;
      handler(notification);
      handler(notification);
    }

    const replay = await waitForCompletedReplay(events, threadId);

    expect(replay.map((item) => item.event.type)).toEqual([
      "thread.message.completed",
      "thread.state.changed",
    ]);
    expect(replay.at(-1)?.event).toMatchObject({
      type: "thread.state.changed",
      thread: { id: threadId, state: "completed" },
    });
  });
});

async function createThread(app: ReturnType<typeof createApp>, title: string) {
  const body = await createThreadResponse(app, title);
  return String(body.thread.id);
}

async function createThreadResponse(app: ReturnType<typeof createApp>, title: string) {
  const response = await app.request(apiPaths.threads, {
    body: JSON.stringify({ title }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  return response.json();
}

function parseSseEvents(body: string): StreamThreadRunEvent[] {
  return body
    .split("\n\n")
    .map((block) => block.split("\n").find((line) => line.startsWith("data: ")))
    .filter((line): line is string => Boolean(line))
    .map((line) => StreamThreadRunEventSchema.parse(JSON.parse(line.slice("data: ".length))));
}

async function readNextSseEvent(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const decoder = new TextDecoder();
  let body = "";
  while (!body.includes("\n\n")) {
    const chunk = await reader.read();
    if (chunk.done) {
      throw new Error("Thread event stream closed before delivering an event.");
    }
    body += decoder.decode(chunk.value, { stream: true });
  }
  return parseSseEvents(body)[0];
}

async function readRemainingStream(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const decoder = new TextDecoder();
  let body = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) {
      return body + decoder.decode();
    }
    body += decoder.decode(chunk.value, { stream: true });
  }
}

function createMockCodex(options: { runGate?: Promise<void> } = {}): CodexClient {
  const threads = new Map<string, ReturnType<CodexClient["startThread"]>>();
  return {
    startThread() {
      const id = `thread-${threads.size + 1}`;
      const thread = {
        id,
        async run(prompt: string) {
          return { finalResponse: prompt };
        },
        ...(options.runGate
          ? {
              async runStreamed() {
                async function* streamEvents() {
                  yield {
                    type: "item.completed",
                    item: { id: "first", type: "agent_message", text: "first" },
                  };
                  await options.runGate;
                  yield {
                    type: "item.completed",
                    item: { id: "second", type: "agent_message", text: "first second" },
                  };
                }
                return { events: streamEvents() };
              },
            }
          : {}),
      };
      threads.set(id, thread);
      return thread;
    },
    resumeThread(threadId) {
      const thread = threads.get(threadId);
      if (!thread) {
        throw new Error(`Unknown mock thread ${threadId}`);
      }
      return thread;
    },
  };
}

async function waitForCompletedReplay(store: ThreadEventStore, threadId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const replay = await store.listThreadEvents({ limit: 100, threadId });
    if (
      replay.events.some(
        (item) =>
          item.event.type === "thread.state.changed" && item.event.thread.state === "completed",
      )
    ) {
      return replay.events;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`Timed out waiting for completed replay for ${threadId}.`);
}
