#!/usr/bin/env node

import { Command } from "@commander-js/extra-typings";
import qrcode from "qrcode-terminal";
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { access, mkdir, readFile, rm, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { apiPaths } from "./api-schema.js";
import {
  readRunningRelayPid,
  stopRunningRelay,
  type StopRunningRelayResult,
} from "./background-process.js";
import { createTursoPairingSessionStore } from "./pairing-store.js";
import {
  codexHomePath,
  inspectCodexDesktopShare,
  isCodexDesktopRunning,
  launchCodexDesktopShared,
  waitForCodexDesktopSharedConnection,
} from "./desktop-app.js";
import { getConnectUrlGuidance } from "./pairing-url-candidates.js";
import {
  backupRelayDatabases,
  inspectRelayCompatibility,
  inspectRelayConnections,
  inspectRelayState,
  listRelayEvents,
  listRelayOwners,
  listRelayWorkspaces,
} from "./operator-tools.js";
import { createRelayStateStore, relayStateSchemaVersion } from "./relay-state-store.js";
import { rotateTailcatServerKey } from "./tailcat-key-rotation.js";
import {
  parseTransportBenchmarkJsonl,
  summarizeTransportBenchmarks,
} from "./transport-benchmark.js";

import { codexRelayDataPath, codexRelayHome, legacyCodexRelayDataPath } from "./paths.js";

const npxCommand = "npx @aias00/codex-relay@latest";

type ServerState = {
  connectUrl?: string;
  connectUrlCandidates?: Array<{ label: string; url: string }>;
  host?: string;
  listenUrl?: string;
  pairingPayload?: string;
  port?: number;
  sharedAppServerManaged?: boolean;
  sharedAppServerSocketPath?: string;
  tailcat?: {
    enabled: boolean;
    exitCode?: number;
    localTargetPort?: number;
    pid?: number;
    startedAt?: string;
    status: "disabled" | "failed" | "healthy" | "starting" | "stopped";
  };
};

type ClearPairingResult = {
  pendingPairingsCleared: number;
  sessionsCleared: number;
};

const program = new Command()
  .name("codex-relay")
  .description("Run and approve the codex-relay local CLI bridge.")
  .option("--bg", "run the Codex Relay server in the background")
  .option("--debug", "write verbose relay diagnostics to debug.log")
  .option(
    "--shared-app-server",
    "require a shared Codex app-server so terminal and mobile can share live sessions",
  )
  .option(
    "--dangerously-auto-approve",
    "automatically approve mobile pairing requests without a local approval command",
  )
  .addHelpText(
    "after",
    `

Examples:
  ${npxCommand}              Start the relay and print a pairing QR
  ${npxCommand} --shared-app-server Share live sessions with a connected terminal
  ${npxCommand} --bg         Start the relay in the background
  ${npxCommand} stop         Stop the background relay
  ${npxCommand} qr           Print the current pairing QR
  ${npxCommand} clear        Sign out every paired mobile app
  ${npxCommand} status       Show running Relay and durable state status
  ${npxCommand} doctor       Check local Relay readiness and stale state
  ${npxCommand} connections  Show route candidates and paired-device counts
  ${npxCommand} workspaces   List registered workspaces
  ${npxCommand} owners       List thread owners and active claims
  ${npxCommand} events THREAD List content-safe durable event metadata
  ${npxCommand} compatibility Show legacy API usage and retirement readiness
  ${npxCommand} diagnostics  Inspect durable Relay state without conversation content
  ${npxCommand} tailcat-key rotate --region REGION Rotate the Tailcat server key safely
  ${npxCommand} transport-benchmark FILE Summarize content-safe transport benchmark JSONL
  ${npxCommand} desktop      Check Codex Desktop shared-session readiness
  ${npxCommand} desktop --launch Launch Codex Desktop on the shared app-server
  ${npxCommand} backup       Create consistent SQLite backups
  ${npxCommand} compact THREAD --through N Compact one thread's durable event log
  ${npxCommand} repair-owner THREAD Repair an expired owner lease
  ${npxCommand} approve CODE Approve a pending mobile pairing request`,
  )
  .action(async (options) => {
    if (options.debug) {
      process.env.CODEX_RELAY_DEBUG = "1";
    }
    if (options.dangerouslyAutoApprove) {
      process.env.CODEX_RELAY_DANGEROUSLY_AUTO_APPROVE = "1";
    }
    if (options.sharedAppServer) {
      process.env.CODEX_RELAY_APP_SERVER_MODE = "socket";
    }

    if (options.bg) {
      await startBackgroundServer();
      return;
    }

    await import("./index.js").catch(handleServerStartError);
  });

program
  .command("stop")
  .description("Stop the background Codex Relay server.")
  .action(async () => {
    await stopBackgroundServer();
  });

program
  .command("qr")
  .description("Print the current pairing QR for an already running server.")
  .action(async () => {
    await printPairingQr();
  });

program
  .command("approve")
  .description("Approve a pending mobile pairing request.")
  .argument("<approval-code>", "approval code shown in the mobile app")
  .action(async (approvalCode) => {
    await approvePairing(approvalCode);
  });

program
  .command("clear")
  .description("Sign out every paired mobile app.")
  .option("--debug", "also delete debug.log")
  .action(async (options, command) => {
    await clearPairings({
      clearDebugLog: Boolean(options.debug || command.optsWithGlobals().debug),
    });
  });

program
  .command("desktop")
  .description("Check or launch Codex Desktop on Relay's shared app-server.")
  .option("--app <path>", "Codex Desktop application bundle path")
  .option("--launch", "launch the desktop app after the readiness check")
  .action(async (options) => {
    const relayState = await readServerState();
    if (!relayState?.sharedAppServerManaged || !relayState.sharedAppServerSocketPath) {
      console.error("The running Relay is not attached to a managed shared app-server daemon.");
      console.error(`Restart it with: ${npxCommand} stop`);
      console.error(`Then start it with: ${npxCommand} --shared-app-server --bg`);
      process.exitCode = 1;
      return;
    }
    const managedCodexHome = dirname(dirname(relayState.sharedAppServerSocketPath));
    const env = {
      ...process.env,
      CODEX_HOME: managedCodexHome,
      ...(options.app ? { CODEX_RELAY_DESKTOP_APP_PATH: options.app } : {}),
    };
    const inspection = await inspectCodexDesktopShare({ env });
    if (inspection.kind === "unsupported_platform") {
      console.error("Codex Desktop shared launch is currently supported on macOS only.");
      process.exitCode = 1;
      return;
    }
    if (inspection.kind === "app_missing") {
      console.error("Codex Desktop was not found.");
      console.error(`Checked: ${inspection.candidates.join(", ")}`);
      console.error(`Provide its path with: ${npxCommand} desktop --app /path/to/App.app`);
      process.exitCode = 1;
      return;
    }
    if (inspection.kind === "app_unsupported") {
      console.error(
        `This Codex Desktop build does not support local daemon sharing: ${inspection.appPath}`,
      );
      console.error("Update Codex Desktop and retry.");
      process.exitCode = 1;
      return;
    }
    if (inspection.kind === "socket_missing") {
      console.error(`Shared app-server socket was not found: ${inspection.socketPath}`);
      process.exitCode = 1;
      return;
    }
    if (inspection.kind === "socket_unreachable") {
      console.error(
        `Shared app-server socket is not accepting connections: ${inspection.socketPath}`,
      );
      process.exitCode = 1;
      return;
    }
    if (options.launch && (await isCodexDesktopRunning(inspection.appPath))) {
      console.error("Codex Desktop is already running, so macOS cannot apply shared mode yet.");
      console.error("Fully quit the desktop app, then run this command again.");
      process.exitCode = 1;
      return;
    }

    console.log(`Codex Desktop: ${inspection.appPath}`);
    console.log(`Shared app-server: ${inspection.socketPath}`);
    console.log("Desktop sharing is ready.");
    if (!options.launch) {
      console.log("");
      console.log("Fully quit an already-running Codex Desktop app, then launch shared mode with:");
      console.log(`  ${npxCommand} desktop --launch`);
      return;
    }

    await launchCodexDesktopShared(inspection.appPath, codexHomePath({ env }));
    await waitForCodexDesktopSharedConnection(inspection.appPath, inspection.socketPath);
    console.log("Launched Codex Desktop with the shared app-server transport.");
    console.log(
      "Reopen the same thread in the desktop app and mobile app to share subsequent turns.",
    );
  });

program
  .command("status")
  .description("Show running Relay configuration and content-safe durable state status.")
  .option("--json", "print machine-readable JSON")
  .action(async (options) => {
    const [server, state, connections, backgroundPid] = await Promise.all([
      readServerState(),
      inspectRelayState(relayStateDbPath()),
      inspectRelayConnections(authDbPath()),
      readRunningRelayPid(codexRelayDataPath("server.pid")),
    ]);
    const result = {
      backgroundPid,
      connections,
      server: contentSafeServerState(server),
      state,
    };
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(`Relay: ${server?.listenUrl ?? "not recorded"}`);
    console.log(`Mobile route: ${server?.connectUrl ?? "not recorded"}`);
    console.log(`Background PID: ${backgroundPid ?? "not managed by codex-relay --bg"}`);
    console.log(`State DB: ${state.exists ? state.path : "missing"}`);
    console.log(`Schema: ${state.schemaVersion ?? "unknown"}`);
    console.log(`Clients: ${connections.activeClientCount}`);
    console.log(`Events: ${state.eventCount}`);
    console.log(`Owners: ${state.ownerCount} (${state.expiredOwnerCount} expired)`);
    console.log(`Active claims: ${state.activeClaimCount}`);
    console.log(`Pending approvals: ${state.pendingApprovalCount}`);
    console.log(`Tailcat: ${server?.tailcat?.status ?? "not recorded"}`);
  });

program
  .command("connections")
  .description("Show Relay route candidates and paired-device counts without credentials.")
  .option("--json", "print machine-readable JSON")
  .action(async (options) => {
    const [server, connections] = await Promise.all([
      readServerState(),
      inspectRelayConnections(authDbPath()),
    ]);
    const result = {
      ...connections,
      connectUrl: server?.connectUrl,
      candidates: server?.connectUrlCandidates ?? [],
      listenUrl: server?.listenUrl,
      tailcat: server?.tailcat,
    };
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(`Selected route: ${result.connectUrl ?? "not recorded"}`);
    console.log(`Listen URL: ${result.listenUrl ?? "not recorded"}`);
    console.log(`Paired clients: ${result.activeClientCount}`);
    console.log(`Pending pairings: ${result.pendingPairingCount}`);
    console.log(`Push subscriptions: ${result.pushSubscriptionCount}`);
    console.log(`Tailcat: ${result.tailcat?.status ?? "not recorded"}`);
    for (const candidate of result.candidates) {
      console.log(`${candidate.label}: ${candidate.url}`);
    }
  });

program
  .command("workspaces")
  .description("List registered Relay workspaces without reading project content.")
  .option("--json", "print machine-readable JSON")
  .action(async (options) => {
    const workspaces = await listRelayWorkspaces(relayStateDbPath());
    if (options.json) {
      console.log(JSON.stringify(workspaces, null, 2));
      return;
    }
    if (workspaces.length === 0) {
      console.log("No registered workspaces.");
      return;
    }
    for (const workspace of workspaces) {
      console.log(
        `${workspace.workspaceId}  ${workspace.state}  ${workspace.canonicalPath}  (${workspace.registrationSource})`,
      );
    }
  });

program
  .command("owners")
  .description("List durable thread owners and active claim identities.")
  .option("--json", "print machine-readable JSON")
  .action(async (options) => {
    const owners = await listRelayOwners(relayStateDbPath());
    if (options.json) {
      console.log(JSON.stringify(owners, null, 2));
      return;
    }
    if (owners.length === 0) {
      console.log("No durable thread owners.");
      return;
    }
    for (const owner of owners) {
      console.log(
        `${owner.threadId}  epoch=${owner.epoch}  ${owner.ownerType}  ${owner.expired ? "expired" : "active"}  claim=${owner.activeClaimId ?? "none"}`,
      );
    }
  });

program
  .command("events")
  .description("List content-safe durable event metadata for one thread.")
  .argument("<thread-id>", "thread whose events should be listed")
  .option("--json", "print machine-readable JSON")
  .option("--limit <count>", "maximum recent events to list", "50")
  .action(async (threadId, options) => {
    const events = await listRelayEvents(
      relayStateDbPath(),
      threadId,
      boundedPositiveInteger(options.limit, "--limit", 500),
    );
    if (options.json) {
      console.log(JSON.stringify(events, null, 2));
      return;
    }
    if (events.length === 0) {
      console.log(`No durable events for ${threadId}.`);
      return;
    }
    for (const event of events) {
      console.log(`${event.sequence}  ${event.eventType}  ${event.eventId}  ${event.createdAt}`);
    }
  });

program
  .command("compatibility")
  .description("Show content-safe legacy API usage and compatibility retirement readiness.")
  .option("--json", "print machine-readable JSON")
  .action(async (options) => {
    const report = await inspectRelayCompatibility(relayStateDbPath());
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(`State DB: ${report.exists ? report.path : "missing"}`);
    console.log(`Observation started: ${report.retirement.observationStartedAt ?? "not started"}`);
    console.log(`Quiet window: ${report.retirement.quietPeriodDays} days`);
    console.log(`Window complete: ${report.retirement.windowComplete ? "yes" : "no"}`);
    console.log(`Retirement ready: ${report.retirement.ready ? "yes" : "no"}`);
    if (report.observations.length === 0) {
      console.log("No legacy compatibility usage observed.");
      return;
    }
    for (const observation of report.observations) {
      console.log(
        `${observation.feature}  count=${observation.count}  first=${observation.firstSeenAt}  last=${observation.lastSeenAt}`,
      );
    }
  });

program
  .command("doctor")
  .description("Check Relay databases, routes, workspaces, owners, and shared app-server state.")
  .option("--json", "print machine-readable JSON")
  .action(async (options) => {
    const [server, state, connections, workspaces, owners, compatibility] = await Promise.all([
      readServerState(),
      inspectRelayState(relayStateDbPath()),
      inspectRelayConnections(authDbPath()),
      listRelayWorkspaces(relayStateDbPath()),
      listRelayOwners(relayStateDbPath()),
      inspectRelayCompatibility(relayStateDbPath()),
    ]);
    const checks = [
      doctorCheck("server-state", Boolean(server), "running server metadata is available"),
      doctorCheck(
        "state-database",
        state.exists,
        state.exists ? state.path : "relay-state.db is missing",
      ),
      doctorCheck(
        "schema",
        state.schemaVersion === relayStateSchemaVersion,
        `schema ${state.schemaVersion ?? "missing"}; expected ${relayStateSchemaVersion}`,
      ),
      doctorCheck(
        "auth-database",
        connections.exists,
        connections.exists ? connections.path : "auth.db is missing",
      ),
      doctorCheck(
        "routes",
        Boolean(server?.connectUrlCandidates?.length),
        `${server?.connectUrlCandidates?.length ?? 0} candidate(s)`,
      ),
      doctorCheck(
        "workspaces",
        workspaces.every((workspace) => workspace.state === "available"),
        `${workspaces.length} registered; ${workspaces.filter((workspace) => workspace.state !== "available").length} unavailable`,
      ),
      doctorCheck(
        "owners",
        owners.every((owner) => !owner.expired),
        `${owners.length} owner(s); ${owners.filter((owner) => owner.expired).length} expired`,
      ),
      doctorCheck(
        "shared-app-server",
        !server?.sharedAppServerManaged || Boolean(server.sharedAppServerSocketPath),
        server?.sharedAppServerManaged
          ? (server.sharedAppServerSocketPath ?? "managed socket path is missing")
          : "not configured",
      ),
      doctorCompatibilityCheck(compatibility.retirement),
      doctorTailcatCheck(server?.tailcat),
    ];
    const result = {
      checks,
      ok: checks.every((check) => check.status !== "error"),
    };
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      for (const check of checks) {
        console.log(`${check.status.toUpperCase()}  ${check.name}  ${check.message}`);
      }
    }
    if (!result.ok) {
      process.exitCode = 1;
    }
  });

