import { beforeEach, describe, expect, it, vi } from "vitest";
import * as MMKV from "react-native-mmkv";
import * as SecureStore from "expo-secure-store";

vi.mock("react-native-get-random-values", () => ({}));

import {
  attachApprovalCode,
  clearSecureSession,
  completeSecurePairing,
  createSecurePairingAttempt,
  decryptResponsePayload,
  encryptRequestPayload,
  initializeSecureTransportStorage,
} from "../../../apps/mobile/src/lib/secure-transport.js";
import {
  createSecurePairing,
  createServerIdentity,
  decryptFromMobile,
  encryptForMobile,
} from "../src/secure-transport.js";

type MockMMKVModule = {
  __getMockMMKVStore(id: string): Map<string, string | number> | undefined;
};

describe("mobile secure transport", () => {
  beforeEach(async () => {
    await clearSecureSession();
  });

  it("accepts valid server responses that arrive out of counter order", async () => {
    const { serverSession } = await pairedSession();
    const first = encryptForMobile(serverSession, JSON.stringify({ order: 1 }));
    const second = encryptForMobile(serverSession, JSON.stringify({ order: 2 }));

    expect(decryptResponsePayload(second)).toEqual({ order: 2 });
    expect(decryptResponsePayload(first)).toEqual({ order: 1 });
    expect(() => decryptResponsePayload(first)).toThrow("invalid encrypted payload");
  });

  it("does not persist E2EE traffic keys in plaintext MMKV", async () => {
    await pairedSession();

    const mmkv = (MMKV as unknown as MockMMKVModule).__getMockMMKVStore("codex-relay-secure");
    expect(mmkv?.get("mobile-to-server-key")).toBeUndefined();
    expect(mmkv?.get("server-to-mobile-key")).toBeUndefined();
  });

  it("accepts valid mobile requests that arrive out of counter order", async () => {
    const { serverSession } = await pairedSession();
    const first = JSON.parse(encryptRequestPayload({ order: 1 }));
    const second = JSON.parse(encryptRequestPayload({ order: 2 }));

    expect(JSON.parse(decryptFromMobile(serverSession, second))).toEqual({ order: 2 });
    expect(JSON.parse(decryptFromMobile(serverSession, first))).toEqual({ order: 1 });
    expect(() => decryptFromMobile(serverSession, first)).toThrow("stale encrypted mobile payload");
  });

  it("serializes sign-out deletion before a new pairing saves key material", async () => {
    let releaseDelete: (() => void) | undefined;
    const deleteReleased = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    const originalDelete = SecureStore.deleteItemAsync;
    const deleteSpy = vi
      .spyOn(SecureStore, "deleteItemAsync")
      .mockImplementationOnce(async (key) => {
        await deleteReleased;
        await originalDelete(key);
      });

    const clearing = clearSecureSession();
    const pairing = pairedSession();
    releaseDelete?.();
    await Promise.all([clearing, pairing]);

    const secureValues = (
      SecureStore as typeof SecureStore & { __getMockSecureStore(): Map<string, string> }
    ).__getMockSecureStore();
    expect(secureValues.has("codex-relay.secure-session-key-material")).toBe(true);
    deleteSpy.mockRestore();
  });

  it("retries secure session hydration after a transient keychain read failure", async () => {
    const getSpy = vi
      .spyOn(SecureStore, "getItemAsync")
      .mockRejectedValueOnce(new Error("keychain temporarily unavailable"));

    await expect(initializeSecureTransportStorage()).rejects.toThrow("temporarily unavailable");
    await expect(initializeSecureTransportStorage()).resolves.toBeUndefined();
    getSpy.mockRestore();
  });
});

async function pairedSession() {
  const serverIdentity = createServerIdentity();
  const serverUrl = "https://relay.example";
  const approvalCode = "ABCD-1234";
  const attempt = createSecurePairingAttempt({
    serverPublicKey: serverIdentity.publicKey,
    serverUrl,
  });
  attachApprovalCode(attempt, approvalCode);
  const pairing = createSecurePairing({
    approvalCode,
    clientEphemeralPublicKey: attempt.clientEphemeralPublicKey,
    clientNonce: attempt.clientNonce,
    clientToken: "client-token",
    clientTokenExpiresAt: "9999-12-31T23:59:59.999Z",
    keyEpoch: 1,
    serverIdentity,
    serverUrl,
  });
  await completeSecurePairing(attempt, { secure: pairing.response });
  return { serverSession: pairing.session };
}
