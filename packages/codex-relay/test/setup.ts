import { vi } from "vitest";

const stores = new Map<string, Map<string, string>>();

vi.mock("react-native-mmkv", () => ({
  createMMKV(options?: { id?: string }) {
    const id = options?.id ?? "default";
    let store = stores.get(id);
    if (!store) {
      store = new Map();
      stores.set(id, store);
    }

    return {
      getString(key: string) {
        return store.get(key);
      },
      remove(key: string) {
        store.delete(key);
      },
      set(key: string, value: string) {
        store.set(key, value);
      },
    };
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