program
  .command("transport-benchmark")
  .description("Summarize content-safe transport benchmark JSONL without reading Relay state.")
  .argument("<jsonl-path>", "benchmark JSONL file")
  .option("--json", "print machine-readable JSON")
  .action(async (jsonlPath, options) => {
    const samples = parseTransportBenchmarkJsonl(await readFile(resolve(jsonlPath), "utf8"));
    const summary = summarizeTransportBenchmarks(samples);
    if (options.json) {
      console.log(JSON.stringify(summary, null, 2));
      return;
    }
    console.log(`Samples: ${summary.sampleCount}`);
    for (const group of summary.groups) {
      const success = `${group.successCount}/${group.sampleCount} (${Math.round(group.successRate * 100)}%)`;
      const latency = group.durationMs
        ? `P50 ${Math.round(group.durationMs.p50)}ms, P95 ${Math.round(group.durationMs.p95)}ms`
        : "no successful latency samples";
      const throughput = group.throughputBytesPerSecond
        ? `, throughput P50 ${Math.round(group.throughputBytesPerSecond.p50)} B/s, P95 ${Math.round(group.throughputBytesPerSecond.p95)} B/s`
        : "";
      const battery = group.batteryUsedPercent
        ? `, battery P50 ${group.batteryUsedPercent.p50}%, P95 ${group.batteryUsedPercent.p95}%`
        : "";
      console.log(
        `${group.route} ${group.scenario}: success ${success}; ${latency}${throughput}${battery}`,
      );
    }
  });

