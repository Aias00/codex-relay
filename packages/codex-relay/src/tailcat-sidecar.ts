import { createHash } from "node:crypto";
import { execFile, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { access, chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import type { TailcatConnectionPlanCandidate } from "./api-schema.js";

export type TailcatSidecarDiagnostics = {
  exitCode?: number;
  localTargetPort: number;
  pid?: number;
  startedAt: string;
  status: "failed" | "healthy" | "starting" | "stopped";
};

export type TailcatSidecar = {
  candidate(): TailcatConnectionPlanCandidate | undefined;
  close(): Promise<void>;
  diagnostics(): TailcatSidecarDiagnostics;
};

export type TailcatSidecarSpawn = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcess;

const execFileAsync = promisify(execFile);

export async function stopStaleTailcatSidecar(input: {
  binaryPath: string;
  inspectProcessCommand?: (pid: number) => Promise<string | undefined>;
  isProcessRunning?: (pid: number) => boolean;
  keyPath: string;
  localTargetPort: number;
  pidPath: string;
  signalProcess?: (pid: number, signal: NodeJS.Signals) => void;
}) {
  const pidPath = resolve(input.pidPath);
  const pid = await readSidecarPid(pidPath);
  if (!pid) {
    return false;
  }
  const inspectProcessCommand = input.inspectProcessCommand ?? readProcessCommand;
  const command = await inspectProcessCommand(pid).catch(() => undefined);
  if (!command || !matchesTailcatProcess(command, input)) {
    await unlinkIfPresent(pidPath);
    return false;
  }
  const isProcessRunning = input.isProcessRunning ?? processIsRunning;
  const signalProcess = input.signalProcess ?? process.kill;
  if (!isProcessRunning(pid)) {
    await unlinkIfPresent(pidPath);
    return false;
  }
  signalProcess(pid, "SIGTERM");
  if (!(await waitForProcessExit(pid, isProcessRunning, 1_000))) {
    signalProcess(pid, "SIGKILL");
    await waitForProcessExit(pid, isProcessRunning, 1_000);
  }
  await unlinkIfPresent(pidPath);
  return true;
}

export async function startTailcatSidecar(input: {
  addressPath: string;
  binaryPath: string;
  keyPath: string;
  localTargetPort: number;
  pidPath?: string;
  priority?: number;
  spawnProcess?: TailcatSidecarSpawn;
  startTimeoutMs?: number;
}): Promise<TailcatSidecar> {
  if (
    !Number.isInteger(input.localTargetPort) ||
    input.localTargetPort < 1 ||
    input.localTargetPort > 65_535
  ) {
    throw new TypeError("Tailcat localTargetPort must be an integer from 1 through 65535.");
  }
  const addressPath = resolve(input.addressPath);
  const keyPath = resolve(input.keyPath);
  const pidPath = resolve(input.pidPath ?? `${addressPath}.pid`);
  const startTimeoutMs = input.startTimeoutMs ?? 10_000;
  if (!Number.isInteger(startTimeoutMs) || startTimeoutMs < 1) {
    throw new TypeError("Tailcat startTimeoutMs must be a positive integer.");
  }
  await access(keyPath);
  await mkdir(dirname(addressPath), { mode: 0o700, recursive: true });
  await stopStaleTailcatSidecar({
    binaryPath: input.binaryPath,
    keyPath,
    localTargetPort: input.localTargetPort,
    pidPath,
  });
  await unlink(addressPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") {
      throw error;
    }
  });

  const startedAt = new Date().toISOString();
  const child = (input.spawnProcess ?? spawn)(
    input.binaryPath,
    [`--key=${keyPath}`, `--serve=${input.localTargetPort}`],
    {
      env: { ...process.env, TAILCAT_ADDR_FILE: addressPath },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  child.stdout?.resume();
  child.stderr?.resume();
  if (!child.pid) {
    await stopTailcatChild(child);
    throw new Error("Tailcat sidecar did not publish a process ID.");
  }
  try {
    await mkdir(dirname(pidPath), { mode: 0o700, recursive: true });
    await writeFile(pidPath, `${child.pid}\n`, { mode: 0o600 });
    await chmod(pidPath, 0o600);
  } catch (error) {
    await stopTailcatChild(child);
    await unlinkOwnedPidFile(pidPath, child.pid);
    await unlinkIfPresent(addressPath);
    throw new Error("Tailcat sidecar failed before publishing a valid address.", {
      cause: error,
    });
  }

  let closing = false;
  let status: TailcatSidecarDiagnostics["status"] = "starting";
  let exitCode: number | undefined;
  child.once("exit", (code) => {
    exitCode = code ?? undefined;
    status = closing ? "stopped" : "failed";
    void unlinkOwnedPidFile(pidPath, child.pid);
  });

  try {
    const token = await waitForTailcatAddress({ addressPath, child, startTimeoutMs });
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("Tailcat sidecar exited during startup.");
    }
    await chmod(addressPath, 0o600);
    const candidate: TailcatConnectionPlanCandidate = {
      localTargetPort: input.localTargetPort,
      priority: input.priority ?? 550,
      routeId: `route_tailcat_${stableHash(token, 20)}`,
      token,
      transport: "tailcat",
    };
    status = "healthy";

    return {
      candidate() {
        return status === "healthy" && child.exitCode === null && child.signalCode === null
          ? candidate
          : undefined;
      },
      async close() {
        if (status === "stopped") {
          return;
        }
        closing = true;
        await stopTailcatChild(child);
        await unlinkOwnedPidFile(pidPath, child.pid);
        status = "stopped";
      },
      diagnostics() {
        return {
          exitCode,
          localTargetPort: input.localTargetPort,
          pid: child.pid,
          startedAt,
          status,
        };
      },
    };
  } catch (error) {
    closing = true;
    await stopTailcatChild(child);
    await unlinkOwnedPidFile(pidPath, child.pid);
    throw new Error("Tailcat sidecar failed before publishing a valid address.", {
      cause: error,
    });
  }
}

async function readSidecarPid(pidPath: string) {
  const value = await readFile(pidPath, "utf8").catch(() => undefined);
  if (value === undefined) {
    return undefined;
  }
  const pid = Number(value.trim());
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) {
    await unlinkIfPresent(pidPath);
    return undefined;
  }
  return pid;
}

