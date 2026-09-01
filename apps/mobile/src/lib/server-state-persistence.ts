export const serverStateRootKey = "codex-relay-server-state";

const persistableServerStateScopes = new Set(["models", "status", "threads"]);
const persistableThreadStateScopes = new Set(["detail", "event-cursor"]);

export function isAppHydrationReady(input: { fontsLoaded: boolean; queryCacheRestored: boolean }) {
  return input.fontsLoaded && input.queryCacheRestored;
}

export function isPersistableServerStateQueryKey(queryKey: readonly unknown[]) {
  if (queryKey[0] !== serverStateRootKey) {
    return false;
  }
  if (queryKey[1] === "event-cursor") {
    return typeof queryKey[2] === "string" && queryKey[2].length > 0;
  }
  const scopeIndex = typeof queryKey[2] === "string" && queryKey[2].startsWith("relay:") ? 3 : 2;
  const scope = String(queryKey[scopeIndex] ?? "");
  const threadStateScope = String(queryKey.at(-1) ?? "");
  return (
    persistableServerStateScopes.has(scope) ||
    (scope === "thread" && persistableThreadStateScopes.has(threadStateScope))
  );
}