program
  .command("tailcat-key")
  .description("Manage the optional Tailcat server key without printing connection tokens.")
  .addCommand(
    new Command()
      .name("rotate")
      .description("Generate and atomically activate a replacement Tailcat server key file.")
      .requiredOption("--region <region>", "DERP region ID, code, or custom DERP hostname")
      .option("--binary <path>", "Tailcat executable path")
      .option("--key <path>", "Tailcat server key path")
      .option("--derpmap-url <url>", "alternate DERP map URL")
      .option("--embed-derp-map", "embed public DERP node data in the connection token")
      .option("--json", "print machine-readable content-safe output")
      .action(async (options) => {
        const result = await rotateTailcatServerKey({
          binaryPath: options.binary ?? process.env.CODEX_RELAY_TAILCAT_BINARY?.trim() ?? "tailcat",
          derpMapUrl: options.derpmapUrl,
          embedDerpMap: options.embedDerpMap,
          keyPath:
            options.key ??
            process.env.CODEX_RELAY_TAILCAT_KEY_PATH?.trim() ??
            codexRelayDataPath("tailcat/default.private.json"),
          region: options.region,
        });
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(`Tailcat key: ${result.keyPath}`);
        console.log(`Rollback key: ${result.backupPath}`);
        console.log("Restart Relay to activate the replacement key and invalidate old tokens.");
        console.log("Relay pairing sessions and durable conversation state were not changed.");
      }),
  );

