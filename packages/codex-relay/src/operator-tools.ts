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

export type RelayWorkspaceInspection = {
  canonicalPath: string;
  displayName: string;
  lastSeenAt: string;
  registrationSource: string;
  state: string;
  workspaceId: string;
};

export type RelayOwnerInspection = {
  activeClaimId?: string;
  activeClaimState?: string;
  epoch: number;
  expired: boolean;
  leaseExpiresAt?: string;
  ownerId: string;
  ownerInstanceId: string;
  ownerType: string;
  runtimeTurnId?: string;
  threadId: string;
  updatedAt: string;
  workspaceId?: string;
};

export type RelayEventInspection = {
  createdAt: string;
  eventId: string;
  eventType: string;
  sequence: number;
  threadId: string;
  workspaceId?: string;
};

export type RelayConnectionDiagnostics = {
  activeClientCount: number;
  exists: boolean;
  path: string;
  pendingPairingCount: number;
  pushSubscriptionCount: number;
};

export type RelayCompatibilityObservationInspection = {
  count: number;
  feature: string;
  firstSeenAt: string;
  lastSeenAt: string;
};

export type CompatibilityRetirementAssessment = {
  blockingFeatures: string[];
  cutoffAt: string;
  observationStartedAt?: string;
  quietPeriodDays: number;
  ready: boolean;
  windowComplete: boolean;
  windowEndsAt?: string;
};

export type RelayCompatibilityDiagnostics = {
  exists: boolean;
  observations: RelayCompatibilityObservationInspection[];
  path: string;
  retirement: CompatibilityRetirementAssessment;
};

export const defaultCompatibilityRetirementQuietPeriodMs = 30 * 24 * 60 * 60 * 1000;

export function assessCompatibilityRetirement(
  observations: RelayCompatibilityObservationInspection[],
  options: {
    now?: number;
    observationStartedAt?: string;
    quietPeriodMs?: number;
  } = {},
): CompatibilityRetirementAssessment {
  const now = options.now ?? Date.now();
  const quietPeriodMs = options.quietPeriodMs ?? defaultCompatibilityRetirementQuietPeriodMs;
  if (!Number.isFinite(now)) {
    throw new TypeError("now must be a finite timestamp.");
  }
  if (!Number.isFinite(quietPeriodMs) || quietPeriodMs <= 0) {
    throw new TypeError("quietPeriodMs must be positive.");
  }
  const cutoff = now - quietPeriodMs;
  const observationStartedAtMs = options.observationStartedAt
    ? Date.parse(options.observationStartedAt)
    : Number.NaN;
  const windowComplete =
    Number.isFinite(observationStartedAtMs) && observationStartedAtMs <= cutoff;
  const blockingFeatures = observations
    .filter(
      (observation) =>
        observation.feature.startsWith("legacy.") &&
        (!Number.isFinite(Date.parse(observation.lastSeenAt)) ||
          Date.parse(observation.lastSeenAt) > cutoff),
    )
    .map((observation) => observation.feature)
    .sort();
  return {
    blockingFeatures,
    cutoffAt: new Date(cutoff).toISOString(),
    observationStartedAt: options.observationStartedAt,
    quietPeriodDays: quietPeriodMs / (24 * 60 * 60 * 1000),
    ready: windowComplete && blockingFeatures.length === 0,
    windowComplete,
    windowEndsAt: Number.isFinite(observationStartedAtMs)
      ? new Date(observationStartedAtMs + quietPeriodMs).toISOString()
      : undefined,
  };
}

export async function inspectRelayCompatibility(
  path: string,
  options: { now?: number; quietPeriodMs?: number } = {},
): Promise<RelayCompatibilityDiagnostics> {
  const resolvedPath = resolve(path);
  if (!(await pathExists(resolvedPath))) {
    return {
      exists: false,
      observations: [],
      path: resolvedPath,
      retirement: assessCompatibilityRetirement([], options),
    };
  }
  const database = new DatabaseSync(resolvedPath, { readOnly: true });
  try {
    const observations = tableExists(database, "compatibility_observations")
      ? database
          .prepare(
            `SELECT feature,
                    observation_count AS observationCount,
                    first_seen_at AS firstSeenAt,
                    last_seen_at AS lastSeenAt
               FROM compatibility_observations
              ORDER BY last_seen_at DESC, feature ASC`,
          )
          .all()
          .map((row) => ({
            count: Number(row.observationCount),
            feature: String(row.feature),
            firstSeenAt: isoTimestamp(row.firstSeenAt),
            lastSeenAt: isoTimestamp(row.lastSeenAt),
          }))
      : [];
    const observationStartedAt = compatibilityObservationStartedAt(database);
    return {
      exists: true,
      observations,
      path: resolvedPath,
      retirement: assessCompatibilityRetirement(observations, {
        ...options,
        observationStartedAt,
      }),
    };
  } finally {
    database.close();
  }
}

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

export async function inspectRelayConnections(
  path: string,
  now = Date.now(),
): Promise<RelayConnectionDiagnostics> {
  const resolvedPath = resolve(path);
  if (!(await pathExists(resolvedPath))) {
    return {
      activeClientCount: 0,
      exists: false,
      path: resolvedPath,
      pendingPairingCount: 0,
      pushSubscriptionCount: 0,
    };
  }
  const database = new DatabaseSync(resolvedPath, { readOnly: true });
  try {
    return {
      activeClientCount: countDistinctClients(database),
      exists: true,
      path: resolvedPath,
      pendingPairingCount: countRows(database, "pending_pairings", "expires_at > ?", now),
      pushSubscriptionCount: countRows(database, "push_notification_subscriptions"),
    };
  } finally {
    database.close();
  }
}

