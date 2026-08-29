import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";

import {
  StreamThreadRunEventSchema,
  ThreadEventSchema,
  type StreamThreadRunEvent,
  type ThreadEvent,
} from "./api-schema.js";
import { connect } from "./libsql-database.js";

type QueryableRelayStateDatabase = Pick<ReturnType<typeof connect>, "prepare">;

export type AppendThreadEventInput = {
  createdAt?: string;
  event: StreamThreadRunEvent;
  eventId?: string;
  threadId: string;
  workspaceId?: string;
};

export type ListThreadEventsInput = {
  afterSequence?: number;
  limit?: number;
  threadId: string;
};

export type ListThreadEventsResult = {
  events: ThreadEvent[];
  hasMore: boolean;
  lastSequence: number;
  resetRequired?: boolean;
};

export type ThreadEventStore = {
  appendThreadEvent(input: AppendThreadEventInput): Promise<ThreadEvent>;
  compactThreadEvents?(input: {
    throughSequence: number;
    threadId: string;
  }): Promise<{ compactedThroughSequence: number; deletedCount: number; lastSequence: number }>;
  listThreadEvents(input: ListThreadEventsInput): Promise<ListThreadEventsResult>;
};

export const threadInputStates = [
  "created",
  "persisted",
  "dispatched",
  "accepted",
  "queued",
  "steered",
  "running",
  "completed",
  "failed",
  "rejected",
  "cancelled",
] as const;

export type ThreadInputState = (typeof threadInputStates)[number];

export type ThreadInput = {
  clientEventId?: string;
  clientId: string;
  createdAt: string;
  inputId: string;
  payload: unknown;
  result?: unknown;
  state: ThreadInputState;
  threadId: string;
  updatedAt: string;
  workspaceId?: string;
};

export type CreateThreadInputInput = {
  clientEventId?: string;
  clientId: string;
  createdAt?: string;
  inputId?: string;
  payload: unknown;
  result?: unknown;
  state: ThreadInputState;
  threadId: string;
  workspaceId?: string;
};

export type ListThreadInputsInput = {
  states?: ThreadInputState[];
  threadId?: string;
};

export type ThreadInputStore = {
  createThreadInput(
    input: CreateThreadInputInput,
  ): Promise<{ created: boolean; input: ThreadInput }>;
  getThreadInputByClientEvent(
    clientId: string,
    clientEventId: string,
  ): Promise<ThreadInput | undefined>;
  listThreadInputs(input?: ListThreadInputsInput): Promise<ThreadInput[]>;
  updateThreadInputState(
    inputId: string,
    state: ThreadInputState,
  ): Promise<ThreadInput | undefined>;
};

export const pendingApprovalKinds = [
  "commandExecution",
  "fileChange",
  "permissions",
  "structuredUserInput",
  "mcpElicitation",
] as const;

export type PendingApprovalKind = (typeof pendingApprovalKinds)[number];

export type DurablePendingApproval = {
  approvalId: string;
  createdAt: string;
  kind: PendingApprovalKind;
  message?: Record<string, unknown>;
  messageId?: string;
  method: string;
  questions?: Array<{
    header?: string;
    id: string;
    options?: Array<{ description?: string; label: string }>;
    question: string;
  }>;
  requestId: number | string;
  threadId: string;
  turnId?: string;
  updatedAt: string;
};

export type PendingApprovalStore = {
  createPendingApproval(
    approval: Omit<DurablePendingApproval, "createdAt" | "updatedAt">,
  ): Promise<DurablePendingApproval>;
  listPendingApprovals(): Promise<DurablePendingApproval[]>;
  resolvePendingApproval(approvalId: string): Promise<boolean>;
};

export const threadOwnerTypes = [
  "relay_app_server",
  "shared_app_server",
  "desktop_bridge",
  "external_cli",
] as const;

export type ThreadOwnerType = (typeof threadOwnerTypes)[number];

export type ThreadOwnerCapabilities = {
  approve: boolean;
  configure: boolean;
  interrupt: boolean;
  queue: boolean;
  send: boolean;
  steer: boolean;
  view: boolean;
};

export type ThreadOwner = {
  capabilities: ThreadOwnerCapabilities;
  epoch: number;
  leaseExpiresAt?: string;
  ownerId: string;
  ownerInstanceId: string;
  ownerType: ThreadOwnerType;
  threadId: string;
  updatedAt: string;
  workspaceId?: string;
};

export type AcquireThreadOwnerInput = {
  capabilities: ThreadOwnerCapabilities;
  leaseExpiresAt?: string;
  ownerId: string;
  ownerInstanceId: string;
  ownerType: ThreadOwnerType;
  threadId: string;
  workspaceId?: string;
};

export const turnClaimStates = ["active", "completed", "failed", "cancelled"] as const;

export type TurnClaimState = (typeof turnClaimStates)[number];
export type TerminalTurnClaimState = Exclude<TurnClaimState, "active">;

export type TurnClaim = {
  claimId: string;
  createdAt: string;
  dispatchStartedAt?: string;
  inputId: string;
  ownerEpoch: number;
  ownerId: string;
  runtimeTurnId?: string;
  state: TurnClaimState;
  terminalAt?: string;
  threadId: string;
  updatedAt: string;
};

export type AcquireTurnClaimInput = {
  claimId?: string;
  inputId: string;
  ownerEpoch: number;
  ownerId: string;
  threadId: string;
};

export type TurnClaimAcquisitionResult =
  | { claim: TurnClaim; input: ThreadInput; kind: "acquired" }
  | { claim: TurnClaim; input: ThreadInput; kind: "existing" }
  | { claim: TurnClaim; kind: "busy" }
  | { input?: ThreadInput; kind: "input_unavailable" }
  | { kind: "no_input" }
  | { kind: "stale_owner"; owner?: ThreadOwner };

export type FinalizeTurnClaimInput = {
  claimId: string;
  ownerEpoch: number;
  ownerId: string;
  state: TerminalTurnClaimState;
};

export type FinalizeTurnClaimResult =
  | { claim: TurnClaim; input?: ThreadInput; kind: "updated" }
  | { claim: TurnClaim; input?: ThreadInput; kind: "already_terminal" }
  | { kind: "stale_claim" }
  | { kind: "stale_owner"; owner?: ThreadOwner };

export type RemapActiveTurnClaimInput = {
  claimId: string;
  fromOwnerEpoch: number;
  fromOwnerId: string;
  ownerEpoch: number;
  ownerId: string;
  threadId: string;
  workspaceId?: string;
};

export type RemapActiveTurnClaimResult =
  | { claim: TurnClaim; input: ThreadInput; kind: "updated" }
  | { claim: TurnClaim; kind: "busy" }
  | { kind: "stale_claim" }
  | { kind: "stale_owner"; owner?: ThreadOwner };

export type BindTurnClaimRuntimeTurnInput = {
  claimId: string;
  ownerEpoch: number;
  ownerId: string;
  runtimeTurnId: string;
};

export type BindTurnClaimRuntimeTurnResult =
  | { claim: TurnClaim; kind: "updated" | "already_bound" | "conflict" }
  | { kind: "stale_claim" }
  | { kind: "stale_owner"; owner?: ThreadOwner };

export type MarkTurnClaimDispatchResult =
  | { claim: TurnClaim; kind: "updated" | "already_marked" }
  | { kind: "stale_claim" }
  | { kind: "stale_owner"; owner?: ThreadOwner };

export type AdoptActiveTurnClaimInput = AcquireThreadOwnerInput & {
  claimId: string;
  runtimeTurnId: string;
};

export type AdoptActiveTurnClaimResult =
  | {
      claim: TurnClaim;
      input: ThreadInput;
      kind: "adopted" | "already_owned";
      owner: ThreadOwner;
    }
  | { kind: "runtime_mismatch" | "runtime_unknown" | "stale_claim" }
  | { kind: "stale_owner"; owner?: ThreadOwner };

export type ThreadCoordinatorStore = {
  adoptActiveTurnClaim(input: AdoptActiveTurnClaimInput): Promise<AdoptActiveTurnClaimResult>;
  acquireThreadOwner(input: AcquireThreadOwnerInput): Promise<ThreadOwner>;
  acquireTurnClaim(input: AcquireTurnClaimInput): Promise<TurnClaimAcquisitionResult>;
  bindTurnClaimRuntimeTurn(
    input: BindTurnClaimRuntimeTurnInput,
  ): Promise<BindTurnClaimRuntimeTurnResult>;
  claimNextThreadInput(input: {
    claimId?: string;
    ownerEpoch: number;
    ownerId: string;
    threadId: string;
  }): Promise<TurnClaimAcquisitionResult>;
  finalizeTurnClaim(input: FinalizeTurnClaimInput): Promise<FinalizeTurnClaimResult>;
  getActiveTurnClaim(threadId: string): Promise<TurnClaim | undefined>;
  getThreadOwner(threadId: string): Promise<ThreadOwner | undefined>;
  listActiveTurnClaims(): Promise<TurnClaim[]>;
  markTurnClaimDispatch(input: {
    claimId: string;
    ownerEpoch: number;
    ownerId: string;
  }): Promise<MarkTurnClaimDispatchResult>;
  repairExpiredThreadOwner(input: {
    now?: string;
    threadId: string;
  }): Promise<
    | { kind: "not_found" }
    | { kind: "not_expired"; owner: ThreadOwner }
    | { cancelledClaimCount: number; kind: "repaired"; owner: ThreadOwner }
  >;
  remapActiveTurnClaim(input: RemapActiveTurnClaimInput): Promise<RemapActiveTurnClaimResult>;
};

