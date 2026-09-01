import { requireOptionalNativeModule } from "expo-modules-core";

export type TailcatTransportNativeModule = {
  enabled?: boolean;
  path?(timeoutMs: number): Promise<string>;
  start(token: string, targetPort: number): Promise<string>;
  stop(): Promise<void>;
};

const nativeModule = requireOptionalNativeModule<TailcatTransportNativeModule>("TailcatTransport");

export function isTailcatTransportAvailable() {
  return nativeModule !== null;
}

export function isTailcatTransportEnabled(
  module: Pick<TailcatTransportNativeModule, "enabled"> | null = nativeModule,
) {
  return module?.enabled === true;
}

export async function startTailcatTransport(token: string, targetPort: number) {
  if (!nativeModule) {
    throw new Error("Tailcat transport is unavailable in this mobile build.");
  }
  return nativeModule.start(token, targetPort);
}

export async function stopTailcatTransport() {
  await nativeModule?.stop();
}

export async function readTailcatTransportPath(timeoutMs: number) {
  return nativeModule?.path ? nativeModule.path(timeoutMs) : "unknown";
}
