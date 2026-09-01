import { describe, expect, it } from "vitest";
import type { ThreadSummary } from "../src/api-schema.js";

import { archivedActiveThreadReplacement } from "../../../apps/mobile/src/lib/chat-correctness-decisions.js";

describe("mobile thread archive replacement selection", () => {
  it("returns the replacement thread workspace when archiving the active cross-workspace thread", () => {
    const replacement = threadSummary("thread-workspace-b", "workspace-b", "/workspace/b");

    expect(
      archivedActiveThreadReplacement({
        activeThreadId: "thread-workspace-a",
        archivedThreadId: "thread-workspace-a",
        threads: [threadSummary("thread-workspace-a", "workspace-a", "/workspace/a"), replacement],
      }),
    ).toEqual({
      previousSelection: undefined,
      replacement,
      replacementSelection: {
        workspaceId: "workspace-b",
        workspacePath: "/workspace/b",
      },
    });
  });
});

function threadSummary(id: string, workspaceId: string, cwd: string): ThreadSummary {
  return {
    id,
    title: id,
    createdAt: "2026-04-29T00:00:00.000Z",
    updatedAt: "2026-04-29T00:00:00.000Z",
    state: "completed",
    messageCount: 0,
    workspaceId,
    cwd,
  };
}
