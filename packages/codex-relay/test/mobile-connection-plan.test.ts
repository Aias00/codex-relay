import { beforeEach, describe, expect, it } from "vitest";

import type { ConnectionPlanResponse, HealthResponse } from "../src/api-schema.js";
import {
  clearCodexRelayConnectionPlanState,
  getConnectionRouteObservations,
  orderConnectionPlanCandidates,
  recordConnectionRouteFailure,
  recordConnectionRouteSuccess,
  requestWithConnectionCandidateRefresh,
  resolveConnectionPlanRoute,
} from "../../../apps/mobile/src/lib/codex-relay-connection-plan.js";

const now = Date.parse("2026-08-26T12:00:00.000Z");

beforeEach(() => {
  clearCodexRelayConnectionPlanState();
});

describe("mobile connection plans", () => {
  it("persists route observations by Relay and route identity", () => {
    const plan = connectionPlan();
    recordConnectionRouteSuccess(plan, plan.candidates[1], now);
    recordConnectionRouteFailure(plan, plan.candidates[0], now + 1000);

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

  it("probes a fresh last-success route first and rejects mismatched Relay epochs", async () => {
    const plan = connectionPlan({ serverEpoch: "epoch-new" });
    recordConnectionRouteSuccess(
      connectionPlan({ serverEpoch: "epoch-old" }),
      plan.candidates[1],
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

function healthResponse(overrides: Partial<HealthResponse> = {}): HealthResponse {
  return {
    ok: true,
    relayId: "relay-a",
    serverEpoch: "epoch-current",
    service: "codex-relay-server",
    ...overrides,
  };
}
