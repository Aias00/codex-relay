import {
  TransportBenchmarkSampleSchema,
  type TransportBenchmarkRoute,
  type TransportBenchmarkSample,
  type TransportBenchmarkScenario,
} from "codex-relay/api-schema";

import { codexRelayStorage as storage } from "./codex-relay-server-url-storage";
import mobilePackage from "../../package.json";

const benchmarkStorageKey = "codex-relay.transport-benchmarks.v1";
const maximumStoredSamples = 200;
const defaultAppVersion = mobilePackage.version.split("-")[0] || mobilePackage.version;

type BenchmarkInput = {
  batteryEndPercent?: number;
  batteryStartPercent?: number;
  bytesTransferred?: number;
  durationMs: number;
  eventsReceived?: number;
  route: TransportBenchmarkRoute;
  scenario: TransportBenchmarkScenario;
  success: boolean;
};

type RecorderContext = {
  appVersion?: string;
  now?: () => number;
  randomUUID?: () => string;
};

export function recordMobileTransportBenchmark(
  input: BenchmarkInput,
  context: RecorderContext = {},
): TransportBenchmarkSample {
  const sample = TransportBenchmarkSampleSchema.parse({
    ...input,
    appVersion:
      context.appVersion ?? process.env.EXPO_PUBLIC_CODEX_RELAY_APP_VERSION ?? defaultAppVersion,
    recordedAt: new Date((context.now ?? Date.now)()).toISOString(),
    sampleId: (context.randomUUID ?? createUuid)(),
    version: 1,
  });
  const samples = [...listMobileTransportBenchmarks(), sample].slice(-maximumStoredSamples);
  storage.set(benchmarkStorageKey, JSON.stringify(samples));
  return sample;
}

export function listMobileTransportBenchmarks(): TransportBenchmarkSample[] {
  const raw = storage.getString(benchmarkStorageKey);
  if (!raw) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.flatMap((value) => {
      const result = TransportBenchmarkSampleSchema.safeParse(value);
      return result.success ? [result.data] : [];
    });
  } catch {
    return [];
  }
}

export function exportMobileTransportBenchmarksJsonl() {
  const samples = listMobileTransportBenchmarks();
  return samples.length > 0
    ? `${samples.map((sample) => JSON.stringify(sample)).join("\n")}\n`
    : "";
}

export function clearMobileTransportBenchmarks() {
  storage.remove(benchmarkStorageKey);
}

function createUuid() {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
