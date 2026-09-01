import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import { homedir, platform as currentPlatform } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import WebSocket from "ws";

import { nonOriginatingCodexAppServerClientInfo } from "./app-server-client-info.js";

const execFileAsync = promisify(execFile);

export const codexDesktopLocalDaemonEnv = "CODEX_APP_SERVER_USE_LOCAL_DAEMON";
const desktopLocalDaemonMarker = Buffer.from(codexDesktopLocalDaemonEnv);

type DesktopShareInput = {
  env?: Partial<NodeJS.ProcessEnv>;
  fileContains?: (path: string, marker: Buffer) => Promise<boolean>;
  homeDirectory?: string;
  pathExists?: (path: string) => Promise<boolean>;
  platform?: NodeJS.Platform;
  socketReachable?: (path: string) => Promise<boolean>;
};

type ExecFileRunner = (file: string, args: readonly string[]) => Promise<unknown>;

type WaitForDesktopConnectionOptions = {
  connectionProbe?: () => Promise<boolean>;
  pollIntervalMs?: number;
  timeoutMs?: number;
};

export type CodexDesktopShareInspection =
  | { kind: "unsupported_platform"; platform: NodeJS.Platform }
  | { candidates: string[]; kind: "app_missing"; socketPath: string }
  | { appPath: string; kind: "app_unsupported" }
  | { appPath: string; kind: "socket_missing"; socketPath: string }
  | { appPath: string; kind: "socket_unreachable"; socketPath: string }
  | { appPath: string; kind: "ready"; socketPath: string };

export function codexDesktopAppCandidates(
  input: Pick<DesktopShareInput, "env" | "homeDirectory"> = {},
) {
  const env = input.env ?? process.env;
  const homeDirectory = input.homeDirectory ?? homedir();
  const configuredPath = env.CODEX_RELAY_DESKTOP_APP_PATH?.trim();
  if (configuredPath) {
    return [expandHome(configuredPath, homeDirectory)];
  }
  return [
    "/Applications/ChatGPT.app",
    "/Applications/Codex.app",
    join(homeDirectory, "Applications", "ChatGPT.app"),
    join(homeDirectory, "Applications", "Codex.app"),
  ];
}

export function codexAppServerControlSocketPath(
  input: Pick<DesktopShareInput, "env" | "homeDirectory"> = {},
) {
  return join(codexHomePath(input), "app-server-control", "app-server-control.sock");
}

export function codexHomePath(input: Pick<DesktopShareInput, "env" | "homeDirectory"> = {}) {
  const env = input.env ?? process.env;
  const homeDirectory = input.homeDirectory ?? homedir();
  return env.CODEX_HOME?.trim() || join(homeDirectory, ".codex");
}

export async function inspectCodexDesktopShare(
  input: DesktopShareInput = {},
): Promise<CodexDesktopShareInspection> {
  const platform = input.platform ?? currentPlatform();
  if (platform !== "darwin") {
    return { kind: "unsupported_platform", platform };
  }

  const pathExists = input.pathExists ?? defaultPathExists;
  const fileContains = input.fileContains ?? defaultFileContains;
  const socketReachable = input.socketReachable ?? probeCodexAppServerSocket;
  const candidates = codexDesktopAppCandidates(input);
  const socketPath = codexAppServerControlSocketPath(input);
  let appPath: string | undefined;
  let unsupportedAppPath: string | undefined;
  for (const candidate of candidates) {
    if (!(await pathExists(candidate))) {
      continue;
    }
    const appArchivePath = join(candidate, "Contents", "Resources", "app.asar");
    if (await fileContains(appArchivePath, desktopLocalDaemonMarker)) {
      appPath = candidate;
      break;
    }
    unsupportedAppPath ??= candidate;
  }
  if (!appPath && !unsupportedAppPath) {
    return { candidates, kind: "app_missing", socketPath };
  }
  if (!appPath) {
    return { appPath: unsupportedAppPath!, kind: "app_unsupported" };
  }
  if (!(await pathExists(socketPath))) {
    return { appPath, kind: "socket_missing", socketPath };
  }
  if (!(await socketReachable(socketPath))) {
    return { appPath, kind: "socket_unreachable", socketPath };
  }
  return { appPath, kind: "ready", socketPath };
}

export function codexDesktopLaunchSpec(appPath: string, codexHome: string) {
  return {
    args: [
      "--env",
      `${codexDesktopLocalDaemonEnv}=1`,
      "--env",
      "CODEX_APP_SERVER_FORCE_CLI=0",
      "--env",
      "CODEX_CLI_PATH",
      "--env",
      `CODEX_HOME=${codexHome}`,
      appPath,
    ],
    command: "/usr/bin/open",
  } as const;
}