export type WorkspaceRegistrationSource = "relay_startup" | "thread_cwd" | "operator";

export type WorkspaceState = "available" | "missing" | "unauthorized";

export type Workspace = {
  canonicalPath: string;
  createdAt: string;
  displayName: string;
  lastSeenAt: string;
  repositoryIdentity?: string;
  state: WorkspaceState;
  workspaceId: string;
};

export type RegisterWorkspaceInput = {
  displayName?: string;
  path: string;
  repositoryIdentity?: string;
  source: WorkspaceRegistrationSource;
};

export type AddWorkspaceAliasInput = {
  path: string;
  source: WorkspaceRegistrationSource;
  workspaceId: string;
};

export type WorkspaceRegistry = {
  addWorkspaceAlias(input: AddWorkspaceAliasInput): Promise<void>;
  listWorkspaces(): Promise<Workspace[]>;
  registerWorkspace(input: RegisterWorkspaceInput): Promise<Workspace>;
  resolveWorkspace(path: string): Promise<Workspace | undefined>;
  resolveWorkspaceById(workspaceId: string): Promise<Workspace | undefined>;
};

export type RelayStateStore = ThreadCoordinatorStore &
  ThreadEventStore &
  ThreadInputStore &
  PendingApprovalStore &
  WorkspaceRegistry;

const currentSchemaVersion = 7;
const defaultPageLimit = 200;
const maximumPageLimit = 500;

