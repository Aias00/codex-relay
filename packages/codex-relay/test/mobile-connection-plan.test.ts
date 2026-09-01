import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ConnectionPlanResponse,
  HealthResponse,
  HttpConnectionPlanCandidate,
} from "../src/api-schema.js";
import {
  clearCodexRelayConnectionPlanState,
  currentConnectionPlanServerUrls,
  currentStoredConnectionPlanServerUrls,
  getConnectionRouteObservations,
  getStoredConnectionPlan,
  orderConnectionPlanCandidates,
  recordConnectionRouteFailure,
  recordConnectionRouteSuccess,
  requestWithConnectionCandidateRefresh,
  resolveConnectionPlanRoute,
  transportBenchmarkRouteForServerUrl,
} from "../../../apps/mobile/src/lib/codex-relay-connection-plan.js";

const now = Date.parse("2026-08-26T12:00:00.000Z");

beforeEach(() => {
  clearCodexRelayConnectionPlanState();
});

describe("mobile connection plans", () => {
  it("replaces stale LAN bootstrap addresses with the current Relay plan", () => {
    const plan = connectionPlan();

    expect(currentConnectionPlanServerUrls(plan, httpCandidate(plan, 0))).toEqual([
      "https://relay.example.com",
      "http://192.168.1.20:8787",
    ]);
    expect(currentConnectionPlanServerUrls(plan, httpCandidate(plan, 0))).not.toContain(
      "http://192.168.1.9:8788",
    );
  });

  it("ignores unsupported Tailcat candidates and falls back to HTTP routes", async () => {
    const plan = connectionPlan({
      candidates: [
        {
          localTargetPort: 8788,
          priority: 550,
          routeId: "route-tailcat",
          token: "tailcat-token",
          transport: "tailcat",
        },
        ...connectionPlan().candidates,
      ],
    });
    const probes: string[] = [];

    const result = await resolveConnectionPlanRoute({
      bootstrapUrls: ["https://relay.example.com"],
      fetchPlan: async () => ({ plan, status: "available" as const }),
      now: () => now,
      probeHealth: async (candidate) => {
        probes.push(candidate.routeId);
        return healthResponse();
      },
    });

    expect({ probes, result }).toMatchObject({
      probes: ["route-public"],
      result: { candidate: { routeId: "route-public" }, status: "resolved" },
    });
    if (result.status !== "resolved") {
      throw new Error("Expected an HTTP connection-plan candidate.");
    }
    expect(currentConnectionPlanServerUrls(plan, result.candidate)).toEqual([
      "https://relay.example.com",
      "http://192.168.1.20:8787",
    ]);
  });

  it("materializes a supported Tailcat candidate without persisting its token", async () => {
    const plan = connectionPlan({
      candidates: [
        {
          localTargetPort: 8788,
          priority: 550,
          routeId: "route-tailcat",
          token: "tailcat-token-must-stay-memory-only",
          transport: "tailcat",
        },
        ...connectionPlan().candidates,
      ],
    });
    const materialized: string[] = [];

    const result = await resolveConnectionPlanRoute({
      bootstrapUrls: ["https://relay.example.com"],
      fetchPlan: async () => ({ plan, status: "available" as const }),
      materializeCandidate: async (candidate) => {
        materialized.push(candidate.routeId);
        return {
          candidate: {
            kind: "last_success",
            priority: candidate.priority,
            routeId: candidate.routeId,
            url: "http://127.0.0.1:49152",
          },
        };
      },
      now: () => now,
      probeHealth: async () => healthResponse(),
    });

    expect(result).toMatchObject({
      candidate: { routeId: "route-tailcat", url: "http://127.0.0.1:49152" },
      sourceCandidate: { routeId: "route-tailcat", transport: "tailcat" },
      status: "resolved",
    });
    expect(materialized).toEqual(["route-tailcat"]);
    expect(getStoredConnectionPlan()?.candidates).toHaveLength(2);
    expect(JSON.stringify(getStoredConnectionPlan())).not.toContain(
      "tailcat-token-must-stay-memory-only",
    );
  });

  it("runs route diagnostics only after a materialized route passes health", async () => {
    const plan = connectionPlan({
      candidates: [
        {
          localTargetPort: 8788,
          priority: 550,
          routeId: "route-tailcat-diagnostics",
          token: "tailcat-diagnostics-token",
          transport: "tailcat",
        },
      ],
    });
    const selected: string[] = [];

    const result = await resolveConnectionPlanRoute({
      bootstrapUrls: ["https://relay.example.com"],
      fetchPlan: async () => ({ plan, status: "available" as const }),
      materializeCandidate: async (candidate) => ({
        candidate: {
          kind: "last_success",
          priority: candidate.priority,
          routeId: candidate.routeId,
          url: "http://127.0.0.1:49155",
        },
        onSelected: () => {
          selected.push(candidate.routeId);
        },
      }),
      now: () => now,
      probeHealth: async () => healthResponse(),
    });

    expect(result).toMatchObject({ status: "resolved" });
    await vi.waitFor(() => expect(selected).toEqual(["route-tailcat-diagnostics"]));
  });

  it("reports content-safe LAN and Tailscale probe timings without route identity", async () => {
    let clock = now;
    const observations: unknown[] = [];
    const plan = connectionPlan({
      candidates: [
        {
          kind: "lan",
          priority: 300,
          routeId: "route-private-lan",
          url: "http://192.168.1.20:8787",
        },
      ],
    });

    await resolveConnectionPlanRoute({
      bootstrapUrls: ["http://192.168.1.20:8787"],
      fetchPlan: async () => ({ plan, status: "available" as const }),
      now: () => clock,
      observeProbe: (observation) => observations.push(observation),
      probeHealth: async () => {
        clock += 125;
        return healthResponse();
      },
    });

    expect(observations).toEqual([{ durationMs: 125, route: "lan", success: true }]);
    expect(JSON.stringify(observations)).not.toMatch(/routeId|url|token|relayId/i);
  });

  it("records public HTTPS probe timings as Cloudflare samples", async () => {
    let clock = now;
    const observations: unknown[] = [];
    const plan = connectionPlan({
      candidates: [
        {
          kind: "public_https",
          priority: 500,
          routeId: "route-public-cloudflare",
          url: "https://relay.example.com",
        },
      ],
    });

    await resolveConnectionPlanRoute({
      bootstrapUrls: ["https://relay.example.com"],
      fetchPlan: async () => ({ plan, status: "available" as const }),
      now: () => clock,
      observeProbe: (observation) => observations.push(observation),
      probeHealth: async () => {
        clock += 275;
        return healthResponse();
      },
    });

    expect(observations).toEqual([{ durationMs: 275, route: "cloudflare", success: true }]);
    expect(JSON.stringify(observations)).not.toMatch(/routeId|url|token|relayId/i);
  });

  it("maps manually selected plan URLs to content-safe benchmark routes", () => {
    const plan = connectionPlan({
      candidates: [
        {
          kind: "lan",
          priority: 300,
          routeId: "route-lan-manual",
          url: "http://192.168.1.20:8787",
        },
        {
          kind: "tailscale",
          priority: 400,
          routeId: "route-tailscale-manual",
          url: "http://100.100.100.100:8787",
        },
        {
          kind: "public_https",
          priority: 500,
          routeId: "route-cloudflare-manual",
          url: "https://relay.example.com",
        },
      ],
    });

    expect(transportBenchmarkRouteForServerUrl("http://192.168.1.20:8787", plan)).toBe("lan");
    expect(transportBenchmarkRouteForServerUrl("http://100.100.100.100:8787", plan)).toBe(
      "tailscale",
    );
    expect(transportBenchmarkRouteForServerUrl("https://relay.example.com", plan)).toBe(
      "cloudflare",
    );
    expect(
      transportBenchmarkRouteForServerUrl("https://unknown.example.com", plan),
    ).toBeUndefined();
  });

  it("cleans up a failed Tailcat materialization before falling back to HTTP", async () => {
    const plan = connectionPlan({
      candidates: [
        {
          localTargetPort: 8788,
          priority: 550,
          routeId: "route-tailcat-failed",
          token: "tailcat-failed-token",
          transport: "tailcat",
        },
        ...connectionPlan().candidates,
      ],
    });
    let cleanedUp = false;
    const probes: string[] = [];

    const result = await resolveConnectionPlanRoute({
      bootstrapUrls: ["https://relay.example.com"],
      fetchPlan: async () => ({ plan, status: "available" as const }),
      materializeCandidate: async (candidate) => ({
        candidate: {
          kind: "last_success",
          priority: candidate.priority,
          routeId: candidate.routeId,
          url: "http://127.0.0.1:49153",
        },
        cleanup: () => {
          cleanedUp = true;
        },
      }),
      now: () => now,
      probeHealth: async (candidate) => {
        probes.push(candidate.routeId);
        return candidate.routeId === "route-public" ? healthResponse() : undefined;
      },
    });

    expect(result).toMatchObject({
      candidate: { routeId: "route-public" },
      sourceCandidate: { routeId: "route-public" },
      status: "resolved",
    });
    expect(probes).toEqual(["route-tailcat-failed", "route-public"]);
    expect(cleanedUp).toBe(true);
  });

  it("uses a successful business route to reconcile stored plan addresses", async () => {
    const plan = connectionPlan();
    const stalePlan = connectionPlan({
      candidates: [
        {
          kind: "lan",
          priority: 300,
          routeId: "route-stale-lan",
          url: "http://192.168.1.9:8788",
        },
      ],
    });
    recordConnectionRouteFailure(stalePlan, httpCandidate(stalePlan, 0), now - 1_000);
    await resolveConnectionPlanRoute({
      bootstrapUrls: [httpCandidate(plan, 0).url],
      fetchPlan: async () => ({ plan, status: "available" as const }),
      now: () => now,
      probeHealth: async () => undefined,
      totalBudgetMs: 1,
    });

    expect(currentStoredConnectionPlanServerUrls(httpCandidate(plan, 0).url)).toEqual([
      "https://relay.example.com",
      "http://192.168.1.20:8787",
    ]);
    expect(currentStoredConnectionPlanServerUrls("http://192.168.1.9:8788")).toBeUndefined();
    expect(getConnectionRouteObservations()).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ routeId: "route-stale-lan" })]),
    );
  });

  it("persists route observations by Relay and route identity", () => {
    const plan = connectionPlan();
    recordConnectionRouteSuccess(plan, httpCandidate(plan, 1), now);
    recordConnectionRouteFailure(plan, httpCandidate(plan, 0), now + 1000);

    expect(getConnectionRouteObservations()).toEqual([
      expect.objectContaining({
        consecutiveFailures: 0,
        lastSucceededAt: now,
        relayId: "relay-a",
        routeId: "route-lan",
      }),
      expect.objectContaining({
        consecutiveFailures: 1,
        lastFailedAt: now + 1000,
        relayId: "relay-a",
        routeId: "route-public",
      }),
    ]);
    expect(orderConnectionPlanCandidates(plan, now + 2000).map(({ routeId }) => routeId)).toEqual([
      "route-lan",
      "route-public",
    ]);
  });

  it("allows a higher-priority transport to supersede a fresh HTTP success", () => {
    const plan = connectionPlan({
      candidates: [
        {
          localTargetPort: 8788,
          priority: 550,
          routeId: "route-tailcat",
          token: "tailcat-token",
          transport: "tailcat",
        },
        ...connectionPlan().candidates,
      ],
    });
    recordConnectionRouteSuccess(plan, httpCandidate(plan, 1), now);

    expect(orderConnectionPlanCandidates(plan, now + 1_000).map(({ routeId }) => routeId)).toEqual([
      "route-tailcat",
      "route-public",
      "route-lan",
    ]);
  });

  it("probes a fresh last-success route first and rejects mismatched Relay epochs", async () => {
    const plan = connectionPlan({ serverEpoch: "epoch-new" });
    recordConnectionRouteSuccess(
      connectionPlan({ serverEpoch: "epoch-old" }),
      httpCandidate(plan, 1),
      now - 1000,
    );
    const probes: string[] = [];

    const result = await resolveConnectionPlanRoute({
      bootstrapUrls: ["https://relay.example.com"],
      fetchPlan: async () => ({ plan, status: "available" as const }),
      now: () => now,
      probeHealth: async (candidate) => {
        probes.push(candidate.routeId);
        return healthResponse({
          relayId: candidate.routeId === "route-lan" ? "relay-a" : plan.relayId,
          serverEpoch: candidate.routeId === "route-lan" ? "epoch-old" : plan.serverEpoch,
        });
      },
    });

    expect(result).toMatchObject({
      candidate: { routeId: "route-public" },
      plan,
      status: "resolved",
    });
    expect(probes).toEqual(["route-lan", "route-public"]);
    expect(
      getConnectionRouteObservations().find(({ routeId }) => routeId === "route-lan"),
    ).toMatchObject({ consecutiveFailures: 1, lastFailedAt: now });
  });

  it("refreshes the plan once after every candidate fails", async () => {
    const initialPlan = connectionPlan();
    const refreshedPlan = connectionPlan({
      candidates: [
        {
          kind: "tailscale",
          priority: 700,
          routeId: "route-tailscale",
          url: "http://100.126.212.81:8788",
        },
      ],
      serverEpoch: "epoch-refreshed",
    });
    let planRequestCount = 0;

    const result = await resolveConnectionPlanRoute({
      bootstrapUrls: ["https://relay.example.com"],
      fetchPlan: async () => ({
        plan: ++planRequestCount === 1 ? initialPlan : refreshedPlan,
        status: "available" as const,
      }),
      now: () => now,
      probeHealth: async (candidate) =>
        candidate.routeId === "route-tailscale"
          ? healthResponse({
              relayId: refreshedPlan.relayId,
              serverEpoch: refreshedPlan.serverEpoch,
            })
          : undefined,
    });

    expect(planRequestCount).toBe(2);
    expect(result).toMatchObject({
      candidate: { routeId: "route-tailscale" },
      plan: refreshedPlan,
      status: "resolved",
    });
  });

  it("falls back cleanly when an older Relay does not expose connection plans", async () => {
    const result = await resolveConnectionPlanRoute({
      bootstrapUrls: ["http://192.168.1.20:8787"],
      fetchPlan: async () => ({ status: "unsupported" as const }),
      now: () => now,
      probeHealth: async () => undefined,
    });

    expect(result).toEqual({ planUnavailable: true, status: "legacy" });
  });

  it("bounds candidate attempts by both route and total failover budgets", async () => {
    let clock = now;
    const timeouts: number[] = [];

    const result = await resolveConnectionPlanRoute({
      bootstrapUrls: ["http://192.168.1.20:8787", "http://192.168.1.21:8787"],
      fetchPlan: async (_serverUrl, timeoutMs) => {
        timeouts.push(timeoutMs);
        clock += timeoutMs;
        throw new Error("offline");
      },
      now: () => clock,
      perRouteTimeoutMs: 20,
      probeHealth: async () => undefined,
      totalBudgetMs: 25,
    });

    expect(timeouts).toEqual([20, 5]);
    expect(result).toEqual({ planUnavailable: false, status: "legacy" });
  });

  it("refreshes saved candidates once after request route exhaustion", async () => {
    let candidates = ["http://old-relay:8787"];
    const requests: string[] = [];
    let refreshCount = 0;

    const result = await requestWithConnectionCandidateRefresh({
      getCandidateUrls: () => candidates,
      refreshCandidates: async () => {
        refreshCount += 1;
        candidates = ["https://new-relay.example.com"];
        return true;
      },
      request: async (serverUrl) => {
        requests.push(serverUrl);
        if (serverUrl.includes("old-relay")) {
          throw new Error("offline");
        }
        return "connected";
      },
    });

    expect(result).toEqual({
      serverUrl: "https://new-relay.example.com",
      value: "connected",
    });
    expect(refreshCount).toBe(1);
    expect(requests).toEqual(["http://old-relay:8787", "https://new-relay.example.com"]);
  });
});

function connectionPlan(overrides: Partial<ConnectionPlanResponse> = {}): ConnectionPlanResponse {
  return {
    candidates: [
      {
        kind: "public_https",
        priority: 500,
        routeId: "route-public",
        url: "https://relay.example.com",
      },
      {
        kind: "lan",
        priority: 300,
        routeId: "route-lan",
        url: "http://192.168.1.20:8787",
      },
    ],
    expiresAt: new Date(now + 5 * 60 * 1000).toISOString(),
    refreshPath: "/v1/connection-plan",
    relayId: "relay-a",
    serverEpoch: "epoch-current",
    ...overrides,
  };
}

function httpCandidate(plan: ConnectionPlanResponse, index: number): HttpConnectionPlanCandidate {
  const candidate = plan.candidates[index];
  if (!candidate || !("url" in candidate)) {
    throw new Error(`Expected HTTP candidate at index ${index}.`);
  }
  return candidate;
}

function healthResponse(overrides: Partial<HealthResponse> = {}): HealthResponse {
  return {
    ok: true,
    relayId: "relay-a",
    serverEpoch: "epoch-current",
    service: "codex-relay-server",
    ...overrides,
  };
}
