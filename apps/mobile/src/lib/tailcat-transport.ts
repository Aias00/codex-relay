import type {
  HttpConnectionPlanCandidate,
  TailcatConnectionPlanCandidate,
} from "@aias00/codex-relay/api-schema";
import {
  isTailcatTransportAvailable,
  isTailcatTransportEnabled,
  readTailcatTransportPath,
  startTailcatTransport,
  stopTailcatTransport,
  type TailcatTransportNativeModule,
} from "expo-tailcat-transport";

import type { MaterializedConnectionPlanCandidate } from "./codex-relay-connection-plan";
import { recordMobileTransportBenchmark } from "./transport-benchmark";

const nativeTransport: TailcatTransportNativeModule = {
  path: readTailcatTransportPath,
  start: startTailcatTransport,
  stop: stopTailcatTransport,
};

export type TailcatTransportDiagnostics = {
  checkedAt?: number;
  path: "derp" | "direct" | "unknown";
  routeId?: string;
  status: "connected" | "failed" | "idle" | "starting" | "stopped";
};

let diagnostics: TailcatTransportDiagnostics = { path: "unknown", status: "idle" };

export function getTailcatTransportDiagnostics(): TailcatTransportDiagnostics {
  return { ...diagnostics };
}

export function tailcatConnectionPlanCapability(
  enabled = isTailcatTransportEnabled(),
  available = isTailcatTransportAvailable(),
) {
  return enabled && available ? "tailcat" : undefined;
}

export async function materializeTailcatConnectionPlanCandidate(
  source: TailcatConnectionPlanCandidate,
  _timeoutMs: number,
  transport: TailcatTransportNativeModule = nativeTransport,
): Promise<MaterializedConnectionPlanCandidate | undefined> {
  const startedAt = Date.now();
  diagnostics = { path: "unknown", routeId: source.routeId, status: "starting" };
  let endpoint: string;
  try {
    endpoint = await transport.start(source.token, source.localTargetPort);
  } catch {
    diagnostics = { path: "unknown", routeId: source.routeId, status: "failed" };
    return undefined;
  }
  const url = normalizedLoopbackEndpoint(endpoint);
  if (!url) {
    await Promise.resolve(transport.stop()).catch(() => undefined);
    diagnostics = { path: "unknown", routeId: source.routeId, status: "failed" };
    return undefined;
  }
  const candidate: HttpConnectionPlanCandidate = {
    kind: "last_success",
    priority: source.priority,
    routeId: source.routeId,
    url,
  };
  return {
    candidate,
    cleanup: async () => {
      await transport.stop();
      if (diagnostics.routeId === source.routeId) {
        diagnostics = { path: "unknown", routeId: source.routeId, status: "stopped" };
      }
    },
    onSelected: async () => {
      const path = normalizeTailcatPath(
        await transport.path?.(Math.min(Math.max(_timeoutMs, 250), 1_500)),
      );
      diagnostics = {
        checkedAt: Date.now(),
        path,
        routeId: source.routeId,
        status: "connected",
      };
      if (path === "direct" || path === "derp") {
        recordMobileTransportBenchmark({
          durationMs: Math.max(0, Date.now() - startedAt),
          route: path === "direct" ? "tailcat_direct" : "tailcat_derp",
          scenario: "connect",
          success: true,
        });
      }
    },
  };
}

export async function stopMaterializedTailcatTransport() {
  await stopTailcatTransport().catch(() => undefined);
  diagnostics = { path: "unknown", status: "stopped" };
}

function normalizeTailcatPath(value: string | undefined): TailcatTransportDiagnostics["path"] {
  return value === "direct" || value === "derp" ? value : "unknown";
}

function normalizedLoopbackEndpoint(value: string) {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    if (
      url.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "[::1]", "::1"].includes(hostname) ||
      !url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.pathname && url.pathname !== "/")
    ) {
      return undefined;
    }
    return `${url.protocol}//${url.host}`;
  } catch {
    return undefined;
  }
}
