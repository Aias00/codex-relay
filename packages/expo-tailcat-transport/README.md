# Expo Tailcat Transport

Internal iOS transport for Codex Relay. The native module binds a pinned Tailcat Go client,
listens only on an ephemeral IPv4 loopback port, and forwards that port to one Relay server port.
The existing paired-session and encrypted-payload protocol remains responsible for authentication.

Build the vendored framework on an Apple Silicon Mac with Xcode and Go 1.26.5 or newer:

```sh
pnpm --filter expo-tailcat-transport build:ios
```

The default build contains an arm64 iOS device slice and a universal iOS simulator slice
with arm64 and x86_64. The build fails if either default simulator architecture is missing,
because CocoaPods otherwise skips the entire XCFramework when a Release build requests both.
Override `TAILCAT_IOS_TARGETS` only for an intentionally narrower local build.

The Expo prebuild flag writes `CodexRelayTailcatTransportEnabled` into the native app Info.plist.
The Swift module exposes that read-only value to JavaScript, so OTA bundles inherit the capability
of the installed binary rather than the environment used to build the update.

The iOS bridge gives Tailcat a bounded on-disk DERP map cache under the app's `Caches`
directory. Entries are keyed by a hash of the map URL, written atomically with `0600`
permissions, and limited to the same 8 MiB response size accepted by Tailcat. The cache
contains only the public DERP map response, ETag, and storage time; connection tokens and
Relay data are never persisted there. Missing, corrupt, oversized, or system-evicted cache
entries fall back to Tailcat's normal network fetch.
