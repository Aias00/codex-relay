export const threadSyncStates = [
  "cached",
  "syncing",
  "hydrating-history",
  "synced",
  "stale",
] as const;

export type ThreadSyncState = (typeof threadSyncStates)[number];

export function threadSyncLabel(state: ThreadSyncState) {
  switch (state) {
    case "cached":
      return "Showing cached messages";
    case "syncing":
      return "Syncing latest messages";
    case "hydrating-history":
      return "Filling older history";
    case "stale":
      return "Using cached messages";
    case "synced":
      return "Up to date";
  }
}
