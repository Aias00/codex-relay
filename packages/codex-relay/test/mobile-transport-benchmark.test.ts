import { beforeEach, describe, expect, it } from "vitest";

import { TransportBenchmarkSampleSchema } from "../src/api-schema.js";
import {
  clearMobileTransportBenchmarks,
  exportMobileTransportBenchmarksJsonl,
  listMobileTransportBenchmarks,
  recordMobileTransportBenchmark,
} from "../../../apps/mobile/src/lib/transport-benchmark.js";

beforeEach(() => {
  clearMobileTransportBenchmarks();
});

describe("mobile transport benchmark recorder", () => {
  it("stores at most 200 strict content-safe samples and evicts the oldest", () => {
    for (let index = 0; index < 205; index += 1) {
      recordMobileTransportBenchmark(
        {
          durationMs: index,
          route: "lan",
          scenario: "connect",
          success: true,
        },
        recorderContext(index),
      );
    }

    const samples = listMobileTransportBenchmarks();
    expect(samples).toHaveLength(200);
    expect(samples[0]).toMatchObject({ durationMs: 5 });
    expect(samples.at(-1)).toMatchObject({ durationMs: 204 });
    expect(JSON.stringify(samples)).not.toMatch(/url|token|relayId|threadId|workspaceId|message/i);
  });

  it("exports JSONL that round-trips through the shared strict schema", () => {
    recordMobileTransportBenchmark(
      {
        bytesTransferred: 4_096,
        durationMs: 250,
        route: "tailcat_derp",
        scenario: "history",
        success: true,
      },
      recorderContext(1),
    );

    const jsonl = exportMobileTransportBenchmarksJsonl();
    const lines = jsonl.trim().split("\n");

    expect(lines).toHaveLength(1);
    expect(TransportBenchmarkSampleSchema.parse(JSON.parse(lines[0]!))).toMatchObject({
      appVersion: "1.4.0",
      bytesTransferred: 4_096,
      route: "tailcat_derp",
      scenario: "history",
    });
  });
});

function recorderContext(index: number) {
  return {
    appVersion: "1.4.0",
    now: () => Date.parse("2026-08-31T20:00:00.000Z") + index,
    randomUUID: () => `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
  };
}
