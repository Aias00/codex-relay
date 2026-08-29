import {
  ConnectionPlanResponseSchema,
  type ConnectionPlanCandidate,
  type ConnectionPlanResponse,
  type HealthResponse,
} from "codex-relay/api-schema";

import { codexRelayStorage as storage } from "./codex-relay-server-url-storage";

const connectionPlanStorageKey = "codex-relay.connection-plan";
const routeObservationsStorageKey = "codex-relay.connection-route-observations";
const defaultPerRouteTimeoutMs = 2000;
const defaultTotalBudgetMs = 7000;
const lastSuccessFreshnessMs = 24 * 60 * 60 * 1000;
const maximumStoredObservations = 100;

export type ConnectionRouteObservation = {
  relayId: string;
  routeId: string;
  url: string;
  serverEpoch: string;
  consecutiveFailures: number;
  lastFailedAt?: number;
  lastSucceededAt?: number;
};

export type ConnectionPlanFetchResult =
  | { status: "available"; plan: ConnectionPlanResponse }
  | { status: "unsupported" };

export type ConnectionPlanResolution =
  | {
      status: "resolved";
      candidate: ConnectionPlanCandidate;
      plan: ConnectionPlanResponse;
    }
  | { status: "legacy"; planUnavailable: boolean };

export async function requestWithConnectionCandidateRefresh<T>(input: {
  getCandidateUrls: () => string[];
  refreshCandidates: () => Promise<boolean>;
  request: (serverUrl: string) => Promise<T>;
}) {
  const initialAttempt = await requestFirstCandidate(input.getCandidateUrls(), input.request);
  if (initialAttempt.result) {
    return initialAttempt.result;
  }

  if (await input.refreshCandidates()) {
    const refreshedAttempt = await requestFirstCandidate(input.getCandidateUrls(), input.request);
    if (refreshedAttempt.result) {
      return refreshedAttempt.result;
    }
    throw refreshedAttempt.error;
  }

  throw initialAttempt.error;
}

export async function resolveConnectionPlanRoute(input: {
  bootstrapUrls: string[];
  fetchPlan: (serverUrl: string, timeoutMs: number) => Promise<ConnectionPlanFetchResult>;
  probeHealth: (
    candidate: ConnectionPlanCandidate,
    timeoutMs: number,
  ) => Promise<HealthResponse | undefined>;
  now?: () => number;
  perRouteTimeoutMs?: number;
  totalBudgetMs?: number;
}): Promise<ConnectionPlanResolution> {
  const now = input.now ?? Date.now;
  const deadline = now() + (input.totalBudgetMs ?? defaultTotalBudgetMs);
  const perRouteTimeoutMs = input.perRouteTimeoutMs ?? defaultPerRouteTimeoutMs;
  const cachedPlan = getStoredConnectionPlan();
  const discoveryUrls = dedupeUrls([
    ...input.bootstrapUrls,
    ...(cachedPlan ? orderConnectionPlanCandidates(cachedPlan, now()).map(({ url }) => url) : []),
  ]);
  const initialRequest = await fetchFirstPlan({
    deadline,
    fetchPlan: input.fetchPlan,
    now,
    perRouteTimeoutMs,
    serverUrls: discoveryUrls,
  });

  if (!initialRequest.plan) {
    if (cachedPlan) {
      const cachedCandidate = await probePlan({
        deadline,
        now,
        perRouteTimeoutMs,
        plan: cachedPlan,
        probeHealth: input.probeHealth,
      });
      if (cachedCandidate) {
        return { candidate: cachedCandidate, plan: cachedPlan, status: "resolved" };
      }
    }
    return {
      planUnavailable:
        initialRequest.attempts > 0 &&
        initialRequest.unsupportedAttempts === initialRequest.attempts,
      status: "legacy",
    };
  }

  saveConnectionPlan(initialRequest.plan);
  const initialCandidate = await probePlan({
    deadline,
    now,
    perRouteTimeoutMs,
    plan: initialRequest.plan,
    probeHealth: input.probeHealth,
  });
  if (initialCandidate) {
    return { candidate: initialCandidate, plan: initialRequest.plan, status: "resolved" };
  }

  const refreshedRequest = await fetchFirstPlan({
    deadline,
    fetchPlan: input.fetchPlan,
    now,
    perRouteTimeoutMs,
    serverUrls: dedupeUrls([
      ...orderConnectionPlanCandidates(initialRequest.plan, now()).map(({ url }) => url),
      ...discoveryUrls,
    ]),
  });
  if (!refreshedRequest.plan) {
    return { planUnavailable: false, status: "legacy" };
  }

  saveConnectionPlan(refreshedRequest.plan);
  const refreshedCandidate = await probePlan({
    deadline,
    now,
    perRouteTimeoutMs,
    plan: refreshedRequest.plan,
    probeHealth: input.probeHealth,
  });
  return refreshedCandidate
    ? { candidate: refreshedCandidate, plan: refreshedRequest.plan, status: "resolved" }
    : { planUnavailable: false, status: "legacy" };
}

