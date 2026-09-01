import { vi } from "vitest";

const stores = new Map<string, Map<string, string | number>>();

vi.mock("react-native-mmkv", () => ({
  __getMockMMKVStore(id: string) {
    return stores.get(id);
  },
  createMMKV(options?: { id?: string }) {
    const id = options?.id ?? "default";
    let store = stores.get(id);
    if (!store) {
      store = new Map();
      stores.set(id, store);
    }

    return {
      clearAll() {
        store.clear();
      },
      getNumber(key: string) {
        const value = store.get(key);
        return typeof value === "number" ? value : undefined;
      },
      getString(key: string) {
        const value = store.get(key);
        return typeof value === "string" ? value : undefined;
      },
      remove(key: string) {
        store.delete(key);
      },
      set(key: string, value: string | number) {
        store.set(key, value);
      },
    };
  },
}));

const secureStore = new Map<string, string>();

vi.mock("expo-secure-store", () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: "AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY",
  __getMockSecureStore() {
    return secureStore;
  },
  async deleteItemAsync(key: string) {
    secureStore.delete(key);
  },
  async getItemAsync(key: string) {
    return secureStore.get(key) ?? null;
  },
  async setItemAsync(key: string, value: string) {
    secureStore.set(key, value);
  },
}));

vi.mock("expo-tailcat-transport", () => ({
  isTailcatTransportAvailable: () => false,
  isTailcatTransportEnabled: () => true,
  startTailcatTransport: async () => {
    throw new Error("Tailcat transport is unavailable in this test build.");
  },
  stopTailcatTransport: async () => undefined,
}));

vi.mock("expo-modules-core", () => ({
  requireOptionalNativeModule: () => null,
}));
