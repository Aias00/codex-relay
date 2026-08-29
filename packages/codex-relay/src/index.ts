import { serve } from "@hono/node-server";
import { fromByteArray, toByteArray } from "base64-js";
import { createHash, randomBytes } from "node:crypto";
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import pc from "picocolors";
import qrcode from "qrcode-terminal";

import { createApp, relayThreadOwnerCapabilities } from "./app.js";
import { CodexAppServerClient } from "./app-server.js";
import { recoverActiveAppServerTurnClaims } from "./app-server-turn-recovery.js";
import {
  resolveCodexAppServerMode,
  resolveCodexSharedAppServerRemoteAddress,
} from "./codex-binary.js";
import { createServerEpoch, relayIdFromServerPublicKey } from "./connection-plan.js";
import { isRelayDebugEnabled, relayDebugLog } from "./debug-log.js";
import {
  createPairingQrPayload,
  getConnectUrlCandidates,
  getConnectUrlGuidance,
  type ConnectUrlCandidate,
} from "./pairing-url-candidates.js";
import { createTursoPairingSessionStore } from "./pairing-store.js";
import { codexRelayDataPath, legacyCodexRelayDataPath } from "./paths.js";
import { createFileRuntimePreferencesStore } from "./preferences-store.js";
import { createRelayStateStore } from "./relay-state-store.js";
import {
  createServerIdentity,
  createServerIdentityFromPrivateKey,
  type ServerIdentity,
} from "./secure-transport.js";

const port = Number(process.env.PORT ?? 8787);
const hostname = process.env.HOST ?? "0.0.0.0";
const dangerouslyAutoApprove = process.env.CODEX_RELAY_DANGEROUSLY_AUTO_APPROVE === "1";
const maxThreadEventRetention = parsePositiveIntegerEnv("CODEX_RELAY_MAX_THREAD_EVENTS");
const threadOwnerLeaseMs = parseNonnegativeIntegerEnv("CODEX_RELAY_OWNER_LEASE_MS");
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
} = {};
const appServerMode = resolveCodexAppServerMode();
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
  process.once("SIGINT", () => stopRelayAppServer(130));
  process.once("SIGTERM", () => stopRelayAppServer(143));
  process.once("exit", () => relayAppServer.close());
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

serve(
  {
    fetch: createApp({
      approvalStore: relayAppServer ? threadEvents : undefined,
      appServer: relayAppServer,
      connectionPlan: { relayId, serverEpoch },
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

    void writeServerState({
      connectUrl,
      connectUrlCandidates,
      host: hostname,
      listenUrl,
      pairingPayload,
      port: info.port,
    });
    Object.assign(managementState, {
      connectUrl,
      connectUrlCandidates,
      listenUrl,
      pairingPayload,
      port: info.port,
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

function stopRelayAppServer(exitCode: number) {
  relayAppServer?.close();
  process.exit(exitCode);
}

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
          `${color.prompt("›")} Terminal: ${color.command(`codex resume --remote ${details.sharedAppServerRemoteAddress}`)}`,
          `  ${color.muted("Connect through the shared Codex app-server to follow and steer the same live sessions.")}`,
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
}) {
  const path = codexRelayDataPath("server-state.json");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(details)}\n`, { mode: 0o600 });
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
