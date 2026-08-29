export const foregroundRefreshDedupeMs = 10_000;

export function shouldStartForegroundRefresh(
  lastStartedAt: number | undefined,
  now: number,
  dedupeMs = foregroundRefreshDedupeMs,
) {
  return lastStartedAt === undefined || now - lastStartedAt >= dedupeMs;
}

export async function runConnectionRefresh<Status, Data>(
  statusRequest: Promise<Status>,
  dataRequest: (status: Status) => Promise<Data>,
  onStatus: (status: Status) => void,
) {
  const status = await statusRequest;
  onStatus(status);
  return dataRequest(status);
}
