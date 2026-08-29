import type { AppServerTurn, CodexAppServerClient } from "./app-server.js";
import { relayDebugLog } from "./debug-log.js";
import type {
  AdoptActiveTurnClaimResult,
  ThreadCoordinatorStore,
  ThreadInput,
  ThreadOwner,
  ThreadOwnerCapabilities,
  ThreadOwnerType,
  TurnClaim,
} from "./relay-state-store.js";

export type RecoveredActiveTurnClaim = {
  claim: TurnClaim;
  input: ThreadInput;
  owner: ThreadOwner;
};

export type RecoverActiveTurnClaimsResult = {
  recovered: RecoveredActiveTurnClaim[];
  skipped: number;
  terminal: number;
};

export async function recoverActiveAppServerTurnClaims(input: {
  appServer: CodexAppServerClient;
  capabilities: ThreadOwnerCapabilities;
  coordinator: ThreadCoordinatorStore;
  ownerId: string;
  ownerInstanceId: string;
  ownerType: ThreadOwnerType;
}): Promise<RecoverActiveTurnClaimsResult> {
  const result: RecoverActiveTurnClaimsResult = { recovered: [], skipped: 0, terminal: 0 };
  const claims = await input.coordinator.listActiveTurnClaims();
  for (const claim of claims) {
    if (!claim.runtimeTurnId && !claim.dispatchStartedAt) {
      result.skipped += 1;
      relayDebugLog("thread.claim.recovery_skipped", {
        claimId: claim.claimId,
        reason: "dispatch_unknown",
        threadId: claim.threadId,
      });
      continue;
    }

    const previousOwner = await input.coordinator.getThreadOwner(claim.threadId);
    if (!previousOwner) {
      result.skipped += 1;
      relayDebugLog("thread.claim.recovery_skipped", {
        claimId: claim.claimId,
        reason: "owner_missing",
        threadId: claim.threadId,
        turnId: claim.runtimeTurnId,
      });
      continue;
    }

    let turns: AppServerTurn[] | undefined;
    try {
      const thread = await input.appServer.readThread(claim.threadId, { includeTurns: true });
      turns = thread.turns;
    } catch {
      result.skipped += 1;
      relayDebugLog("thread.claim.recovery_skipped", {
        claimId: claim.claimId,
        reason: "thread_read_failed",
        threadId: claim.threadId,
        turnId: claim.runtimeTurnId,
      });
      continue;
    }
    let recoverableClaim = claim;
    let turn: AppServerTurn | undefined;
    let needsDispatchBinding = false;
    if (claim.runtimeTurnId) {
      turn = turns?.find((candidate) => candidate.id === claim.runtimeTurnId);
    } else {
      const candidates = dispatchedTurnCandidates(turns ?? [], claim.dispatchStartedAt!);
      if (candidates.length !== 1) {
        result.skipped += 1;
        relayDebugLog("thread.claim.recovery_skipped", {
          candidateCount: candidates.length,
          claimId: claim.claimId,
          reason: "dispatch_candidate_not_unique",
          threadId: claim.threadId,
        });
        continue;
      }
      turn = candidates[0];
      needsDispatchBinding = true;
    }
    if (!turn) {
      result.skipped += 1;
      relayDebugLog("thread.claim.recovery_skipped", {
        claimId: claim.claimId,
        reason: "runtime_turn_missing",
        threadId: claim.threadId,
        turnId: claim.runtimeTurnId,
      });
      continue;
    }

    const state = appServerRecoveredTurnState(turn);
    if (state === "unknown") {
      result.skipped += 1;
      relayDebugLog("thread.claim.recovery_skipped", {
        claimId: claim.claimId,
        reason: "runtime_state_unknown",
        threadId: claim.threadId,
        turnId: claim.runtimeTurnId,
      });
      continue;
    }
    if (needsDispatchBinding) {
      const bound = await input.coordinator.bindTurnClaimRuntimeTurn({
        claimId: claim.claimId,
        ownerEpoch: claim.ownerEpoch,
        ownerId: claim.ownerId,
        runtimeTurnId: turn.id,
      });
      if (bound.kind !== "updated" && bound.kind !== "already_bound") {
        result.skipped += 1;
        relayDebugLog("thread.claim.recovery_skipped", {
          claimId: claim.claimId,
          reason: `dispatch_bind_${bound.kind}`,
          threadId: claim.threadId,
          turnId: turn.id,
        });
        continue;
      }
      recoverableClaim = bound.claim;
    }

    const adopted = await input.coordinator.adoptActiveTurnClaim({
      capabilities: input.capabilities,
      claimId: recoverableClaim.claimId,
      ownerId: input.ownerId,
      ownerInstanceId: input.ownerInstanceId,
      ownerType: input.ownerType,
      runtimeTurnId: recoverableClaim.runtimeTurnId!,
      threadId: recoverableClaim.threadId,
      workspaceId: previousOwner.workspaceId,
    });
    if (adopted.kind !== "adopted" && adopted.kind !== "already_owned") {
      result.skipped += 1;
      logAdoptionSkipped(recoverableClaim, adopted);
      continue;
    }

    if (state === "running") {
      result.recovered.push({ claim: adopted.claim, input: adopted.input, owner: adopted.owner });
      relayDebugLog("thread.claim.recovered", {
        claimId: adopted.claim.claimId,
        ownerEpoch: adopted.claim.ownerEpoch,
        state,
        threadId: adopted.claim.threadId,
        turnId: adopted.claim.runtimeTurnId,
      });
      continue;
    }

    const finalized = await input.coordinator.finalizeTurnClaim({
      claimId: adopted.claim.claimId,
      ownerEpoch: adopted.claim.ownerEpoch,
      ownerId: adopted.claim.ownerId,
      state,
    });
    if (finalized.kind === "updated" || finalized.kind === "already_terminal") {
      result.terminal += 1;
      relayDebugLog("thread.claim.recovered", {
        claimId: adopted.claim.claimId,
        ownerEpoch: adopted.claim.ownerEpoch,
        state,
        threadId: adopted.claim.threadId,
        turnId: adopted.claim.runtimeTurnId,
      });
    } else {
      result.skipped += 1;
      relayDebugLog("thread.claim.recovery_skipped", {
        claimId: adopted.claim.claimId,
        reason: finalized.kind,
        threadId: adopted.claim.threadId,
        turnId: adopted.claim.runtimeTurnId,
      });
    }
  }
  return result;
}

