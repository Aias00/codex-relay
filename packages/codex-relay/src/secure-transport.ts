import { gcm } from "@noble/ciphers/aes.js";
import { randomBytes, utf8ToBytes } from "@noble/ciphers/utils.js";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { fromByteArray, toByteArray } from "base64-js";

export const secureProtocolVersion = 1;
const handshakeTag = "codex-relay-e2ee-v1";

export type ServerIdentity = {
  privateKey: Uint8Array;
  publicKey: string;
};

export type SecureSession = {
  keyEpoch: number;
  mobileToServerKey: Uint8Array;
  serverToMobileKey: Uint8Array;
  lastMobileCounter: number;
  mobileCounterFloor?: number;
  nextServerCounter: number;
  serverCounterLimit?: number;
  serverCounterMutation?: Promise<void>;
  serverCounterRenewAt?: number;
  seenMobileCounters?: number[];
};

const replayWindowSize = 1024;

export function createServerIdentity(): ServerIdentity {
  const privateKey = ed25519.utils.randomSecretKey();
  return createServerIdentityFromPrivateKey(privateKey);
}

export function createServerIdentityFromPrivateKey(privateKey: Uint8Array): ServerIdentity {
  return {
    privateKey,
    publicKey: bytesToBase64(ed25519.getPublicKey(privateKey)),
  };
}

export function createSecurePairing(input: {
  clientEphemeralPublicKey: string;
  clientNonce: string;
  clientToken: string;
  clientTokenExpiresAt: string;
  keyEpoch: number;
  approvalCode: string;
  serverIdentity: ServerIdentity;
  serverUrl: string;
}) {
  const serverEphemeralPrivateKey = x25519.utils.randomSecretKey();
  const serverEphemeralPublicKey = x25519.getPublicKey(serverEphemeralPrivateKey);
  const serverNonce = randomBytes(32);
  const transcript = pairingTranscript({
    clientEphemeralPublicKey: input.clientEphemeralPublicKey,
    clientNonce: input.clientNonce,
    keyEpoch: input.keyEpoch,
    approvalCode: input.approvalCode,
    serverEphemeralPublicKey: bytesToBase64(serverEphemeralPublicKey),
    serverIdentityPublicKey: input.serverIdentity.publicKey,
    serverNonce: bytesToBase64(serverNonce),
    serverUrl: input.serverUrl,
  });
  const sharedSecret = x25519.getSharedSecret(
    serverEphemeralPrivateKey,
    base64ToBytes(input.clientEphemeralPublicKey),
  );
  const session = deriveSession(sharedSecret, transcript, input.keyEpoch);
  const encryptedPayload = encryptWithKey(
    session.serverToMobileKey,
    "server",
    input.keyEpoch,
    0,
    JSON.stringify({
      clientToken: input.clientToken,
      clientTokenExpiresAt: input.clientTokenExpiresAt,
    }),
  );

  session.nextServerCounter = 1;
  return {
    response: {
      encryptedPayload: encryptedPayload.ciphertext,
      keyEpoch: input.keyEpoch,
      protocolVersion: secureProtocolVersion as 1,
      serverEphemeralPublicKey: bytesToBase64(serverEphemeralPublicKey),
      serverNonce: bytesToBase64(serverNonce),
      serverSignature: bytesToBase64(ed25519.sign(transcript, input.serverIdentity.privateKey)),
    },
    session,
  };
}

export function encryptForMobile(session: SecureSession, plaintext: string) {
  if (
    session.serverCounterLimit !== undefined &&
    session.nextServerCounter >= session.serverCounterLimit
  ) {
    throw new Error("Secure server counter reservation is exhausted.");
  }
  const envelope = encryptWithKey(
    session.serverToMobileKey,
    "server",
    session.keyEpoch,
    session.nextServerCounter,
    plaintext,
  );
  session.nextServerCounter += 1;
  return envelope;
}

export function decryptFromMobile(session: SecureSession, envelope: unknown) {
  if (!isEncryptedEnvelope(envelope) || envelope.sender !== "mobile") {
    throw new Error("Expected encrypted mobile payload.");
  }
  const counterFloor = session.mobileCounterFloor ?? session.lastMobileCounter + 1;
  const seenCounters = session.seenMobileCounters ?? [];
  if (
    envelope.keyEpoch !== session.keyEpoch ||
    !Number.isSafeInteger(envelope.counter) ||
    envelope.counter < counterFloor ||
    seenCounters.includes(envelope.counter)
  ) {
    throw new Error("Rejected stale encrypted mobile payload.");
  }

  const plaintext = decryptWithKey(
    session.mobileToServerKey,
    "mobile",
    envelope.counter,
    envelope.ciphertext,
  );
  session.lastMobileCounter = Math.max(session.lastMobileCounter, envelope.counter);
  seenCounters.push(envelope.counter);
  session.mobileCounterFloor = Math.max(
    counterFloor,
    session.lastMobileCounter - replayWindowSize + 1,
  );
  session.seenMobileCounters = seenCounters.filter(
    (counter) => counter >= (session.mobileCounterFloor ?? 0),
  );
  return plaintext;
}

export function encodePairingServerKey(publicKey: string) {
  return publicKey;
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
    lastMobileCounter: -1,
    mobileCounterFloor: 0,
    mobileToServerKey: hkdf(
      sha256,
      sharedSecret,
      salt,
      utf8ToBytes(`${infoPrefix}|mobileToServer`),
      32,
    ),
    nextServerCounter: 0,
    seenMobileCounters: [],
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
  return new TextEncoder().encode(
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
) {
  const ciphertext = gcm(key, nonceFor(sender, counter)).encrypt(
    new TextEncoder().encode(plaintext),
  );
  return {
    ciphertext: bytesToBase64(ciphertext),
    counter,
    keyEpoch,
    protocolVersion: secureProtocolVersion as 1,
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
  return new TextDecoder().decode(plaintext);
}

function nonceFor(sender: "mobile" | "server", counter: number) {
  const nonce = new Uint8Array(12);
  nonce[0] = sender === "mobile" ? 1 : 2;
  new DataView(nonce.buffer).setBigUint64(4, BigInt(counter), false);
  return nonce;
}

function isEncryptedEnvelope(value: unknown): value is {
  ciphertext: string;
  counter: number;
  keyEpoch: number;
  sender: "mobile" | "server";
} {
  return (
    value !== null &&
    typeof value === "object" &&
    "ciphertext" in value &&
    "counter" in value &&
    "keyEpoch" in value &&
    "sender" in value &&
    typeof (value as { ciphertext?: unknown }).ciphertext === "string" &&
    typeof (value as { counter?: unknown }).counter === "number" &&
    typeof (value as { keyEpoch?: unknown }).keyEpoch === "number" &&
    ((value as { sender?: unknown }).sender === "mobile" ||
      (value as { sender?: unknown }).sender === "server")
  );
}

function bytesToBase64(bytes: Uint8Array) {
  return fromByteArray(bytes);
}

function base64ToBytes(value: string) {
  return toByteArray(value);
}
