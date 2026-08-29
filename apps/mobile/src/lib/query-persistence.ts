import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import { defaultShouldDehydrateQuery, type Query } from "@tanstack/react-query";
import { createMMKV } from "react-native-mmkv";

import { isPersistableServerStateQueryKey } from "@/lib/server-state-persistence";

const storage = createMMKV({ id: "codex-relay-query-cache" });

const clientStorage = {
  setItem(key: string, value: string) {
    storage.set(key, value);
  },
  getItem(key: string) {
    return storage.getString(key) ?? null;
  },
  removeItem(key: string) {
    storage.remove(key);
  },
};

export const queryClientPersister = createAsyncStoragePersister({
  key: "codex-relay.react-query",
  storage: clientStorage,
  throttleTime: 1000,
});

export const persistedQueryMaxAgeMs = 7 * 24 * 60 * 60 * 1000;

export function shouldPersistQuery(query: Query) {
  return defaultShouldDehydrateQuery(query) && isPersistableServerStateQueryKey(query.queryKey);
}
