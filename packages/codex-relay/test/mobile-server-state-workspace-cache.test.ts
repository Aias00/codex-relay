import { describe, expect, it } from "vitest";

import {
  filterThreadsForWorkspace,
  shouldResetWorkspaceScopedServerState,
  workspaceCacheIdentity,
  workspaceSelectionQuery,
} from "../../../apps/mobile/src/lib/server-state-workspace-cache.js";
import { workspaceFileContentQueryKey } from "../../../apps/mobile/src/lib/workspace-file-queries.js";

describe("mobile server-state workspace cache", () => {
  it("resets workspace-scoped cache only after a known workspace changes", () => {
    expect(shouldResetWorkspaceScopedServerState(undefined, "/workspace/a")).toBe(false);
    expect(shouldResetWorkspaceScopedServerState("/workspace/a", "/workspace/a")).toBe(false);
    expect(shouldResetWorkspaceScopedServerState("/workspace/a", "/workspace/b")).toBe(true);
  });

  it("keeps the same workspace identity when its path changes", () => {
    expect(
      shouldResetWorkspaceScopedServerState(
        { workspaceId: "workspace-1", workspacePath: "/workspace/old" },
        { workspaceId: "workspace-1", workspacePath: "/workspace/new" },
      ),
    ).toBe(false);
    expect(
      shouldResetWorkspaceScopedServerState(
        { workspaceId: "workspace-1", workspacePath: "/workspace/shared" },
        { workspaceId: "workspace-2", workspacePath: "/workspace/shared" },
      ),
    ).toBe(true);
  });

  it("isolates cache identities by workspace ID and falls back to legacy paths", () => {
    expect(workspaceCacheIdentity({ workspaceId: "workspace-1", workspacePath: "/shared" })).toBe(
      "id:workspace-1",
    );
    expect(workspaceCacheIdentity({ workspaceId: "workspace-2", workspacePath: "/shared" })).toBe(
      "id:workspace-2",
    );
    expect(workspaceCacheIdentity("/legacy/workspace")).toBe("/legacy/workspace");
  });

  it("serializes stable identity and compatibility path together", () => {
    expect(
      workspaceSelectionQuery({ workspaceId: "workspace 1", workspacePath: "/work/a b" }),
    ).toBe("?workspaceId=workspace+1&workspacePath=%2Fwork%2Fa+b");
    expect(workspaceSelectionQuery("/legacy/workspace")).toBe(
      "?workspacePath=%2Flegacy%2Fworkspace",
    );
  });

  it("isolates workspace file caches by relay and workspace identity", () => {
    const first = workspaceFileContentQueryKey(
      "https://relay-a.example",
      { workspaceId: "workspace-1", workspacePath: "/shared" },
      "README.md",
    );
    expect(
      workspaceFileContentQueryKey(
        "https://relay-a.example",
        { workspaceId: "workspace-2", workspacePath: "/shared" },
        "README.md",
      ),
    ).not.toEqual(first);
    expect(
      workspaceFileContentQueryKey(
        "https://relay-b.example",
        { workspaceId: "workspace-1", workspacePath: "/shared" },
        "README.md",
      ),
    ).not.toEqual(first);
  });

  it("filters a global thread cache before promoting it into a workspace cache", () => {
    const threads = [
      { cwd: "/workspace/a", id: "thread-a", workspaceId: "workspace-a" },
      { cwd: "/workspace/b", id: "thread-b", workspaceId: "workspace-b" },
      { cwd: "/workspace/a", id: "legacy-thread-a" },
    ];

    expect(
      filterThreadsForWorkspace(threads, {
        workspaceId: "workspace-a",
        workspacePath: "/workspace/a",
      }),
    ).toEqual([threads[0], threads[2]]);
  });
});
