import { describe, expect, it, vi } from "vitest";

import {
  foregroundRefreshDedupeMs,
  runConnectionRefresh,
  shouldStartForegroundRefresh,
} from "./connection-refresh";

describe("runConnectionRefresh", () => {
  it("deduplicates adjacent focus and app-state refreshes", () => {
    expect(shouldStartForegroundRefresh(undefined, 1_000)).toBe(true);
    expect(shouldStartForegroundRefresh(1_000, 1_000 + foregroundRefreshDedupeMs - 1)).toBe(false);
    expect(shouldStartForegroundRefresh(1_000, 1_000 + foregroundRefreshDedupeMs)).toBe(true);
  });

  it("marks the relay connected when status resolves while data refresh is still pending", async () => {
    const status = { reachable: true };
    const dataRequest = vi.fn<() => Promise<never>>(() => new Promise<never>(() => undefined));
    const onStatus = vi.fn<(resolvedStatus: typeof status) => void>();

    void runConnectionRefresh(Promise.resolve(status), dataRequest, onStatus);
    await Promise.resolve();

    expect(onStatus).toHaveBeenCalledWith(status);
    expect(dataRequest).toHaveBeenCalledWith(status);
  });

  it("does not start scoped data refresh before status resolves", async () => {
    let resolveStatus: ((status: { workspaceId: string }) => void) | undefined;
    const statusRequest = new Promise<{ workspaceId: string }>((resolve) => {
      resolveStatus = resolve;
    });
    const dataRequest = vi.fn<(status: { workspaceId: string }) => Promise<string>>(
      async (status) => status.workspaceId,
    );

    const result = runConnectionRefresh(statusRequest, dataRequest, vi.fn());
    expect(dataRequest).not.toHaveBeenCalled();

    resolveStatus?.({ workspaceId: "workspace-1" });
    await expect(result).resolves.toBe("workspace-1");
  });
});
