import { DatabaseSync } from "node:sqlite";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import {
  assessCompatibilityRetirement,
  backupRelayDatabases,
  defaultCompatibilityRetirementQuietPeriodMs,
  inspectRelayCompatibility,
  inspectRelayConnections,
  inspectRelayState,
  listRelayEvents,
  listRelayOwners,
  listRelayWorkspaces,
} from "../src/operator-tools.js";
import { createRelayStateStore } from "../src/relay-state-store.js";

const execFileAsync = promisify(execFile);

describe("relay operator tools", () => {
  it("reports content-safe durable state counts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-relay-diagnostics-"));
    const statePath = join(directory, "relay-state.db");
    try {
      const store = await createRelayStateStore(statePath);
      await store.appendThreadEvent({
        eventId: "event-1",
        threadId: "thread-1",
        event: stateEvent("thread-1"),
      });
      await store.createPendingApproval({
        approvalId: "approval-1",
        kind: "structuredUserInput",
        method: "item/tool/requestUserInput",
        requestId: 1,
        threadId: "thread-1",
      });

      await expect(inspectRelayState(statePath)).resolves.toMatchObject({
        eventCount: 1,
        exists: true,
        path: statePath,
        pendingApprovalCount: 1,
        schemaVersion: 9,
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("reports compatibility usage without exposing stored input payloads", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-relay-compatibility-report-"));
    const statePath = join(directory, "relay-state.db");
    try {
      const store = await createRelayStateStore(statePath);
      await store.recordCompatibilityObservation({
        feature: "legacy.input_without_client_event_id",
        observedAt: "2026-08-31T00:00:00.000Z",
      });
      await store.createThreadInput({
        clientId: "phone",
        payload: { prompt: "must not appear in compatibility output" },
        state: "queued",
        threadId: "thread-safe",
      });
      store.close();

      const report = await inspectRelayCompatibility(statePath, {
        now: Date.parse("2026-08-31T00:01:00.000Z"),
      });
      expect(report.observations).toEqual([
        {
          count: 1,
          feature: "legacy.input_without_client_event_id",
          firstSeenAt: "2026-08-31T00:00:00.000Z",
          lastSeenAt: "2026-08-31T00:00:00.000Z",
        },
      ]);
      expect(JSON.stringify(report)).not.toContain("must not appear");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("requires a complete quiet window with no recent legacy usage before retirement", () => {
    const now = Date.parse("2026-08-31T00:00:00.000Z");
    const olderThanWindow = new Date(
      now - defaultCompatibilityRetirementQuietPeriodMs - 1,
    ).toISOString();
    const recent = new Date(now - 60_000).toISOString();

    expect(
      assessCompatibilityRetirement([], {
        now,
        observationStartedAt: olderThanWindow,
      }),
    ).toMatchObject({ ready: true, blockingFeatures: [], windowComplete: true });
    expect(
      assessCompatibilityRetirement(
        [
          {
            count: 2,
            feature: "legacy.run_stream_prompt",
            firstSeenAt: recent,
            lastSeenAt: recent,
          },
        ],
        { now, observationStartedAt: olderThanWindow },
      ),
    ).toMatchObject({
      ready: false,
      blockingFeatures: ["legacy.run_stream_prompt"],
      windowComplete: true,
    });
    expect(
      assessCompatibilityRetirement([], {
        now,
        observationStartedAt: recent,
      }),
    ).toMatchObject({ ready: false, blockingFeatures: [], windowComplete: false });
  });

  it("prints content-safe compatibility JSON through the CLI", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-relay-compatibility-cli-"));
    const statePath = join(directory, "relay-state.db");
    try {
      const store = await createRelayStateStore(statePath);
      await store.recordCompatibilityObservation({
        feature: "legacy.run_stream_attach",
      });
      await store.createThreadInput({
        clientId: "phone",
        payload: { prompt: "cli must not print this payload" },
        state: "queued",
        threadId: "thread-cli-safe",
      });
      store.close();

      const { stdout } = await execFileAsync(
        process.execPath,
        ["--import", "tsx", "src/cli.ts", "compatibility", "--json"],
        {
          cwd: process.cwd(),
          env: { ...process.env, CODEX_RELAY_STATE_DB_PATH: statePath },
        },
      );

      expect(JSON.parse(stdout)).toMatchObject({
        observations: [{ count: 1, feature: "legacy.run_stream_attach" }],
      });
      expect(stdout).not.toContain("cli must not print this payload");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("filters Tailcat credentials from CLI status output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-relay-tailcat-cli-"));
    try {
      await writeFile(
        join(directory, "server-state.json"),
        JSON.stringify({
          listenUrl: "http://127.0.0.1:8788",
          tailcat: {
            enabled: true,
            keyPath: "/secret/key.private.json",
            localTargetPort: 8788,
            pid: 1234,
            status: "healthy",
            token: "tailcat-token-must-not-print",
          },
        }),
      );

      const { stdout } = await execFileAsync(
        process.execPath,
        ["--import", "tsx", "src/cli.ts", "status", "--json"],
        {
          cwd: process.cwd(),
          env: { ...process.env, CODEX_RELAY_HOME: directory },
        },
      );

      expect(JSON.parse(stdout)).toMatchObject({
        server: { tailcat: { enabled: true, localTargetPort: 8788, status: "healthy" } },
      });
      expect(stdout).not.toContain("tailcat-token-must-not-print");
      expect(stdout).not.toContain("/secret/key.private.json");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("creates consistent online backups for each existing database", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-relay-backup-"));
    const source = join(directory, "relay-state.db");
    const destinationDirectory = join(directory, "backup");
    try {
      const database = new DatabaseSync(source);
      database.exec("CREATE TABLE sample (value TEXT); INSERT INTO sample VALUES ('safe');");
      database.close();

      const result = await backupRelayDatabases({ destinationDirectory, paths: [source] });
      const backupDatabase = new DatabaseSync(join(destinationDirectory, "relay-state.db"), {
        readOnly: true,
      });
      const row = backupDatabase.prepare("SELECT value FROM sample").get() as { value: string };
      backupDatabase.close();

      expect(result.backedUp).toHaveLength(1);
      expect(row.value).toBe("safe");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("lists content-safe workspaces, owners, claims, and event metadata", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-relay-operator-list-"));
    const statePath = join(directory, "relay-state.db");
    try {
      const store = await createRelayStateStore(statePath);
      const workspacePath = join(directory, "workspace");
      const workspace = await store.registerWorkspace({
        path: workspacePath,
        source: "operator",
      });
      await store.appendThreadEvent({
        eventId: "event-safe",
        event: stateEvent("thread-safe"),
        threadId: "thread-safe",
        workspaceId: workspace.workspaceId,
      });
      await store.createThreadInput({
        clientId: "phone",
        inputId: "input-safe",
        payload: { prompt: "must not be exposed" },
        state: "queued",
        threadId: "thread-safe",
        workspaceId: workspace.workspaceId,
      });
      const owner = await store.acquireThreadOwner({
        capabilities: {
          approve: true,
          configure: true,
          interrupt: true,
          queue: true,
          send: true,
          steer: true,
          view: true,
        },
        ownerId: "owner-safe",
        ownerInstanceId: "process-safe",
        ownerType: "shared_app_server",
        threadId: "thread-safe",
        workspaceId: workspace.workspaceId,
      });
      await store.acquireTurnClaim({
        inputId: "input-safe",
        ownerEpoch: owner.epoch,
        ownerId: owner.ownerId,
        threadId: "thread-safe",
      });

      await expect(listRelayWorkspaces(statePath)).resolves.toContainEqual(
        expect.objectContaining({
          canonicalPath: workspacePath,
          workspaceId: workspace.workspaceId,
        }),
      );
      await expect(listRelayOwners(statePath)).resolves.toContainEqual(
        expect.objectContaining({
          activeClaimId: expect.any(String),
          ownerId: "owner-safe",
          threadId: "thread-safe",
        }),
      );
      await expect(listRelayEvents(statePath, "thread-safe")).resolves.toEqual([
        expect.objectContaining({
          eventId: "event-safe",
          eventType: "thread.state.changed",
          sequence: 1,
        }),
      ]);
      expect(JSON.stringify(await listRelayEvents(statePath, "thread-safe"))).not.toContain(
        "must not be exposed",
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("reports paired-device counts without exposing session credentials", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-relay-connections-"));
    const authPath = join(directory, "auth.db");
    try {
      const database = new DatabaseSync(authPath);
      database.exec(`
        CREATE TABLE pairing_sessions (
          token_hash TEXT PRIMARY KEY,
          client_session_id TEXT
        );
        CREATE TABLE pending_pairings (
          approval_code TEXT PRIMARY KEY,
          expires_at INTEGER NOT NULL
        );
        CREATE TABLE push_notification_subscriptions (
          client_session_id TEXT PRIMARY KEY
        );
        INSERT INTO pairing_sessions VALUES ('secret-token', 'phone-1');
        INSERT INTO pending_pairings VALUES ('secret-code', ${Date.now() + 60_000});
        INSERT INTO push_notification_subscriptions VALUES ('phone-1');
      `);
      database.close();

      const result = await inspectRelayConnections(authPath);
      expect(result).toMatchObject({
        activeClientCount: 1,
        pendingPairingCount: 1,
        pushSubscriptionCount: 1,
      });
      expect(JSON.stringify(result)).not.toContain("secret-token");
      expect(JSON.stringify(result)).not.toContain("secret-code");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});

function stateEvent(threadId: string) {
  const timestamp = new Date().toISOString();
  return {
    type: "thread.state.changed" as const,
    thread: {
      id: threadId,
      title: "Thread",
      createdAt: timestamp,
      updatedAt: timestamp,
      state: "running" as const,
      messageCount: 0,
    },
  };
}
