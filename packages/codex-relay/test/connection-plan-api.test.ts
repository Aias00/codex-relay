import { describe, expect, it } from "vitest";

import { ConnectionPlanResponseSchema, HealthResponseSchema, apiPaths } from "../src/api-schema.js";
import { createApp } from "../src/app.js";
import {
  createConnectionPlan,
  createServerEpoch,
  relayIdFromServerPublicKey,
} from "../src/connection-plan.js";
import { createTursoPairingSessionStore } from "../src/pairing-store.js";

describe("connection plan", () => {
  it("derives a stable Relay identity from the persistent server identity", () => {
    const first = relayIdFromServerPublicKey("persistent-public-key");
    const second = relayIdFromServerPublicKey("persistent-public-key");

    expect(first).toBe(second);
    expect(first).toMatch(/^relay_[A-Za-z0-9_-]{24}$/);
    expect(relayIdFromServerPublicKey("replacement-public-key")).not.toBe(first);
    expect(createServerEpoch()).not.toBe(createServerEpoch());
  });

  it("normalizes, classifies, ranks, and deduplicates server candidates", () => {
    const plan = createConnectionPlan({
      candidates: [
        { label: "Public", url: "https://relay.example.com/" },
        { label: "Tailscale", url: "http://100.126.212.81:8788" },
        { label: "en0", url: "http://192.168.31.114:8788" },
        { label: "Link local", url: "http://169.254.4.20:8788" },
        { label: "Duplicate", url: "https://relay.example.com" },
        { label: "Server", url: "http://0.0.0.0:8788" },
      ],
      now: Date.parse("2026-08-26T00:00:00.000Z"),
      relayId: "relay-stable",
      serverEpoch: "epoch-current",
      ttlMs: 60_000,
    });

    expect(plan).toMatchObject({
      expiresAt: "2026-08-26T00:01:00.000Z",
      refreshPath: apiPaths.connectionPlan,
      relayId: "relay-stable",
      serverEpoch: "epoch-current",
    });
    expect(plan.candidates.map(({ kind, url }) => [kind, url])).toEqual([
      ["public_https", "https://relay.example.com"],
      ["tailscale", "http://100.126.212.81:8788"],
      ["lan", "http://192.168.31.114:8788"],
      ["link_local", "http://169.254.4.20:8788"],
    ]);
    expect(new Set(plan.candidates.map((candidate) => candidate.routeId)).size).toBe(4);
  });

  it("serves matching health and refreshable connection plan identities", async () => {
    const app = createApp({
      appServer: null,
      connectionPlan: {
        relayId: "relay-api",
        serverEpoch: "epoch-api",
      },
      management: {
        connectUrl: "https://relay.example.com",
        connectUrlCandidates: [
          { label: "Public", url: "https://relay.example.com" },
          { label: "Tailscale", url: "http://100.126.212.81:8788" },
        ],
      },
    });

    const healthResponse = await app.request(apiPaths.health);
    const planResponse = await app.request(apiPaths.connectionPlan);
    const health = HealthResponseSchema.parse(await healthResponse.json());
    const plan = ConnectionPlanResponseSchema.parse(await planResponse.json());

    expect(healthResponse.status).toBe(200);
    expect(planResponse.status).toBe(200);
    expect(healthResponse.headers.get("cache-control")).toBe("no-store");
    expect(planResponse.headers.get("cache-control")).toBe("no-store");
    expect(health).toMatchObject({ relayId: plan.relayId, serverEpoch: plan.serverEpoch });
    expect(plan).toMatchObject({
      refreshPath: apiPaths.connectionPlan,
      relayId: "relay-api",
      serverEpoch: "epoch-api",
    });
    expect(plan.candidates).toHaveLength(2);
  });

  it("keeps health and connection plans behind existing pairing authentication", async () => {
    const sessions = await createTursoPairingSessionStore(":memory:");
    const app = createApp({
      appServer: null,
      pairing: {
        createClientToken: () => "client-token",
        hashClientToken: (token) => token,
        sessions,
      },
    });

    const health = await app.request(apiPaths.health);
    const plan = await app.request(apiPaths.connectionPlan);
    const version = await app.request(apiPaths.version);

    expect(health.status).toBe(401);
    expect(plan.status).toBe(401);
    expect(version.status).toBe(200);
  });
});