export function orderConnectionPlanCandidates(plan: ConnectionPlanResponse, now = Date.now()) {
  const observations = new Map(
    getConnectionRouteObservations()
      .filter(({ relayId }) => relayId === plan.relayId)
      .map((observation) => [observation.routeId, observation]),
  );
  return [...plan.candidates].sort((left, right) => {
    const leftObservation = matchingObservation(observations.get(left.routeId), left);
    const rightObservation = matchingObservation(observations.get(right.routeId), right);
    const leftFresh = isFreshSuccess(leftObservation, now);
    const rightFresh = isFreshSuccess(rightObservation, now);
    if (leftFresh !== rightFresh) {
      return rightFresh ? 1 : -1;
    }
    if (leftFresh && rightFresh) {
      const successDifference =
        (rightObservation?.lastSucceededAt ?? 0) - (leftObservation?.lastSucceededAt ?? 0);
      if (successDifference !== 0) {
        return successDifference;
      }
    }
    return right.priority - left.priority || left.routeId.localeCompare(right.routeId);
  });
}

export function recordConnectionRouteSuccess(
  plan: ConnectionPlanResponse,
  candidate: ConnectionPlanCandidate,
  now = Date.now(),
) {
  updateConnectionRouteObservation(plan, candidate, (current) => ({
    ...current,
    consecutiveFailures: 0,
    lastSucceededAt: now,
    serverEpoch: plan.serverEpoch,
  }));
}

export function recordConnectionRouteFailure(
  plan: ConnectionPlanResponse,
  candidate: ConnectionPlanCandidate,
  now = Date.now(),
) {
  updateConnectionRouteObservation(plan, candidate, (current) => ({
    ...current,
    consecutiveFailures: current.consecutiveFailures + 1,
    lastFailedAt: now,
    serverEpoch: plan.serverEpoch,
  }));
}

export function getStoredConnectionPlan() {
  const parsed = readStoredJson(connectionPlanStorageKey);
  const result = ConnectionPlanResponseSchema.safeParse(parsed);
  return result.success ? result.data : undefined;
}

export function getConnectionRouteObservations(): ConnectionRouteObservation[] {
  const parsed = readStoredJson(routeObservationsStorageKey);
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.filter(isConnectionRouteObservation);
}

export function clearCodexRelayConnectionPlanState() {
  clearStoredConnectionPlan();
  storage.remove(routeObservationsStorageKey);
}

export function clearStoredConnectionPlan() {
  storage.remove(connectionPlanStorageKey);
}

async function fetchFirstPlan(input: {
  deadline: number;
  fetchPlan: (serverUrl: string, timeoutMs: number) => Promise<ConnectionPlanFetchResult>;
  now: () => number;
  perRouteTimeoutMs: number;
  serverUrls: string[];
}) {
  let attempts = 0;
  let unsupportedAttempts = 0;
  for (const serverUrl of input.serverUrls) {
    const timeoutMs = remainingAttemptTimeout(input.deadline, input.now(), input.perRouteTimeoutMs);
    if (timeoutMs === 0) {
      break;
    }
    attempts += 1;
    try {
      const result = await input.fetchPlan(serverUrl, timeoutMs);
      if (result.status === "unsupported") {
        unsupportedAttempts += 1;
        continue;
      }
      return {
        attempts,
        plan: ConnectionPlanResponseSchema.parse(result.plan),
        unsupportedAttempts,
      };
    } catch {
      continue;
    }
  }
  return { attempts, plan: undefined, unsupportedAttempts };
}

