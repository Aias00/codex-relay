import "react-native-get-random-values";

import { gcm } from "@noble/ciphers/aes.js";
import { bytesToUtf8, randomBytes, utf8ToBytes } from "@noble/ciphers/utils.js";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import * as SecureStore from "expo-secure-store";
import {
  EncryptedPayloadSchema,
  PairEncryptedPayloadSchema,
  type EncryptedPayload,
  type PairResponse,
} from "codex-relay/api-schema";
import { fromByteArray, toByteArray } from "base64-js";
import { createMMKV } from "react-native-mmkv";

const secureProtocolVersion = 1;
const handshakeTag = "codex-relay-e2ee-v1";
const storage = createMMKV({ id: "codex-relay-secure" });
const keyEpochStorageKey = "key-epoch";
const mobileToServerKeyStorageKey = "mobile-to-server-key";
const serverToMobileKeyStorageKey = "server-to-mobile-key";
const nextMobileCounterStorageKey = "next-mobile-counter";
const lastServerCounterStorageKey = "last-server-counter";
const serverCounterFloorStorageKey = "server-counter-floor";
const seenServerCountersStorageKey = "seen-server-counters";
const secureSessionKeyMaterialStorageKey = "codex-relay.secure-session-key-material";
const replayWindowSize = 1024;
let secureSessionKeyMaterial: SecureSessionKeyMaterial | undefined;
let secureSessionKeyMaterialHydration: Promise<void> | undefined;
let secureSessionKeyMaterialGeneration = 0;
let secureStoreMutationQueue = Promise.resolve();

export type SecurePairingAttempt = {
  approvalCode?: string;
  clientEphemeralPublicKey: string;
  clientNonce: string;
  clientEphemeralPrivateKey: Uint8Array;
  serverPublicKey: string;
  serverUrl: string;
};

type SecureSession = {
  keyEpoch: number;
  lastServerCounter: number;
  mobileToServerKey: Uint8Array;
  nextMobileCounter: number;
  seenServerCounters: number[];
  serverCounterFloor: number;
  serverToMobileKey: Uint8Array;
};

type SecureSessionKeyMaterial = Pick<
  SecureSession,
  "keyEpoch" | "mobileToServerKey" | "serverToMobileKey"
>;

export function createSecurePairingAttempt(input: {
  serverPublicKey: string;
  serverUrl: string;
}): SecurePairingAttempt {
  const clientEphemeralPrivateKey = x25519.utils.randomSecretKey();
  return {
    clientEphemeralPrivateKey,
    clientEphemeralPublicKey: bytesToBase64(x25519.getPublicKey(clientEphemeralPrivateKey)),
    clientNonce: bytesToBase64(randomBytes(32)),
    serverPublicKey: input.serverPublicKey,
    serverUrl: input.serverUrl,
  };
}

export function attachApprovalCode(attempt: SecurePairingAttempt, approvalCode: string) {
  attempt.approvalCode = approvalCode;
}

export async function completeSecurePairing(attempt: SecurePairingAttempt, response: PairResponse) {
  if (!response.secure) {
    throw new Error("Server did not return a secure pairing response.");
  }

  const transcript = pairingTranscript({
    approvalCode: attempt.approvalCode ?? "",
    clientEphemeralPublicKey: attempt.clientEphemeralPublicKey,
    clientNonce: attempt.clientNonce,
    keyEpoch: response.secure.keyEpoch,
    serverEphemeralPublicKey: response.secure.serverEphemeralPublicKey,
    serverIdentityPublicKey: attempt.serverPublicKey,
    serverNonce: response.secure.serverNonce,
    serverUrl: attempt.serverUrl,
  });
  if (
    !ed25519.verify(
      base64ToBytes(response.secure.serverSignature),
      transcript,
      base64ToBytes(attempt.serverPublicKey),
    )
  ) {
    throw new Error("Server secure pairing signature did not match the scanned QR.");
  }

  const sharedSecret = x25519.getSharedSecret(
    attempt.clientEphemeralPrivateKey,
    base64ToBytes(response.secure.serverEphemeralPublicKey),
  );
  const session = deriveSession(sharedSecret, transcript, response.secure.keyEpoch);
  const decrypted = decryptWithKey(
    session.serverToMobileKey,
    "server",
    0,
    response.secure.encryptedPayload,
  );
  const payload = PairEncryptedPayloadSchema.parse(JSON.parse(decrypted));
  await saveSecureSessionKeyMaterial(session);
  saveSecureSession(session);
  return payload;
}

export function initializeSecureTransportStorage() {
  if (!secureSessionKeyMaterialHydration) {
    const pending = hydrateSecureSessionKeyMaterial();
    secureSessionKeyMaterialHydration = pending;
    void pending.catch(() => {
      if (secureSessionKeyMaterialHydration === pending) {
        secureSessionKeyMaterialHydration = undefined;
      }
    });
  }
  return secureSessionKeyMaterialHydration;
}

