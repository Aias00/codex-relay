import { createMMKV } from "react-native-mmkv";

const defaultServerUrl = "http://localhost:8787";
const serverUrlCandidatesStorageKey = "codex-relay.server-url-candidates";
const serverUrlStorageKey = "codex-relay.server-url";
let ephemeralServerUrl: string | undefined;

export const codexRelayStorage = createMMKV({ id: "codex-relay" });

export type CodexRelayServerUrlCandidate = {
  label: string;
  url: string;
};

export const fallbackCodexRelayServerUrl =
  process.env.EXPO_PUBLIC_CODEX_RELAY_SERVER_URL?.replace(/\/$/, "") ?? defaultServerUrl;

export function getCodexRelayServerUrl() {
  return (
    ephemeralServerUrl ??
    codexRelayStorage.getString(serverUrlStorageKey) ??
    fallbackCodexRelayServerUrl
  );
}

export function getCodexRelayServerUrlCandidates(): CodexRelayServerUrlCandidate[] {
  const selectedServerUrl = getCodexRelayServerUrl();
  const candidates = serverUrlCandidatesFromUrls([
    selectedServerUrl,
    fallbackCodexRelayServerUrl,
    ...readStoredServerUrlCandidates(),
  ]);
  const selectedIndex = candidates.findIndex(({ url }) => url === selectedServerUrl);
  if (selectedIndex <= 0) {
    return candidates;
  }
  return [
    candidates[selectedIndex],
    ...candidates.slice(0, selectedIndex),
    ...candidates.slice(selectedIndex + 1),
  ];
}

export function setCodexRelayServerUrl(url: string) {
  const normalizedUrl = normalizeServerUrl(url);
  ephemeralServerUrl = undefined;
  codexRelayStorage.set(serverUrlStorageKey, normalizedUrl);
  return normalizedUrl;
}

export function setEphemeralCodexRelayServerUrl(url: string) {
  ephemeralServerUrl = normalizeServerUrl(url);
  return ephemeralServerUrl;
}

export function clearEphemeralCodexRelayServerUrl() {
  ephemeralServerUrl = undefined;
}

export function clearCodexRelayServerUrlState() {
  ephemeralServerUrl = undefined;
  codexRelayStorage.remove(serverUrlStorageKey);
  codexRelayStorage.remove(serverUrlCandidatesStorageKey);
}

export function saveCodexRelayServerUrlCandidates(urls: string[]) {
  codexRelayStorage.set(
    serverUrlCandidatesStorageKey,
    JSON.stringify(sortServerUrlsByConnectionPreference(urls).filter(isConnectableServerUrl)),
  );
}

export function normalizeServerUrl(url: string) {
  const trimmed = url.trim().replace(/\/$/, "");
  if (!trimmed) {
    throw new Error("Server URL is empty.");
  }

  const parsed = new URL(trimmed);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Server URL must start with http:// or https://.");
  }

  return parsed.toString().replace(/\/$/, "");
}

export function dedupeServerUrls(urls: string[]) {
  const deduped = new Set<string>();
  for (const url of urls) {
    try {
      deduped.add(normalizeServerUrl(url));
    } catch {
      continue;
    }
  }
  return [...deduped];
}

export function isConnectableServerUrl(url: string) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host === "0.0.0.0") {
      return false;
    }
    return !isIPv4NetworkOrBroadcastHost(host);
  } catch {
    return false;
  }
}

export function sortServerUrlsByConnectionPreference(urls: string[]) {
  return dedupeServerUrls(urls).sort(
    (left, right) => serverUrlConnectionScore(right) - serverUrlConnectionScore(left),
  );
}

export function isPrivateIPv4Host(host: string) {
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

export function isLinkLocalIPv4Host(host: string) {
  const octets = host.split(".").map(Number);
  return octets.length === 4 && octets[0] === 169 && octets[1] === 254;
}

export function isIPv4NetworkOrBroadcastHost(host: string) {
  const octets = host.split(".").map(Number);
  return (
    octets.length === 4 &&
    octets.every((octet) => Number.isInteger(octet)) &&
    (octets[3] === 0 || octets[3] === 255)
  );
}

export function isCarrierGradePrivateIPv4Host(host: string) {
  const octets = host.split(".").map(Number);
  return octets.length === 4 && octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
}

export function isLocalIPv6Host(host: string) {
  const normalized = host.replace(/^\[/, "").replace(/\]$/, "");
  return (
    normalized.startsWith("fe80:") || normalized.startsWith("fc") || normalized.startsWith("fd")
  );
}

function readStoredServerUrlCandidates() {
  const stored = codexRelayStorage.getString(serverUrlCandidatesStorageKey);
  if (!stored) {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(stored);
    return Array.isArray(parsed)
      ? parsed.filter((url): url is string => typeof url === "string")
      : [];
  } catch {
    return [];
  }
}

function serverUrlCandidatesFromUrls(urls: string[]): CodexRelayServerUrlCandidate[] {
  return sortServerUrlsByConnectionPreference(urls)
    .filter(isConnectableServerUrl)
    .map((url) => ({
      label: serverUrlCandidateLabel(url),
      url,
    }));
}

function serverUrlConnectionScore(url: string) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
      return 10;
    }
    if (host === "0.0.0.0" || isIPv4NetworkOrBroadcastHost(host)) {
      return -100;
    }
    if (isCarrierGradePrivateIPv4Host(host)) {
      return 550;
    }
    if (parsed.protocol === "https:" && !isPrivateIPv4Host(host) && !isLocalIPv6Host(host)) {
      return 525;
    }
    if (host.endsWith(".ts.net") || host.endsWith(".beta.tailscale.net")) {
      return 500;
    }
    if (host.endsWith(".local")) {
      return 350;
    }
    if (isLinkLocalIPv4Host(host)) {
      return 100;
    }
    if (isPrivateIPv4Host(host) || isLocalIPv6Host(host)) {
      return 300;
    }
    return 250;
  } catch {
    return -100;
  }
}

function serverUrlCandidateLabel(url: string) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
      return "Localhost";
    }
    if (host.endsWith(".local")) {
      return "Local network";
    }
    if (host.endsWith(".ts.net") || host.endsWith(".beta.tailscale.net")) {
      return "Tailscale DNS";
    }
    if (isCarrierGradePrivateIPv4Host(host)) {
      return "Tailscale IP";
    }
    if (isPrivateIPv4Host(host) || isLocalIPv6Host(host)) {
      return "LAN IP";
    }
    return "Server";
  } catch {
    return "Server";
  }
}
