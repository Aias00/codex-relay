import * as SecureStore from "expo-secure-store";

import { codexRelayStorage } from "./codex-relay-server-url-storage";

const clientTokenStorageKey = "codex-relay.client-token";

type SecureStoreApi = {
  deleteItemAsync(key: string): Promise<void>;
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string, options?: SecureStore.SecureStoreOptions): Promise<void>;
};

export function createSecureCredentialState(input: {
  deleteLegacy(): void;
  legacyValue(): string | undefined;
  secureStore: SecureStoreApi;
  storageKey: string;
}) {
  let initialized = false;
  let initializePromise: Promise<void> | undefined;
  let generation = 0;
  let mutationQueue = Promise.resolve();
  let value: string | undefined;

  function enqueueMutation(operation: () => Promise<void>) {
    const result = mutationQueue.catch(() => undefined).then(operation);
    mutationQueue = result.catch(() => undefined);
    return result;
  }

  return {
    clear() {
      generation += 1;
      initialized = true;
      value = undefined;
      input.deleteLegacy();
      return enqueueMutation(() => input.secureStore.deleteItemAsync(input.storageKey));
    },
    get() {
      return value;
    },
    initialize() {
      if (!initializePromise) {
        const pending = (async () => {
          const initializeGeneration = generation;
          await mutationQueue.catch(() => undefined);
          const secureValue = await input.secureStore.getItemAsync(input.storageKey);
          if (secureValue) {
            if (initializeGeneration === generation) {
              value = secureValue;
            }
            input.deleteLegacy();
            initialized = true;
            return;
          }
          const legacyValue = input.legacyValue();
          if (legacyValue) {
            await enqueueMutation(() =>
              input.secureStore.setItemAsync(input.storageKey, legacyValue, {
                keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
              }),
            );
            if (initializeGeneration === generation) {
              value = legacyValue;
            }
            input.deleteLegacy();
          }
          initialized = true;
        })();
        initializePromise = pending;
        void pending.catch(() => {
          if (initializePromise === pending) {
            initializePromise = undefined;
          }
        });
      }
      return initializePromise;
    },
    isInitialized() {
      return initialized;
    },
    async set(nextValue: string) {
      generation += 1;
      const setGeneration = generation;
      await enqueueMutation(() =>
        input.secureStore.setItemAsync(input.storageKey, nextValue, {
          keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
        }),
      );
      if (setGeneration === generation) {
        value = nextValue;
      }
      initialized = true;
      input.deleteLegacy();
    },
  };
}

const clientTokenState = createSecureCredentialState({
  deleteLegacy: () => codexRelayStorage.remove(clientTokenStorageKey),
  legacyValue: () => codexRelayStorage.getString(clientTokenStorageKey),
  secureStore: SecureStore,
  storageKey: clientTokenStorageKey,
});

export function initializeCodexRelayCredentials() {
  return clientTokenState.initialize();
}

export function getCodexRelayClientToken() {
  return clientTokenState.get();
}

export function saveCodexRelayClientToken(clientToken: string) {
  return clientTokenState.set(clientToken);
}

export function clearCodexRelayClientToken() {
  return clientTokenState.clear();
}