export function encryptRequestPayload(payload: unknown) {
  const session = readSecureSession();
  if (!session) {
    return JSON.stringify(payload);
  }

  const envelope = encryptWithKey(
    session.mobileToServerKey,
    "mobile",
    session.keyEpoch,
    session.nextMobileCounter,
    JSON.stringify(payload),
  );
  session.nextMobileCounter += 1;
  saveSecureSession(session);
  return JSON.stringify(EncryptedPayloadSchema.parse(envelope));
}

export function decryptResponsePayload(payload: unknown) {
  const session = readSecureSession();
  const envelope = EncryptedPayloadSchema.safeParse(payload);
  if (!session || !envelope.success) {
    return payload;
  }
  if (
    envelope.data.sender !== "server" ||
    envelope.data.keyEpoch !== session.keyEpoch ||
    !Number.isSafeInteger(envelope.data.counter) ||
    envelope.data.counter < session.serverCounterFloor ||
    session.seenServerCounters.includes(envelope.data.counter)
  ) {
    throw new Error("Server returned an invalid encrypted payload.");
  }

  const decrypted = decryptWithKey(
    session.serverToMobileKey,
    "server",
    envelope.data.counter,
    envelope.data.ciphertext,
  );
  session.lastServerCounter = Math.max(session.lastServerCounter, envelope.data.counter);
  session.seenServerCounters.push(envelope.data.counter);
  session.serverCounterFloor = Math.max(
    session.serverCounterFloor,
    session.lastServerCounter - replayWindowSize + 1,
  );
  session.seenServerCounters = session.seenServerCounters.filter(
    (counter) => counter >= session.serverCounterFloor,
  );
  saveSecureSession(session);
  return JSON.parse(decrypted);
}

export function clearSecureSession() {
  secureSessionKeyMaterialGeneration += 1;
  secureSessionKeyMaterial = undefined;
  secureSessionKeyMaterialHydration = undefined;
  storage.clearAll();
  return enqueueSecureStoreMutation(() =>
    SecureStore.deleteItemAsync(secureSessionKeyMaterialStorageKey),
  );
}

function deriveSession(
  sharedSecret: Uint8Array,
  transcript: Uint8Array,
  keyEpoch: number,
): SecureSession {
  const salt = sha256(transcript);
  const infoPrefix = `${handshakeTag}|${keyEpoch}|${bytesToBase64(sha256(transcript))}`;
  return {
    keyEpoch,
    lastServerCounter: 0,
    mobileToServerKey: hkdf(
      sha256,
      sharedSecret,
      salt,
      utf8ToBytes(`${infoPrefix}|mobileToServer`),
      32,
    ),
    nextMobileCounter: 0,
    seenServerCounters: [],
    serverCounterFloor: 1,
    serverToMobileKey: hkdf(
      sha256,
      sharedSecret,
      salt,
      utf8ToBytes(`${infoPrefix}|serverToMobile`),
      32,
    ),
  };
}

function pairingTranscript(input: {
  approvalCode: string;
  clientEphemeralPublicKey: string;
  clientNonce: string;
  keyEpoch: number;
  serverEphemeralPublicKey: string;
  serverIdentityPublicKey: string;
  serverNonce: string;
  serverUrl: string;
}) {
  return utf8ToBytes(
    JSON.stringify({
      tag: handshakeTag,
      approvalCode: input.approvalCode,
      clientEphemeralPublicKey: input.clientEphemeralPublicKey,
      clientNonce: input.clientNonce,
      keyEpoch: input.keyEpoch,
      serverEphemeralPublicKey: input.serverEphemeralPublicKey,
      serverIdentityPublicKey: input.serverIdentityPublicKey,
      serverNonce: input.serverNonce,
      serverUrl: input.serverUrl,
    }),
  );
}

function encryptWithKey(
  key: Uint8Array,
  sender: "mobile" | "server",
  keyEpoch: number,
  counter: number,
  plaintext: string,
): EncryptedPayload {
  const ciphertext = gcm(key, nonceFor(sender, counter)).encrypt(utf8ToBytes(plaintext));
  return {
    ciphertext: bytesToBase64(ciphertext),
    counter,
    keyEpoch,
    protocolVersion: secureProtocolVersion,
    sender,
  };
}

function decryptWithKey(
  key: Uint8Array,
  sender: "mobile" | "server",
  counter: number,
  ciphertext: string,
) {
  const plaintext = gcm(key, nonceFor(sender, counter)).decrypt(base64ToBytes(ciphertext));
  return bytesToUtf8(plaintext);
}

function nonceFor(sender: "mobile" | "server", counter: number) {
  const nonce = new Uint8Array(12);
  nonce[0] = sender === "mobile" ? 1 : 2;
  new DataView(nonce.buffer).setBigUint64(4, BigInt(counter), false);
  return nonce;
}

