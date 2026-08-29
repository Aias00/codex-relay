import { describe, expect, it } from "vitest";

import {
  createPairingQrPayload,
  getConnectUrlCandidates,
  getConnectUrlGuidance,
  normalizeUrl,
} from "../src/pairing-url-candidates.js";

describe("pairing URL candidates", () => {
  it("keeps the primary serverUrl while adding compact candidate hosts for newer apps", () => {
    const payload = createPairingQrPayload({
      serverPublicKey: "server-public-key",
      serverUrls: ["http://100.64.0.10:8787", "http://192.168.1.10:8787"],
    });

    const parsed = new URL(payload);
    expect(parsed.protocol).toBe("codex-relay:");
    expect(parsed.hostname).toBe("pair");
    expect(parsed.searchParams.get("serverUrl")).toBe("http://100.64.0.10:8787");
    expect(parsed.searchParams.get("serverPublicKey")).toBe("server-public-key");
    expect(parsed.searchParams.get("h")).toBe("192.168.1.10");
    expect(parsed.searchParams.has("serverUrls")).toBe(false);
  });

  it("omits compact candidates when there is only one URL", () => {
    const payload = createPairingQrPayload({
      serverPublicKey: "server-public-key",
      serverUrls: ["http://192.168.1.10:8787"],
    });

    const parsed = new URL(payload);
    expect(parsed.searchParams.get("serverUrl")).toBe("http://192.168.1.10:8787");
    expect(parsed.searchParams.has("h")).toBe(false);
  });

  it("does not compact candidates with a different protocol or port", () => {
    const payload = createPairingQrPayload({
      serverPublicKey: "server-public-key",
      serverUrls: [
        "http://100.64.0.10:8787",
        "https://relay.example.com",
        "http://192.168.1.10:8788",
      ],
    });

    const parsed = new URL(payload);
    expect(parsed.searchParams.has("h")).toBe(false);
    expect(parsed.searchParams.has("serverUrls")).toBe(false);
  });

  it("keeps compact QR fallbacks short and skips unusable local hosts", () => {
    const payload = createPairingQrPayload({
      serverPublicKey: "server-public-key",
      serverUrls: [
        "http://100.64.0.10:8787",
        "http://0.0.0.0:8787",
        "http://192.168.139.0:8787",
        "http://169.254.51.1:8787",
        "http://192.168.1.10:8787",
        "http://192.168.1.11:8787",
        "http://192.168.1.12:8787",
        "http://192.168.1.13:8787",
      ],
    });

    const parsed = new URL(payload);
    expect(parsed.searchParams.get("h")).toBe("192.168.1.10,192.168.1.11,192.168.1.12");
  });

  it("normalizes only http and https URLs", () => {
    expect(normalizeUrl(" http://192.168.1.10:8787/ ")).toBe("http://192.168.1.10:8787");
    expect(normalizeUrl("https://relay.example.com/")).toBe("https://relay.example.com");
    expect(normalizeUrl("ftp://relay.example.com")).toBeUndefined();
    expect(normalizeUrl("")).toBeUndefined();
  });

  it("prefers a configured public URL for mobile pairing", () => {
    const candidates = getConnectUrlCandidates({
      listenUrl: "http://0.0.0.0:8788",
      port: 8788,
      publicUrl: " https://relay.example.com/ ",
    });

    expect(candidates[0]).toEqual({ label: "Public", url: "https://relay.example.com" });
  });

  it("explains local network addresses as same-Wi-Fi pairing", () => {
    expect(getConnectUrlGuidance("http://192.168.1.10:8787")).toContain("same network");
    expect(getConnectUrlGuidance("http://10.0.0.10:8787")).toContain("Tailscale");
  });

  it("explains Tailscale addresses as requiring Tailscale on both devices", () => {
    expect(getConnectUrlGuidance("http://100.103.76.81:8787")).toContain("Tailscale");
    expect(getConnectUrlGuidance("http://relay.tailnet.ts.net:8787")).toContain(
      "both this computer and the phone",
    );
  });

  it("warns when the mobile URL is only reachable locally", () => {
    expect(getConnectUrlGuidance("http://127.0.0.1:8787")).toContain("only reachable");
    expect(getConnectUrlGuidance("http://0.0.0.0:8787")).toContain("only reachable");
  });
});