export async function launchCodexDesktopShared(appPath: string, codexHome: string) {
  const launch = codexDesktopLaunchSpec(appPath, codexHome);
  await execFileAsync(launch.command, launch.args);
}

export async function isCodexDesktopRunning(
  appPath: string,
  run: ExecFileRunner = async (file, args) => execFileAsync(file, [...args]),
) {
  const processPattern = desktopProcessPattern(appPath);
  try {
    await run("/usr/bin/pgrep", ["-f", processPattern]);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === 1) {
      return false;
    }
    throw error;
  }
}

export async function waitForCodexDesktopSharedConnection(
  appPath: string,
  socketPath: string,
  options: WaitForDesktopConnectionOptions = {},
) {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const connectionProbe =
    options.connectionProbe ?? (() => isCodexDesktopConnected(appPath, socketPath));
  const deadline = Date.now() + timeoutMs;
  do {
    if (await connectionProbe()) {
      return;
    }
    await delay(pollIntervalMs);
  } while (Date.now() < deadline);
  throw new Error(`Codex Desktop did not connect to ${socketPath} within ${timeoutMs}ms.`);
}

export function connectedProcessIdsFromLsof(output: string, socketPath: string) {
  const records = output
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter((columns) => columns.length >= 8);
  const serverDevices = new Set(
    records
      .filter((columns) => columns.at(-1) === socketPath)
      .map((columns) => columns[5])
      .filter((device): device is string => Boolean(device)),
  );
  const connected = new Set<number>();
  for (const columns of records) {
    const peer = columns.at(-1);
    const pid = Number(columns[1]);
    if (peer?.startsWith("->") && serverDevices.has(peer.slice(2)) && Number.isInteger(pid)) {
      connected.add(pid);
    }
  }
  return connected;
}

export function probeCodexAppServerSocket(path: string) {
  return new Promise<boolean>((resolve) => {
    const socket = new WebSocket(`ws+unix://${path}:/`, { perMessageDeflate: false });
    let settled = false;
    const timeout = setTimeout(() => finish(false), 1_500);
    const finish = (reachable: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      socket.removeAllListeners();
      socket.terminate();
      resolve(reachable);
    };
    socket.once("open", () => {
      socket.send(
        JSON.stringify({
          id: 1,
          method: "initialize",
          params: {
            capabilities: { experimentalApi: true, requestAttestation: false },
            clientInfo: nonOriginatingCodexAppServerClientInfo,
          },
        }),
      );
    });
    socket.on("message", (data) => {
      try {
        const response = JSON.parse(String(data)) as { error?: unknown; id?: unknown };
        if (response.id === 1) {
          finish(response.error === undefined);
        }
      } catch {}
    });
    socket.once("error", () => finish(false));
    socket.once("close", () => finish(false));
  });
}

async function isCodexDesktopConnected(appPath: string, socketPath: string) {
  let pids: number[];
  try {
    const result = await execFileAsync("/usr/bin/pgrep", ["-f", desktopProcessPattern(appPath)], {
      encoding: "utf8",
    });
    pids = result.stdout
      .split(/\s+/)
      .map(Number)
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === 1) {
      return false;
    }
    throw error;
  }
  if (pids.length === 0) {
    return false;
  }
  const lsof = await execFileAsync("/usr/sbin/lsof", ["-nP", "-U"], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  const connectedPids = connectedProcessIdsFromLsof(lsof.stdout, socketPath);
  return pids.some((pid) => connectedPids.has(pid));
}

function defaultPathExists(path: string) {
  return access(path).then(
    () => true,
    () => false,
  );
}

async function defaultFileContains(path: string, marker: Buffer) {
  const stream = createReadStream(path);
  let overlap = Buffer.alloc(0);
  try {
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const searchable = overlap.length > 0 ? Buffer.concat([overlap, bytes]) : bytes;
      if (searchable.includes(marker)) {
        return true;
      }
      overlap = searchable.subarray(Math.max(0, searchable.length - marker.length + 1));
    }
    return false;
  } catch {
    return false;
  } finally {
    stream.destroy();
  }
}

function desktopProcessPattern(appPath: string) {
  return `^${escapeRegularExpression(appPath)}/Contents/MacOS/[^ ]+( |$)`;
}

function escapeRegularExpression(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function expandHome(path: string, homeDirectory: string) {
  return path === "~"
    ? homeDirectory
    : path.startsWith("~/")
      ? resolve(homeDirectory, path.slice(2))
      : path;
}
