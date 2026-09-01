import { describe, expect, it, vi } from "vitest";

import { isTailcatTransportEnabled } from "../../expo-tailcat-transport/src/index.js";

import {
  getTailcatTransportDiagnostics,
  materializeTailcatConnectionPlanCandidate,
  stopMaterializedTailcatTransport,
  tailcatConnectionPlanCapability,
} from "../../../apps/mobile/src/lib/tailcat-transport.js";

const candidate = {
  localTargetPort: 8788,
  priority: 550,
  routeId: "route-tailcat-mobile",
  token: "tailcat-token-must-remain-native-only",
  transport: "tailcat" as const,
};

describe("mobile Tailcat transport", () => {
  it("inherits the native app capability flag when an OTA omits the build environment", () => {
    const nativeEnabled = isTailcatTransportEnabled({ enabled: true });

    expect(tailcatConnectionPlanCapability(nativeEnabled, true)).toBe("tailcat");
    expect(isTailcatTransportEnabled({ enabled: false })).toBe(false);
    expect(isTailcatTransportEnabled(null)).toBe(false);
  });

  it("declares capability only when both the build flag and native module are present", () => {
    expect(tailcatConnectionPlanCapability(true, true)).toBe("tailcat");
    expect(tailcatConnectionPlanCapability(false, true)).toBeUndefined();
    expect(tailcatConnectionPlanCapability(true, false)).toBeUndefined();
  });

  it("materializes only a loopback HTTP endpoint and keeps the token out of the result", async () => {
    const start = vi.fn<(token: string, targetPort: number) => Promise<string>>(async () =>
      Promise.resolve("http://127.0.0.1:49152"),
    );
    const path = vi.fn<(timeoutMs: number) => Promise<string>>(async () => "direct");
    const stop = vi.fn<() => Promise<void>>(async () => undefined);

    const result = await materializeTailcatConnectionPlanCandidate(candidate, 2_000, {
      path,
      start,
      stop,
    });

    expect(start).toHaveBeenCalledWith(candidate.token, candidate.localTargetPort);
    expect(result).toMatchObject({
      candidate: {
        kind: "last_success",
        routeId: candidate.routeId,
        url: "http://127.0.0.1:49152",
      },
    });
    expect(JSON.stringify(result)).not.toContain(candidate.token);
    await result?.onSelected?.();
    expect(path).toHaveBeenCalledWith(1_500);
    expect(getTailcatTransportDiagnostics()).toMatchObject({
      path: "direct",
      routeId: candidate.routeId,
      status: "connected",
    });
    expect(JSON.stringify(getTailcatTransportDiagnostics())).not.toContain(candidate.token);
    await result?.cleanup?.();
    expect(stop).toHaveBeenCalledOnce();
    expect(getTailcatTransportDiagnostics()).toMatchObject({ path: "unknown", status: "stopped" });
  });

  it("rejects a native endpoint that is not loopback", async () => {
    const stop = vi.fn<() => Promise<void>>(async () => undefined);

    await expect(
      materializeTailcatConnectionPlanCandidate(candidate, 2_000, {
        path: async () => "unknown",
        start: async () => "http://192.168.1.20:49152",
        stop,
      }),
    ).resolves.toBeUndefined();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("fails closed without propagating native errors that may contain connection details", async () => {
    await expect(
      materializeTailcatConnectionPlanCandidate(candidate, 2_000, {
        path: async () => "unknown",
        start: async () => {
          throw new Error(`failed for ${candidate.token}`);
        },
        stop: async () => undefined,
      }),
    ).resolves.toBeUndefined();
  });

  it("normalizes native path diagnostics without exposing network details", async () => {
    const result = await materializeTailcatConnectionPlanCandidate(candidate, 2_000, {
      path: async () => "192.0.2.10:41641 via derp-17",
      start: async () => "http://127.0.0.1:49154",
      stop: async () => undefined,
    });

    await result?.onSelected?.();

    expect(getTailcatTransportDiagnostics()).toMatchObject({
      path: "unknown",
      routeId: candidate.routeId,
      status: "connected",
    });
    expect(JSON.stringify(getTailcatTransportDiagnostics())).not.toContain("192.0.2.10");
    await stopMaterializedTailcatTransport();
  });
});