function saveSecureSession(session: SecureSession) {
  storage.set(nextMobileCounterStorageKey, session.nextMobileCounter);
  storage.set(lastServerCounterStorageKey, session.lastServerCounter);
  storage.set(serverCounterFloorStorageKey, session.serverCounterFloor);
  storage.set(seenServerCountersStorageKey, JSON.stringify(session.seenServerCounters));
}

function readSecureSession() {
  if (!secureSessionKeyMaterial) {
    return undefined;
  }

  const lastServerCounter = storage.getNumber(lastServerCounterStorageKey) ?? 0;
  const storedSeenServerCounters = storage.getString(seenServerCountersStorageKey);
  return {
    keyEpoch: secureSessionKeyMaterial.keyEpoch,
    lastServerCounter,
    mobileToServerKey: secureSessionKeyMaterial.mobileToServerKey,
    nextMobileCounter: storage.getNumber(nextMobileCounterStorageKey) ?? 0,
    seenServerCounters: parseStoredCounters(storedSeenServerCounters),
    serverCounterFloor: storage.getNumber(serverCounterFloorStorageKey) ?? lastServerCounter + 1,
    serverToMobileKey: secureSessionKeyMaterial.serverToMobileKey,
  };
}

async function hydrateSecureSessionKeyMaterial() {
  const generation = secureSessionKeyMaterialGeneration;
  await secureStoreMutationQueue.catch(() => undefined);
  const stored = await SecureStore.getItemAsync(secureSessionKeyMaterialStorageKey);
  const secure = parseSecureSessionKeyMaterial(stored);
  if (secure) {
    if (generation === secureSessionKeyMaterialGeneration) {
      secureSessionKeyMaterial = secure;
    }
    removeLegacyKeyMaterial();
    return;
  }

  if (generation !== secureSessionKeyMaterialGeneration) {
    return;
  }

  const legacy = legacySecureSessionKeyMaterial();
  if (!legacy) {
    return;
  }
  await saveSecureSessionKeyMaterial(legacy);
  removeLegacyKeyMaterial();
}

async function saveSecureSessionKeyMaterial(session: SecureSessionKeyMaterial) {
  const generation = secureSessionKeyMaterialGeneration;
  const serialized = JSON.stringify({
    keyEpoch: session.keyEpoch,
    mobileToServerKey: bytesToBase64(session.mobileToServerKey),
    serverToMobileKey: bytesToBase64(session.serverToMobileKey),
  });
  await enqueueSecureStoreMutation(() =>
    SecureStore.setItemAsync(secureSessionKeyMaterialStorageKey, serialized, {
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
    }),
  );
  if (generation !== secureSessionKeyMaterialGeneration) {
    return;
  }
  secureSessionKeyMaterial = {
    keyEpoch: session.keyEpoch,
    mobileToServerKey: session.mobileToServerKey.slice(),
    serverToMobileKey: session.serverToMobileKey.slice(),
  };
}

function enqueueSecureStoreMutation(operation: () => Promise<void>) {
  const result = secureStoreMutationQueue.catch(() => undefined).then(operation);
  secureStoreMutationQueue = result.catch(() => undefined);
  return result;
}

function parseSecureSessionKeyMaterial(value: string | null) {
  if (!value) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (
      !Number.isSafeInteger(parsed.keyEpoch) ||
      typeof parsed.mobileToServerKey !== "string" ||
      typeof parsed.serverToMobileKey !== "string"
    ) {
      return undefined;
    }
    return {
      keyEpoch: parsed.keyEpoch as number,
      mobileToServerKey: base64ToBytes(parsed.mobileToServerKey),
      serverToMobileKey: base64ToBytes(parsed.serverToMobileKey),
    };
  } catch {
    return undefined;
  }
}

function legacySecureSessionKeyMaterial() {
  const keyEpoch = storage.getNumber(keyEpochStorageKey);
  const mobileToServerKey = storage.getString(mobileToServerKeyStorageKey);
  const serverToMobileKey = storage.getString(serverToMobileKeyStorageKey);
  return keyEpoch !== undefined && mobileToServerKey && serverToMobileKey
    ? {
        keyEpoch,
        mobileToServerKey: base64ToBytes(mobileToServerKey),
        serverToMobileKey: base64ToBytes(serverToMobileKey),
      }
    : undefined;
}

function removeLegacyKeyMaterial() {
  storage.remove(keyEpochStorageKey);
  storage.remove(mobileToServerKeyStorageKey);
  storage.remove(serverToMobileKeyStorageKey);
}

function parseStoredCounters(value: string | undefined) {
  if (!value) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((counter): counter is number => Number.isSafeInteger(counter) && counter >= 0)
      : [];
  } catch {
    return [];
  }
}

function bytesToBase64(bytes: Uint8Array) {
  return fromByteArray(bytes);
}

function base64ToBytes(value: string) {
  return toByteArray(value);
}
