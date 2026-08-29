import { describe, expect, it } from "vitest";

import {
  shouldBlockThreadActivation,
  threadDetailSwitchStaleTimeMs,
  threadSnapshotFetchOptions,
  workspaceSelectionForThread,
} from "../../../apps/mobile/src/lib/thread-activation.js";

describe("mobile thread activation", () => {
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
    expect(threadDetailSwitchStaleTimeMs).toBeGreaterThan(0);
    expect(threadSnapshotFetchOptions()).toEqual({
      staleTime: threadDetailSwitchStaleTimeMs,
    });
    expect(threadSnapshotFetchOptions(true)).toEqual({ refresh: true });
  });
});
