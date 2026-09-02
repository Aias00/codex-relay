import type { ThreadSummary } from "@aias00/codex-relay/api-schema";
import { describe, expect, it } from "vitest";

import { preferredThreadSnapshotWithAuthoritativeGoal } from "./server-state-messages";

function thread(overrides: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    id: "thread-1",
    title: "Thread",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    state: "completed",
    cwd: "/tmp/project",
    messageCount: 2,
    lastActivityAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("preferredThreadSnapshotWithAuthoritativeGoal", () => {
  it("applies a terminal goal update without replacing newer thread metadata", () => {
    const current = thread({
      updatedAt: "2026-09-01T02:00:00.000Z",
      messageCount: 12,
      goal: {
        threadId: "thread-1",
        objective: "Ship the fix",
        status: "active",
        tokenBudget: null,
        tokensUsed: 100,
        timeUsedSeconds: 20,
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-01T00:10:00.000Z",
      },
    });
    const incoming = thread({
      updatedAt: "2026-09-01T01:00:00.000Z",
      messageCount: 2,
      goal: {
        threadId: "thread-1",
        objective: "Ship the fix",
        status: "complete",
        tokenBudget: null,
        tokensUsed: 200,
        timeUsedSeconds: 40,
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-01T01:00:00.000Z",
      },
    });

    expect(preferredThreadSnapshotWithAuthoritativeGoal(current, incoming)).toEqual({
      ...current,
      goal: incoming.goal,
    });
  });

  it("applies an authoritative goal clear without replacing newer thread metadata", () => {
    const current = thread({
      updatedAt: "2026-09-01T02:00:00.000Z",
      messageCount: 12,
      goal: {
        threadId: "thread-1",
        objective: "Ship the fix",
        status: "complete",
        tokenBudget: null,
        tokensUsed: 200,
        timeUsedSeconds: 40,
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-01T01:00:00.000Z",
      },
    });
    const incoming = thread({
      updatedAt: "2026-09-01T01:00:00.000Z",
      goal: null,
    });

    expect(preferredThreadSnapshotWithAuthoritativeGoal(current, incoming)).toEqual({
      ...current,
      goal: null,
    });
  });
});
