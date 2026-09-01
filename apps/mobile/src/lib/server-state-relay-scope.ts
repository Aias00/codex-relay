import type { QueryKey } from "@tanstack/react-query";

import { serverStateRootKey } from "./server-state-persistence";

const relayScopePrefix = "relay:";

export function serverStateRootForRelay(serverUrl: string, relayId: string | undefined) {
  return relayId
    ? ([serverStateRootKey, serverUrl, `${relayScopePrefix}${relayId}`] as const)
    : ([serverStateRootKey, serverUrl] as const);
}

export function legacyServerStateRoot(serverUrl: string) {
  return [serverStateRootKey, serverUrl] as const;
}

export function relayScopedServerStateQueryKey(
  queryKey: QueryKey,
  serverUrl: string,
  relayId: string,
): QueryKey | undefined {
  if (queryKey[0] !== serverStateRootKey || queryKey[1] !== serverUrl) {
    return undefined;
  }
  if (typeof queryKey[2] === "string" && queryKey[2].startsWith(relayScopePrefix)) {
    return undefined;
  }
  return [queryKey[0], queryKey[1], `${relayScopePrefix}${relayId}`, ...queryKey.slice(2)];
}

export function isRelayScopedServerStateQueryKey(queryKey: QueryKey) {
  return typeof queryKey[2] === "string" && queryKey[2].startsWith(relayScopePrefix);
}