program
  .command("diagnostics")
  .description("Inspect durable Relay state without reading conversation content.")
  .option("--json", "print machine-readable JSON")
  .action(async (options) => {
    const diagnostics = await inspectRelayState(relayStateDbPath());
    if (options.json) {
      console.log(JSON.stringify(diagnostics, null, 2));
      return;
    }
    console.log(`State DB: ${diagnostics.path}`);
    console.log(`Exists: ${diagnostics.exists ? "yes" : "no"}`);
    if (!diagnostics.exists) {
      return;
    }
    console.log(`Schema: ${diagnostics.schemaVersion ?? "unknown"}`);
    console.log(`Events: ${diagnostics.eventCount}`);
    console.log(
      `Event streams: ${diagnostics.streams.threadCount} thread(s), max sequence ${diagnostics.streams.maximumSequence}, ${diagnostics.streams.compactedThreadCount} compacted`,
    );
    console.log(
      `Turn lifecycle: ${Object.entries(diagnostics.turnLifecycle)
        .map(([phase, count]) => `${phase}=${count}`)
        .join(", ")}`,
    );
    console.log(`Pending approvals: ${diagnostics.pendingApprovalCount}`);
    console.log(`Owners: ${diagnostics.ownerCount} (${diagnostics.expiredOwnerCount} expired)`);
    console.log(`Active claims: ${diagnostics.activeClaimCount}`);
  });

