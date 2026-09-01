import { serve } from "@hono/node-server";
import { fromByteArray, toByteArray } from "base64-js";
import { createHash, randomBytes } from "node:crypto";
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import pc from "picocolors";
import qrcode from "qrcode-terminal";

import { createApp, relayThreadOwnerCapabilities } from "./app.js";
import { CodexAppServerClient } from "./app-server.js";
import {
  effectiveManagedSharedAppServerState,
  ensureCodexSharedAppServerDaemon,
} from "./app-server-daemon.js";
import { recoverActiveAppServerTurnClaims } from "./app-server-turn-recovery.js";
import {
  resolveCodexAppServerMode,
  resolveCodexSharedAppServerRemoteAddress,
} from "./codex-binary.js";
import { createServerEpoch, relayIdFromServerPublicKey } from "./connection-plan.js";
import { flushRelayDebugLog, isRelayDebugEnabled, relayDebugLog } from "./debug-log.js";
import {
  createPairingQrPayload,
  getConnectUrlCandidates,
  getConnectUrlGuidance,
  type ConnectUrlCandidate,
} from "./pairing-url-candidates.js";
import { createTursoPairingSessionStore } from "./pairing-store.js";
import { codexRelayDataPath, legacyCodexRelayDataPath } from "./paths.js";
import { createFileRuntimePreferencesStore } from "./preferences-store.js";
import { createRelayLifecycle } from "./relay-lifecycle.js";
import { createRelayStateStore } from "./relay-state-store.js";
import {
  createServerIdentity,
  createServerIdentityFromPrivateKey,
  type ServerIdentity,
} from "./secure-transport.js";
import {
  startTailcatSidecar,
  stopStaleTailcatSidecar,
  type TailcatSidecar,
  type TailcatSidecarDiagnostics,
} from "./tailcat-sidecar.js";

const port = Number(process.env.PORT ?? 8787);
const hostname = process.env.HOST ?? "0.0.0.0";
const dangerouslyAutoApprove = process.env.CODEX_RELAY_DANGEROUSLY_AUTO_APPROVE === "1";
const maxThreadEventRetention = parsePositiveIntegerEnv("CODEX_RELAY_MAX_THREAD_EVENTS");
const threadOwnerLeaseMs = parseNonnegativeIntegerEnv("CODEX_RELAY_OWNER_LEASE_MS");
const shutdownDrainMs = parseNonnegativeIntegerEnv("CODEX_RELAY_SHUTDOWN_DRAIN_MS") ?? 10_000;
const relayLifecycle = createRelayLifecycle({ drainTimeoutMs: shutdownDrainMs });
const serverIdentity = await getServerIdentity();
const relayId = relayIdFromServerPublicKey(serverIdentity.publicKey);
const serverEpoch = createServerEpoch();
const approvalSecret = await getApprovalSecret();
const debugLogPath = isRelayDebugEnabled()
  ? (process.env.CODEX_RELAY_DEBUG_LOG_PATH ?? (await prepareCodexRelayDataPath("debug.log")))
  : undefined;
if (debugLogPath) {
  process.env.CODEX_RELAY_DEBUG_LOG_PATH = debugLogPath;
  relayDebugLog("relay.debug.enabled", { debugLogPath, pid: process.pid });
}
const tailcatAddressPath =
  process.env.CODEX_RELAY_TAILCAT_ADDRESS_PATH ?? codexRelayDataPath("tailcat/address.token");
const tailcatBinaryPath = process.env.CODEX_RELAY_TAILCAT_BINARY ?? "tailcat";
const tailcatKeyPath =
  process.env.CODEX_RELAY_TAILCAT_KEY_PATH ?? codexRelayDataPath("tailcat/default.private.json");
