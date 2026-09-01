import { createHash, randomUUID } from "node:crypto";

import {
  ConnectionPlanResponseSchema,
  HealthResponseSchema,
  apiPaths,
  type ConnectionPlanResponse,
  type HealthResponse,
  type HttpConnectionPlanCandidate,
  type TailcatConnectionPlanCandidate,
} from "./api-schema.js";

export type ConnectionPlanSourceCandidate = {
  label?: string;
  url: string;
};

const defaultConnectionPlanTtlMs = 5 * 60 * 1000;

export function relayIdFromServerPublicKey(serverPublicKey: string) {
  return `relay_${stableHash(serverPublicKey, 24)}`;
}

export function createServerEpoch() {
  return randomUUID();
}

export function createHealthResponse(input: {
  relayId: string;
  serverEpoch: string;
}): HealthResponse {
  return HealthResponseSchema.parse({
    ok: true,
    relayId: input.relayId,
    serverEpoch: input.serverEpoch,
    service: "codex-relay-server",
  });
}

export function createConnectionPlan(input: {
  candidates: ConnectionPlanSourceCandidate[];
  now?: number;
  relayId: string;
  serverEpoch: string;
  tailcatCandidates?: TailcatConnectionPlanCandidate[];
  ttlMs?: number;
}): ConnectionPlanResponse {
  const now = input.now ?? Date.now();
  const candidates = [
    ...(input.tailcatCandidates ?? []),
    ...normalizeConnectionPlanCandidates(input.candidates),
  ].sort(
    (left, right) => right.priority - left.priority || left.routeId.localeCompare(right.routeId),
  );
  return ConnectionPlanResponseSchema.parse({
    candidates,
    expiresAt: new Date(now + (input.ttlMs ?? defaultConnectionPlanTtlMs)).toISOString(),
    refreshPath: apiPaths.connectionPlan,
    relayId: input.relayId,
    serverEpoch: input.serverEpoch,
  });
}

export function normalizeConnectionPlanCandidates(candidates: ConnectionPlanSourceCandidate[]) {
  const deduped = new Map<string, HttpConnectionPlanCandidate>();
  for (const candidate of candidates) {
    const normalizedUrl = normalizeCandidateUrl(candidate.url);
    if (!normalizedUrl || deduped.has(normalizedUrl)) {
      continue;
    }
    const kind = connectionRouteKind(normalizedUrl, candidate.label);
    if (!kind) {
      continue;
    }
    deduped.set(normalizedUrl, {
      kind,
      priority: routePriority(kind) - deduped.size,
      routeId: `route_${stableHash(normalizedUrl, 20)}`,
      url: normalizedUrl,
    });
  }
  return [...deduped.values()].sort((left, right) => right.priority - left.priority);
}

function connectionRouteKind(
  url: string,
  label: string | undefined,
): HttpConnectionPlanCandidate["kind"] | undefined {
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase();
  const normalizedLabel = label?.toLowerCase() ?? "";
  if (isUnspecifiedOrLocalhost(host)) {
    return undefined;
  }
  if (isLinkLocalIpv4(host)) {
    return "link_local";
  }
  if (
    normalizedLabel.includes("tailscale") ||
    host.endsWith(".ts.net") ||
    host.endsWith(".beta.tailscale.net") ||
    isTailscaleIpv4(host)
  ) {
    return "tailscale";
  }
  if (parsed.protocol === "https:" && !isLocalNetworkHost(host)) {
    return "public_https";
  }
  if (isLocalNetworkHost(host) || parsed.protocol === "http:") {
    return "lan";
  }
  return undefined;
}

function routePriority(kind: HttpConnectionPlanCandidate["kind"]) {
  switch (kind) {
    case "public_https":
      return 500;
    case "tailscale":
      return 450;
    case "lan":
      return 300;
    case "link_local":
      return 100;
    case "last_success":
      return 600;
  }
}

function normalizeCandidateUrl(value: string) {
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    parsed.pathname = parsed.pathname.replace(/\/$/, "");
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

function isUnspecifiedOrLocalhost(host: string) {
  return host === "0.0.0.0" || host === "::" || host === "localhost" || host === "127.0.0.1";
}

function isLinkLocalIpv4(host: string) {
  const octets = ipv4Octets(host);
  return Boolean(octets && octets[0] === 169 && octets[1] === 254);
}

function isTailscaleIpv4(host: string) {
  const octets = ipv4Octets(host);
  return Boolean(octets && octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127);
}

function isLocalNetworkHost(host: string) {
  const octets = ipv4Octets(host);
  if (octets) {
    return (
      octets[0] === 10 ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 192 && octets[1] === 168) ||
      isLinkLocalIpv4(host)
    );
  }
  return host.endsWith(".local") || host.startsWith("fe80:") || /^f[cd]/i.test(host);
}

function ipv4Octets(host: string) {
  const octets = host.split(".").map(Number);
  return octets.length === 4 &&
    octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)
    ? octets
    : undefined;
}

function stableHash(value: string, length: number) {
  return createHash("sha256").update(value).digest("base64url").slice(0, length);
}
