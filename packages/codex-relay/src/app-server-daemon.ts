import { spawn } from "node:child_process";
import { connect } from "node:net";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  resolveCodexSharedAppServerSocketPath,
  resolveCodexSharedAppServerSpawn,
  type CodexAppServerMode,
  type CodexAppServerSpawn,
  type CodexAppServerSpawnInput,
} from "./codex-binary.js";

type EnsureDaemonInput = CodexAppServerSpawnInput & {
  pollIntervalMs?: number;
  socketReachable?: (path: string) => Promise<boolean>;
  start?: (spawn: CodexAppServerSpawn, env: NodeJS.ProcessEnv) => Promise<number>;
  stop?: (pid: number) => Promise<void> | void;
  timeoutMs?: number;
};

export type CodexSharedAppServerDaemon =
  | { socketPath: string; status: "alreadyRunning" }
  | { pid: number; socketPath: string; status: "started" };

export function effectiveManagedSharedAppServerState(input: {
  appServerMode: CodexAppServerMode | undefined;
  managed: boolean;
  socketPath: string | undefined;
}) {
  const sharedSocketIsActive = input.appServerMode === "socket";
  return {
    sharedAppServerManaged: sharedSocketIsActive && input.managed,
    sharedAppServerSocketPath: sharedSocketIsActive ? input.socketPath : undefined,
  };
}

export async function ensureCodexSharedAppServerDaemon(
  input: EnsureDaemonInput = {},
): Promise<CodexSharedAppServerDaemon> {
  const env = { ...process.env, ...input.env };
  const socketPath = resolveCodexSharedAppServerSocketPath(env);
  const socketReachable = input.socketReachable ?? isSocketReachable;
  if (await socketReachable(socketPath)) {
    return { socketPath, status: "alreadyRunning" };
  }

  const pid = await (input.start ?? startDetachedSharedAppServer)(
    resolveCodexSharedAppServerSpawn(input),
    env,
  );
  const timeoutMs = input.timeoutMs ?? 15_000;
  const pollIntervalMs = input.pollIntervalMs ?? 25;
  const deadline = Date.now() + timeoutMs;
  try {
    do {
      if (await socketReachable(socketPath)) {
        return { pid, socketPath, status: "started" };
      }
      await delay(pollIntervalMs);
    } while (Date.now() < deadline);
    throw new Error(`Timed out waiting for detached Codex app-server daemon at ${socketPath}.`);
  } catch (error) {
    await (input.stop ?? stopDetachedSharedAppServer)(pid);
    throw error;
  }
}

async function startDetachedSharedAppServer(
  spawnConfig: CodexAppServerSpawn,
  env: NodeJS.ProcessEnv,
) {
  const child = spawn(spawnConfig.command, spawnConfig.args, {
    cwd: resolveCodexSharedAppServerDaemonCwd(env),
    detached: true,
    env,
    shell: spawnConfig.shell,
    stdio: "ignore",
    windowsHide: spawnConfig.windowsHide,
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  if (!child.pid) {
    throw new Error("Detached Codex app-server daemon did not return a process ID.");
  }
  child.unref();
  return child.pid;
}

async function stopDetachedSharedAppServer(pid: number) {
  signalDetachedSharedAppServer(pid, "SIGTERM");
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (!detachedSharedAppServerIsRunning(pid)) {
      return;
    }
    await delay(25);
  }
  if (detachedSharedAppServerIsRunning(pid)) {
    signalDetachedSharedAppServer(pid, "SIGKILL");
  }
}

function signalDetachedSharedAppServer(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      throw error;
    }
  }
}

function detachedSharedAppServerIsRunning(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export function resolveCodexSharedAppServerDaemonCwd(
  env: Partial<NodeJS.ProcessEnv> = process.env,
) {
  return resolve(
    env.CODEX_RELAY_APP_SERVER_CWD?.trim() ||
      env.CODEX_RELAY_WORKSPACE_PATH?.trim() ||
      env.HOME?.trim() ||
      homedir(),
  );
}

function isSocketReachable(path: string) {
  return new Promise<boolean>((resolve) => {
    const socket = connect({ path });
    let settled = false;
    const finish = (reachable: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(reachable);
    };
    socket.once("connect", () => {
      finish(true);
    });
    socket.once("error", () => {
      finish(false);
    });
  });
}