const tailcatPidPath = process.env.CODEX_RELAY_TAILCAT_PID_PATH ?? `${tailcatAddressPath}.pid`;
await stopStaleTailcatSidecar({
  binaryPath: tailcatBinaryPath,
  keyPath: tailcatKeyPath,
  localTargetPort: port,
  pidPath: tailcatPidPath,
})
  .then((stopped) => {
    if (stopped) {
      relayDebugLog("tailcat.stale_sidecar_stopped");
    }
  })
  .catch((error) => {
    relayDebugLog("tailcat.stale_sidecar_cleanup_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  });
const tailcatEnabled = process.env.CODEX_RELAY_TAILCAT_TRANSPORT === "1";
const tailcatSidecar = tailcatEnabled
  ? await startTailcatSidecar({
      addressPath: tailcatAddressPath,
      binaryPath: tailcatBinaryPath,
      keyPath: tailcatKeyPath,
      localTargetPort: port,
      pidPath: tailcatPidPath,
      startTimeoutMs: parsePositiveIntegerEnv("CODEX_RELAY_TAILCAT_START_TIMEOUT_MS") ?? 10_000,
    })
      .then((sidecar) => {
        relayDebugLog("tailcat.started", sidecar.diagnostics());
        return sidecar;
      })
      .catch((error) => {
        relayDebugLog("tailcat.start_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        console.warn(
          "Tailcat transport is unavailable; continuing with HTTP connection candidates.",
        );
        return undefined;
      })
  : undefined;
const colors = pc.createColors(!process.env.NO_COLOR && process.env.TERM !== "dumb");
const color = {
  brand: colors.cyan,
  code: colors.yellow,
  command: colors.green,
  event: colors.magenta,
  muted: colors.gray,
  prompt: colors.cyan,
  url: colors.blue,
};
const npxCommand = "npx codex-relay@latest";
const workspacePath = resolve(process.env.CODEX_RELAY_WORKSPACE_PATH ?? process.cwd());

const sessionStore = await createTursoPairingSessionStore(
  process.env.CODEX_RELAY_AUTH_DB_PATH ??
    (await prepareCodexRelayDataPath("auth.db", ["auth.db-shm", "auth.db-wal"])),
);
const threadEvents = await createRelayStateStore(
  process.env.CODEX_RELAY_STATE_DB_PATH ?? codexRelayDataPath("relay-state.db"),
).catch((error) => {
  relayDebugLog("relay_state.initialization_failed", {
    error: error instanceof Error ? error.message : String(error),
  });
  logRuntimeEvent(
    "Warning",
    "Durable event replay is unavailable; continuing with the existing mobile API.",
  );
  return undefined;
});
if (threadEvents) {
  await threadEvents
    .registerWorkspace({ path: workspacePath, source: "relay_startup" })
    .catch((error) => {
      relayDebugLog("workspace_registry.startup_registration_failed", {
        error: error instanceof Error ? error.message : String(error),
        workspacePath,
      });
      logRuntimeEvent(
        "Warning",
        "Workspace identity registration failed; continuing with path-based APIs.",
      );
    });
}
const preferencesStore = createFileRuntimePreferencesStore(
  process.env.CODEX_RELAY_PREFERENCES_PATH ?? (await prepareCodexRelayDataPath("preferences.json")),
);
const managementState: {
  connectUrl?: string;
  connectUrlCandidates?: ConnectUrlCandidate[];
  listenUrl?: string;
  pairingPayload?: string;
  port?: number;
  tailcat?: TailcatRuntimeDiagnostics;
} = {};
const appServerMode = resolveCodexAppServerMode();
let sharedAppServerManaged = false;
let sharedAppServerSocketPath: string | undefined;
if (appServerMode.mode === "socket" && process.platform !== "win32") {
  await ensureCodexSharedAppServerDaemon()
    .then((daemon) => {
      sharedAppServerManaged = true;
      sharedAppServerSocketPath = daemon.socketPath;
    })
    .catch((error) => {
      logRuntimeEvent(
        "Warning",
        `Managed shared app-server unavailable; continuing with process-owned shared startup (${error instanceof Error ? error.message : String(error)}).`,
      );
    });
}
const relayAppServer =
  appServerMode.mode === "socket"
    ? new CodexAppServerClient({
        mode: appServerMode,
        onStartupFallback: (error) => {
          logRuntimeEvent(
            "Fallback",
            `Shared app-server unavailable; continuing with a private app-server (${error.message}).`,
          );
        },
      })
    : undefined;
if (relayAppServer) {
  await relayAppServer.initialize();
}
const recoveredTurnClaims =
  relayAppServer && threadEvents
    ? await recoverActiveAppServerTurnClaims({
        appServer: relayAppServer,
        capabilities: relayThreadOwnerCapabilities,
        coordinator: threadEvents,
        ownerId: relayId,
        ownerInstanceId: serverEpoch,
        ownerType: "shared_app_server",
      })
        .then((result) => result.recovered)
        .catch((error) => {
          relayDebugLog("thread.claim.startup_recovery_failed", {
            error: error instanceof Error ? error.message : String(error),
          });
          return [];
        })
    : [];

const httpServer = serve(
  {
    fetch: createApp({
      approvalStore: relayAppServer ? threadEvents : undefined,
      appServer: relayAppServer,
      compatibilityObservations: threadEvents,
      connectionPlan: {
        relayId,
        serverEpoch,
        tailcatCandidate: () => tailcatSidecar?.candidate(),
      },
      lifecycle: relayLifecycle,
      management: managementState,
      maxThreadEventRetention,
      pairing: {
        approvalSecret,
        dangerouslyAutoApprove,
        serverIdentity,
        createClientToken: () => randomBytes(32).toString("base64url"),
        hashClientToken,
        sessions: sessionStore,
        onPaired: ({ clientName, tokenCount }) => {
          const name = clientName ? ` from ${clientName}` : "";
          logRuntimeEvent(
            "Paired",
            `Mobile client connected${name}; ${formatClientCount(tokenCount)} active.`,
          );
        },
        onPairAttempt: ({ remoteAddress }) => {
          logRuntimeEvent(
            "Pairing",
            `Handshake received${remoteAddress ? ` from ${remoteAddress}` : ""}.`,
          );
        },
        onPairApprovalRequested: ({ clientName }) => {
          const name = clientName ? ` from ${clientName}` : "";
          logRuntimeEvent(
            "Approval",
            `Pairing approval requested${name}. Use the code shown in the mobile app to approve locally.`,
          );
        },
        onPairApproved: ({ clientName }) => {
          const name = clientName ? ` for ${clientName}` : "";
          logRuntimeEvent(
            "Approved",
            `Pairing request approved${name}. Waiting for secure session pickup.`,
          );
        },
        onPairingsCleared: ({ pendingPairingsCleared, sessionsCleared }) => {
          logRuntimeEvent(
            "Cleared",
            `Signed out ${sessionsCleared} mobile session${sessionsCleared === 1 ? "" : "s"} and removed ${pendingPairingsCleared} pending pairing request${pendingPairingsCleared === 1 ? "" : "s"}.`,
          );
        },
        onTokenRefreshed: ({ clientName, tokenCount }) => {
          const name = clientName ? ` for ${clientName}` : "";
          logRuntimeEvent(
            "Refreshed",
            `Mobile session rotated${name}; ${formatClientCount(tokenCount)} active.`,
          );
        },
      },
      preferences: preferencesStore,
      recoveredTurnClaims,
      threadCoordinator: threadEvents,
      threadEvents,
      threadInputs: threadEvents,
      threadOwnerLeaseMs,
      workspacePath,
      workspaceRegistry: threadEvents,
    }).fetch,
    hostname,
    port,
  },
  (info) => {
    const listenUrl = `http://${info.address}:${info.port}`;
    const connectUrlCandidates = getConnectUrlCandidates({
      listenUrl,
      port: info.port,
      publicUrl: process.env.CODEX_RELAY_PUBLIC_URL,
    });
    const connectUrl = connectUrlCandidates[0]?.url ?? listenUrl;
    const connectUrls = connectUrlCandidates.map((candidate) => candidate.url);
    const pairingPayload = createPairingQrPayload({
      serverPublicKey: serverIdentity.publicKey,
      serverUrls: connectUrls.length > 0 ? connectUrls : [connectUrl],
    });
    const effectiveSharedAppServerState = effectiveManagedSharedAppServerState({
      appServerMode: relayAppServer?.appServerMode,
      managed: sharedAppServerManaged,
      socketPath: sharedAppServerSocketPath,
    });

    void writeServerState({
      connectUrl,
      connectUrlCandidates,
      host: hostname,
      listenUrl,
      pairingPayload,
      port: info.port,
      tailcat: tailcatRuntimeDiagnostics(tailcatEnabled, tailcatSidecar, port),
      ...effectiveSharedAppServerState,
    });
    Object.assign(managementState, {
      connectUrl,
      connectUrlCandidates,
      listenUrl,
      pairingPayload,
      port: info.port,
      tailcat: tailcatRuntimeDiagnostics(tailcatEnabled, tailcatSidecar, port),
    });
    void writeBackgroundPid();
    if (debugLogPath) {
      logRuntimeEvent("Debug", `Writing diagnostics to ${debugLogPath}`);
      relayDebugLog("relay.started", {
        connectUrl,
        connectUrlCandidates,
        listenUrl,
        port: info.port,
        relayId,
        serverEpoch,
        workspacePath,
      });
    }
    console.log("");
    qrcode.generate(pairingPayload, { small: true });
    console.log(
      formatStartupInstructions({
        connectUrl,
        connectUrlCandidates,
        dangerouslyAutoApprove,
        listenUrl,
        pairingPayload,
        port: info.port,
        sharedAppServerRemoteAddress:
          relayAppServer?.appServerMode === "socket"
            ? resolveCodexSharedAppServerRemoteAddress()
            : undefined,
      }),
    );
  },
);

relayLifecycle.onQuiesce(() => {
  httpServer.close();
  relayDebugLog("relay.shutdown.quiescing", { drainTimeoutMs: shutdownDrainMs });
});
relayLifecycle.onClose(async () => {
  const connectionCloser = httpServer as typeof httpServer & {
    closeAllConnections?: () => void;
    closeIdleConnections?: () => void;
  };
  connectionCloser.closeIdleConnections?.();
  connectionCloser.closeAllConnections?.();
  relayAppServer?.close();
  await tailcatSidecar?.close();
  sessionStore.close();
  threadEvents?.close();
});

let shutdownExitCode: number | undefined;
function requestShutdown(exitCode: number) {
  shutdownExitCode ??= exitCode;
  void relayLifecycle
    .shutdown()
    .then(async (report) => {
      relayDebugLog("relay.shutdown.completed", {
        drainTimedOut: report.drainTimedOut,
        errors: report.errors,
      });
      await flushRelayDebugLog();
      process.exit(shutdownExitCode);
    })
    .catch(async (error) => {
      relayDebugLog("relay.shutdown.failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      await flushRelayDebugLog();
      process.exit(1);
    });
}

process.once("SIGINT", () => requestShutdown(130));
process.once("SIGTERM", () => requestShutdown(143));
process.once("exit", () => {
  relayAppServer?.close();
  void tailcatSidecar?.close();
  sessionStore.close();
  threadEvents?.close();
});

function formatStartupInstructions(details: {
  connectUrl: string;
  connectUrlCandidates: ConnectUrlCandidate[];
  dangerouslyAutoApprove: boolean;
  listenUrl: string;
  pairingPayload: string;
  port: number;
  sharedAppServerRemoteAddress?: string;
}) {
  const lines = [
    `${color.prompt("›")} Scan the QR code above to pair ${color.brand("Codex Relay mobile")}.`,
    "",
    `${color.prompt("›")} Mobile: ${color.url(details.connectUrl)}`,
    ...formatConnectUrlGuidance(details.connectUrl),
    ...formatConnectUrlCandidates(details.connectUrlCandidates),
    `${color.prompt("›")} Server: ${color.muted(details.listenUrl)}`,
    "",
    `${color.prompt("›")} Pairing: ${color.url(details.pairingPayload)}`,
    ...(details.sharedAppServerRemoteAddress
      ? [
          "",
          `${color.prompt("›")} New terminal session: ${color.command(`codex --remote ${details.sharedAppServerRemoteAddress} -C "$PWD"`)}`,
          `${color.prompt("›")} Resume terminal session: ${color.command(`codex resume --remote ${details.sharedAppServerRemoteAddress} -C "$PWD"`)}`,
          `  ${color.muted("New sessions use the current terminal directory. Resumed sessions retain their original working directory.")}`,
        ]
      : []),
    "",
    `${color.prompt("›")} Commands`,
    `  ${color.command(npxCommand)}              Start and print a pairing QR`,
    `  ${color.command(`${npxCommand} --bg`)}         Start in the background`,
    `  ${color.command(`${npxCommand} stop`)}         Stop the background relay`,
    `  ${color.command(`${npxCommand} qr`)}           Print this QR again`,
    `  ${color.command(`${npxCommand} approve <code>`)} Approve a device`,
    "",
    details.dangerouslyAutoApprove
      ? `${color.prompt("›")} Pairing requests will be auto-approved.`
      : `${color.prompt("›")} Waiting for pairing requests`,
    details.dangerouslyAutoApprove
      ? `${color.prompt("›")} Disable this for normal use.`
      : `${color.prompt("›")} Approve a device with ${color.command(
          formatApprovalCommand("<code>", details.port),
        )}`,
  ];
  return ["", ...lines, ""].join("\n");
}

function formatConnectUrlGuidance(connectUrl: string) {
  const guidance = getConnectUrlGuidance(connectUrl);
  return guidance ? [`${color.prompt("›")} Network: ${guidance}`] : [];
}

function formatConnectUrlCandidates(candidates: ConnectUrlCandidate[]) {
  if (candidates.length <= 1) {
    return [];
  }

  return [
    `${color.prompt("›")} QR includes ${candidates.length} candidate addresses; the app will use the first reachable one.`,
    ...candidates
      .slice(1)
      .map((candidate) => `  ${color.muted(candidate.label)} ${color.url(candidate.url)}`),
  ];
}

function logRuntimeEvent(label: string, message: string) {
  console.log(`${color.prompt("›")} ${color.event(label.padEnd(8))} ${message}`);
}

function parsePositiveIntegerEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function parseNonnegativeIntegerEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a nonnegative integer.`);
  }
  return parsed;
}

function formatClientCount(tokenCount: number) {
  return `${tokenCount} client${tokenCount === 1 ? "" : "s"}`;
}

function hashClientToken(token: string) {
  return createHash("sha256").update(token).digest("base64url");
}

async function getApprovalSecret() {
  if (process.env.CODEX_RELAY_APPROVAL_SECRET) {
    return process.env.CODEX_RELAY_APPROVAL_SECRET;
  }

  const path = await prepareCodexRelayDataPath("approval-secret");
  try {
    return (await readFile(path, "utf8")).trim();
  } catch {
    const secret = randomBytes(32).toString("base64url");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${secret}\n`, { mode: 0o600 });
    return secret;
  }
}

async function getServerIdentity(): Promise<ServerIdentity> {
  const path = await prepareCodexRelayDataPath("server-identity-key");
  try {
    return createServerIdentityFromPrivateKey(toByteArray((await readFile(path, "utf8")).trim()));
  } catch {
    const identity = createServerIdentity();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${fromByteArray(identity.privateKey)}\n`, { mode: 0o600 });
    return identity;
  }
}

async function writeServerState(details: {
  connectUrl: string;
  connectUrlCandidates: ConnectUrlCandidate[];
  host: string;
  listenUrl: string;
  pairingPayload: string;
  port: number;
  sharedAppServerManaged: boolean;
  sharedAppServerSocketPath?: string;
  tailcat?: TailcatRuntimeDiagnostics;
}) {
  const path = codexRelayDataPath("server-state.json");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(details)}\n`, { mode: 0o600 });
}

type TailcatRuntimeDiagnostics =
  | { enabled: false; status: "disabled" }
  | ({ enabled: true } & TailcatSidecarDiagnostics)
  | { enabled: true; localTargetPort: number; status: "failed" };

function tailcatRuntimeDiagnostics(
  enabled: boolean,
  sidecar: TailcatSidecar | undefined,
  localTargetPort: number,
): TailcatRuntimeDiagnostics {
  if (!enabled) {
    return { enabled: false, status: "disabled" };
  }
  return sidecar
    ? { enabled: true, ...sidecar.diagnostics() }
    : { enabled: true, localTargetPort, status: "failed" };
}

async function prepareCodexRelayDataPath(fileName: string, companionFileNames: string[] = []) {
  const targetPath = codexRelayDataPath(fileName);
  const legacyPath = legacyCodexRelayDataPath(fileName);
  if (targetPath !== legacyPath) {
    await copyLegacyFileIfTargetMissing(legacyPath, targetPath);
    for (const companionFileName of companionFileNames) {
      await copyLegacyFileIfTargetMissing(
        legacyCodexRelayDataPath(companionFileName),
        codexRelayDataPath(companionFileName),
      );
    }
  }
  return targetPath;
}

async function copyLegacyFileIfTargetMissing(legacyPath: string, targetPath: string) {
  await access(targetPath).catch(async () => {
    await mkdir(dirname(targetPath), { recursive: true });
    await copyFile(legacyPath, targetPath).catch(() => undefined);
  });
}

async function writeBackgroundPid() {
  const path = process.env.CODEX_RELAY_PID_PATH;
  if (!path) {
    return;
  }

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${process.pid}\n`, { mode: 0o600 });
}

function formatApprovalCommand(approvalCode: string, activePort: number) {
  return activePort === 8787
    ? `${npxCommand} approve ${approvalCode}`
    : `PORT=${activePort} ${npxCommand} approve ${approvalCode}`;
}