program
  .command("backup")
  .description("Create consistent SQLite backups of Relay state and paired sessions.")
  .option("-o, --output <directory>", "backup destination directory")
  .action(async (options) => {
    const destination = options.output
      ? resolve(options.output)
      : codexRelayDataPath(`backups/${backupTimestamp()}`);
    const result = await backupRelayDatabases({
      destinationDirectory: destination,
      paths: [relayStateDbPath(), authDbPath()],
    });
    if (result.backedUp.length === 0) {
      console.log("No Relay databases were found.");
      return;
    }
    console.log(`Backup directory: ${result.destinationDirectory}`);
    for (const entry of result.backedUp) {
      console.log(`Backed up ${entry.source} -> ${entry.destination}`);
    }
  });

program
  .command("compact")
  .description("Compact durable events for one thread through an explicit sequence.")
  .argument("<thread-id>", "thread to compact")
  .requiredOption("--through <sequence>", "highest event sequence to remove")
  .action(async (threadId, options) => {
    const throughSequence = positiveInteger(options.through, "--through");
    const store = await createRelayStateStore(relayStateDbPath());
    const result = await store.compactThreadEvents!({ threadId, throughSequence });
    console.log(
      `Compacted ${result.deletedCount} event(s) for ${threadId} through sequence ${result.compactedThroughSequence}; latest sequence ${result.lastSequence}.`,
    );
  });

program
  .command("repair-owner")
  .description("Remove an expired thread owner lease and cancel its stale active claim.")
  .argument("<thread-id>", "thread whose expired owner should be repaired")
  .action(async (threadId) => {
    const store = await createRelayStateStore(relayStateDbPath());
    const result = await store.repairExpiredThreadOwner({ threadId });
    if (result.kind === "not_found") {
      console.log(`Thread ${threadId} has no durable owner.`);
      return;
    }
    if (result.kind === "not_expired") {
      console.error(`Thread ${threadId} owner lease is not expired; no changes were made.`);
      process.exitCode = 1;
      return;
    }
    console.log(
      `Repaired expired owner for ${threadId}; cancelled ${result.cancelledClaimCount} stale claim(s).`,
    );
  });

await program.parseAsync();

async function startBackgroundServer() {
  const logPath = codexRelayDataPath("server.log");
  const debugLogPath = codexRelayDataPath("debug.log");
  const pidPath = codexRelayDataPath("server.pid");
  await mkdir(dirname(logPath), { recursive: true });

  const existingPid = await readRunningRelayPid(pidPath);
  if (existingPid) {
    console.log(`codex-relay is already running in the background (pid ${existingPid}).`);
    console.log(`Logs: ${logPath}`);
    if (process.env.CODEX_RELAY_DEBUG === "1") {
      console.log(`Debug logs: ${debugLogPath}`);
    }
    console.log(`Print the current pairing QR with: ${npxCommand} qr`);
    return;
  }
  await unlink(pidPath).catch(() => undefined);

  const output = openSync(logPath, "a", 0o600);
  const cliPath = fileURLToPath(import.meta.url);
  const child = spawn(process.execPath, [...process.execArgv, cliPath, ...backgroundArgs()], {
    cwd: process.cwd(),
    detached: true,
    env: {
      ...process.env,
      CODEX_RELAY_BACKGROUND: "1",
      CODEX_RELAY_HOME: codexRelayHome(),
      CODEX_RELAY_PID_PATH: pidPath,
    },
    stdio: ["ignore", output, output],
  });
  child.unref();
  closeSync(output);

  const startedPid = await waitForBackgroundPid(child, pidPath);
  if (!startedPid) {
    console.error("codex-relay failed to start in the background.");
    console.error(`Logs: ${logPath}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Started codex-relay in the background (pid ${startedPid}).`);
  console.log(`Logs: ${logPath}`);
  if (process.env.CODEX_RELAY_DEBUG === "1") {
    console.log(`Debug logs: ${debugLogPath}`);
  }
  console.log(`Print the pairing QR later with: ${npxCommand} qr`);
  console.log(`Stop the background relay with: ${npxCommand} stop`);
}

function backgroundArgs() {
  return process.argv.slice(2).filter((arg) => arg !== "--bg");
}

async function waitForBackgroundPid(child: ReturnType<typeof spawn>, pidPath: string) {
  let childExited = false;
  child.once("exit", () => {
    childExited = true;
  });

  for (let attempt = 0; attempt < 50; attempt += 1) {
    const pid = await readRunningRelayPid(pidPath);
    if (pid) {
      return pid;
    }
    if (childExited) {
      return undefined;
    }
    await setTimeout(100);
  }

  return undefined;
}

async function stopBackgroundServer() {
  const result = await stopRunningRelay(codexRelayDataPath("server.pid"));
  printStopResult(result);
}

function printStopResult(result: StopRunningRelayResult) {
  switch (result.kind) {
    case "not-running":
      console.log("No background Codex Relay server is running.");
      return;
    case "stopped":
      console.log(`Stopped codex-relay background server (pid ${result.pid}).`);
      return;
    case "timed-out":
      console.error(`Timed out stopping codex-relay background server (pid ${result.pid}).`);
      process.exitCode = 1;
      return;
    default:
      return assertNever(result);
  }
}

function assertNever(value: never): never {
  throw new TypeError(`Unexpected background stop result: ${JSON.stringify(value)}`);
}

async function approvePairing(rawCode: string | undefined) {
  const approvalCode = normalizeApprovalCode(rawCode ?? "");
  if (!approvalCode) {
    console.error(`Usage: ${npxCommand} approve XXXX-XXXX`);
    process.exitCode = 1;
    return;
  }

  const endpoint = await getApprovalEndpoint();
  const secret = await readApprovalSecret();
  const response = await fetch(`${endpoint}${apiPaths.pairApprove}`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-codex-relay-approve-secret": secret,
    },
    body: JSON.stringify({ approvalCode }),
  });
  const payload = await response.json().catch(() => undefined);

  if (!response.ok) {
    const message =
      payload &&
      typeof payload === "object" &&
      "error" in payload &&
      payload.error &&
      typeof payload.error === "object" &&
      "message" in payload.error
        ? String(payload.error.message)
        : `Codex Relay server returned ${response.status}`;
    console.error(message);
    process.exitCode = 1;
    return;
  }

  console.log("Approved Codex Relay pairing request.");
}

