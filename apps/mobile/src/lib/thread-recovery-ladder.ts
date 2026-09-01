export type ThreadRecoverySnapshot = {
  hasOlderMessages?: boolean;
};

export type ThreadReplayRecoveryResult = {
  available: boolean;
  lastSequence: number;
  resetRequired: boolean;
};

export type ThreadRecoveryLadderResult<TSnapshot extends ThreadRecoverySnapshot> = {
  olderHistory?: Promise<void>;
  replay?: ThreadReplayRecoveryResult;
  snapshot?: TSnapshot;
  source: "events" | "message-cursor" | "snapshot";
};

export async function runThreadRecoveryLadder<TSnapshot extends ThreadRecoverySnapshot>(input: {
  baselineSnapshot?: TSnapshot;
  hydrateOlderHistory(): Promise<void>;
  isSequenceGap(error: unknown): boolean;
  refreshFromMessageCursor(): Promise<TSnapshot>;
  refreshRecentSnapshot(): Promise<TSnapshot>;
  replayEvents(): Promise<ThreadReplayRecoveryResult>;
  setEventCursor(sequence: number): void;
}): Promise<ThreadRecoveryLadderResult<TSnapshot>> {
  let replay: ThreadReplayRecoveryResult | undefined;
  let sequenceGap = false;
  try {
    replay = await input.replayEvents();
  } catch (error) {
    if (!input.isSequenceGap(error)) {
      throw error;
    }
    sequenceGap = true;
  }

  if (replay?.available && !replay.resetRequired) {
    return { replay, source: "events" };
  }

  if (input.baselineSnapshot) {
    if (replay?.resetRequired) {
      input.setEventCursor(replay.lastSequence);
    }
    return withOlderHistory(input, {
      replay,
      snapshot: input.baselineSnapshot,
      source: "snapshot",
    });
  }

  if (!sequenceGap && replay && !replay.available) {
    try {
      const snapshot = await input.refreshFromMessageCursor();
      return withOlderHistory(input, { replay, snapshot, source: "message-cursor" });
    } catch {
      // A recent authoritative snapshot is the final bounded recovery source.
    }
  }

  const snapshot = await input.refreshRecentSnapshot();
  if (replay?.resetRequired) {
    input.setEventCursor(replay.lastSequence);
  }
  return withOlderHistory(input, { replay, snapshot, source: "snapshot" });
}

function withOlderHistory<TSnapshot extends ThreadRecoverySnapshot>(
  input: { hydrateOlderHistory(): Promise<void> },
  result: Omit<ThreadRecoveryLadderResult<TSnapshot>, "olderHistory"> & { snapshot: TSnapshot },
): ThreadRecoveryLadderResult<TSnapshot> {
  return result.snapshot.hasOlderMessages
    ? { ...result, olderHistory: input.hydrateOlderHistory() }
    : result;
}
