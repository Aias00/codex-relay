import type { RuntimePreferences } from "codex-relay/api-schema";

export type RuntimePreferencesStage = {
  readonly revision: number;
  readonly scopeKey: string;
};

type RuntimePreferencesDraft = {
  readonly preferences: RuntimePreferences;
  readonly revision: number;
};

export function createRuntimePreferencesCoordinator() {
  const draftsByScope = new Map<string, RuntimePreferencesDraft>();
  let nextRevision = 0;
  let updateQueue = Promise.resolve();

  function stage(scopeKey: string, preferences: RuntimePreferences): RuntimePreferencesStage {
    const revision = ++nextRevision;
    draftsByScope.set(scopeKey, { preferences, revision });
    return { revision, scopeKey };
  }

  function current(scopeKey: string) {
    return draftsByScope.get(scopeKey)?.preferences;
  }

  function isPending(scopeKey: string) {
    return draftsByScope.has(scopeKey);
  }

  function settle(stageToSettle: RuntimePreferencesStage) {
    if (draftsByScope.get(stageToSettle.scopeKey)?.revision !== stageToSettle.revision) {
      return false;
    }
    draftsByScope.delete(stageToSettle.scopeKey);
    return true;
  }

  function enqueue<Result>(operation: () => Promise<Result>) {
    const result = updateQueue.then(operation);
    updateQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  function afterUpdates() {
    return updateQueue;
  }

  return { afterUpdates, current, enqueue, isPending, settle, stage };
}
