import { describe, expect, it } from "vitest";

import type { TransportBenchmarkSample } from "../src/api-schema.js";

import {
  parseTransportBenchmarkJsonl,
  summarizeTransportBenchmarks,
} from "../src/transport-benchmark.js";

describe("transport benchmark artifacts", () => {
  it("parses strict content-safe samples and rejects URL or conversation fields", () => {
    const valid = benchmarkSample({
      durationMs: 120,
      sampleId: "00000000-0000-4000-8000-000000000001",
    });
    expect(parseTransportBenchmarkJsonl(`${JSON.stringify(valid)}\n`)).toEqual([valid]);

    const secretUrl = "https://secret.example/private-token";
    expect(() =>
      parseTransportBenchmarkJsonl(
        JSON.stringify({ ...valid, serverUrl: secretUrl, threadId: "thread-secret" }),
      ),
    ).toThrow("Invalid transport benchmark sample on line 1.");
    let errorText = "";
    try {
      parseTransportBenchmarkJsonl(JSON.stringify({ ...valid, serverUrl: secretUrl }));
    } catch (error) {
      errorText = String(error);
    }
    expect(errorText).toContain("Invalid transport benchmark sample on line 1.");
    expect(errorText).not.toContain(secretUrl);
  });

  it("summarizes success, latency, throughput, and battery without retaining raw samples", () => {
    const samples = [
      benchmarkSample({
        batteryEndPercent: 79,
        batteryStartPercent: 80,
        bytesTransferred: 1_000,
        durationMs: 100,
        eventsReceived: 12,
        sampleId: "00000000-0000-4000-8000-000000000001",
      }),
      benchmarkSample({
        batteryEndPercent: 78,
        batteryStartPercent: 80,
        bytesTransferred: 4_000,
        durationMs: 200,
        eventsReceived: 20,
        sampleId: "00000000-0000-4000-8000-000000000002",
      }),
      benchmarkSample({
        durationMs: 400,
        sampleId: "00000000-0000-4000-8000-000000000003",
        success: false,
      }),
    ];

    const summary = summarizeTransportBenchmarks(samples);

    expect(summary).toEqual({
      generatedAt: expect.any(String),
      groups: [
        {
          batteryUsedPercent: { p50: 1, p95: 2 },
          durationMs: { p50: 100, p95: 200 },
          eventsReceived: { p50: 12, p95: 20 },
          route: "tailcat_direct",
          sampleCount: 3,
          scenario: "connect",
          successCount: 2,
          successRate: 2 / 3,
          throughputBytesPerSecond: { p50: 10_000, p95: 20_000 },
        },
      ],
      sampleCount: 3,
      version: 1,
    });
    expect(JSON.stringify(summary)).not.toContain(samples[0]!.sampleId);
  });

  it("groups and sorts every planned route and scenario deterministically", () => {
    const samples = [
      benchmarkSample({
        route: "cloudflare",
        sampleId: "00000000-0000-4000-8000-000000000010",
        scenario: "history",
      }),
      benchmarkSample({
        route: "lan",
        sampleId: "00000000-0000-4000-8000-000000000011",
        scenario: "connect",
      }),
      benchmarkSample({
        route: "tailcat_derp",
        sampleId: "00000000-0000-4000-8000-000000000012",
        scenario: "sse",
      }),
    ];

    expect(
      summarizeTransportBenchmarks(samples).groups.map(({ route, scenario }) => [route, scenario]),
    ).toEqual([
      ["cloudflare", "history"],
      ["lan", "connect"],
      ["tailcat_derp", "sse"],
    ]);
  });
});

function benchmarkSample(
  overrides: Partial<TransportBenchmarkSample> = {},
): TransportBenchmarkSample {
  return {
    appVersion: "1.4.0",
    durationMs: 100,
    recordedAt: "2026-08-31T20:00:00.000Z",
    route: "tailcat_direct",
    sampleId: "00000000-0000-4000-8000-000000000000",
    scenario: "connect",
    success: true,
    version: 1,
    ...overrides,
  };
}
