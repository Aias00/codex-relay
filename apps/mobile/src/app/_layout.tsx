import "@/global.css";
import "expo-dev-client";
import "react-native-gesture-handler";

import { BottomSheetModalProvider } from "@gorhom/bottom-sheet";
import { HotUpdater } from "@hot-updater/react-native";
import { PortalHost } from "@rn-primitives/portal";
import { QueryClient } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { useFonts } from "expo-font";
import * as Notifications from "expo-notifications";
import { router, Stack } from "expo-router";
import { DarkTheme, ThemeProvider } from "expo-router/react-navigation";
import * as SplashScreen from "expo-splash-screen";
import React, { useEffect, useState } from "react";
import { Text, TextInput } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";

import { AnimatedSplashOverlay } from "@/components/animated-icon";
import { useInitialPushNotificationRegistration } from "@/hooks/use-initial-push-notification-registration";
import { addHotUpdaterLog, formatHotUpdaterProgress } from "@/lib/hot-updater-logs";
import {
  configurePushNotificationPresentation,
  isPushNotificationEventProcessed,
  notificationResponseTarget,
  stagePushNotificationTarget,
  supportsPushNotifications,
} from "@/lib/push-notifications";
import {
  persistedQueryMaxAgeMs,
  queryClientPersister,
  shouldPersistQuery,
} from "@/lib/query-persistence";
import { isAppHydrationReady } from "@/lib/server-state-persistence";
import { restoreChatStoreFromQueryCache } from "@/lib/server-state-hydration";
import { initializeCodexRelayCredentials } from "@/lib/secure-credentials";
import { initializeSecureTransportStorage } from "@/lib/secure-transport";
import { initializeInputDeliveryOutbox } from "@/lib/input-delivery-outbox";

void SplashScreen.preventAutoHideAsync();
configurePushNotificationPresentation();

const appTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: "#191919",
    border: "rgba(255, 255, 255, 0.08)",
    card: "#202222",
  },
};

const queryClient = new QueryClient({
  defaultOptions: {
    mutations: {
      retry: false,
    },
    queries: {
      retry: 1,
      staleTime: 0,
    },
  },
});

const TextWithDefaults = Text as typeof Text & {
  defaultProps?: Partial<React.ComponentProps<typeof Text>>;
};
const TextInputWithDefaults = TextInput as typeof TextInput & {
  defaultProps?: Partial<React.ComponentProps<typeof TextInput>>;
};
const secureStateRetryDelayMs = 2000;

TextWithDefaults.defaultProps = {
  ...TextWithDefaults.defaultProps,
  allowFontScaling: false,
  maxFontSizeMultiplier: 1,
};

TextInputWithDefaults.defaultProps = {
  ...TextInputWithDefaults.defaultProps,
  allowFontScaling: false,
  maxFontSizeMultiplier: 1,
};

async function checkForLaunchUpdate() {
  addHotUpdaterLog(
    "info",
    "OTA launch check started",
    [
      `App version: ${HotUpdater.getAppVersion()}`,
      `Channel: ${HotUpdater.getChannel()}`,
      `Default channel: ${HotUpdater.getDefaultChannel()}`,
      `Cohort: ${HotUpdater.getCohort()}`,
      `Bundle: ${HotUpdater.getBundleId()}`,
      `Min bundle: ${HotUpdater.getMinBundleId()}`,
    ].join("\n"),
  );

  const updateInfo = await HotUpdater.checkForUpdate({
    updateStrategy: "appVersion",
    onError: (error) => {
      addHotUpdaterLog(
        "warning",
        "OTA launch check reported error",
        [`Name: ${error.name}`, `Message: ${error.message}`].join("\n"),
      );
    },
  });

  if (!updateInfo) {
    addHotUpdaterLog("info", "OTA launch check found no update");
    return;
  }

  addHotUpdaterLog(
    "info",
    "OTA launch check found update",
    [`ID: ${updateInfo.id}`, `Status: ${updateInfo.status}`, `Message: ${updateInfo.message}`].join(
      "\n",
    ),
  );

  const didDownload = await updateInfo.updateBundle();
  addHotUpdaterLog(
    didDownload ? "info" : "warning",
    "OTA launch update bundle finished",
    `Downloaded: ${didDownload ? "yes" : "no"}`,
  );
}