async function clearPairings(options: { clearDebugLog: boolean }) {
  const result = await clearPairingsViaServer().catch(async (error) => {
    if (await hasRunningBackgroundServer()) {
      throw error;
    }
    return clearPairingsFromLocalStore();
  });
  const removedDebugLogs = options.clearDebugLog ? await clearDebugLogs() : [];

  console.log(
    `Signed out ${result.sessionsCleared} paired mobile app${
      result.sessionsCleared === 1 ? "" : "s"
    }.`,
  );
  if (result.pendingPairingsCleared > 0) {
    console.log(
      `Removed ${result.pendingPairingsCleared} pending pairing request${
        result.pendingPairingsCleared === 1 ? "" : "s"
      }.`,
    );
  }
  if (options.clearDebugLog) {
    console.log(
      removedDebugLogs.length > 0
        ? `Deleted debug logs: ${removedDebugLogs.join(", ")}`
        : "No debug logs found.",
    );
  }
}

async function clearPairingsViaServer(): Promise<ClearPairingResult> {
  const endpoint = await getApprovalEndpoint();
  const secret = await readApprovalSecret();
  const response = await fetch(`${endpoint}${apiPaths.sessionsClear}`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "x-codex-relay-approve-secret": secret,
    },
  });
  const payload = await response.json().catch(() => undefined);

  if (!response.ok) {
    const message =
      payload &&
      typeof payload === "object" &&
      "error" in payload &&
      payload.error &&
      typeof payload.error === "object" &&
      "message" in payload.error
        ? String(payload.error.message)
        : `Codex Relay server returned ${response.status}`;
    throw new Error(message);
  }

  return parseClearPairingResult(payload);
}

async function clearPairingsFromLocalStore(): Promise<ClearPairingResult> {
  const dbPath = await resolveAuthDbPath();
  if (!dbPath) {
    return { pendingPairingsCleared: 0, sessionsCleared: 0 };
  }

  const sessions = await createTursoPairingSessionStore(dbPath);
  return sessions.clearAll();
}

async function resolveAuthDbPath() {
  if (process.env.CODEX_RELAY_AUTH_DB_PATH) {
    return process.env.CODEX_RELAY_AUTH_DB_PATH;
  }

  const primary = codexRelayDataPath("auth.db");
  if (await pathExists(primary)) {
    return primary;
  }

  const legacy = legacyCodexRelayDataPath("auth.db");
  if (await pathExists(legacy)) {
    return legacy;
  }

  return undefined;
}

function relayStateDbPath() {
  return process.env.CODEX_RELAY_STATE_DB_PATH ?? codexRelayDataPath("relay-state.db");
}

function authDbPath() {
  return process.env.CODEX_RELAY_AUTH_DB_PATH ?? codexRelayDataPath("auth.db");
}

function backupTimestamp() {
  return new Date().toISOString().replaceAll(":", "-");
}

