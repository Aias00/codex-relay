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

    await expect(
      ensureCodexSharedAppServerDaemon({
        env: { CODEX_HOME: "/Users/lea/.codex" },
        socketReachable: async () => true,
        start,
      }),
    ).resolves.toEqual({
      socketPath: "/Users/lea/.codex/app-server-control/app-server-control.sock",
      status: "alreadyRunning",
    });
    expect(start).not.toHaveBeenCalled();
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
});