function TabLayout() {
  useInitialPushNotificationRegistration();
  const [fontsLoaded] = useFonts({
    GeistMono: require("../../assets/fonts/GeistMono-Regular.ttf"),
    "GeistMono-Medium": require("../../assets/fonts/GeistMono-Medium.ttf"),
  });
  const [queryCacheRestored, setQueryCacheRestored] = useState(false);
  const [secureStateRestored, setSecureStateRestored] = useState(false);
  const appHydrationReady = isAppHydrationReady({
    fontsLoaded,
    queryCacheRestored,
    secureStateRestored,
  });

  useEffect(() => {
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const restoreSecureState = () => {
      void Promise.all([
        initializeCodexRelayCredentials(),
        initializeSecureTransportStorage(),
        initializeInputDeliveryOutbox(),
      ]).then(
        () => {
          if (!cancelled) {
            setSecureStateRestored(true);
          }
        },
        () => {
          if (!cancelled) {
            retry = setTimeout(restoreSecureState, secureStateRetryDelayMs);
          }
        },
      );
    };
    restoreSecureState();
    return () => {
      cancelled = true;
      if (retry) {
        clearTimeout(retry);
      }
    };
  }, []);

  useEffect(() => {
    if (appHydrationReady) {
      void SplashScreen.hideAsync();
    }
  }, [appHydrationReady]);

  useEffect(() => {
    const unsubscribeProgress = HotUpdater.addListener("onProgress", (event) => {
      addHotUpdaterLog("info", "OTA download progress", formatHotUpdaterProgress(event));
    });

    void checkForLaunchUpdate().catch(() => undefined);

    return unsubscribeProgress;
  }, []);

  useEffect(() => {
    if (!supportsPushNotifications()) {
      return;
    }
    const openNotificationThread = (response: Notifications.NotificationResponse) => {
      const target = notificationResponseTarget(response);
      Notifications.clearLastNotificationResponse();
      if (!target || isPushNotificationEventProcessed(target)) {
        return;
      }
      stagePushNotificationTarget(target);
      router.replace("/");
    };

    const mostRecentResponse = Notifications.getLastNotificationResponse();
    if (mostRecentResponse) {
      openNotificationThread(mostRecentResponse);
    }
    const subscription =
      Notifications.addNotificationResponseReceivedListener(openNotificationThread);
    return () => subscription.remove();
  }, []);

  if (!fontsLoaded || !secureStateRestored) {
    return null;
  }

  return (
    <PersistQueryClientProvider
      client={queryClient}
      onError={() => setQueryCacheRestored(true)}
      onSuccess={() => {
        restoreChatStoreFromQueryCache(queryClient);
        setQueryCacheRestored(true);
      }}
      persistOptions={{
        buster: "codex-relay-server-state-v3",
        dehydrateOptions: {
          shouldDehydrateQuery: shouldPersistQuery,
        },
        maxAge: persistedQueryMaxAgeMs,
        persister: queryClientPersister,
      }}
    >
      <ThemeProvider value={appTheme}>
        <GestureHandlerRootView style={{ flex: 1 }}>
          <KeyboardProvider>
            <BottomSheetModalProvider>
              <AnimatedSplashOverlay />
              <Stack
                screenOptions={{
                  contentStyle: {
                    backgroundColor: "#191919",
                  },
                  headerShown: false,
                }}
              >
                <Stack.Screen name="(drawer)" />
                <Stack.Screen name="pair" />
                <Stack.Screen
                  name="image-viewer"
                  options={{
                    contentStyle: {
                      backgroundColor: "#050505",
                    },
                    gestureEnabled: true,
                    presentation: "modal",
                  }}
                />
                <Stack.Screen
                  name="settings"
                  options={{
                    animation: "slide_from_right",
                    title: "Settings",
                  }}
                />
                <Stack.Screen
                  name="workspace-file-editor"
                  options={{
                    animation: "slide_from_right",
                    title: "File Editor",
                  }}
                />
              </Stack>
              <PortalHost />
            </BottomSheetModalProvider>
          </KeyboardProvider>
        </GestureHandlerRootView>
      </ThemeProvider>
    </PersistQueryClientProvider>
  );
}

const hotUpdaterBaseUrl = process.env.EXPO_PUBLIC_HOT_UPDATER_BASE_URL?.trim();

if (hotUpdaterBaseUrl) {
  HotUpdater.init({
    baseURL: hotUpdaterBaseUrl,
  });
}

export default TabLayout;