export async function createRelayStateStore(path: string): Promise<RelayStateStore> {
  if (path !== ":memory:") {
    await mkdir(dirname(path), { recursive: true });
  }

  const database = connect(path);
  const runWrite = createWriteQueue();
  await database.exec(`
    CREATE TABLE IF NOT EXISTS relay_state_schema (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS thread_event_sequences (
      thread_id TEXT PRIMARY KEY,
      next_sequence INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS thread_events (
      event_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      workspace_id TEXT,
      sequence INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(thread_id, sequence)
    );

    CREATE INDEX IF NOT EXISTS thread_events_thread_sequence_idx
      ON thread_events(thread_id, sequence);

    CREATE TABLE IF NOT EXISTS thread_event_compaction (
      thread_id TEXT PRIMARY KEY,
      compacted_through_sequence INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workspaces (
      workspace_id TEXT PRIMARY KEY,
      canonical_path TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      repository_identity TEXT,
      state TEXT NOT NULL,
      registration_source TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workspace_path_aliases (
      alias_path TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      registration_source TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(workspace_id)
    );

    CREATE INDEX IF NOT EXISTS workspace_path_aliases_workspace_idx
      ON workspace_path_aliases(workspace_id);

    CREATE TABLE IF NOT EXISTS thread_inputs (
      input_id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      client_event_id TEXT,
      thread_id TEXT NOT NULL,
      workspace_id TEXT,
      payload_json TEXT NOT NULL,
      result_json TEXT,
      state TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(client_id, client_event_id)
    );

    CREATE INDEX IF NOT EXISTS thread_inputs_thread_state_created_idx
      ON thread_inputs(thread_id, state, created_at, input_id);

    CREATE TABLE IF NOT EXISTS pending_approvals (
      approval_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      turn_id TEXT,
      request_id INTEGER NOT NULL,
      method TEXT NOT NULL,
      kind TEXT NOT NULL,
      message_id TEXT,
      message_json TEXT,
      questions_json TEXT,
      state TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS pending_approvals_state_created_idx
      ON pending_approvals(state, created_at, approval_id);

    CREATE TABLE IF NOT EXISTS thread_owners (
      thread_id TEXT PRIMARY KEY,
      workspace_id TEXT,
      owner_id TEXT NOT NULL,
      owner_instance_id TEXT NOT NULL,
      owner_type TEXT NOT NULL,
      epoch INTEGER NOT NULL,
      lease_expires_at INTEGER,
      capabilities_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS turn_claims (
      claim_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      input_id TEXT NOT NULL UNIQUE,
      owner_id TEXT NOT NULL,
      owner_epoch INTEGER NOT NULL,
      runtime_turn_id TEXT,
      dispatch_started_at INTEGER,
      state TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      terminal_at INTEGER,
      FOREIGN KEY(input_id) REFERENCES thread_inputs(input_id)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS turn_claims_one_active_per_thread_idx
      ON turn_claims(thread_id)
      WHERE state = 'active';

    CREATE INDEX IF NOT EXISTS turn_claims_thread_created_idx
      ON turn_claims(thread_id, created_at, claim_id);
  `);
  const turnClaimColumns = await database.prepare("PRAGMA table_info(turn_claims)").all();
  if (!turnClaimColumns.some((column) => String(column.name) === "runtime_turn_id")) {
    try {
      await database.exec("ALTER TABLE turn_claims ADD COLUMN runtime_turn_id TEXT");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/duplicate column name/i.test(message)) {
        throw error;
      }
    }
  }
  if (!turnClaimColumns.some((column) => String(column.name) === "dispatch_started_at")) {
    try {
      await database.exec("ALTER TABLE turn_claims ADD COLUMN dispatch_started_at INTEGER");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/duplicate column name/i.test(message)) {
        throw error;
      }
    }
  }
  await database.exec(`
    CREATE INDEX IF NOT EXISTS turn_claims_runtime_turn_idx
      ON turn_claims(runtime_turn_id)
      WHERE runtime_turn_id IS NOT NULL;
  `);
  await database
    .prepare("INSERT OR IGNORE INTO relay_state_schema (version, applied_at) VALUES (?, ?)")
    .run(currentSchemaVersion, Date.now());

  return {
    async compactThreadEvents(input) {
      const throughSequence = normalizeNonnegativeInteger(input.throughSequence, "throughSequence");
      const now = Date.now();
      return runWrite(
        database.transaction(async (transaction) => {
          const sequenceRow = await transaction
            .prepare(
              "SELECT next_sequence AS nextSequence FROM thread_event_sequences WHERE thread_id = ?",
            )
            .get(input.threadId);
          const lastSequence = Math.max(0, Number(sequenceRow?.nextSequence ?? 1) - 1);
          const compactedThroughSequence = Math.min(throughSequence, lastSequence);
          const currentRow = await transaction
            .prepare(
              "SELECT compacted_through_sequence AS compactedThroughSequence FROM thread_event_compaction WHERE thread_id = ?",
            )
            .get(input.threadId);
          const currentThroughSequence = Number(currentRow?.compactedThroughSequence ?? 0);
          if (compactedThroughSequence <= currentThroughSequence) {
            return {
              compactedThroughSequence: currentThroughSequence,
              deletedCount: 0,
              lastSequence,
            };
          }
          const deleted = await transaction
            .prepare("DELETE FROM thread_events WHERE thread_id = ? AND sequence <= ?")
            .run(input.threadId, compactedThroughSequence);
          await transaction
            .prepare(
              `INSERT INTO thread_event_compaction (
                 thread_id, compacted_through_sequence, updated_at
               ) VALUES (?, ?, ?)
               ON CONFLICT(thread_id) DO UPDATE SET
                 compacted_through_sequence = excluded.compacted_through_sequence,
                 updated_at = excluded.updated_at`,
            )
            .run(input.threadId, compactedThroughSequence, now);
          return {
            compactedThroughSequence,
            deletedCount: Number(deleted.rowsAffected ?? 0),
            lastSequence,
          };
        }),
      );
    },
    async adoptActiveTurnClaim(input) {
      const now = Date.now();
      const leaseExpiresAt = input.leaseExpiresAt
        ? parseTimestamp(input.leaseExpiresAt, "thread owner lease")
        : null;
      return runWrite(
        database.transaction(async (transaction) => {
          const claimRow = await transaction
            .prepare(turnClaimSelectSql("WHERE claim_id = ?"))
            .get(input.claimId);
          if (!claimRow) {
            return { kind: "stale_claim" as const };
          }
          const claim = turnClaimFromRow(claimRow);
          if (claim.state !== "active" || claim.threadId !== input.threadId) {
            return { kind: "stale_claim" as const };
          }
          if (!claim.runtimeTurnId) {
            return { kind: "runtime_unknown" as const };
          }
          if (claim.runtimeTurnId !== input.runtimeTurnId) {
            return { kind: "runtime_mismatch" as const };
          }

          const ownerRow = await transaction
            .prepare(threadOwnerSelectSql("WHERE thread_id = ?"))
            .get(claim.threadId);
          if (
            !ownerRow ||
            String(ownerRow.ownerId) !== claim.ownerId ||
            Number(ownerRow.epoch) !== claim.ownerEpoch
          ) {
            return {
              kind: "stale_owner" as const,
              owner: ownerRow ? threadOwnerFromRow(ownerRow) : undefined,
            };
          }
          const sameGeneration =
            String(ownerRow.ownerId) === input.ownerId &&
            String(ownerRow.ownerInstanceId) === input.ownerInstanceId;
          if (sameGeneration) {
            const inputRow = await selectThreadInputRow(transaction, claim.inputId);
            if (!inputRow) {
              return { kind: "stale_claim" as const };
            }
            return {
              claim,
              input: threadInputFromRow(inputRow),
              kind: "already_owned" as const,
              owner: threadOwnerFromRow(ownerRow),
            };
          }
          if (
            typeof ownerRow.leaseExpiresAt === "number" &&
            Number(ownerRow.leaseExpiresAt) > now
          ) {
            return {
              kind: "stale_owner" as const,
              owner: threadOwnerFromRow(ownerRow),
            };
          }

          const epoch = Number(ownerRow.epoch) + 1;
          await transaction
            .prepare(
              `UPDATE thread_owners
               SET workspace_id = COALESCE(?, workspace_id),
                   owner_id = ?,
                   owner_instance_id = ?,
                   owner_type = ?,
                   epoch = ?,
                   lease_expires_at = ?,
                   capabilities_json = ?,
                   updated_at = ?
               WHERE thread_id = ? AND owner_id = ? AND epoch = ?`,
            )
            .run(
              input.workspaceId ?? null,
              input.ownerId,
              input.ownerInstanceId,
              input.ownerType,
              epoch,
              leaseExpiresAt,
              JSON.stringify(input.capabilities),
              now,
              claim.threadId,
              claim.ownerId,
              claim.ownerEpoch,
            );
          await transaction
            .prepare(
              `UPDATE turn_claims
               SET owner_id = ?, owner_epoch = ?, updated_at = ?
               WHERE claim_id = ? AND state = 'active' AND runtime_turn_id = ?`,
            )
            .run(input.ownerId, epoch, now, claim.claimId, input.runtimeTurnId);
          await transaction
            .prepare(
              `UPDATE thread_inputs
               SET workspace_id = COALESCE(?, workspace_id), state = 'running', updated_at = ?
               WHERE input_id = ?`,
            )
            .run(input.workspaceId ?? null, now, claim.inputId);

          const [updatedOwnerRow, updatedClaimRow, updatedInputRow] = await Promise.all([
            transaction.prepare(threadOwnerSelectSql("WHERE thread_id = ?")).get(claim.threadId),
            transaction.prepare(turnClaimSelectSql("WHERE claim_id = ?")).get(claim.claimId),
            selectThreadInputRow(transaction, claim.inputId),
          ]);
          if (!updatedOwnerRow || !updatedClaimRow || !updatedInputRow) {
            throw new Error(`Failed to adopt active turn claim ${claim.claimId}.`);
          }
          const updatedOwner = threadOwnerFromRow(updatedOwnerRow);
          const updatedClaim = turnClaimFromRow(updatedClaimRow);
          const updatedInput = threadInputFromRow(updatedInputRow);
          if (
            updatedOwner.ownerId !== input.ownerId ||
            updatedOwner.ownerInstanceId !== input.ownerInstanceId ||
            updatedOwner.epoch !== epoch ||
            updatedClaim.ownerId !== input.ownerId ||
            updatedClaim.ownerEpoch !== epoch ||
            updatedClaim.runtimeTurnId !== input.runtimeTurnId ||
            updatedClaim.state !== "active" ||
            updatedInput.state !== "running"
          ) {
            throw new Error(`Active turn claim ${claim.claimId} changed during adoption.`);
          }
          return {
            claim: updatedClaim,
            input: updatedInput,
            kind: "adopted" as const,
            owner: updatedOwner,
          };
        }),
      );
    },
    async addWorkspaceAlias(input) {
      const aliasPath = normalizeAbsolutePath(input.path);
      const now = Date.now();
      await runWrite(
        database.transaction(async (transaction) => {
          const workspace = await transaction
            .prepare("SELECT workspace_id AS workspaceId FROM workspaces WHERE workspace_id = ?")
            .get(input.workspaceId);
          if (!workspace) {
            throw new Error(`Unknown workspace: ${input.workspaceId}`);
          }
          const existingAlias = await transaction
            .prepare(
              "SELECT workspace_id AS workspaceId FROM workspace_path_aliases WHERE alias_path = ?",
            )
            .get(aliasPath);
          if (existingAlias && String(existingAlias.workspaceId) !== input.workspaceId) {
            throw new Error(`Workspace path alias is already registered: ${aliasPath}`);
          }
          await transaction
            .prepare(
              `INSERT INTO workspace_path_aliases (
               alias_path,
               workspace_id,
               registration_source,
               created_at,
               last_seen_at
             ) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(alias_path) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
            )
            .run(aliasPath, input.workspaceId, input.source, now, now);
        }),
      );
    },
    async acquireThreadOwner(input) {
      const now = Date.now();
      const leaseExpiresAt = input.leaseExpiresAt
        ? parseTimestamp(input.leaseExpiresAt, "thread owner lease")
        : null;
      return runWrite(
        database.transaction(async (transaction) => {
          const existing = await transaction
            .prepare(
              `SELECT thread_id AS threadId,
                      workspace_id AS workspaceId,
                      owner_id AS ownerId,
                      owner_instance_id AS ownerInstanceId,
                      owner_type AS ownerType,
                      epoch,
                      lease_expires_at AS leaseExpiresAt,
                      capabilities_json AS capabilitiesJson,
                      updated_at AS updatedAt
               FROM thread_owners
               WHERE thread_id = ?`,
            )
            .get(input.threadId);
          const sameGeneration =
            existing &&
            String(existing.ownerId) === input.ownerId &&
            String(existing.ownerInstanceId) === input.ownerInstanceId;
          const existingLeaseIsActive =
            existing &&
            !sameGeneration &&
            typeof existing.leaseExpiresAt === "number" &&
            Number(existing.leaseExpiresAt) > now;
          if (existingLeaseIsActive) {
            return threadOwnerFromRow(existing);
          }
          const epoch = sameGeneration ? Number(existing.epoch) : Number(existing?.epoch ?? 0) + 1;

          if (existing && !sameGeneration) {
            await transaction
              .prepare(
                `UPDATE thread_inputs
                 SET state = 'failed', updated_at = ?
                 WHERE input_id IN (
                   SELECT input_id FROM turn_claims
                   WHERE thread_id = ? AND state = 'active'
                 )`,
              )
              .run(now, input.threadId);
            await transaction
              .prepare(
                `UPDATE turn_claims
                 SET state = 'cancelled', updated_at = ?, terminal_at = ?
                 WHERE thread_id = ? AND state = 'active'`,
              )
              .run(now, now, input.threadId);
          }

          await transaction
            .prepare(
              `INSERT INTO thread_owners (
                 thread_id,
                 workspace_id,
                 owner_id,
                 owner_instance_id,
                 owner_type,
                 epoch,
                 lease_expires_at,
                 capabilities_json,
                 updated_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(thread_id) DO UPDATE SET
                 workspace_id = excluded.workspace_id,
                 owner_id = excluded.owner_id,
                 owner_instance_id = excluded.owner_instance_id,
                 owner_type = excluded.owner_type,
                 epoch = excluded.epoch,
                 lease_expires_at = excluded.lease_expires_at,
                 capabilities_json = excluded.capabilities_json,
                 updated_at = excluded.updated_at`,
            )
            .run(
              input.threadId,
              input.workspaceId ?? existing?.workspaceId ?? null,
              input.ownerId,
              input.ownerInstanceId,
              input.ownerType,
              epoch,
              leaseExpiresAt,
              JSON.stringify(input.capabilities),
              now,
            );
          const row = await transaction
            .prepare(
              `SELECT thread_id AS threadId,
                      workspace_id AS workspaceId,
                      owner_id AS ownerId,
                      owner_instance_id AS ownerInstanceId,
                      owner_type AS ownerType,
                      epoch,
                      lease_expires_at AS leaseExpiresAt,
                      capabilities_json AS capabilitiesJson,
                      updated_at AS updatedAt
               FROM thread_owners
               WHERE thread_id = ?`,
            )
            .get(input.threadId);
          if (!row) {
            throw new Error(`Failed to acquire owner for thread ${input.threadId}.`);
          }
          return threadOwnerFromRow(row);
        }),
      );
    },
    async acquireTurnClaim(input) {
      const now = Date.now();
      return runWrite(
        database.transaction(async (transaction) => {
          const ownerRow = await transaction
            .prepare(
              `SELECT thread_id AS threadId,
                      workspace_id AS workspaceId,
                      owner_id AS ownerId,
                      owner_instance_id AS ownerInstanceId,
                      owner_type AS ownerType,
                      epoch,
                      lease_expires_at AS leaseExpiresAt,
                      capabilities_json AS capabilitiesJson,
                      updated_at AS updatedAt
               FROM thread_owners
               WHERE thread_id = ?`,
            )
            .get(input.threadId);
          if (
            !ownerRow ||
            String(ownerRow.ownerId) !== input.ownerId ||
            Number(ownerRow.epoch) !== input.ownerEpoch
          ) {
            return {
              kind: "stale_owner" as const,
              owner: ownerRow ? threadOwnerFromRow(ownerRow) : undefined,
            };
          }

          const inputRow = await selectThreadInputRow(transaction, input.inputId);
          const threadInput = inputRow ? threadInputFromRow(inputRow) : undefined;
          if (!threadInput || threadInput.threadId !== input.threadId) {
            return { input: threadInput, kind: "input_unavailable" as const };
          }
          const existingClaimRow = await transaction
            .prepare(turnClaimSelectSql("WHERE input_id = ?"))
            .get(input.inputId);
          if (existingClaimRow) {
            return {
              claim: turnClaimFromRow(existingClaimRow),
              input: threadInput,
              kind: "existing" as const,
            };
          }
          const activeClaimRow = await transaction
            .prepare(turnClaimSelectSql("WHERE thread_id = ? AND state = 'active'"))
            .get(input.threadId);
          if (activeClaimRow) {
            return { claim: turnClaimFromRow(activeClaimRow), kind: "busy" as const };
          }
          if (!isClaimableThreadInputState(threadInput.state)) {
            return { input: threadInput, kind: "input_unavailable" as const };
          }

          const claimId = input.claimId ?? randomUUID();
          await insertTurnClaim(transaction, {
            claimId,
            inputId: input.inputId,
            now,
            ownerEpoch: input.ownerEpoch,
            ownerId: input.ownerId,
            threadId: input.threadId,
          });
          const [claimRow, claimedInputRow] = await Promise.all([
            transaction.prepare(turnClaimSelectSql("WHERE claim_id = ?")).get(claimId),
            selectThreadInputRow(transaction, input.inputId),
          ]);
          if (!claimRow || !claimedInputRow) {
            throw new Error(`Failed to acquire turn claim ${claimId}.`);
          }
          return {
            claim: turnClaimFromRow(claimRow),
            input: threadInputFromRow(claimedInputRow),
            kind: "acquired" as const,
          };
        }),
      );
    },
    async bindTurnClaimRuntimeTurn(input) {
      const now = Date.now();
      return runWrite(
        database.transaction(async (transaction) => {
          const claimRow = await transaction
            .prepare(turnClaimSelectSql("WHERE claim_id = ?"))
            .get(input.claimId);
          if (!claimRow) {
            return { kind: "stale_claim" as const };
          }
          const claim = turnClaimFromRow(claimRow);
          const ownerRow = await transaction
            .prepare(
              `SELECT thread_id AS threadId,
                      workspace_id AS workspaceId,
                      owner_id AS ownerId,
                      owner_instance_id AS ownerInstanceId,
                      owner_type AS ownerType,
                      epoch,
                      lease_expires_at AS leaseExpiresAt,
                      capabilities_json AS capabilitiesJson,
                      updated_at AS updatedAt
               FROM thread_owners
               WHERE thread_id = ?`,
            )
            .get(claim.threadId);
          if (
            !ownerRow ||
            String(ownerRow.ownerId) !== input.ownerId ||
            Number(ownerRow.epoch) !== input.ownerEpoch
          ) {
            return {
              kind: "stale_owner" as const,
              owner: ownerRow ? threadOwnerFromRow(ownerRow) : undefined,
            };
          }
          if (
            claim.state !== "active" ||
            claim.ownerId !== input.ownerId ||
            claim.ownerEpoch !== input.ownerEpoch
          ) {
            return { kind: "stale_claim" as const };
          }
          if (claim.runtimeTurnId) {
            return {
              claim,
              kind: claim.runtimeTurnId === input.runtimeTurnId ? "already_bound" : "conflict",
            };
          }

          await transaction
            .prepare(
              `UPDATE turn_claims
               SET runtime_turn_id = ?, updated_at = ?
               WHERE claim_id = ? AND state = 'active' AND runtime_turn_id IS NULL`,
            )
            .run(input.runtimeTurnId, now, input.claimId);
          const updatedRow = await transaction
            .prepare(turnClaimSelectSql("WHERE claim_id = ?"))
            .get(input.claimId);
          if (!updatedRow) {
            return { kind: "stale_claim" as const };
          }
          const updatedClaim = turnClaimFromRow(updatedRow);
          if (updatedClaim.state !== "active") {
            return { kind: "stale_claim" as const };
          }
          return {
            claim: updatedClaim,
            kind:
              updatedClaim.runtimeTurnId === input.runtimeTurnId
                ? "updated"
                : ("conflict" as const),
          };
        }),
      );
    },
    async claimNextThreadInput(input) {
      const now = Date.now();
      return runWrite(
        database.transaction(async (transaction) => {
          const ownerRow = await transaction
            .prepare(
              `SELECT thread_id AS threadId,
                      workspace_id AS workspaceId,
                      owner_id AS ownerId,
                      owner_instance_id AS ownerInstanceId,
                      owner_type AS ownerType,
                      epoch,
                      lease_expires_at AS leaseExpiresAt,
                      capabilities_json AS capabilitiesJson,
                      updated_at AS updatedAt
               FROM thread_owners
               WHERE thread_id = ?`,
            )
            .get(input.threadId);
          if (
            !ownerRow ||
            String(ownerRow.ownerId) !== input.ownerId ||
            Number(ownerRow.epoch) !== input.ownerEpoch
          ) {
            return {
              kind: "stale_owner" as const,
              owner: ownerRow ? threadOwnerFromRow(ownerRow) : undefined,
            };
          }
          const activeClaimRow = await transaction
            .prepare(turnClaimSelectSql("WHERE thread_id = ? AND state = 'active'"))
            .get(input.threadId);
          if (activeClaimRow) {
            return { claim: turnClaimFromRow(activeClaimRow), kind: "busy" as const };
          }
          const inputRow = await transaction
            .prepare(
              `${threadInputSelectSql()}
               WHERE thread_id = ? AND state IN ('persisted', 'accepted', 'queued', 'steered')
               ORDER BY created_at ASC, rowid ASC
               LIMIT 1`,
            )
            .get(input.threadId);
          if (!inputRow) {
            return { kind: "no_input" as const };
          }
          const threadInput = threadInputFromRow(inputRow);
          const existingClaimRow = await transaction
            .prepare(turnClaimSelectSql("WHERE input_id = ?"))
            .get(threadInput.inputId);
          if (existingClaimRow) {
            return {
              claim: turnClaimFromRow(existingClaimRow),
              input: threadInput,
              kind: "existing" as const,
            };
          }

          const claimId = input.claimId ?? randomUUID();
          await insertTurnClaim(transaction, {
            claimId,
            inputId: threadInput.inputId,
            now,
            ownerEpoch: input.ownerEpoch,
            ownerId: input.ownerId,
            threadId: input.threadId,
          });
          const [claimRow, claimedInputRow] = await Promise.all([
            transaction.prepare(turnClaimSelectSql("WHERE claim_id = ?")).get(claimId),
            selectThreadInputRow(transaction, threadInput.inputId),
          ]);
          if (!claimRow || !claimedInputRow) {
            throw new Error(`Failed to claim the next input for thread ${input.threadId}.`);
          }
          return {
            claim: turnClaimFromRow(claimRow),
            input: threadInputFromRow(claimedInputRow),
            kind: "acquired" as const,
          };
        }),
      );
    },
    async finalizeTurnClaim(input) {
      const now = Date.now();
      return runWrite(
        database.transaction(async (transaction) => {
          const claimRow = await transaction
            .prepare(turnClaimSelectSql("WHERE claim_id = ?"))
            .get(input.claimId);
          if (!claimRow) {
            return { kind: "stale_claim" as const };
          }
          const claim = turnClaimFromRow(claimRow);
          const ownerRow = await transaction
            .prepare(
              `SELECT thread_id AS threadId,
                      workspace_id AS workspaceId,
                      owner_id AS ownerId,
                      owner_instance_id AS ownerInstanceId,
                      owner_type AS ownerType,
                      epoch,
                      lease_expires_at AS leaseExpiresAt,
                      capabilities_json AS capabilitiesJson,
                      updated_at AS updatedAt
               FROM thread_owners
               WHERE thread_id = ?`,
            )
            .get(claim.threadId);
          if (
            !ownerRow ||
            String(ownerRow.ownerId) !== input.ownerId ||
            Number(ownerRow.epoch) !== input.ownerEpoch
          ) {
            return {
              kind: "stale_owner" as const,
              owner: ownerRow ? threadOwnerFromRow(ownerRow) : undefined,
            };
          }
          const inputRow = await selectThreadInputRow(transaction, claim.inputId);
          if (claim.ownerId !== input.ownerId || claim.ownerEpoch !== input.ownerEpoch) {
            return { kind: "stale_claim" as const };
          }
          if (claim.state !== "active") {
            return {
              claim,
              input: inputRow ? threadInputFromRow(inputRow) : undefined,
              kind: "already_terminal" as const,
            };
          }

          await transaction
            .prepare(
              `UPDATE turn_claims
               SET state = ?, updated_at = ?, terminal_at = ?
               WHERE claim_id = ? AND state = 'active'`,
            )
            .run(input.state, now, now, input.claimId);
          await transaction
            .prepare("UPDATE thread_inputs SET state = ?, updated_at = ? WHERE input_id = ?")
            .run(input.state, now, claim.inputId);
          const [updatedClaimRow, updatedInputRow] = await Promise.all([
            transaction.prepare(turnClaimSelectSql("WHERE claim_id = ?")).get(input.claimId),
            selectThreadInputRow(transaction, claim.inputId),
          ]);
          if (!updatedClaimRow) {
            throw new Error(`Failed to finalize turn claim ${input.claimId}.`);
          }
          return {
            claim: turnClaimFromRow(updatedClaimRow),
            input: updatedInputRow ? threadInputFromRow(updatedInputRow) : undefined,
            kind: "updated" as const,
          };
        }),
      );
    },
    async remapActiveTurnClaim(input) {
      const now = Date.now();
      return runWrite(
        database.transaction(async (transaction) => {
          const claimRow = await transaction
            .prepare(turnClaimSelectSql("WHERE claim_id = ?"))
            .get(input.claimId);
          if (!claimRow) {
            return { kind: "stale_claim" as const };
          }
          const claim = turnClaimFromRow(claimRow);
          if (
            claim.state !== "active" ||
            claim.ownerId !== input.fromOwnerId ||
            claim.ownerEpoch !== input.fromOwnerEpoch
          ) {
            return { kind: "stale_claim" as const };
          }

          const ownerSelectSql = `SELECT thread_id AS threadId,
                                         workspace_id AS workspaceId,
                                         owner_id AS ownerId,
                                         owner_instance_id AS ownerInstanceId,
                                         owner_type AS ownerType,
                                         epoch,
                                         lease_expires_at AS leaseExpiresAt,
                                         capabilities_json AS capabilitiesJson,
                                         updated_at AS updatedAt
                                  FROM thread_owners
                                  WHERE thread_id = ?`;
          const previousOwnerRow = await transaction.prepare(ownerSelectSql).get(claim.threadId);
          if (
            !previousOwnerRow ||
            String(previousOwnerRow.ownerId) !== input.fromOwnerId ||
            Number(previousOwnerRow.epoch) !== input.fromOwnerEpoch
          ) {
            return {
              kind: "stale_owner" as const,
              owner: previousOwnerRow ? threadOwnerFromRow(previousOwnerRow) : undefined,
            };
          }
          const nextOwnerRow = await transaction.prepare(ownerSelectSql).get(input.threadId);
          if (
            !nextOwnerRow ||
            String(nextOwnerRow.ownerId) !== input.ownerId ||
            Number(nextOwnerRow.epoch) !== input.ownerEpoch
          ) {
            return {
              kind: "stale_owner" as const,
              owner: nextOwnerRow ? threadOwnerFromRow(nextOwnerRow) : undefined,
            };
          }
          const activeClaimRow = await transaction
            .prepare(turnClaimSelectSql("WHERE thread_id = ? AND state = 'active'"))
            .get(input.threadId);
          if (activeClaimRow && String(activeClaimRow.claimId) !== input.claimId) {
            return { claim: turnClaimFromRow(activeClaimRow), kind: "busy" as const };
          }

          await transaction
            .prepare(
              `UPDATE turn_claims
               SET thread_id = ?, owner_id = ?, owner_epoch = ?, updated_at = ?
               WHERE claim_id = ? AND state = 'active'`,
            )
            .run(input.threadId, input.ownerId, input.ownerEpoch, now, input.claimId);
          await transaction
            .prepare(
              `UPDATE thread_inputs
               SET thread_id = ?, workspace_id = COALESCE(?, workspace_id), updated_at = ?
               WHERE input_id = ?`,
            )
            .run(input.threadId, input.workspaceId ?? null, now, claim.inputId);
          const [updatedClaimRow, updatedInputRow] = await Promise.all([
            transaction.prepare(turnClaimSelectSql("WHERE claim_id = ?")).get(input.claimId),
            selectThreadInputRow(transaction, claim.inputId),
          ]);
          if (!updatedClaimRow || !updatedInputRow) {
            throw new Error(`Failed to remap turn claim ${input.claimId}.`);
          }
          return {
            claim: turnClaimFromRow(updatedClaimRow),
            input: threadInputFromRow(updatedInputRow),
            kind: "updated" as const,
          };
        }),
      );
    },
    async getActiveTurnClaim(threadId) {
      const row = await database
        .prepare(turnClaimSelectSql("WHERE thread_id = ? AND state = 'active'"))
        .get(threadId);
      return row ? turnClaimFromRow(row) : undefined;
    },
    async getThreadOwner(threadId) {
      const row = await database
        .prepare(
          `SELECT thread_id AS threadId,
                  workspace_id AS workspaceId,
                  owner_id AS ownerId,
                  owner_instance_id AS ownerInstanceId,
                  owner_type AS ownerType,
                  epoch,
                  lease_expires_at AS leaseExpiresAt,
                  capabilities_json AS capabilitiesJson,
                  updated_at AS updatedAt
           FROM thread_owners
           WHERE thread_id = ?`,
        )
        .get(threadId);
      return row ? threadOwnerFromRow(row) : undefined;
    },
    async listActiveTurnClaims() {
      const rows = await database
        .prepare(
          `${turnClaimSelectSql("WHERE state = 'active'")} ORDER BY created_at ASC, rowid ASC`,
        )
        .all();
      return rows.map(turnClaimFromRow);
    },
    async appendThreadEvent(input) {
      const parsedEvent = StreamThreadRunEventSchema.parse(input.event);
      const payloadThreadId = threadIdFromEvent(parsedEvent);
      if (payloadThreadId && payloadThreadId !== input.threadId) {
        throw new Error(
          `Thread event payload belongs to thread ${payloadThreadId}, not ${input.threadId}.`,
        );
      }
      const eventId = input.eventId ?? randomUUID();
      const createdAt = input.createdAt ?? new Date().toISOString();
      const createdAtMs = Date.parse(createdAt);
      if (!Number.isFinite(createdAtMs)) {
        throw new Error(`Invalid thread event timestamp: ${createdAt}`);
      }

      return runWrite(
        database.transaction(async (transaction) => {
          const existing = await transaction
            .prepare(
              `SELECT event_id AS eventId,
                    thread_id AS threadId,
                    workspace_id AS workspaceId,
                    sequence,
                    payload_json AS payloadJson,
                    created_at AS createdAt
             FROM thread_events
             WHERE event_id = ?`,
            )
            .get(eventId);
          if (existing) {
            if (String(existing.threadId) !== input.threadId) {
              throw new Error(
                `Thread event ${eventId} already belongs to thread ${String(existing.threadId)}.`,
              );
            }
            return threadEventFromRow(existing);
          }

          await transaction
            .prepare(
              "INSERT OR IGNORE INTO thread_event_sequences (thread_id, next_sequence) VALUES (?, 1)",
            )
            .run(input.threadId);
          const cursor = await transaction
            .prepare(
              "SELECT next_sequence AS nextSequence FROM thread_event_sequences WHERE thread_id = ?",
            )
            .get(input.threadId);
          const sequence = Number(cursor?.nextSequence);
          if (!Number.isInteger(sequence) || sequence < 1) {
            throw new Error(`Invalid event sequence for thread ${input.threadId}.`);
          }
          await transaction
            .prepare(
              "UPDATE thread_event_sequences SET next_sequence = next_sequence + 1 WHERE thread_id = ?",
            )
            .run(input.threadId);
          await transaction
            .prepare(
              `INSERT INTO thread_events (
               event_id,
               thread_id,
               workspace_id,
               sequence,
               event_type,
               payload_json,
               created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              eventId,
              input.threadId,
              input.workspaceId ?? null,
              sequence,
              parsedEvent.type,
              JSON.stringify(parsedEvent),
              createdAtMs,
            );

          return ThreadEventSchema.parse({
            createdAt: new Date(createdAtMs).toISOString(),
            event: parsedEvent,
            eventId,
            sequence,
            threadId: input.threadId,
            workspaceId: input.workspaceId,
          });
        }),
      );
    },
    async createThreadInput(input) {
      const inputId = input.inputId ?? randomUUID();
      const createdAt = input.createdAt ?? new Date().toISOString();
      const createdAtMs = Date.parse(createdAt);
      if (!Number.isFinite(createdAtMs)) {
        throw new Error(`Invalid thread input timestamp: ${createdAt}`);
      }
      const payloadJson = JSON.stringify(input.payload);
      const resultJson = input.result === undefined ? null : JSON.stringify(input.result);

      return runWrite(
        database.transaction(async (transaction) => {
          if (input.clientEventId) {
            const existing = await transaction
              .prepare(
                `SELECT input_id AS inputId,
                        client_id AS clientId,
                        client_event_id AS clientEventId,
                        thread_id AS threadId,
                        workspace_id AS workspaceId,
                        payload_json AS payloadJson,
                        result_json AS resultJson,
                        state,
                        created_at AS createdAt,
                        updated_at AS updatedAt
                 FROM thread_inputs
                 WHERE client_id = ? AND client_event_id = ?`,
              )
              .get(input.clientId, input.clientEventId);
            if (existing) {
              return { created: false, input: threadInputFromRow(existing) };
            }
          }

          await transaction
            .prepare(
              `INSERT INTO thread_inputs (
                 input_id,
                 client_id,
                 client_event_id,
                 thread_id,
                 workspace_id,
                 payload_json,
                 result_json,
                 state,
                 created_at,
                 updated_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              inputId,
              input.clientId,
              input.clientEventId ?? null,
              input.threadId,
              input.workspaceId ?? null,
              payloadJson,
              resultJson,
              input.state,
              createdAtMs,
              createdAtMs,
            );

          const row = await transaction
            .prepare(
              `SELECT input_id AS inputId,
                      client_id AS clientId,
                      client_event_id AS clientEventId,
                      thread_id AS threadId,
                      workspace_id AS workspaceId,
                      payload_json AS payloadJson,
                      result_json AS resultJson,
                      state,
                      created_at AS createdAt,
                      updated_at AS updatedAt
               FROM thread_inputs
               WHERE input_id = ?`,
            )
            .get(inputId);
          if (!row) {
            throw new Error(`Failed to persist thread input: ${inputId}`);
          }
          return { created: true, input: threadInputFromRow(row) };
        }),
      );
    },
    async createPendingApproval(input) {
      const now = Date.now();
      if (!pendingApprovalKinds.includes(input.kind)) {
        throw new Error(`Invalid pending approval kind: ${input.kind}`);
      }
      await runWrite(
        database.transaction(async (transaction) => {
          await transaction
            .prepare(
              `INSERT INTO pending_approvals (
                 approval_id,
                 thread_id,
                 turn_id,
                 request_id,
                 method,
                 kind,
                 message_id,
                 message_json,
                 questions_json,
                 state,
                 created_at,
                 updated_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
               ON CONFLICT(approval_id) DO UPDATE SET
                 thread_id = excluded.thread_id,
                 turn_id = excluded.turn_id,
                 request_id = excluded.request_id,
                 method = excluded.method,
                 kind = excluded.kind,
                 message_id = excluded.message_id,
                 message_json = excluded.message_json,
                 questions_json = excluded.questions_json,
                 state = 'pending',
                 updated_at = excluded.updated_at`,
            )
            .run(
              input.approvalId,
              input.threadId,
              input.turnId ?? null,
              input.requestId,
              input.method,
              input.kind,
              input.messageId ?? null,
              input.message ? JSON.stringify(input.message) : null,
              input.questions ? JSON.stringify(input.questions) : null,
              now,
              now,
            );
        }),
      );
      const row = await database
        .prepare(`${pendingApprovalSelectSql()} WHERE approval_id = ? AND state = 'pending'`)
        .get(input.approvalId);
      if (!row) {
        throw new Error(`Failed to persist approval ${input.approvalId}.`);
      }
      return pendingApprovalFromRow(row);
    },
    async getThreadInputByClientEvent(clientId, clientEventId) {
      const row = await database
        .prepare(
          `SELECT input_id AS inputId,
                  client_id AS clientId,
                  client_event_id AS clientEventId,
                  thread_id AS threadId,
                  workspace_id AS workspaceId,
                  payload_json AS payloadJson,
                  result_json AS resultJson,
                  state,
                  created_at AS createdAt,
                  updated_at AS updatedAt
           FROM thread_inputs
           WHERE client_id = ? AND client_event_id = ?`,
        )
        .get(clientId, clientEventId);
      return row ? threadInputFromRow(row) : undefined;
    },
    async listThreadEvents(input) {
      const afterSequence = normalizeNonnegativeInteger(input.afterSequence ?? 0, "afterSequence");
      const limit = Math.min(
        normalizePositiveInteger(input.limit ?? defaultPageLimit, "limit"),
        maximumPageLimit,
      );
      const [compactionRow, sequenceRow] = await Promise.all([
        database
          .prepare(
            "SELECT compacted_through_sequence AS compactedThroughSequence FROM thread_event_compaction WHERE thread_id = ?",
          )
          .get(input.threadId),
        database
          .prepare(
            "SELECT next_sequence AS nextSequence FROM thread_event_sequences WHERE thread_id = ?",
          )
          .get(input.threadId),
      ]);
      const compactedThroughSequence = Number(compactionRow?.compactedThroughSequence ?? 0);
      const lastSequence = Math.max(0, Number(sequenceRow?.nextSequence ?? 1) - 1);
      if (afterSequence < compactedThroughSequence) {
        return { events: [], hasMore: false, lastSequence, resetRequired: true };
      }
      const rows = await database
        .prepare(
          `SELECT event_id AS eventId,
                  thread_id AS threadId,
                  workspace_id AS workspaceId,
                  sequence,
                  payload_json AS payloadJson,
                  created_at AS createdAt
           FROM thread_events
           WHERE thread_id = ? AND sequence > ?
           ORDER BY sequence ASC
           LIMIT ?`,
        )
        .all(input.threadId, afterSequence, limit + 1);
      const hasMore = rows.length > limit;
      const events = rows.slice(0, limit).map(threadEventFromRow);
      return {
        events,
        hasMore,
        lastSequence: events.at(-1)?.sequence ?? afterSequence,
        resetRequired: false,
      };
    },
    async listThreadInputs(input = {}) {
      const clauses: string[] = [];
      const arguments_: Array<string> = [];
      if (input.threadId) {
        clauses.push("thread_id = ?");
        arguments_.push(input.threadId);
      }
      if (input.states && input.states.length > 0) {
        clauses.push(`state IN (${input.states.map(() => "?").join(", ")})`);
        arguments_.push(...input.states);
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
      const rows = await database
        .prepare(
          `SELECT input_id AS inputId,
                  client_id AS clientId,
                  client_event_id AS clientEventId,
                  thread_id AS threadId,
                  workspace_id AS workspaceId,
                  payload_json AS payloadJson,
                  result_json AS resultJson,
                  state,
                  created_at AS createdAt,
                  updated_at AS updatedAt
           FROM thread_inputs
           ${where}
           ORDER BY created_at ASC, rowid ASC`,
        )
        .all(...arguments_);
      return rows.map(threadInputFromRow);
    },
    async listPendingApprovals() {
      const rows = await database
        .prepare(
          `${pendingApprovalSelectSql()}
           WHERE state = 'pending'
           ORDER BY created_at ASC, approval_id ASC`,
        )
        .all();
      return rows.map(pendingApprovalFromRow);
    },
    async markTurnClaimDispatch(input) {
      const now = Date.now();
      return runWrite(
        database.transaction(async (transaction) => {
          const claimRow = await transaction
            .prepare(turnClaimSelectSql("WHERE claim_id = ?"))
            .get(input.claimId);
          if (!claimRow) {
            return { kind: "stale_claim" as const };
          }
          const claim = turnClaimFromRow(claimRow);
          const ownerRow = await transaction
            .prepare(threadOwnerSelectSql("WHERE thread_id = ?"))
            .get(claim.threadId);
          if (
            !ownerRow ||
            String(ownerRow.ownerId) !== input.ownerId ||
            Number(ownerRow.epoch) !== input.ownerEpoch
          ) {
            return {
              kind: "stale_owner" as const,
              owner: ownerRow ? threadOwnerFromRow(ownerRow) : undefined,
            };
          }
          if (
            claim.state !== "active" ||
            claim.ownerId !== input.ownerId ||
            claim.ownerEpoch !== input.ownerEpoch ||
            claim.runtimeTurnId
          ) {
            return { kind: "stale_claim" as const };
          }
          await transaction
            .prepare(
              `UPDATE turn_claims
               SET dispatch_started_at = ?, updated_at = ?
               WHERE claim_id = ? AND state = 'active' AND runtime_turn_id IS NULL`,
            )
            .run(now, now, input.claimId);
          const updatedRow = await transaction
            .prepare(turnClaimSelectSql("WHERE claim_id = ?"))
            .get(input.claimId);
          if (!updatedRow) {
            return { kind: "stale_claim" as const };
          }
          const updatedClaim = turnClaimFromRow(updatedRow);
          return {
            claim: updatedClaim,
            kind: claim.dispatchStartedAt ? ("already_marked" as const) : ("updated" as const),
          };
        }),
      );
    },
    async repairExpiredThreadOwner(input) {
      const now = input.now ? parseTimestamp(input.now, "owner repair") : Date.now();
      return runWrite(
        database.transaction(async (transaction) => {
          const ownerRow = await transaction
            .prepare(threadOwnerSelectSql("WHERE thread_id = ?"))
            .get(input.threadId);
          if (!ownerRow) {
            return { kind: "not_found" as const };
          }
          const owner = threadOwnerFromRow(ownerRow);
          const leaseExpiresAt =
            typeof ownerRow.leaseExpiresAt === "number" ? Number(ownerRow.leaseExpiresAt) : null;
          if (leaseExpiresAt === null || leaseExpiresAt > now) {
            return { kind: "not_expired" as const, owner };
          }
          const activeClaims = await transaction
            .prepare(turnClaimSelectSql("WHERE thread_id = ? AND state = 'active'"))
            .all(input.threadId);
          await transaction
            .prepare(
              `UPDATE thread_inputs
               SET state = 'failed', updated_at = ?
               WHERE input_id IN (
                 SELECT input_id FROM turn_claims
                 WHERE thread_id = ? AND state = 'active'
               )`,
            )
            .run(now, input.threadId);
          await transaction
            .prepare(
              `UPDATE turn_claims
               SET state = 'cancelled', updated_at = ?, terminal_at = ?
               WHERE thread_id = ? AND state = 'active'`,
            )
            .run(now, now, input.threadId);
          await transaction
            .prepare("DELETE FROM thread_owners WHERE thread_id = ? AND epoch = ?")
            .run(input.threadId, owner.epoch);
          return {
            cancelledClaimCount: activeClaims.length,
            kind: "repaired" as const,
            owner,
          };
        }),
      );
    },
    async listWorkspaces() {
      const rows = await database
        .prepare(
          `SELECT workspace_id AS workspaceId,
                  canonical_path AS canonicalPath,
                  display_name AS displayName,
                  repository_identity AS repositoryIdentity,
                  state,
                  created_at AS createdAt,
                  last_seen_at AS lastSeenAt
           FROM workspaces
           ORDER BY canonical_path ASC, workspace_id ASC`,
        )
        .all();
      return rows.map(workspaceFromRow);
    },
    async registerWorkspace(input) {
      const inspected = await inspectWorkspacePath(input.path);
      const now = Date.now();
      return runWrite(
        database.transaction(async (transaction) => {
          const matchingRows = await transaction
            .prepare(
              `SELECT DISTINCT w.workspace_id AS workspaceId,
                             w.canonical_path AS canonicalPath,
                             w.display_name AS displayName,
                             w.repository_identity AS repositoryIdentity,
                             w.state,
                             w.created_at AS createdAt,
                             w.last_seen_at AS lastSeenAt
             FROM workspaces w
             LEFT JOIN workspace_path_aliases a ON a.workspace_id = w.workspace_id
             WHERE w.canonical_path = ?
                OR w.canonical_path = ?
                OR a.alias_path = ?
                OR a.alias_path = ?`,
            )
            .all(
              inspected.canonicalPath,
              inspected.normalizedPath,
              inspected.canonicalPath,
              inspected.normalizedPath,
            );
          const workspaceIds = new Set(matchingRows.map((row) => String(row.workspaceId)));
          if (workspaceIds.size > 1) {
            throw new Error(`Workspace paths resolve to conflicting identities: ${input.path}`);
          }

          const existing = matchingRows[0];
          const workspaceId = existing ? String(existing.workspaceId) : randomUUID();
          if (
            existing?.state === "available" &&
            inspected.state === "available" &&
            String(existing.canonicalPath) !== inspected.canonicalPath
          ) {
            throw new Error(
              `Workspace alias no longer resolves to its registered path: ${input.path}`,
            );
          }
          const canonicalPath = existing
            ? shouldRefreshCanonicalPath(existing, inspected)
              ? inspected.canonicalPath
              : String(existing.canonicalPath)
            : inspected.canonicalPath;
          const state = existing
            ? await workspaceStateForRegistration(existing, inspected)
            : inspected.state;
          if (existing) {
            await transaction
              .prepare(
                `UPDATE workspaces
               SET canonical_path = ?,
                   display_name = ?,
                   repository_identity = ?,
                   state = ?,
                   last_seen_at = ?
               WHERE workspace_id = ?`,
              )
              .run(
                canonicalPath,
                input.displayName ?? String(existing.displayName),
                input.repositoryIdentity ?? existing.repositoryIdentity ?? null,
                state,
                now,
                workspaceId,
              );
          } else {
            await transaction
              .prepare(
                `INSERT INTO workspaces (
                 workspace_id,
                 canonical_path,
                 display_name,
                 repository_identity,
                 state,
                 registration_source,
                 created_at,
                 last_seen_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
              )
              .run(
                workspaceId,
                canonicalPath,
                input.displayName ?? (basename(canonicalPath) || canonicalPath),
                input.repositoryIdentity ?? null,
                inspected.state,
                input.source,
                now,
                now,
              );
          }

          for (const aliasPath of new Set([inspected.normalizedPath, inspected.canonicalPath])) {
            await transaction
              .prepare(
                `INSERT INTO workspace_path_aliases (
                 alias_path,
                 workspace_id,
                 registration_source,
                 created_at,
                 last_seen_at
               ) VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(alias_path) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
              )
              .run(aliasPath, workspaceId, input.source, now, now);
          }

          const row = await transaction
            .prepare(
              `SELECT workspace_id AS workspaceId,
                    canonical_path AS canonicalPath,
                    display_name AS displayName,
                    repository_identity AS repositoryIdentity,
                    state,
                    created_at AS createdAt,
                    last_seen_at AS lastSeenAt
             FROM workspaces
             WHERE workspace_id = ?`,
            )
            .get(workspaceId);
          if (!row) {
            throw new Error(`Failed to register workspace: ${input.path}`);
          }
          return workspaceFromRow(row);
        }),
      );
    },
    async resolveWorkspace(path) {
      const inspected = await inspectWorkspacePath(path);
      const row = await database
        .prepare(
          `SELECT DISTINCT w.workspace_id AS workspaceId,
                           w.canonical_path AS canonicalPath,
                           w.display_name AS displayName,
                           w.repository_identity AS repositoryIdentity,
                           w.state,
                           w.created_at AS createdAt,
                           w.last_seen_at AS lastSeenAt
           FROM workspaces w
           LEFT JOIN workspace_path_aliases a ON a.workspace_id = w.workspace_id
           WHERE w.canonical_path = ?
              OR w.canonical_path = ?
              OR a.alias_path = ?
              OR a.alias_path = ?
           LIMIT 1`,
        )
        .get(
          inspected.canonicalPath,
          inspected.normalizedPath,
          inspected.canonicalPath,
          inspected.normalizedPath,
        );
      return row ? workspaceFromRow(row) : undefined;
    },
    async resolveWorkspaceById(workspaceId) {
      const row = await database
        .prepare(
          `SELECT workspace_id AS workspaceId,
                  canonical_path AS canonicalPath,
                  display_name AS displayName,
                  repository_identity AS repositoryIdentity,
                  state,
                  created_at AS createdAt,
                  last_seen_at AS lastSeenAt
           FROM workspaces
           WHERE workspace_id = ?`,
        )
        .get(workspaceId);
      return row ? workspaceFromRow(row) : undefined;
    },
    async updateThreadInputState(inputId, state) {
      return runWrite(
        database.transaction(async (transaction) => {
          await transaction
            .prepare("UPDATE thread_inputs SET state = ?, updated_at = ? WHERE input_id = ?")
            .run(state, Date.now(), inputId);
          const row = await transaction
            .prepare(
              `SELECT input_id AS inputId,
                      client_id AS clientId,
                      client_event_id AS clientEventId,
                      thread_id AS threadId,
                      workspace_id AS workspaceId,
                      payload_json AS payloadJson,
                      result_json AS resultJson,
                      state,
                      created_at AS createdAt,
                      updated_at AS updatedAt
               FROM thread_inputs
               WHERE input_id = ?`,
            )
            .get(inputId);
          return row ? threadInputFromRow(row) : undefined;
        }),
      );
    },
    async resolvePendingApproval(approvalId) {
      const result = await runWrite(() =>
        database
          .prepare(
            `UPDATE pending_approvals
             SET state = 'resolved', updated_at = ?
             WHERE approval_id = ? AND state = 'pending'`,
          )
          .run(Date.now(), approvalId),
      );
      return Number(result.rowsAffected ?? 0) > 0;
    },
  };
}

type InspectedWorkspacePath = {
  canonicalPath: string;
  normalizedPath: string;
  state: WorkspaceState;
};

async function inspectWorkspacePath(path: string): Promise<InspectedWorkspacePath> {
  const normalizedPath = normalizeAbsolutePath(path);
  let canonicalPath = normalizedPath;
  try {
    canonicalPath = await realpath(normalizedPath);
    const workspaceStat = await stat(canonicalPath);
    if (!workspaceStat.isDirectory()) {
      throw new Error(`Workspace path must be a directory: ${path}`);
    }
    await access(canonicalPath, constants.R_OK);
    return { canonicalPath, normalizedPath, state: "available" };
  } catch (error) {
    const code = filesystemErrorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { canonicalPath: normalizedPath, normalizedPath, state: "missing" };
    }
    if (code === "EACCES" || code === "EPERM") {
      return { canonicalPath, normalizedPath, state: "unauthorized" };
    }
    throw error;
  }
}

async function workspaceStateForRegistration(
  existing: Record<string, unknown>,
  inspected: InspectedWorkspacePath,
) {
  if (
    inspected.state === "available" ||
    inspected.normalizedPath === String(existing.canonicalPath)
  ) {
    return inspected.state;
  }
  return (await inspectWorkspacePath(String(existing.canonicalPath))).state;
}

function normalizeAbsolutePath(path: string) {
  if (!isAbsolute(path)) {
    throw new Error(`Workspace path must be an absolute path: ${path}`);
  }
  return resolve(path);
}

function filesystemErrorCode(error: unknown) {
  return typeof error === "object" && error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function shouldRefreshCanonicalPath(
  existing: Record<string, unknown>,
  inspected: InspectedWorkspacePath,
) {
  return existing.state !== "available" && inspected.state === "available";
}

function workspaceFromRow(row: Record<string, unknown>): Workspace {
  return {
    canonicalPath: String(row.canonicalPath),
    createdAt: new Date(Number(row.createdAt)).toISOString(),
    displayName: String(row.displayName),
    lastSeenAt: new Date(Number(row.lastSeenAt)).toISOString(),
    repositoryIdentity:
      typeof row.repositoryIdentity === "string" ? row.repositoryIdentity : undefined,
    state: workspaceStateFromRow(row.state),
    workspaceId: String(row.workspaceId),
  };
}

function workspaceStateFromRow(value: unknown): WorkspaceState {
  if (value === "available" || value === "missing" || value === "unauthorized") {
    return value;
  }
  throw new Error(`Invalid workspace state: ${String(value)}`);
}

function createWriteQueue() {
  let tail = Promise.resolve();
  return async function runWrite<T>(operation: () => Promise<T>) {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  };
}

function threadIdFromEvent(event: StreamThreadRunEvent) {
  if ("thread" in event && event.thread) {
    return event.thread.id;
  }
  if ("threadId" in event) {
    return event.threadId;
  }
  if ("request" in event) {
    return event.request.threadId;
  }
  return undefined;
}

function threadEventFromRow(row: Record<string, unknown>) {
  const payloadJson = String(row.payloadJson);
  return ThreadEventSchema.parse({
    createdAt: new Date(Number(row.createdAt)).toISOString(),
    event: JSON.parse(payloadJson),
    eventId: String(row.eventId),
    sequence: Number(row.sequence),
    threadId: String(row.threadId),
    workspaceId: typeof row.workspaceId === "string" ? row.workspaceId : undefined,
  });
}

function threadInputFromRow(row: Record<string, unknown>): ThreadInput {
  return {
    clientEventId: typeof row.clientEventId === "string" ? row.clientEventId : undefined,
    clientId: String(row.clientId),
    createdAt: new Date(Number(row.createdAt)).toISOString(),
    inputId: String(row.inputId),
    payload: JSON.parse(String(row.payloadJson)),
    result: typeof row.resultJson === "string" ? JSON.parse(row.resultJson) : undefined,
    state: threadInputStateFromRow(row.state),
    threadId: String(row.threadId),
    updatedAt: new Date(Number(row.updatedAt)).toISOString(),
    workspaceId: typeof row.workspaceId === "string" ? row.workspaceId : undefined,
  };
}

function threadInputSelectSql() {
  return `SELECT input_id AS inputId,
                 client_id AS clientId,
                 client_event_id AS clientEventId,
                 thread_id AS threadId,
                 workspace_id AS workspaceId,
                 payload_json AS payloadJson,
                 result_json AS resultJson,
                 state,
                 created_at AS createdAt,
                 updated_at AS updatedAt
          FROM thread_inputs`;
}

function selectThreadInputRow(database: QueryableRelayStateDatabase, inputId: string) {
  return database.prepare(`${threadInputSelectSql()} WHERE input_id = ?`).get(inputId);
}

function pendingApprovalSelectSql() {
  return `SELECT approval_id AS approvalId,
                 thread_id AS threadId,
                 turn_id AS turnId,
                 request_id AS requestId,
                 method,
                 kind,
                 message_id AS messageId,
                 message_json AS messageJson,
                 questions_json AS questionsJson,
                 created_at AS createdAt,
                 updated_at AS updatedAt
          FROM pending_approvals`;
}

function pendingApprovalFromRow(row: Record<string, unknown>): DurablePendingApproval {
  const kind = String(row.kind);
  if (!pendingApprovalKinds.includes(kind as PendingApprovalKind)) {
    throw new Error(`Invalid pending approval kind: ${kind}`);
  }
  return {
    approvalId: String(row.approvalId),
    createdAt: new Date(Number(row.createdAt)).toISOString(),
    kind: kind as PendingApprovalKind,
    message:
      typeof row.messageJson === "string"
        ? (JSON.parse(row.messageJson) as Record<string, unknown>)
        : undefined,
    messageId: typeof row.messageId === "string" ? row.messageId : undefined,
    method: String(row.method),
    questions:
      typeof row.questionsJson === "string"
        ? (JSON.parse(row.questionsJson) as DurablePendingApproval["questions"])
        : undefined,
    requestId:
      typeof row.requestId === "number" || typeof row.requestId === "string"
        ? row.requestId
        : String(row.requestId),
    threadId: String(row.threadId),
    turnId: typeof row.turnId === "string" ? row.turnId : undefined,
    updatedAt: new Date(Number(row.updatedAt)).toISOString(),
  };
}

function threadOwnerFromRow(row: Record<string, unknown>): ThreadOwner {
  const capabilities = JSON.parse(String(row.capabilitiesJson)) as Record<string, unknown>;
  return {
    capabilities: {
      approve: Boolean(capabilities.approve),
      configure: Boolean(capabilities.configure),
      interrupt: Boolean(capabilities.interrupt),
      queue: Boolean(capabilities.queue),
      send: Boolean(capabilities.send),
      steer: Boolean(capabilities.steer),
      view: Boolean(capabilities.view),
    },
    epoch: normalizePositiveInteger(Number(row.epoch), "thread owner epoch"),
    leaseExpiresAt:
      typeof row.leaseExpiresAt === "number"
        ? new Date(row.leaseExpiresAt).toISOString()
        : undefined,
    ownerId: String(row.ownerId),
    ownerInstanceId: String(row.ownerInstanceId),
    ownerType: threadOwnerTypeFromRow(row.ownerType),
    threadId: String(row.threadId),
    updatedAt: new Date(Number(row.updatedAt)).toISOString(),
    workspaceId: typeof row.workspaceId === "string" ? row.workspaceId : undefined,
  };
}

function threadOwnerTypeFromRow(value: unknown): ThreadOwnerType {
  if (threadOwnerTypes.includes(value as ThreadOwnerType)) {
    return value as ThreadOwnerType;
  }
  throw new Error(`Invalid thread owner type: ${String(value)}`);
}

function threadOwnerSelectSql(where: string) {
  return `SELECT thread_id AS threadId,
                 workspace_id AS workspaceId,
                 owner_id AS ownerId,
                 owner_instance_id AS ownerInstanceId,
                 owner_type AS ownerType,
                 epoch,
                 lease_expires_at AS leaseExpiresAt,
                 capabilities_json AS capabilitiesJson,
                 updated_at AS updatedAt
          FROM thread_owners
          ${where}`;
}

function turnClaimSelectSql(where: string) {
  return `SELECT claim_id AS claimId,
                 thread_id AS threadId,
                 input_id AS inputId,
                 owner_id AS ownerId,
                 owner_epoch AS ownerEpoch,
                 runtime_turn_id AS runtimeTurnId,
                 dispatch_started_at AS dispatchStartedAt,
                 state,
                 created_at AS createdAt,
                 updated_at AS updatedAt,
                 terminal_at AS terminalAt
          FROM turn_claims
          ${where}`;
}

function turnClaimFromRow(row: Record<string, unknown>): TurnClaim {
  return {
    claimId: String(row.claimId),
    createdAt: new Date(Number(row.createdAt)).toISOString(),
    dispatchStartedAt:
      typeof row.dispatchStartedAt === "number"
        ? new Date(row.dispatchStartedAt).toISOString()
        : undefined,
    inputId: String(row.inputId),
    ownerEpoch: normalizePositiveInteger(Number(row.ownerEpoch), "turn claim owner epoch"),
    ownerId: String(row.ownerId),
    runtimeTurnId: typeof row.runtimeTurnId === "string" ? row.runtimeTurnId : undefined,
    state: turnClaimStateFromRow(row.state),
    terminalAt:
      typeof row.terminalAt === "number" ? new Date(row.terminalAt).toISOString() : undefined,
    threadId: String(row.threadId),
    updatedAt: new Date(Number(row.updatedAt)).toISOString(),
  };
}

function turnClaimStateFromRow(value: unknown): TurnClaimState {
  if (turnClaimStates.includes(value as TurnClaimState)) {
    return value as TurnClaimState;
  }
  throw new Error(`Invalid turn claim state: ${String(value)}`);
}

async function insertTurnClaim(
  database: QueryableRelayStateDatabase,
  input: {
    claimId: string;
    inputId: string;
    now: number;
    ownerEpoch: number;
    ownerId: string;
    threadId: string;
  },
) {
  await database
    .prepare(
      `INSERT INTO turn_claims (
         claim_id,
         thread_id,
         input_id,
         owner_id,
         owner_epoch,
         runtime_turn_id,
         dispatch_started_at,
         state,
         created_at,
         updated_at,
         terminal_at
       ) VALUES (?, ?, ?, ?, ?, NULL, NULL, 'active', ?, ?, NULL)`,
    )
    .run(
      input.claimId,
      input.threadId,
      input.inputId,
      input.ownerId,
      input.ownerEpoch,
      input.now,
      input.now,
    );
  await database
    .prepare("UPDATE thread_inputs SET state = 'running', updated_at = ? WHERE input_id = ?")
    .run(input.now, input.inputId);
}

function isClaimableThreadInputState(state: ThreadInputState) {
  return (
    state === "persisted" ||
    state === "accepted" ||
    state === "queued" ||
    state === "steered" ||
    state === "dispatched"
  );
}

function parseTimestamp(value: string, field: string) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`Invalid ${field} timestamp: ${value}`);
  }
  return timestamp;
}

function threadInputStateFromRow(value: unknown): ThreadInputState {
  if (threadInputStates.includes(value as ThreadInputState)) {
    return value as ThreadInputState;
  }
  throw new Error(`Invalid thread input state: ${String(value)}`);
}

function normalizeNonnegativeInteger(value: number, field: string) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a nonnegative integer.`);
  }
  return value;
}

function normalizePositiveInteger(value: number, field: string) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive integer.`);
  }
  return value;
}
