import {
  TransportBenchmarkSampleSchema,
  type TransportBenchmarkRoute,
  type TransportBenchmarkSample,
  type TransportBenchmarkScenario,
} from "./api-schema.js";

export type TransportBenchmarkSummary = {
  generatedAt: string;
  groups: TransportBenchmarkSummaryGroup[];
  sampleCount: number;
  version: 1;
};

export type TransportBenchmarkSummaryGroup = {
  batteryUsedPercent?: Percentiles;
  durationMs?: Percentiles;
  eventsReceived?: Percentiles;
  route: TransportBenchmarkRoute;
  sampleCount: number;
  scenario: TransportBenchmarkScenario;
  successCount: number;
  successRate: number;
  throughputBytesPerSecond?: Percentiles;
};

type Percentiles = { p50: number; p95: number };

export function parseTransportBenchmarkJsonl(value: string): TransportBenchmarkSample[] {
  const samples: TransportBenchmarkSample[] = [];
  for (const [index, rawLine] of value.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    try {
      samples.push(TransportBenchmarkSampleSchema.parse(JSON.parse(line)));
    } catch {
      throw new Error(`Invalid transport benchmark sample on line ${index + 1}.`);
    }
  }
  return samples;
}

export function summarizeTransportBenchmarks(
  samples: TransportBenchmarkSample[],
): TransportBenchmarkSummary {
  const parsedSamples = samples.map((sample) => TransportBenchmarkSampleSchema.parse(sample));
  const grouped = new Map<string, TransportBenchmarkSample[]>();
  for (const sample of parsedSamples) {
    const key = `${sample.route}\u0000${sample.scenario}`;
    grouped.set(key, [...(grouped.get(key) ?? []), sample]);
  }
  const groups = [...grouped.values()]
    .map(summarizeGroup)
    .sort(
      (left, right) =>
        left.route.localeCompare(right.route) || left.scenario.localeCompare(right.scenario),
    );
  return {
    generatedAt: new Date().toISOString(),
    groups,
    sampleCount: parsedSamples.length,
    version: 1,
  };
}

function summarizeGroup(samples: TransportBenchmarkSample[]): TransportBenchmarkSummaryGroup {
  const first = samples[0];
  if (!first) {
    throw new Error("Cannot summarize an empty transport benchmark group.");
  }
  const successful = samples.filter(({ success }) => success);
  const durationMs = successful.map(({ durationMs }) => durationMs);
  const throughput = successful.flatMap((sample) =>
    sample.bytesTransferred !== undefined && sample.durationMs > 0
      ? [(sample.bytesTransferred * 1000) / sample.durationMs]
      : [],
  );
  const batteryUsed = successful.flatMap((sample) =>
    sample.batteryStartPercent !== undefined && sample.batteryEndPercent !== undefined
      ? [sample.batteryStartPercent - sample.batteryEndPercent]
      : [],
  );
  const eventsReceived = successful.flatMap((sample) =>
    sample.eventsReceived === undefined ? [] : [sample.eventsReceived],
  );
  return {
    ...(batteryUsed.length > 0 ? { batteryUsedPercent: percentiles(batteryUsed) } : {}),
    ...(durationMs.length > 0 ? { durationMs: percentiles(durationMs) } : {}),
    ...(eventsReceived.length > 0 ? { eventsReceived: percentiles(eventsReceived) } : {}),
    route: first.route,
    sampleCount: samples.length,
    scenario: first.scenario,
    successCount: successful.length,
    successRate: successful.length / samples.length,
    ...(throughput.length > 0 ? { throughputBytesPerSecond: percentiles(throughput) } : {}),
  };
}

function percentiles(values: number[]): Percentiles {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    p50: nearestRank(sorted, 0.5),
    p95: nearestRank(sorted, 0.95),
  };
}

function nearestRank(sorted: number[], percentile: number) {
  const index = Math.max(0, Math.ceil(percentile * sorted.length) - 1);
  return sorted[index] ?? 0;
}