async function probePlan(input: {
  deadline: number;
  now: () => number;
  perRouteTimeoutMs: number;
  plan: ConnectionPlanResponse;
  probeHealth: (
    candidate: ConnectionPlanCandidate,
    timeoutMs: number,
  ) => Promise<HealthResponse | undefined>;
}) {
  for (const candidate of orderConnectionPlanCandidates(input.plan, input.now())) {
    const timeoutMs = remainingAttemptTimeout(input.deadline, input.now(), input.perRouteTimeoutMs);
    if (timeoutMs === 0) {
      break;
    }
    try {
      const health = await input.probeHealth(candidate, timeoutMs);
      if (
        health?.ok === true &&
        health.service === "codex-relay-server" &&
        health.relayId === input.plan.relayId &&
        health.serverEpoch === input.plan.serverEpoch
      ) {
        recordConnectionRouteSuccess(input.plan, candidate, input.now());
        return candidate;
      }
    } catch {
      // A failed probe is a route observation, not a session failure.
    }
    recordConnectionRouteFailure(input.plan, candidate, input.now());
  }
  return undefined;
}

function saveConnectionPlan(plan: ConnectionPlanResponse) {
  storage.set(connectionPlanStorageKey, JSON.stringify(ConnectionPlanResponseSchema.parse(plan)));
}

async function requestFirstCandidate<T>(
  serverUrls: string[],
  request: (serverUrl: string) => Promise<T>,
) {
  let error: unknown = new Error("Network request failed for all saved server URLs.");
  for (const serverUrl of serverUrls) {
    try {
      return { result: { serverUrl, value: await request(serverUrl) } };
    } catch (caught) {
      error = caught;
    }
  }
  return { error, result: undefined };
}

function updateConnectionRouteObservation(
  plan: ConnectionPlanResponse,
  candidate: ConnectionPlanCandidate,
  update: (current: ConnectionRouteObservation) => ConnectionRouteObservation,
) {
  const observations = getConnectionRouteObservations();
  const index = observations.findIndex(
    ({ relayId, routeId }) => relayId === plan.relayId && routeId === candidate.routeId,
  );
  const current: ConnectionRouteObservation =
    index >= 0
      ? observations[index]
      : {
          consecutiveFailures: 0,
          relayId: plan.relayId,
          routeId: candidate.routeId,
          serverEpoch: plan.serverEpoch,
          url: candidate.url,
        };
  const next = update({ ...current, url: candidate.url });
  if (index >= 0) {
    observations[index] = next;
  } else {
    observations.push(next);
  }
  storage.set(
    routeObservationsStorageKey,
    JSON.stringify(observations.slice(-maximumStoredObservations)),
  );
}

function matchingObservation(
  observation: ConnectionRouteObservation | undefined,
  candidate: ConnectionPlanCandidate,
) {
  return observation?.url === candidate.url ? observation : undefined;
}

function isFreshSuccess(observation: ConnectionRouteObservation | undefined, now: number) {
  if (!observation?.lastSucceededAt) {
    return false;
  }
  return (
    observation.lastSucceededAt >= now - lastSuccessFreshnessMs &&
    (observation.lastFailedAt ?? 0) <= observation.lastSucceededAt
  );
}

function remainingAttemptTimeout(deadline: number, now: number, perRouteTimeoutMs: number) {
  return Math.max(0, Math.min(perRouteTimeoutMs, deadline - now));
}

function dedupeUrls(urls: string[]) {
  return [...new Set(urls.filter(Boolean))];
}

function readStoredJson(key: string) {
  const stored = storage.getString(key);
  if (!stored) {
    return undefined;
  }
  try {
    return JSON.parse(stored) as unknown;
  } catch {
    return undefined;
  }
}

function isConnectionRouteObservation(value: unknown): value is ConnectionRouteObservation {
  if (!value || typeof value !== "object") {
    return false;
  }
  const observation = value as Partial<ConnectionRouteObservation>;
  return (
    typeof observation.relayId === "string" &&
    typeof observation.routeId === "string" &&
    typeof observation.url === "string" &&
    typeof observation.serverEpoch === "string" &&
    typeof observation.consecutiveFailures === "number" &&
    (observation.lastFailedAt === undefined || typeof observation.lastFailedAt === "number") &&
    (observation.lastSucceededAt === undefined || typeof observation.lastSucceededAt === "number")
  );
}