function dispatchedTurnCandidates(turns: AppServerTurn[], dispatchStartedAt: string) {
  const dispatchStartedAtMs = Date.parse(dispatchStartedAt);
  if (!Number.isFinite(dispatchStartedAtMs)) {
    return [];
  }
  return turns.filter((turn) => {
    if (turn.startedAt === null || !Number.isFinite(turn.startedAt)) {
      return false;
    }
    const startedAtMs =
      turn.startedAt < 1_000_000_000_000 ? turn.startedAt * 1_000 : turn.startedAt;
    return (
      startedAtMs >= dispatchStartedAtMs - 1_500 && startedAtMs <= dispatchStartedAtMs + 30_000
    );
  });
}

export function appServerRecoveredTurnState(turn: AppServerTurn) {
  const status = turnStatusType(turn.status);
  if (["active", "inProgress", "in_progress", "running"].includes(status ?? "")) {
    return "running" as const;
  }
  if (["aborted", "canceled", "cancelled", "interrupted"].includes(status ?? "")) {
    return "cancelled" as const;
  }
  if (["error", "failed"].includes(status ?? "") || turn.error) {
    return "failed" as const;
  }
  if (
    ["complete", "completed", "idle"].includes(status ?? "") ||
    (turn.completedAt !== null && turn.completedAt !== undefined)
  ) {
    return "completed" as const;
  }
  return "unknown" as const;
}

function turnStatusType(status: unknown) {
  if (typeof status === "string") {
    return status;
  }
  if (!status || typeof status !== "object") {
    return undefined;
  }
  const record = status as Record<string, unknown>;
  return typeof record.type === "string"
    ? record.type
    : typeof record.status === "string"
      ? record.status
      : undefined;
}

function logAdoptionSkipped(claim: TurnClaim, result: AdoptActiveTurnClaimResult) {
  relayDebugLog("thread.claim.recovery_skipped", {
    claimId: claim.claimId,
    reason: result.kind,
    threadId: claim.threadId,
    turnId: claim.runtimeTurnId,
  });
}
