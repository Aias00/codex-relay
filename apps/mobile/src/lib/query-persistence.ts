import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import { defaultShouldDehydrateQuery, type Query } from "@tanstack/react-query";
import { gcm } from "@noble/ciphers/aes.js";
import { randomBytes, utf8ToBytes, bytesToUtf8 } from "@noble/ciphers/utils.js";
import { fromByteArray, toByteArray } from "base64-js";
import * as SecureStore from "expo-secure-store";
import { createMMKV } from "react-native-mmkv";

import { isPersistableServerStateQueryKey } from "./server-state-persistence";

const storage = createMMKV({ id: "codex-relay-query-cache" });
const queryCacheEncryptionKeyStorageKey = "codex-relay.query-cache-encryption-key";
const encryptedStorageVersion = 1;
let encryptionKeyPromise: Promise<Uint8Array> | undefined;

const clientStorage = {
  async setItem(key: string, value: string) {
    storage.set(key, await encryptStoredValue(key, value));
  },
  async getItem(key: string) {
    const stored = storage.getString(key);
    if (!stored) {
      return null;
    }
    const envelope = parseEncryptedStoredValue(stored);
    if (!envelope) {
      await clientStorage.setItem(key, stored);
      return stored;
    }
    const encryptionKey = await queryCacheEncryptionKey();
    try {
      return bytesToUtf8(
        gcm(encryptionKey, toByteArray(envelope.nonce), utf8ToBytes(key)).decrypt(
          toByteArray(envelope.ciphertext),
        ),
      );
    } catch {
      storage.remove(key);
      return null;
    }
  },
  removeItem(key: string) {
    storage.remove(key);
  },
};

async function encryptStoredValue(key: string, value: string) {
  const encryptionKey = await queryCacheEncryptionKey();
  const nonce = randomBytes(12);
  const ciphertext = gcm(encryptionKey, nonce, utf8ToBytes(key)).encrypt(utf8ToBytes(value));
  return JSON.stringify({
    ciphertext: fromByteArray(ciphertext),
    nonce: fromByteArray(nonce),
    version: encryptedStorageVersion,
  });
}

function queryCacheEncryptionKey() {
  if (!encryptionKeyPromise) {
    const pending = (async () => {
      const existing = await SecureStore.getItemAsync(queryCacheEncryptionKeyStorageKey);
      if (existing) {
        const decoded = toByteArray(existing);
        if (decoded.length === 32) {
          return decoded;
        }
      }
      const created = randomBytes(32);
      await SecureStore.setItemAsync(queryCacheEncryptionKeyStorageKey, fromByteArray(created), {
        keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
      });
      return created;
    })();
    encryptionKeyPromise = pending;
    void pending.catch(() => {
      if (encryptionKeyPromise === pending) {
        encryptionKeyPromise = undefined;
      }
    });
  }
  return encryptionKeyPromise;
}

function parseEncryptedStoredValue(value: string) {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return parsed.version === encryptedStorageVersion &&
      typeof parsed.ciphertext === "string" &&
      typeof parsed.nonce === "string"
      ? { ciphertext: parsed.ciphertext, nonce: parsed.nonce }
      : undefined;
  } catch {
    return undefined;
  }
}

export const queryClientPersister = createAsyncStoragePersister({
  key: "codex-relay.react-query",
  storage: clientStorage,
  throttleTime: 1000,
});

export const persistedQueryMaxAgeMs = 7 * 24 * 60 * 60 * 1000;

export function shouldPersistQuery(query: Query) {
  return defaultShouldDehydrateQuery(query) && isPersistableServerStateQueryKey(query.queryKey);
}
