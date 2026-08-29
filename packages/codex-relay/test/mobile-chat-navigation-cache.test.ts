import { beforeEach, describe, expect, it } from "vitest";

import {
  cacheChatNavigation,
  clearCachedChatNavigation,
  parseCachedChatNavigation,
  readCachedChatNavigation,
} from "../../../apps/mobile/src/lib/chat-navigation-cache.js";

describe("mobile chat navigation cache", () => {
  beforeEach(() => {
    clearCachedChatNavigation();
  });

  it("persists the last workspace and active thread for cold-start hydration", () => {
    cacheChatNavigation({
      activeThreadId: "thread-1",
      workspaceId: "workspace-1",
      workspacePath: "/workspace/one",
    });

    expect(readCachedChatNavigation()).toEqual({
      activeThreadId: "thread-1",
      workspaceId: "workspace-1",
      workspacePath: "/workspace/one",
    });
  });

  it("ignores malformed and invalid cached fields", () => {
    expect(parseCachedChatNavigation("not-json")).toEqual({});
    expect(
      parseCachedChatNavigation(
        JSON.stringify({
          activeThreadId: 42,
          workspaceId: "  ",
          workspacePath: " /workspace/one ",
        }),
      ),
    ).toEqual({
      activeThreadId: undefined,
      workspaceId: undefined,
      workspacePath: "/workspace/one",
    });
  });
});
