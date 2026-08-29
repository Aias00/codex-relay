export const serverStateRootKey = "codex-relay-server-state";

const persistableServerStateScopes = new Set(["models", "status", "threads"]);
const persistableThreadStateScopes = new Set(["detail", "event-cursor"]);

export function isPersistableServerStateQueryKey(queryKey: readonly unknown[]) {
  if (queryKey[0] !== serverStateRootKey) {
    return false;
  }
  if (queryKey[1] === "event-cursor") {
    return typeof queryKey[2] === "string" && queryKey[2].length > 0;
  }
  const scope = String(queryKey[2] ?? "");
  const threadStateScope = String(queryKey[5] ?? queryKey[4] ?? "");
  return (
    persistableServerStateScopes.has(scope) ||
    (scope === "thread" && persistableThreadStateScopes.has(threadStateScope))
  );
}
