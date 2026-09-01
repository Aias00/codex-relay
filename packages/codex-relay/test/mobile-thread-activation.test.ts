import { describe, expect, it } from "vitest";

import {
  isAuthoritativeThreadSnapshot,
  runningThreadRecoveryMode,
  shouldAttachRunningThreadStream,
  shouldBlockThreadActivation,
  threadActivationTiming,
  threadDetailSwitchStaleTimeMs,
  threadSnapshotFetchOptions,
  workspaceSelectionForThread,
} from "../../../apps/mobile/src/lib/thread-activation.js";

describe("mobile thread activation", () => {
  it("defers switching to an uncached refreshed thread until its snapshot is materialized", () => {
    expect(
      threadActivationTiming({
        currentThreadId: "thread-cached",
        hasTargetDetail: false,
        targetThreadId: "thread-fresh",
      }),
    ).toBe("after-snapshot");
    expect(
      threadActivationTiming({
        currentThreadId: "thread-cached",
        hasTargetDetail: true,
        targetThreadId: "thread-fresh",
      }),
    ).toBe("before-snapshot");
    expect(
      threadActivationTiming({
        currentThreadId: "thread-cached",
        hasTargetDetail: false,
        targetThreadId: "thread-cached",
      }),
    ).toBe("before-snapshot");
  });

  it("switches to the thread workspace identity before activating its detail query", () => {
    expect(
      workspaceSelectionForThread({
        cwd: "/workspace/b",
        workspaceId: "workspace-b",
      }),
    ).toEqual({
      workspaceId: "workspace-b",
      workspacePath: "/workspace/b",
    });
  });

  it("renders cached detail immediately while allowing a bounded background refresh", () => {
    expect(shouldBlockThreadActivation({ messages: [] })).toBe(false);
    expect(shouldBlockThreadActivation(undefined)).toBe(true);
    expect(shouldBlockThreadActivation({ messages: [] }, true)).toBe(true);
    expect(threadDetailSwitchStaleTimeMs).toBeGreaterThan(0);
    expect(threadSnapshotFetchOptions()).toEqual({
      staleTime: threadDetailSwitchStaleTimeMs,
    });
    expect(threadSnapshotFetchOptions(true)).toEqual({ refresh: true });
    expect(threadSnapshotFetchOptions(false, true)).toEqual({ staleTime: 0 });
  });

  it("treats server terminal snapshots as authoritative without a history refresh", () => {
    expect(isAuthoritativeThreadSnapshot("idle")).toBe(true);
    expect(isAuthoritativeThreadSnapshot("completed")).toBe(true);
    expect(isAuthoritativeThreadSnapshot("failed")).toBe(true);
    expect(isAuthoritativeThreadSnapshot("running")).toBe(false);
    expect(isAuthoritativeThreadSnapshot("running", true)).toBe(true);
  });

  it("attaches the durable event stream for every running thread source", () => {
    expect(shouldAttachRunningThreadStream({ state: "running" })).toBe(true);
    expect(shouldAttachRunningThreadStream({ state: "completed" })).toBe(false);
    expect(shouldAttachRunningThreadStream(undefined)).toBe(false);
    expect(runningThreadRecoveryMode({ source: "app", state: "running" })).toBe("stream");
    expect(runningThreadRecoveryMode({ source: "cli", state: "running" })).toBe("stream");
  });

  it("polls external running threads only after their event stream fails", () => {
    expect(runningThreadRecoveryMode({ source: "app", state: "running" }, true)).toBe("stream");
    expect(runningThreadRecoveryMode({ source: "cli", state: "running" }, true)).toBe("poll");
    expect(runningThreadRecoveryMode({ source: "cli", state: "completed" }, true)).toBe("none");
  });
});