function positiveInteger(value: string, flag: string) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} must be a positive integer.`);
  }
  return parsed;
}

function boundedPositiveInteger(value: string, flag: string, maximum: number) {
  const parsed = positiveInteger(value, flag);
  if (parsed > maximum) {
    throw new Error(`${flag} must not exceed ${maximum}.`);
  }
  return parsed;
}

function contentSafeServerState(state: ServerState | undefined) {
  if (!state) {
    return undefined;
  }
  return {
    connectUrl: state.connectUrl,
    connectUrlCandidates: state.connectUrlCandidates,
    host: state.host,
    listenUrl: state.listenUrl,
    port: state.port,
    sharedAppServerManaged: state.sharedAppServerManaged,
    sharedAppServerSocketPath: state.sharedAppServerSocketPath,
    tailcat: state.tailcat,
  };
}

function doctorCheck(name: string, ok: boolean, message: string) {
  return { message, name, status: ok ? ("ok" as const) : ("error" as const) };
}

function doctorCompatibilityCheck(
  retirement: Awaited<ReturnType<typeof inspectRelayCompatibility>>["retirement"],
) {
  if (retirement.ready) {
    return {
      message: `no legacy usage during the ${retirement.quietPeriodDays}-day quiet window`,
      name: "compatibility-retirement",
      status: "ok" as const,
    };
  }
  const message = retirement.windowComplete
    ? `${retirement.blockingFeatures.length} legacy feature(s) used after ${retirement.cutoffAt}`
    : `observation window ends ${retirement.windowEndsAt ?? "after schema v9 telemetry starts"}`;
  return {
    message,
    name: "compatibility-retirement",
    status: "warning" as const,
  };
}

function doctorTailcatCheck(tailcat: ServerState["tailcat"]) {
  if (!tailcat || !tailcat.enabled || tailcat.status === "disabled") {
    return {
      message: "optional transport is disabled",
      name: "tailcat",
      status: "ok" as const,
    };
  }
  if (tailcat.status === "healthy") {
    return {
      message: `healthy on Relay port ${tailcat.localTargetPort ?? "unknown"}`,
      name: "tailcat",
      status: "ok" as const,
    };
  }
  return {
    message: `optional transport is ${tailcat.status}; HTTP candidates remain available`,
    name: "tailcat",
    status: "warning" as const,
  };
}

async function clearDebugLogs() {
  const paths = [
    ...new Set([codexRelayDataPath("debug.log"), legacyCodexRelayDataPath("debug.log")]),
  ];
  const removed: string[] = [];
  for (const path of paths) {
    if (!(await pathExists(path))) {
      continue;
    }
    await rm(path, { force: true });
    removed.push(path);
  }
  return removed;
}

async function hasRunningBackgroundServer() {
  return Boolean(await readRunningRelayPid(codexRelayDataPath("server.pid")));
}

async function pathExists(path: string) {
  return access(path).then(
    () => true,
    () => false,
  );
}

function parseClearPairingResult(payload: unknown): ClearPairingResult {
  if (!payload || typeof payload !== "object") {
    return { pendingPairingsCleared: 0, sessionsCleared: 0 };
  }

  return {
    pendingPairingsCleared:
      "pendingPairingsCleared" in payload ? Number(payload.pendingPairingsCleared) || 0 : 0,
    sessionsCleared: "sessionsCleared" in payload ? Number(payload.sessionsCleared) || 0 : 0,
  };
}

async function printPairingQr() {
  const storedState = await readServerState();
  const state = storedState?.pairingPayload ? storedState : await readServerLogState();
  if (!state?.pairingPayload) {
    console.error("No running Codex Relay server state was found.");
    console.error(`Start the server first with: ${npxCommand}`);
    console.error(`Or run it in the background with: ${npxCommand} --bg`);
    process.exitCode = 1;
    return;
  }

  console.log("");
  qrcode.generate(state.pairingPayload, { small: true });
  console.log("");
  if (state.connectUrl) {
    console.log(`Mobile: ${state.connectUrl}`);
    const guidance = getConnectUrlGuidance(state.connectUrl);
    if (guidance) {
      console.log(`Network: ${guidance}`);
    }
  }
  if (state.connectUrlCandidates && state.connectUrlCandidates.length > 1) {
    console.log(`Candidate addresses: ${state.connectUrlCandidates.length}`);
    for (const candidate of state.connectUrlCandidates.slice(1)) {
      console.log(`  ${candidate.label}: ${candidate.url}`);
    }
  }
  if (state.listenUrl) {
    console.log(`Server: ${state.listenUrl}`);
  }
  console.log("");
  console.log(`Pairing: ${state.pairingPayload}`);
  console.log("");
}

async function handleServerStartError(error: unknown) {
  if (!isDatabaseLockError(error)) {
    throw error;
  }

  const pidPath = codexRelayDataPath("server.pid");
  const logPath = codexRelayDataPath("server.log");
  const existingPid = await readRunningRelayPid(pidPath);
  const storedState = await readServerState();
  const state = storedState?.pairingPayload ? storedState : await readServerLogState();

  console.error("Codex Relay is already using its local pairing database.");
  console.error("");
  if (existingPid) {
    console.error(`A background server appears to be running (pid ${existingPid}).`);
    console.error("Use the existing server instead of starting a second one:");
    console.error(`  ${npxCommand} qr`);
    console.error("");
    console.error("To stop the background server:");
    console.error(`  ${npxCommand} stop`);
    console.error("");
    console.error(`Logs: ${logPath}`);
  } else {
    console.error("Another Codex Relay process is already running or exited without cleanup.");
    if (state?.pairingPayload) {
      console.error("Use the existing server instead of starting a second one:");
      console.error(`  ${npxCommand} qr`);
      console.error("");
    }
    console.error("Find it with:");
    console.error(
      `  lsof -nP ${codexRelayDataPath("auth.db")} ${codexRelayDataPath("auth.db-wal")}`,
    );
    console.error("  lsof -nP -iTCP:8787 -sTCP:LISTEN");
    console.error("");
    console.error("Then stop that process with:");
    console.error("  kill -TERM <pid>");
  }
  console.error("");
  console.error("If you wanted a persistent server, start it once with:");
  console.error(`  ${npxCommand} --bg`);
  process.exitCode = 1;
}

async function readApprovalSecret() {
  if (process.env.CODEX_RELAY_APPROVAL_SECRET) {
    return process.env.CODEX_RELAY_APPROVAL_SECRET;
  }

  return (await readRelayDataFile("approval-secret")).trim();
}

async function getApprovalEndpoint() {
  const state = await readServerState();
  const port = process.env.PORT ? Number(process.env.PORT) : (state?.port ?? 8787);
  const host = process.env.HOST ?? state?.host ?? "127.0.0.1";
  const connectHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  return `http://${connectHost}:${port}`;
}

