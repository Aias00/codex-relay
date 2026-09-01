import { describe, expect, it, vi } from "vitest";
import type { ThreadDetailResponse } from "../src/api-schema.js";

import { materializePushActivation } from "../../../apps/mobile/src/lib/push-activation.js";

describe("mobile push activation materialization", () => {
  it("defers identified notifications until Relay identity is available", async () => {
    const input = activationInput({ currentRelayId: undefined });

    await expect(materializePushActivation(input)).resolves.toEqual({
      reason: "relay_unknown",
      status: "deferred",
    });
    expect(input.loadThread).not.toHaveBeenCalled();
    expect(input.activate).not.toHaveBeenCalled();
  });

  it("rejects another Relay or workspace without changing navigation", async () => {
    const relayMismatch = activationInput({
      target: { intent: "turn_terminal", relayId: "relay-old", threadId: "thread-1" },
    });
    await expect(materializePushActivation(relayMismatch)).resolves.toEqual({
      reason: "relay_mismatch",
      status: "rejected",
    });

    const workspaceMismatch = activationInput({
      target: {
        intent: "turn_terminal",
        relayId: "relay-1",
        threadId: "thread-1",
        workspaceId: "workspace-old",
      },
    });
    await expect(materializePushActivation(workspaceMismatch)).resolves.toEqual({
      reason: "workspace_mismatch",
      status: "rejected",
    });
    expect(workspaceMismatch.activate).not.toHaveBeenCalled();
  });

  it("keeps transient failures pending but rejects an authoritative missing thread", async () => {
    const transient = activationInput({
      loadThread: async () => {
        throw new Error("offline");
      },
    });
    await expect(materializePushActivation(transient)).resolves.toEqual({
      reason: "thread_unavailable",
      status: "deferred",
    });

    const missing = activationInput({
      loadThread: async () => {
        throw new MissingThreadError();
      },
    });
    await expect(materializePushActivation(missing)).resolves.toEqual({
      reason: "thread_missing",
      status: "rejected",
    });
  });

  it("activates only after the exact thread snapshot materializes", async () => {
    const input = activationInput();

    await expect(materializePushActivation(input)).resolves.toMatchObject({
      detail: { thread: { id: "thread-1", workspaceId: "workspace-1" } },
      status: "activated",
    });
    expect(input.loadThread).toHaveBeenCalledWith("thread-1");
    expect(input.activate).toHaveBeenCalledWith(threadDetail());
  });
});

class MissingThreadError extends Error {}

function activationInput(overrides: Partial<Parameters<typeof materializePushActivation>[0]> = {}) {
  return {
    activate: vi.fn<(detail: ThreadDetailResponse) => void>(),
    currentRelayId: "relay-1",
    isMissingThread: (error: unknown) => error instanceof MissingThreadError,
    loadThread: vi.fn<(threadId: string) => Promise<ThreadDetailResponse>>(async () =>
      threadDetail(),
    ),
    target: {
      intent: "turn_terminal" as const,
      relayId: "relay-1",
      threadId: "thread-1",
      workspaceId: "workspace-1",
    },
    ...overrides,
  };
}

function threadDetail(): ThreadDetailResponse {
  return {
    hasOlderMessages: false,
    messages: [],
    pendingInputRequests: [],
    thread: {
      createdAt: "2026-08-31T00:00:00.000Z",
      id: "thread-1",
      messageCount: 0,
      state: "completed",
      title: "Thread",
      updatedAt: "2026-08-31T00:00:00.000Z",
      workspaceId: "workspace-1",
    },
  };
}