export async function listRelayWorkspaces(path: string): Promise<RelayWorkspaceInspection[]> {
  return withRelayStateDatabase(path, (database) => {
    if (!tableExists(database, "workspaces")) {
      return [];
    }
    return database
      .prepare(
        `SELECT workspace_id AS workspaceId,
                canonical_path AS canonicalPath,
                display_name AS displayName,
                state,
                registration_source AS registrationSource,
                last_seen_at AS lastSeenAt
           FROM workspaces
          ORDER BY last_seen_at DESC, workspace_id ASC`,
      )
      .all()
      .map((row) => ({
        canonicalPath: String(row.canonicalPath),
        displayName: String(row.displayName),
        lastSeenAt: isoTimestamp(row.lastSeenAt),
        registrationSource: String(row.registrationSource),
        state: String(row.state),
        workspaceId: String(row.workspaceId),
      }));
  });
}

export async function listRelayOwners(
  path: string,
  now = Date.now(),
): Promise<RelayOwnerInspection[]> {
  return withRelayStateDatabase(path, (database) => {
    if (!tableExists(database, "thread_owners")) {
      return [];
    }
    return database
      .prepare(
        `SELECT owners.thread_id AS threadId,
                owners.workspace_id AS workspaceId,
                owners.owner_id AS ownerId,
                owners.owner_instance_id AS ownerInstanceId,
                owners.owner_type AS ownerType,
                owners.epoch,
                owners.lease_expires_at AS leaseExpiresAt,
                owners.updated_at AS updatedAt,
                claims.claim_id AS activeClaimId,
                claims.runtime_turn_id AS runtimeTurnId,
                claims.state AS activeClaimState
           FROM thread_owners AS owners
           LEFT JOIN turn_claims AS claims
             ON claims.thread_id = owners.thread_id AND claims.state = 'active'
          ORDER BY owners.updated_at DESC, owners.thread_id ASC`,
      )
      .all()
      .map((row) => {
        const leaseExpiresAt = optionalNumber(row.leaseExpiresAt);
        return {
          activeClaimId: optionalString(row.activeClaimId),
          activeClaimState: optionalString(row.activeClaimState),
          epoch: Number(row.epoch),
          expired: leaseExpiresAt !== undefined && leaseExpiresAt <= now,
          leaseExpiresAt: leaseExpiresAt === undefined ? undefined : isoTimestamp(leaseExpiresAt),
          ownerId: String(row.ownerId),
          ownerInstanceId: String(row.ownerInstanceId),
          ownerType: String(row.ownerType),
          runtimeTurnId: optionalString(row.runtimeTurnId),
          threadId: String(row.threadId),
          updatedAt: isoTimestamp(row.updatedAt),
          workspaceId: optionalString(row.workspaceId),
        };
      });
  });
}

export async function listRelayEvents(
  path: string,
  threadId: string,
  limit = 50,
): Promise<RelayEventInspection[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new TypeError("limit must be an integer from 1 through 500.");
  }
  return withRelayStateDatabase(path, (database) => {
    if (!tableExists(database, "thread_events")) {
      return [];
    }
    return database
      .prepare(
        `SELECT event_id AS eventId,
                thread_id AS threadId,
                workspace_id AS workspaceId,
                sequence,
                event_type AS eventType,
                created_at AS createdAt
           FROM thread_events
          WHERE thread_id = ?
          ORDER BY sequence DESC
          LIMIT ?`,
      )
      .all(threadId, limit)
      .map((row) => ({
        createdAt: isoTimestamp(row.createdAt),
        eventId: String(row.eventId),
        eventType: String(row.eventType),
        sequence: Number(row.sequence),
        threadId: String(row.threadId),
        workspaceId: optionalString(row.workspaceId),
      }))
      .reverse();
  });
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

function countDistinctClients(database: DatabaseSync) {
  if (!tableExists(database, "pairing_sessions")) {
    return 0;
  }
  const row = database
    .prepare(
      "SELECT COUNT(DISTINCT COALESCE(client_session_id, token_hash)) AS count FROM pairing_sessions",
    )
    .get() as { count?: number } | undefined;
  return Number(row?.count ?? 0);
}

async function withRelayStateDatabase<T>(path: string, read: (database: DatabaseSync) => T) {
  const resolvedPath = resolve(path);
  if (!(await pathExists(resolvedPath))) {
    return [] as T;
  }
  const database = new DatabaseSync(resolvedPath, { readOnly: true });
  try {
    return read(database);
  } finally {
    database.close();
  }
}

function isoTimestamp(value: unknown) {
  return new Date(Number(value)).toISOString();
}

function optionalNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalString(value: unknown) {
  return typeof value === "string" && value ? value : undefined;
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

function compatibilityObservationStartedAt(database: DatabaseSync) {
  if (!tableExists(database, "relay_state_schema")) {
    return undefined;
  }
  const row = database
    .prepare("SELECT applied_at AS appliedAt FROM relay_state_schema WHERE version = 9")
    .get() as { appliedAt?: number } | undefined;
  return typeof row?.appliedAt === "number" ? isoTimestamp(row.appliedAt) : undefined;
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
