import { describe, expect, it, vi } from "vitest";

import {
  ensureCodexSharedAppServerDaemon,
  resolveCodexSharedAppServerDaemonCwd,
} from "../src/app-server-daemon.js";
import type { CodexAppServerSpawn } from "../src/codex-binary.js";

describe("managed Codex app-server daemon", () => {
  it("uses the configured Relay workspace instead of the package process cwd", () => {
    expect(
      resolveCodexSharedAppServerDaemonCwd({
        CODEX_RELAY_WORKSPACE_PATH: "/Users/lea/Work/github/iggy",
        HOME: "/Users/lea",
      }),
    ).toBe("/Users/lea/Work/github/iggy");
    expect(
      resolveCodexSharedAppServerDaemonCwd({
        CODEX_RELAY_APP_SERVER_CWD: "/Users/lea/Work/github/explicit",
        CODEX_RELAY_WORKSPACE_PATH: "/Users/lea/Work/github/iggy",
      }),
    ).toBe("/Users/lea/Work/github/explicit");
  });

  it("attaches to an already-running shared daemon", async () => {
    const start = vi.fn<(spawn: CodexAppServerSpawn, env: NodeJS.ProcessEnv) => Promise<number>>(
      async () => 123,
    );
    const stop = vi.fn<(pid: number) => Promise<void>>(async () => undefined);

    await expect(
      ensureCodexSharedAppServerDaemon({
        env: { CODEX_HOME: "/Users/lea/.codex" },
        socketReachable: async () => true,
        start,
        stop,
      }),
    ).resolves.toEqual({
      socketPath: "/Users/lea/.codex/app-server-control/app-server-control.sock",
      status: "alreadyRunning",
    });
    expect(start).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  });

  it("starts a detached shared daemon and waits for its socket", async () => {
    const start = vi.fn<(spawn: CodexAppServerSpawn, env: NodeJS.ProcessEnv) => Promise<number>>(
      async () => 456,
    );
    const socketReachable = vi.fn<(path: string) => Promise<boolean>>(async () => true);
    socketReachable.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

    await expect(
      ensureCodexSharedAppServerDaemon({
        env: { CODEX_HOME: "/Users/lea/.codex" },
        pollIntervalMs: 1,
        socketReachable,
        start,
        timeoutMs: 100,
      }),
    ).resolves.toEqual({
      pid: 456,
      socketPath: "/Users/lea/.codex/app-server-control/app-server-control.sock",
      status: "started",
    });
    expect(start).toHaveBeenCalledOnce();
  });

  it("stops a detached daemon when its socket never becomes reachable", async () => {
    const start = vi.fn<(spawn: CodexAppServerSpawn, env: NodeJS.ProcessEnv) => Promise<number>>(
      async () => 789,
    );
    const stop = vi.fn<(pid: number) => Promise<void>>(async () => undefined);

    await expect(
      ensureCodexSharedAppServerDaemon({
        env: { CODEX_HOME: "/Users/lea/.codex" },
        pollIntervalMs: 1,
        socketReachable: async () => false,
        start,
        stop,
        timeoutMs: 5,
      }),
    ).rejects.toThrow(
      "Timed out waiting for detached Codex app-server daemon at /Users/lea/.codex/app-server-control/app-server-control.sock.",
    );
    expect(stop).toHaveBeenCalledWith(789);
  });

  it("stops a detached daemon when socket polling errors during startup", async () => {
    const start = vi.fn<(spawn: CodexAppServerSpawn, env: NodeJS.ProcessEnv) => Promise<number>>(
      async () => 790,
    );
    const stop = vi.fn<(pid: number) => Promise<void>>(async () => undefined);
    const socketReachable = vi.fn<(path: string) => Promise<boolean>>();
    socketReachable
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error("socket poll failed"));

    await expect(
      ensureCodexSharedAppServerDaemon({
        env: { CODEX_HOME: "/Users/lea/.codex" },
        pollIntervalMs: 1,
        socketReachable,
        start,
        stop,
        timeoutMs: 100,
      }),
    ).rejects.toThrow("socket poll failed");
    expect(stop).toHaveBeenCalledWith(790);
  });
});
