import { access, mkdir } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { DatabaseSync, backup } from "node:sqlite";

export type RelayStateDiagnostics = {
  activeClaimCount: number;
  eventCount: number;
  exists: boolean;
  expiredOwnerCount: number;
  ownerCount: number;
  path: string;
  pendingApprovalCount: number;
  schemaVersion?: number;
};

export async function inspectRelayState(path: string): Promise<RelayStateDiagnostics> {
  const resolvedPath = resolve(path);
  if (!(await pathExists(resolvedPath))) {
    return {
      activeClaimCount: 0,
      eventCount: 0,
      exists: false,
      expiredOwnerCount: 0,
      ownerCount: 0,
      path: resolvedPath,
      pendingApprovalCount: 0,
    };
  }

  const database = new DatabaseSync(resolvedPath, { readOnly: true });
  try {
    return {
      activeClaimCount: countRows(database, "turn_claims", "state = 'active'"),
      eventCount: countRows(database, "thread_events"),
      exists: true,
      expiredOwnerCount: countRows(
        database,
        "thread_owners",
        "lease_expires_at IS NOT NULL AND lease_expires_at <= ?",
        Date.now(),
      ),
      ownerCount: countRows(database, "thread_owners"),
      path: resolvedPath,
      pendingApprovalCount: countRows(database, "pending_approvals", "state = 'pending'"),
      schemaVersion: maximumSchemaVersion(database),
    };
  } finally {
    database.close();
  }
}

export async function backupRelayDatabases(input: {
  destinationDirectory: string;
  paths: string[];
}) {
  const destinationDirectory = resolve(input.destinationDirectory);
  await mkdir(destinationDirectory, { recursive: true, mode: 0o700 });
  const backedUp: Array<{ destination: string; source: string }> = [];
  for (const sourcePath of input.paths) {
    const source = resolve(sourcePath);
    if (!(await pathExists(source))) {
      continue;
    }
    const destination = resolve(destinationDirectory, basename(source));
    const database = new DatabaseSync(source, { readOnly: true });
    try {
      await backup(database, destination);
    } finally {
      database.close();
    }
    backedUp.push({ destination, source });
  }
  return { backedUp, destinationDirectory };
}

function countRows(
  database: DatabaseSync,
  table: string,
  where?: string,
  ...parameters: Array<number | string>
) {
  if (!tableExists(database, table)) {
    return 0;
  }
  const row = database
    .prepare(`SELECT COUNT(*) AS count FROM ${table}${where ? ` WHERE ${where}` : ""}`)
    .get(...parameters) as { count?: number } | undefined;
  return Number(row?.count ?? 0);
}

function maximumSchemaVersion(database: DatabaseSync) {
  if (!tableExists(database, "relay_state_schema")) {
    return undefined;
  }
  const row = database.prepare("SELECT MAX(version) AS version FROM relay_state_schema").get() as
    | { version?: number }
    | undefined;
  return typeof row?.version === "number" ? row.version : undefined;
}

function tableExists(database: DatabaseSync, table: string) {
  return Boolean(
    database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
  );
}

function pathExists(path: string) {
  return access(path).then(
    () => true,
    () => false,
  );
}
