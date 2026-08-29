import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { backupRelayDatabases, inspectRelayState } from "../src/operator-tools.js";
import { createRelayStateStore } from "../src/relay-state-store.js";

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
        schemaVersion: 8,
      });
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
