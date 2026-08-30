import { execFileSync } from "node:child_process";
import { networkInterfaces } from "node:os";

const maxPairingQrFallbackHosts = 3;
const ignoredLocalInterfaceNamePattern = /^(awdl|bridge|llw|lo|utun)/i;

export type ConnectUrlCandidate = {
  label: string;
  url: string;
};

export function getConnectUrlGuidance(url: string) {
  const host = parseUrlHost(url);
  if (!host) {
    return undefined;
  }

  if (isLocalhost(host) || isUnspecifiedHost(host)) {
    return "This address is only reachable from this computer. Use a same-Wi-Fi address or Tailscale for mobile pairing.";
  }

  if (isTailscaleHost(host)) {
    return "Using Tailscale. Keep Tailscale connected on both this computer and the phone.";
  }

  if (isPrivateIPv4Host(host) || isLocalIPv6Host(host)) {
    return "Using a local Wi-Fi/LAN address. Keep the phone and computer on the same network; if pairing is flaky, try Tailscale.";
  }

  return "Using a configured or public address. Make sure the phone can reach it before pairing.";
}

export function createPairingQrPayload(details: { serverPublicKey: string; serverUrls: string[] }) {
  const primaryServerUrl = details.serverUrls[0];
  if (!primaryServerUrl) {
    throw new Error("Pairing QR requires at least one server URL.");
  }

  const url = new URL("codex-relay://pair");
  url.searchParams.set("serverUrl", primaryServerUrl);
  url.searchParams.set("serverPublicKey", details.serverPublicKey);
  const hosts = compactCandidateHosts(primaryServerUrl, details.serverUrls);
  if (hosts.length > 0) {
    url.searchParams.set("h", hosts.join(","));
  }
  return url.toString();
}

export function getConnectUrlCandidates(details: {
  listenUrl: string;
  port: number;
  publicUrl?: string;
}) {
  return dedupeCandidates([
    ...publicConnectUrlCandidates(details.publicUrl),
    ...tailscaleConnectUrlCandidates(details.port),
    ...localNetworkConnectUrlCandidates(details.port),
    { label: "Server", url: details.listenUrl },
  ]);
}

export function normalizeUrl(value: string | undefined) {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim().replace(/\/$/, "");
  if (!trimmed) {
    return undefined;
  }

  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString().replace(/\/$/, "")
      : undefined;
  } catch {
    return undefined;
  }
}

function tailscaleConnectUrlCandidates(port: number) {
  const status = getTailscaleStatus();
  const candidates: ConnectUrlCandidate[] = [];
  for (const ip of status?.Self?.TailscaleIPs ?? []) {
    if (ip.startsWith("100.") && ip.includes(".")) {
      candidates.push({ label: "Tailscale", url: `http://${ip}:${port}` });
    }
  }

  const dnsName = status?.Self?.DNSName?.replace(/\.$/, "");
  if (dnsName) {
    const servedUrl = getTailscaleServeHttpsUrl(dnsName, port);
    candidates.push({
      label: servedUrl ? "Tailscale Serve" : "Tailscale DNS",
      url: servedUrl ?? `http://${dnsName}:${port}`,
    });
  }

  for (const ip of status?.Self?.TailscaleIPs ?? []) {
    if (ip.includes(".")) {
      candidates.push({ label: "Tailscale", url: `http://${ip}:${port}` });
    }
  }

  return candidates;
}

function publicConnectUrlCandidates(publicUrl: string | undefined) {
  const url = normalizeUrl(publicUrl);
  return url ? [{ label: "Public", url }] : [];
}

function localNetworkConnectUrlCandidates(port: number) {
  const candidates: ConnectUrlCandidate[] = [];
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    if (ignoredLocalInterfaceNamePattern.test(name)) {
      continue;
    }
    for (const address of addresses ?? []) {
      if (
        address.family === "IPv4" &&
        !address.internal &&
        isUsableLocalIPv4Host(address.address)
      ) {
        candidates.push({ label: name, url: `http://${address.address}:${port}` });
      }
    }
  }
  return candidates;
}

