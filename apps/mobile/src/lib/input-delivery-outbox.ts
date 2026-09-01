import { utf8ToBytes } from "@noble/ciphers/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { fromByteArray } from "base64-js";
import * as SecureStore from "expo-secure-store";

import {
  claimInputIdentity,
  clearInputIdentity,
  moveInputIdentity,
  type PendingInputIdentity,
} from "./input-delivery-state";

const inputDeliveryOutboxStorageKey = "codex-relay.input-delivery-outbox";
const inputDeliveryOutboxVersion = 1;
const defaultMaxAgeMs = 7 * 24 * 60 * 60 * 1000;
const maximumEntryCount = 64;

type SecureStoreApi = {
  deleteItemAsync(key: string): Promise<void>;
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string, options?: SecureStore.SecureStoreOptions): Promise<void>;
};

type PersistedInputIdentity = PendingInputIdentity & {
  composerKey: string;
  createdAt: number;
};

export function createInputDeliveryOutbox(input: {
  maxAgeMs?: number;
  now?: () => number;
  secureStore: SecureStoreApi;
  storageKey?: string;
}) {
  const maxAgeMs = input.maxAgeMs ?? defaultMaxAgeMs;
  const now = input.now ?? Date.now;
  const storageKey = input.storageKey ?? inputDeliveryOutboxStorageKey;
  let entries = new Map<string, PersistedInputIdentity>();
  let initialization: Promise<void> | undefined;
  let persistenceQueue = Promise.resolve();

  async function initialize() {
    if (!initialization) {
      const pending = (async () => {
        const stored = await input.secureStore.getItemAsync(storageKey);
        entries = parseOutbox(stored, now(), maxAgeMs);
      })();
      initialization = pending;
      void pending.catch(() => {
        if (initialization === pending) {
          initialization = undefined;
        }
      });
    }
    return initialization;
  }

  async function persist() {
    const retained = [...entries.values()]
      .filter((entry) => now() - entry.createdAt <= maxAgeMs)
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, maximumEntryCount);
    entries = new Map(retained.map((entry) => [entry.composerKey, entry]));
    const serialized =
      retained.length === 0
        ? undefined
        : JSON.stringify({ entries: retained, version: inputDeliveryOutboxVersion });
    const result = persistenceQueue
      .catch(() => undefined)
      .then(() =>
        serialized === undefined
          ? input.secureStore.deleteItemAsync(storageKey)
          : input.secureStore.setItemAsync(storageKey, serialized, {
              keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
            }),
      );
    persistenceQueue = result.catch(() => undefined);
    return result;
  }

  return {
    async initialize() {
      await initialize();
    },
    async claim(
      pending: Map<string, PendingInputIdentity>,
      composerKey: string,
      signature: string,
      createClientEventId: () => string,
    ) {
      await initialize().catch(() => undefined);
      const signatureDigest = digestSignature(signature);
      const persisted = entries.get(composerKey);
      if (!pending.has(composerKey) && persisted?.signature === signatureDigest) {
        pending.set(composerKey, {
          clientEventId: persisted.clientEventId,
          signature: persisted.signature,
        });
      }
      const clientEventId = claimInputIdentity(
        pending,
        composerKey,
        signatureDigest,
        createClientEventId,
      );
      const current = pending.get(composerKey)!;
      entries.set(composerKey, {
        ...current,
        composerKey,
        createdAt: persisted?.clientEventId === current.clientEventId ? persisted.createdAt : now(),
      });
      await persist().catch(() => undefined);
      return clientEventId;
    },
    async clear(
      pending: Map<string, PendingInputIdentity>,
      composerKey: string,
      clientEventId: string,
    ) {
      await initialize().catch(() => undefined);
      clearInputIdentity(pending, composerKey, clientEventId);
      if (entries.get(composerKey)?.clientEventId === clientEventId) {
        entries.delete(composerKey);
      }
      await persist().catch(() => undefined);
    },
    async move(
      pending: Map<string, PendingInputIdentity>,
      fromComposerKey: string,
      toComposerKey: string,
      clientEventId: string,
    ) {
      await initialize().catch(() => undefined);
      const persisted = entries.get(fromComposerKey);
      if (!pending.has(fromComposerKey) && persisted?.clientEventId === clientEventId) {
        pending.set(fromComposerKey, {
          clientEventId: persisted.clientEventId,
          signature: persisted.signature,
        });
      }
      moveInputIdentity(pending, fromComposerKey, toComposerKey, clientEventId);
      if (persisted?.clientEventId === clientEventId) {
        entries.delete(fromComposerKey);
        entries.set(toComposerKey, { ...persisted, composerKey: toComposerKey });
      }
      await persist().catch(() => undefined);
    },
    async clearAll() {
      await initialize().catch(() => undefined);
      entries.clear();
      await persist().catch(() => undefined);
    },
  };
}

function parseOutbox(value: string | null, now: number, maxAgeMs: number) {
  const parsedEntries = new Map<string, PersistedInputIdentity>();
  if (!value) {
    return parsedEntries;
  }
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (parsed.version !== inputDeliveryOutboxVersion || !Array.isArray(parsed.entries)) {
      return parsedEntries;
    }
    for (const candidate of parsed.entries) {
      if (!isPersistedInputIdentity(candidate) || now - candidate.createdAt > maxAgeMs) {
        continue;
      }
      parsedEntries.set(candidate.composerKey, candidate);
    }
  } catch {}
  return parsedEntries;
}

function isPersistedInputIdentity(value: unknown): value is PersistedInputIdentity {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.clientEventId === "string" &&
    typeof candidate.composerKey === "string" &&
    typeof candidate.createdAt === "number" &&
    Number.isFinite(candidate.createdAt) &&
    typeof candidate.signature === "string"
  );
}

function digestSignature(signature: string) {
  return fromByteArray(sha256(utf8ToBytes(signature)));
}

const inputDeliveryOutbox = createInputDeliveryOutbox({ secureStore: SecureStore });

export function initializeInputDeliveryOutbox() {
  return inputDeliveryOutbox.initialize();
}

export function claimPersistedInputIdentity(
  pending: Map<string, PendingInputIdentity>,
  composerKey: string,
  signature: string,
  createClientEventId: () => string,
) {
  return inputDeliveryOutbox.claim(pending, composerKey, signature, createClientEventId);
}

export function clearPersistedInputIdentity(
  pending: Map<string, PendingInputIdentity>,
  composerKey: string,
  clientEventId: string,
) {
  return inputDeliveryOutbox.clear(pending, composerKey, clientEventId);
}

export function movePersistedInputIdentity(
  pending: Map<string, PendingInputIdentity>,
  fromComposerKey: string,
  toComposerKey: string,
  clientEventId: string,
) {
  return inputDeliveryOutbox.move(pending, fromComposerKey, toComposerKey, clientEventId);
}

export function clearInputDeliveryOutbox() {
  return inputDeliveryOutbox.clearAll();
}