async function readServerState(): Promise<ServerState | undefined> {
  const state = await readRelayDataFile("server-state.json")
    .then(
      (value) =>
        JSON.parse(value) as {
          connectUrl?: unknown;
          connectUrlCandidates?: unknown;
          host?: unknown;
          listenUrl?: unknown;
          pairingPayload?: unknown;
          port?: unknown;
          sharedAppServerManaged?: unknown;
          sharedAppServerSocketPath?: unknown;
          tailcat?: unknown;
        },
    )
    .catch(() => undefined);
  if (!state) {
    return undefined;
  }

  return {
    connectUrl: typeof state.connectUrl === "string" ? state.connectUrl : undefined,
    connectUrlCandidates: parseConnectUrlCandidates(state.connectUrlCandidates),
    host: typeof state.host === "string" ? state.host : undefined,
    listenUrl: typeof state.listenUrl === "string" ? state.listenUrl : undefined,
    pairingPayload: typeof state.pairingPayload === "string" ? state.pairingPayload : undefined,
    port: typeof state.port === "number" ? state.port : undefined,
    sharedAppServerManaged:
      typeof state.sharedAppServerManaged === "boolean" ? state.sharedAppServerManaged : undefined,
    sharedAppServerSocketPath:
      typeof state.sharedAppServerSocketPath === "string"
        ? state.sharedAppServerSocketPath
        : undefined,
    tailcat: parseTailcatServerState(state.tailcat),
  };
}

function parseTailcatServerState(value: unknown): ServerState["tailcat"] {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const state = value as Record<string, unknown>;
  const statuses = new Set(["disabled", "failed", "healthy", "starting", "stopped"]);
  if (typeof state.enabled !== "boolean" || !statuses.has(String(state.status))) {
    return undefined;
  }
  return {
    enabled: state.enabled,
    exitCode: typeof state.exitCode === "number" ? state.exitCode : undefined,
    localTargetPort: typeof state.localTargetPort === "number" ? state.localTargetPort : undefined,
    pid: typeof state.pid === "number" ? state.pid : undefined,
    startedAt: typeof state.startedAt === "string" ? state.startedAt : undefined,
    status: state.status as NonNullable<ServerState["tailcat"]>["status"],
  };
}

async function readServerLogState(): Promise<ServerState | undefined> {
  const log = await readRelayDataFile("server.log").catch(() => undefined);
  if (!log) {
    return undefined;
  }

  const connectUrl = lastLogValue(log, "Mobile");
  const listenUrl = lastLogValue(log, "Server");
  const pairingPayload = lastLogValue(log, "Pairing");
  return pairingPayload ? { connectUrl, listenUrl, pairingPayload } : undefined;
}

async function readRelayDataFile(fileName: string) {
  const primary = await readFile(codexRelayDataPath(fileName), "utf8").catch(() => undefined);
  if (primary !== undefined) {
    return primary;
  }
  return readFile(legacyCodexRelayDataPath(fileName), "utf8");
}

function lastLogValue(log: string, label: string) {
  const pattern = new RegExp(`${label}:\\s*(\\S+)`, "g");
  let value: string | undefined;
  for (const match of log.matchAll(pattern)) {
    value = match[1];
  }
  return value;
}

function parseConnectUrlCandidates(value: unknown) {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value
    .map((candidate) => {
      if (!candidate || typeof candidate !== "object") {
        return undefined;
      }
      const label = "label" in candidate ? candidate.label : undefined;
      const url = "url" in candidate ? candidate.url : undefined;
      return typeof label === "string" && typeof url === "string" ? { label, url } : undefined;
    })
    .filter((candidate): candidate is { label: string; url: string } => Boolean(candidate));
}

function isDatabaseLockError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("failed to open database") && message.includes("Locking error");
}

function normalizeApprovalCode(value: string) {
  const normalized = value
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .replaceAll("O", "0")
    .replaceAll("I", "1");
  return normalized.length === 8 ? `${normalized.slice(0, 4)}-${normalized.slice(4)}` : normalized;
}