async function readProcessCommand(pid: number) {
  const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "command="]);
  return stdout.trim() || undefined;
}

function matchesTailcatProcess(
  command: string,
  input: Pick<
    Parameters<typeof stopStaleTailcatSidecar>[0],
    "binaryPath" | "keyPath" | "localTargetPort"
  >,
) {
  const executable = command.trim().split(/\s+/, 1)[0];
  return (
    executable !== undefined &&
    basename(executable) === basename(input.binaryPath) &&
    command.includes(`--key=${resolve(input.keyPath)}`) &&
    command.includes(`--serve=${input.localTargetPort}`)
  );
}

function processIsRunning(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitForProcessExit(
  pid: number,
  isProcessRunning: (pid: number) => boolean,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) {
      return true;
    }
    await delay(25);
  }
  return !isProcessRunning(pid);
}

async function unlinkOwnedPidFile(pidPath: string, pid: number | undefined) {
  if (!pid) {
    return;
  }
  const current = await readFile(pidPath, "utf8").catch(() => undefined);
  if (current?.trim() === String(pid)) {
    await unlinkIfPresent(pidPath);
  }
}

async function unlinkIfPresent(path: string) {
  await unlink(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") {
      throw error;
    }
  });
}

async function waitForTailcatAddress(input: {
  addressPath: string;
  child: ChildProcess;
  startTimeoutMs: number;
}) {
  const deadline = Date.now() + input.startTimeoutMs;
  while (Date.now() < deadline) {
    if (input.child.exitCode !== null || input.child.signalCode !== null) {
      throw new Error("Tailcat sidecar exited during startup.");
    }
    const token = await readFile(input.addressPath, "utf8").catch(() => undefined);
    if (token !== undefined) {
      return normalizeTailcatToken(token);
    }
    await delay(25);
  }
  throw new Error("Tailcat sidecar startup timed out.");
}

function normalizeTailcatToken(value: string) {
  const token = value.trim();
  if (token.length < 16 || token.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(token)) {
    throw new Error("Tailcat address file is invalid.");
  }
  return token;
}

async function stopTailcatChild(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  if (await settlesWithin(exited, 1_000)) {
    return;
  }
  child.kill("SIGKILL");
  await settlesWithin(exited, 1_000);
}

async function settlesWithin(operation: Promise<void>, timeoutMs: number) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    operation.then(() => true),
    new Promise<false>((resolve) => {
      timeout = setTimeout(() => resolve(false), timeoutMs);
    }),
  ]);
  if (timeout) {
    clearTimeout(timeout);
  }
  return result;
}

function stableHash(value: string, length: number) {
  return createHash("sha256").update(value).digest("base64url").slice(0, length);
}
