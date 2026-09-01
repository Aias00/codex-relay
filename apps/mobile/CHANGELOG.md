# @codex-relay/mobile

## 1.4.0-ship.9

### Patch Changes

- ee31fee: Run the shared app-server as a detached local daemon so terminal, optional Codex Desktop, and mobile clients keep active sessions across Relay restarts. Subscribe Relay before starting turns on TUI-loaded threads so mobile clients receive assistant and terminal events, including after switching from the run stream to durable replay. Preserve canonical user-message replacement metadata across repeated app-server item events and begin carrying one semantic client event identity from mobile optimistic state through canonical app-server user messages to prevent duplicate mobile bubbles. Keep cached active-thread navigation during transient detail refresh failures instead of replacing it with an unrelated list fallback, and invalidate that selection when the persisted connection plan identifies a different Relay. Scope persisted server state by Relay identity with URL-only cache migration, and use one attention priority plus a Relay/workspace/thread-scoped seen ledger for background catch-up and conversation status. Route push activation with Relay, workspace, thread, turn, and bounded semantic-event deduplication while retaining legacy payload compatibility. Load recent thread history through paginated, single-flight app-server requests so large conversations remain responsive over Tailscale and Cloudflare. Coalesce mobile refreshes and reduce background thread prefetch concurrency to keep the active conversation responsive. Add a verified macOS Desktop launcher without changing the TUI-first workflow.

  Treat interrupted app-server turns as terminal so shared TUI sessions cannot leave mobile stuck on Working. Add content-safe compatibility usage aggregates plus a 30-day retirement gate, CLI report, and non-failing doctor warning before removing legacy request paths.

  Add the capability-gated Tailcat server experiment with an owned, fail-open sidecar, additive Connection Plan candidate, content-safe diagnostics, and HTTP-only fallback for mobile bundles without native Tailcat support.

  Embed a pinned Tailcat Go client in the iOS app behind an Expo module, materialize its route through an app-local loopback proxy, keep connection tokens memory-only, and preserve bounded HTTP fallback for older or unhealthy clients.

  Add content-safe direct-versus-DERP path diagnostics, a bounded persistent iOS DERP-map cache, and an explicit atomic Tailcat server-key rotation command with one protected rollback copy.

  Define strict content-safe transport benchmark JSONL and aggregate it by route and scenario without exposing raw samples or Relay conversation identity.

  Add content-safe `status`, `doctor`, `connections`, `workspaces`, `owners`, and `events` operator commands for diagnosing durable state, routes, stale ownership, and workspace registration without exposing conversation payloads or credentials.

  Shut Relay down through explicit quiesce, bounded drain, and close phases so accepted work and durable events flush before SSE, PTY, HTTP, app-server, and SQLite resources close.

  Derive durable semantic event IDs for accepted and canonical user messages, and recover mobile timelines through one event-cursor, message-cursor, authoritative-snapshot, and generation-guarded background-history ladder.

  Stage push activation until Relay, workspace, and thread snapshots materialize, retaining transient failures for retry and preventing stale notifications from replacing valid navigation.

  Harden pairing and encrypted transport state with loopback-only management authorization, replay windows, crash-safe server counter reservations, transactional client replacement, and SecureStore-backed credentials and traffic keys. Encrypt persisted mobile query state and preserve legacy migration without leaving plaintext conversation caches.

  Make mobile mutations recoverable across unstable networks: persist content-free input identities in a SecureStore outbox, reconcile early stream loss from authoritative snapshots, and make queued cancel, steer, interrupt, and approval retries idempotent across lost responses and Relay restarts. Add one normalized turn lifecycle for mobile reconnecting state and content-safe operator diagnostics for durable stream and input phases.

  Clean up failed app-server and Tailcat startup processes, correct workspace selection after archive, add the main server and mobile regression suites plus package builds to CI, and update vulnerable direct and transitive dependencies within the supported Expo SDK.

## 1.4.0-ship.8

### Patch Changes

- bdc4b5a: Restore fast thread history loading and keep relay version mismatches as sidebar warnings.

## 1.4.0-ship.7

### Patch Changes

- f764166: Keep relay and mobile thread history consistent with Codex 0.149 app-server and SDK behavior, and require the compatible relay release from the app.
- 0d69564: Add a scroll-to-latest button above the composer

## 1.4.0-ship.6

### Patch Changes

- 61f3833: Make the relay setup and phone approval commands selectable and copyable.

## 1.4.0-ship.5

### Patch Changes

- ea78eff: Persist pinned chats locally so they remain available across app restarts.

## 1.4.0-ship.4

### Patch Changes

- 1a640ee: fix: dismiss connecting banner after status check
- afcf5bd: Keep paired mobile sessions connected until they are explicitly signed out or cleared.

## 1.4.0-ship.3

### Patch Changes

- 358aefc: Require codex-relay 1.4.5 or newer in the in-app relay update notice.

## 1.4.0-ship.2

### Patch Changes

- 3150a9d: Support renaming and rewinding Codex app-server chats from mobile.
- f810d3f: Reload the active chat from the Codex app-server when refreshing from mobile.

## 1.4.0-ship.1

### Patch Changes

- c923a9a: Replace the duplicate chat-header new-chat action with a refresh action. New chats remain available from the workspace sidebar.
- a957dec: fix: improve mobile project labels
