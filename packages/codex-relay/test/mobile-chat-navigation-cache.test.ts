import { beforeEach, describe, expect, it } from "vitest";

import {
  cacheChatNavigation,
  cachedChatNavigationForRelay,
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
      relayId: "relay-1",
      workspaceId: "workspace-1",
      workspacePath: "/workspace/one",
    });

    expect(readCachedChatNavigation()).toEqual({
      activeThreadId: "thread-1",
      relayId: "relay-1",
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
          relayId: " relay-1 ",
          workspaceId: "  ",
          workspacePath: " /workspace/one ",
        }),
      ),
    ).toEqual({
      activeThreadId: undefined,
      relayId: "relay-1",
      workspaceId: undefined,
      workspacePath: "/workspace/one",
    });
  });

  it("keeps matching and legacy navigation but rejects another Relay's selection", () => {
    const selection = {
      activeThreadId: "thread-1",
      relayId: "relay-1",
      workspaceId: "workspace-1",
      workspacePath: "/workspace/one",
    };

    expect(cachedChatNavigationForRelay(selection, "relay-1")).toEqual(selection);
    expect(
      cachedChatNavigationForRelay(
        { activeThreadId: "thread-legacy", workspacePath: "/workspace/legacy" },
        "relay-1",
      ),
    ).toEqual({
      activeThreadId: "thread-legacy",
      relayId: "relay-1",
      workspacePath: "/workspace/legacy",
    });
    expect(cachedChatNavigationForRelay(selection, "relay-2")).toEqual({
      relayId: "relay-2",
    });
  });
});
