import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  codexDesktopAppCandidates,
  codexDesktopLaunchSpec,
  connectedProcessIdsFromLsof,
  inspectCodexDesktopShare,
  isCodexDesktopRunning,
  probeCodexAppServerSocket,
  waitForCodexDesktopSharedConnection,
} from "../src/desktop-app.js";
import { nonOriginatingCodexAppServerClientInfo } from "../src/app-server-client-info.js";

describe("Codex Desktop shared app-server launch", () => {
  it("uses the official non-originating identity for control probes", () => {
    expect(nonOriginatingCodexAppServerClientInfo).toEqual({
      name: "codex_app_server_daemon",
      title: null,
      version: "",
    });
  });

  it("uses an explicitly configured desktop app", () => {
    expect(
      codexDesktopAppCandidates({
        env: { CODEX_RELAY_DESKTOP_APP_PATH: "/Applications/Preview.app" },
        homeDirectory: "/Users/lea",
      }),
    ).toEqual(["/Applications/Preview.app"]);
  });

  it("finds a supported desktop app and the shared Unix socket", async () => {
    const existing = new Set([
      "/Applications/ChatGPT.app",
      "/Users/lea/.codex/app-server-control/app-server-control.sock",
    ]);
    await expect(
      inspectCodexDesktopShare({
        env: {},
        fileContains: async () => true,
        homeDirectory: "/Users/lea",
        pathExists: async (path) => existing.has(path),
        platform: "darwin",
        socketReachable: async () => true,
      }),
    ).resolves.toEqual({
      appPath: "/Applications/ChatGPT.app",
      kind: "ready",
      socketPath: "/Users/lea/.codex/app-server-control/app-server-control.sock",
    });
  });

  it("reports a missing shared app-server socket", async () => {
    await expect(
      inspectCodexDesktopShare({
        env: {},
        fileContains: async () => true,
        homeDirectory: "/Users/lea",
        pathExists: async (path) => path === "/Applications/Codex.app",
        platform: "darwin",
        socketReachable: async () => true,
      }),
    ).resolves.toEqual({
      appPath: "/Applications/Codex.app",
      kind: "socket_missing",
      socketPath: "/Users/lea/.codex/app-server-control/app-server-control.sock",
    });
  });

  it("rejects a desktop build without local daemon transport support", async () => {
    await expect(
      inspectCodexDesktopShare({
        env: {},
        fileContains: async () => false,
        homeDirectory: "/Users/lea",
        pathExists: async () => true,
        platform: "darwin",
        socketReachable: async () => true,
      }),
    ).resolves.toEqual({
      appPath: "/Applications/ChatGPT.app",
      kind: "app_unsupported",
    });
  });

  it("rejects a stale shared app-server socket", async () => {
    await expect(
      inspectCodexDesktopShare({
        env: {},
        fileContains: async () => true,
        homeDirectory: "/Users/lea",
        pathExists: async () => true,
        platform: "darwin",
        socketReachable: async () => false,
      }),
    ).resolves.toEqual({
      appPath: "/Applications/ChatGPT.app",
      kind: "socket_unreachable",
      socketPath: "/Users/lea/.codex/app-server-control/app-server-control.sock",
    });
  });

  it("builds a macOS launch that opts into the local daemon transport", () => {
    expect(codexDesktopLaunchSpec("/Applications/ChatGPT.app", "/Users/lea/.codex-custom")).toEqual(
      {
        args: [
          "--env",
          "CODEX_APP_SERVER_USE_LOCAL_DAEMON=1",
          "--env",
          "CODEX_APP_SERVER_FORCE_CLI=0",
          "--env",
          "CODEX_CLI_PATH",
          "--env",
          "CODEX_HOME=/Users/lea/.codex-custom",
          "/Applications/ChatGPT.app",
        ],
        command: "/usr/bin/open",
      },
    );
  });

  it("detects an already-running desktop app", async () => {
    await expect(
      isCodexDesktopRunning("/Applications/ChatGPT.app", async () => undefined),
    ).resolves.toBe(true);
    await expect(
      isCodexDesktopRunning("/Applications/ChatGPT.app", async () => {
        throw Object.assign(new Error("not found"), { code: 1 });
      }),
    ).resolves.toBe(false);
  });

  it.skipIf(process.platform !== "darwin")(
    "uses a process expression accepted by macOS pgrep",
    async () => {
      await expect(
        isCodexDesktopRunning("/Applications/Codex Relay Missing App.app"),
      ).resolves.toBe(false);
    },
  );

  it("rejects a non-WebSocket listener at the control socket", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-relay-desktop-probe-"));
    const socketPath = join(directory, "not-app-server.sock");
    const server = createServer((socket) => socket.destroy());
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    try {
      await expect(probeCodexAppServerSocket(socketPath)).resolves.toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("correlates client processes with the app-server Unix socket", () => {
    const output = `COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME
codex 200 lea 30u unix 0xserver 0t0 /Users/lea/.codex/app-server-control/app-server-control.sock
codex 200 lea 32u unix 0xaccepted 0t0 /Users/lea/.codex/app-server-control/app-server-control.sock
ChatGPT 300 lea 42u unix 0xclient 0t0 ->0xaccepted
node 400 lea 12u unix 0xother 0t0 ->0xelsewhere`;
    expect(
      connectedProcessIdsFromLsof(
        output,
        "/Users/lea/.codex/app-server-control/app-server-control.sock",
      ),
    ).toEqual(new Set([300]));
  });

  it("waits until Codex Desktop actually connects to the shared socket", async () => {
    const connectionProbe = vi.fn<() => Promise<boolean>>(async () => true);
    connectionProbe.mockResolvedValueOnce(false).mockResolvedValueOnce(false);
    await expect(
      waitForCodexDesktopSharedConnection("/Applications/ChatGPT.app", "/tmp/app.sock", {
        connectionProbe,
        pollIntervalMs: 1,
        timeoutMs: 100,
      }),
    ).resolves.toBeUndefined();
    expect(connectionProbe).toHaveBeenCalledTimes(3);
  });
});
