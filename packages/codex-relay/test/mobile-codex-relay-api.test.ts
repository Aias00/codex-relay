import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearCodexRelayServerUrlState,
  clearEphemeralCodexRelayServerUrl,
  fallbackCodexRelayServerUrl,
  getCodexRelayServerUrl,
  getCodexRelayServerUrlCandidates,
  saveCodexRelayServerUrlCandidates,
  setCodexRelayServerUrl,
  setEphemeralCodexRelayServerUrl,
  sortServerUrlsByConnectionPreference,
} from "../../../apps/mobile/src/lib/codex-relay-server-url-storage.js";
import { requestWithNetworkTimeout } from "../../../apps/mobile/src/lib/network-timeout.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  clearCodexRelayServerUrlState();
});

describe("mobile Codex Relay API session storage", () => {
  it("clears the selected server URL and stored candidates", () => {
    setCodexRelayServerUrl("http://100.103.76.81:8787");
    saveCodexRelayServerUrlCandidates([
      "http://100.103.76.81:8787",
      "http://gronxb-macmini.taild999d7.ts.net:8787",
    ]);

    clearCodexRelayServerUrlState();

    expect(getCodexRelayServerUrl()).toBe(fallbackCodexRelayServerUrl);
    expect(getCodexRelayServerUrlCandidates()).toEqual([
      {
        label: "Localhost",
        url: fallbackCodexRelayServerUrl,
      },
    ]);
  });

  it("keeps the configured fallback URL in candidates after an older LAN URL was selected", () => {
    setCodexRelayServerUrl("http://192.168.47.15:8788");

    expect(getCodexRelayServerUrlCandidates()).toEqual([
      {
        label: "LAN IP",
        url: "http://192.168.47.15:8788",
      },
      {
        label: "Localhost",
        url: fallbackCodexRelayServerUrl,
      },
    ]);
  });

  it("prefers public HTTPS URLs over LAN and Tailscale DNS candidates", () => {
    expect(
      sortServerUrlsByConnectionPreference([
        "http://192.168.47.15:8788",
        "http://macbook-pro-m4.tail73d4c.ts.net:8788",
        "https://codex-relay.aias.eu.org",
      ]),
    ).toEqual([
      "https://codex-relay.aias.eu.org",
      "http://macbook-pro-m4.tail73d4c.ts.net:8788",
      "http://192.168.47.15:8788",
    ]);
  });

  it("keeps the currently verified server URL ahead of higher-scored fallbacks", () => {
    saveCodexRelayServerUrlCandidates([
      "https://codex-relay.aias.eu.org",
      "http://100.126.212.81:8788",
    ]);
    setCodexRelayServerUrl("http://100.126.212.81:8788");

    expect(getCodexRelayServerUrlCandidates().map(({ url }) => url)).toEqual([
      "http://100.126.212.81:8788",
      "https://codex-relay.aias.eu.org",
      fallbackCodexRelayServerUrl,
    ]);
  });

  it("uses a Tailcat loopback URL only for the current JS runtime", () => {
    setCodexRelayServerUrl("https://codex-relay.aias.eu.org");
    setEphemeralCodexRelayServerUrl("http://127.0.0.1:49152");

    expect(getCodexRelayServerUrl()).toBe("http://127.0.0.1:49152");

    clearEphemeralCodexRelayServerUrl();

    expect(getCodexRelayServerUrl()).toBe("https://codex-relay.aias.eu.org");
  });

  it("rejects bootstrap requests when the network hangs", async () => {
    vi.useFakeTimers();

    const request = requestWithNetworkTimeout(
      new Promise<Response>(() => undefined),
      undefined,
      25,
    );
    const caught = request.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(25);

    await expect(caught).resolves.toMatchObject({ message: "Request timed out." });
  });
});