function dedupeCandidates(candidates: ConnectUrlCandidate[]) {
  const deduped = new Map<string, ConnectUrlCandidate>();
  for (const candidate of candidates) {
    const url = normalizeUrl(candidate.url);
    if (url && !deduped.has(url)) {
      deduped.set(url, { ...candidate, url });
    }
  }
  return [...deduped.values()];
}

function compactCandidateHosts(primaryServerUrl: string, serverUrls: string[]) {
  const primary = parseUrl(primaryServerUrl);
  if (!primary) {
    return [];
  }

  const hosts: string[] = [];
  for (const serverUrl of serverUrls.slice(1)) {
    const candidate = parseUrl(serverUrl);
    if (
      candidate &&
      candidate.protocol === primary.protocol &&
      candidate.port === primary.port &&
      isPairingQrFallbackHost(candidate.hostname) &&
      !hosts.includes(candidate.hostname)
    ) {
      hosts.push(candidate.hostname);
      if (hosts.length >= maxPairingQrFallbackHosts) {
        break;
      }
    }
  }
  return hosts;
}

function parseUrl(url: string) {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

function parseUrlHost(url: string) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function isLocalhost(host: string) {
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function isUnspecifiedHost(host: string) {
  return host === "0.0.0.0" || host === "::";
}

function isPairingQrFallbackHost(host: string) {
  return !isLocalhost(host) && !isUnspecifiedHost(host) && isUsableLocalIPv4Host(host);
}

function isUsableLocalIPv4Host(host: string) {
  const octets = host.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return true;
  }
  if (
    octets[0] === 0 ||
    octets[0] === 127 ||
    (octets[0] === 169 && octets[1] === 254) ||
    octets[3] === 0 ||
    octets[3] === 255
  ) {
    return false;
  }
  return true;
}

function isTailscaleHost(host: string) {
  return (
    host.endsWith(".ts.net") || host.endsWith(".beta.tailscale.net") || isTailscaleIPv4Host(host)
  );
}

function isPrivateIPv4Host(host: string) {
  const octets = host.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) {
    return false;
  }
  return (
    octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168) ||
    (octets[0] === 169 && octets[1] === 254)
  );
}

function isTailscaleIPv4Host(host: string) {
  const octets = host.split(".").map(Number);
  return octets.length === 4 && octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
}

function isLocalIPv6Host(host: string) {
  const normalized = host.replace(/^\[/, "").replace(/\]$/, "");
  return (
    normalized.startsWith("fe80:") || normalized.startsWith("fc") || normalized.startsWith("fd")
  );
}

function getTailscaleStatus() {
  const output = execTailscaleJson(["status", "--json"]);
  if (!output) {
    return undefined;
  }
  try {
    return JSON.parse(output) as {
      Self?: {
        DNSName?: string;
        TailscaleIPs?: string[];
      };
    };
  } catch {
    return undefined;
  }
}

function getTailscaleServeHttpsUrl(dnsName: string, port: number) {
  const output = execTailscaleJson(["serve", "status", "--json"]);
  if (!output) {
    return undefined;
  }
  try {
    const serveStatus = JSON.parse(output) as {
      TCP?: Record<string, { HTTPS?: boolean }>;
      Web?: Record<string, unknown>;
    };
    const portKey = String(port);
    const hostPort = `${dnsName}:${portKey}`;
    return serveStatus.TCP?.[portKey]?.HTTPS && serveStatus.Web?.[hostPort]
      ? `https://${hostPort}`
      : undefined;
  } catch {
    return undefined;
  }
}

function execTailscaleJson(args: string[]) {
  const commands = [
    process.env.CODEX_RELAY_TAILSCALE_BIN?.trim(),
    "tailscale",
    "/usr/local/bin/tailscale",
    "/opt/homebrew/bin/tailscale",
    "/usr/bin/tailscale",
  ].filter((command): command is string => Boolean(command));

  for (const command of commands) {
    try {
      return execFileSync(command, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 1500,
      });
    } catch {
      continue;
    }
  }
  return undefined;
}
