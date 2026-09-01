import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

type DebugFields = Record<string, unknown>;
let pendingDebugWrite = Promise.resolve();

export function isRelayDebugEnabled() {
  return process.env.CODEX_RELAY_DEBUG === "1" || process.env.CODEX_RELAY_DEBUG_STREAM === "1";
}

export function relayDebugLog(event: string, fields: DebugFields = {}) {
  if (!isRelayDebugEnabled()) {
    return;
  }

  const entry = sanitizeDebugValue({
    ts: new Date().toISOString(),
    event,
    ...fields,
  });
  const line = `${JSON.stringify(entry)}\n`;
  const path = process.env.CODEX_RELAY_DEBUG_LOG_PATH?.trim();
  if (path) {
    pendingDebugWrite = pendingDebugWrite
      .then(async () => {
        await mkdir(dirname(path), { recursive: true });
        await appendFile(path, line, { mode: 0o600 });
      })
      .catch(() => undefined);
  }

  console.log(`[debug] ${event} ${formatDebugFields(fields)}`.trimEnd());
}

export async function flushRelayDebugLog() {
  await pendingDebugWrite;
}

function sanitizeDebugValue(value: unknown): unknown {
  if (value instanceof Error) {
    return {
      message: value.message,
      name: value.name,
      stack: value.stack,
    };
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeDebugValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, sanitizeDebugValue(item)]),
    );
  }
  return value;
}

function formatDebugFields(fields: DebugFields) {
  return Object.entries(fields)
    .map(([key, value]) => `${key}=${formatDebugValue(value)}`)
    .join(" ");
}

function formatDebugValue(value: unknown) {
  if (value === undefined) {
    return "undefined";
  }
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return value.includes(" ") ? JSON.stringify(value) : value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(sanitizeDebugValue(value));
}
