# Reliable Multi-Workspace Relay Design

## Status

- **Status:** In progress
- **Date:** 2026-08-26
- **Scope:** Relay server, mobile client, Codex app-server integration, and optional desktop bridge
- **Primary objective:** Make mobile conversation state reliable across network changes, app restarts, multiple workspaces, and shared desktop sessions.

### Implementation Progress

Checkpoint 1 is implemented as an additive, backward-compatible server foundation:

- Independent `relay-state.db` initialization with fail-open production startup.
- Per-thread monotonic event sequences and idempotent event identities.
- Durable event pagination through `GET /v1/threads/:threadId/events`.
- Shared Zod and OpenAPI replay contracts.
- Store, route, legacy thread API, build, typecheck, and mobile stream regression coverage.

Checkpoint 2 adds durable publishing for prompt-initiated run streams:

- Existing SSE event names and payloads remain compatible; optional `eventId` and `sequence` fields carry the durable cursor.
- Events commit to `relay-state.db` before live delivery, in per-thread sequence order.
- Persistence failures fall back to the legacy live stream instead of breaking mobile/server interaction.
- Mobile SSE disconnection does not cancel the Codex turn; later output continues into the durable event log.
- Attach streams intentionally remain non-durable until a single canonical app-server watcher owns notification persistence.

Checkpoint 3 adds backward-compatible mobile replay consumption:

- Thread snapshots and their last durable event cursor persist in the existing React Query cache.
- Thread hydration fetches missing event pages and applies replay and realtime events through one sequence gate.
- Duplicate durable events are ignored; sequence gaps stop the current subscription and enter the existing recovery path.
- Cursorless streams and Relays without the replay endpoint continue using the legacy snapshot/SSE behavior.
- Attach completion performs a final replay pass so cursor state catches up with the prompt stream's durable log.

Checkpoint 4 adds cursor-resumable durable realtime delivery:

- `GET /v1/threads/:threadId/events/stream?afterSequence=N` replays and follows stored events without persisting duplicates.
- Subscriber disconnect only closes that event reader; prompt execution and durable publication continue independently.
- Mobile uses the durable stream only after obtaining a durable cursor, with an app-session-only capability fallback to the legacy attach endpoint.
- Existing event names and the legacy `/runs/stream` contract remain unchanged.

Checkpoint 5 adds the server foundation for connection planning:

- A stable `relayId` is derived from the existing persistent server identity while `serverEpoch` changes on each process start.
- Authenticated `/v1/health` and `/v1/connection-plan` endpoints expose matching identity metadata and current route candidates.
- Candidate plans use stable route IDs, explicit route kinds, bounded expiry, and retain low-priority link-local routes.
- Existing pairing QR candidates and mobile route selection remain unchanged until the mobile plan consumer ships separately.

Checkpoint 6 adds backward-compatible mobile connection-plan consumption:

- Pairing completion and session refresh fetch the authenticated plan before loading thread data.
- Health probes accept a route only when both `relayId` and `serverEpoch` match the fetched plan.
- Route success and failure observations persist by `relayId + routeId`, with a fresh verified route tried first.
- Per-route and total failover budgets bound reconnect time, and one plan refresh follows an all-candidate failure.
- Older Relays without the plan endpoint fall back to the existing saved URL candidates for the rest of the App session.

Checkpoint 7 adds the stable workspace registry foundation:

- `relay-state.db` schema v2 persists random workspace identities, canonical paths, aliases, availability state, and trusted registration sources.
- Relay startup configuration and app-server thread `cwd` discovery populate the registry without allowing mobile clients to register arbitrary directories.
- Authenticated `GET /v1/workspaces` lists trusted workspaces while existing path-based APIs remain unchanged.
- File-backed state mutations are serialized so durable events and workspace discovery do not contend on SQLite writes.

Checkpoint 8 adds backward-compatible server workspace identity consumption:

- Core workspace-scoped APIs accept optional `workspaceId` while retaining `workspacePath` as a compatibility field.
- Requests that provide both fields must identify the same registered workspace; unknown or conflicting identities are rejected.
- Status, thread, file, terminal, Git, and runtime preference responses add workspace identity where available.
- Prompt-stream durable events inherit the selected thread workspace identity.
- Existing mobile requests and path-keyed caches remain supported until the mobile identity migration ships separately.

Checkpoint 9 adds backward-compatible mobile workspace identity consumption:

- React Query status, thread-list, thread-detail, queued-input, context-window, and event-cursor keys are isolated by Relay URL, stable workspace identity, and thread identity.
- Persisted path-keyed and legacy unscoped thread snapshots and cursors remain readable and are promoted into stable ID keys after status or thread hydration identifies the workspace.
- Initial refresh applies status before requesting threads, preventing an unscoped multi-workspace list from being written into one workspace cache.
- Mobile workspace requests send both `workspaceId` and `workspacePath`; new Relays resolve the stable identity while older Relays continue using the compatibility path.
- Runtime preference caches prefer Relay URL plus workspace ID, promote legacy path entries on read, and retain path aliases for release rollback compatibility.
- Workspace file, Markdown, editor, skill, Git, and terminal requests carry stable identity where available; remote file query keys also include Relay URL and workspace identity.

Checkpoint 10 makes accepted mobile inputs durable and retry-safe:

- `relay-state.db` schema v3 persists input payloads, lifecycle state, and the original acknowledgement result before `/input` returns success.
- Optional `clientEventId` plus the existing client session identity makes mobile retries idempotent without changing older client requests.
- Mobile retains one stable event UUID across transport retries, while older Relays continue accepting the request without the optional field.
- Relay startup hydrates queued inputs from durable state so accepted queue entries survive a process restart.

Checkpoint 11 adds process-lifetime thread owner epochs and atomic turn claims:

- `relay-state.db` schema v4 persists one current owner generation per thread and at most one active turn claim.
- Every Relay app-server `turn/start` for an initial, queued, or steered durable input is preceded by an atomic claim tied to the current owner epoch.
- Retrying an initial stream with the same client event observes that turn only while its claim is active; terminal retries close idempotently for snapshot recovery, and a different input accepted while a claim is active remains durably queued without subscribing its caller to the preceding turn.
- Terminal writes validate both owner epoch and claim identity; stale callbacks cannot complete a replacement owner's input or dispatch its next queue item.
- Replacing a Relay process owner increments the epoch and records cancelled claim tombstones while marking their inputs failed for explicit later reconciliation.
- Missing app-server thread recovery transactionally remaps the active input and claim to the recovered thread and owner before retrying `turn/start`.
- A completed app-server turn with no output or input request is persisted as a failed input, matching the existing `codex_empty_response` stream result.
- FIFO claim selection uses durable insertion order when timestamps collide.

Checkpoint 12 reconciles active Relay-managed streams after a shared app-server socket reconnect:

- The socket client publishes internal `disconnected` and `reconnected` lifecycle events with attached versus Relay-owned server identity.
- Each active streamed run subscribes for its lifetime and, after reconnect, reads its current thread with turns through the existing per-thread serialization gates.
- Reconciliation only accepts the already-known active turn ID: a running turn refreshes local output state, while a terminal turn uses the existing idempotent finalization path to persist output, release its claim, and dispatch durable queued input.
- Transient reconciliation read failures leave the active claim intact for later notification or reconnect recovery.
- Reconciliation never calls `turn/start`, and stream cleanup removes the lifecycle listener.

Checkpoint 13 persists the execution identity required for safe process-restart recovery:

- `relay-state.db` schema v5 adds an optional app-server runtime turn ID to each durable claim and migrates existing v4 databases in place.
- Initial runs, FIFO queue handoffs, and explicit steer dispatch bind the `turn/start` result to the active claim before treating the local turn as recoverable.
- Rebinding the same runtime turn is idempotent; a different runtime turn, stale owner epoch, or terminal claim cannot overwrite the persisted identity.
- Active claims can be enumerated in durable insertion order so the next startup-recovery checkpoint can reconcile them without guessing from in-memory maps.
- Existing v4 claims remain valid with an unknown runtime identity and are not automatically replayed or failed by this migration.

Checkpoint 14 reconstructs exact Relay-managed app-server turns after a Relay process restart:

- Startup recovery enumerates only active claims with a persisted runtime turn ID and confirms that exact turn through `thread/read(includeTurns: true)` before mutating durable ownership.
- A confirmed running turn atomically advances the owner epoch, transfers the claim to the new Relay process generation, preserves the input as running, and restores the in-memory owner, claim, input, steering, and app-server turn maps.
- A confirmed terminal turn is adopted before its claim and durable input are finalized, so callbacks from the previous owner generation remain stale.
- The recovered-turn watcher closes the startup notification window with an immediate authoritative reread and repeats that reread after shared-socket reconnects.
- Terminal notifications and reconnect reconciliation are scoped to the exact startup-recovered claim and runtime turn IDs; after finalization they cannot affect later request-scoped claims on the same thread.
- Missing turns, unknown runtime IDs or states, stale owners, and failed thread reads leave the previous durable claim untouched. Recovery never calls `turn/start`.

Checkpoint 15 restores canonical output persistence and durable queue progress for recovered turns:

- The recovery watcher reacts to exact-turn `item/completed` and terminal notifications by rereading the authoritative thread instead of trusting notification payloads.
- Completed items are projected through the existing app-server message mapping into the durable event log without requiring a request-scoped SSE controller; terminal snapshots publish all exact-turn messages before the terminal thread state.
- Recovery event identities are deterministic by claim and canonical payload, so repeated notifications, reconnect rereads, and terminal snapshots do not duplicate unchanged replay events while still allowing changed canonical content to append a newer event.
- Startup, reconnect, and recovery-dispatched turns publish an idempotent running state; every recovery projection flushes durable writes before terminal claim finalization.
- A successfully completed recovered claim atomically claims the next eligible durable input in FIFO order before issuing one `turn/start`, then binds the returned runtime turn ID and keeps the same headless watcher attached to that recovery-managed claim.
- Repeated terminal notifications cannot start the queued input twice. Invalid queued payloads and `turn/start` failures finalize the newly claimed input as failed, while stale owners stop dispatch.
- Existing mobile replay and realtime event schemas remain unchanged; no mobile bundle update is required for this checkpoint.

Checkpoint 16 adds public owner-epoch mutation guards without breaking rolling upgrades:

- Thread list, detail, and stream state expose the current optional `ownerEpoch`; public summaries reread the coordinator so a refresh observes an owner replacement performed outside the current Relay process cache.
- Run, stream, archive, rewind, goal, queued input, steer, interrupt, and approval resolution requests accept an optional `expectedOwnerEpoch` and return `stale_owner_epoch` before their side effect when the durable owner generation changed.
- Mutations that perform preparatory reads or hydration revalidate the durable epoch at the app-server dispatch or durable-write boundary, closing owner changes that occur while those awaits are in progress. A future owner-operation lease remains responsible for cross-process exclusion across the external RPC itself.
- Idempotent input retries still return their persisted response before epoch validation, so a response lost across an owner replacement does not convert an already accepted input into a false rejection.
- Mobile automatically carries the cached epoch for prompts, archive/rewind/goal actions, queue actions, interrupts, and approval/input-request resolutions. An interrupt rejection preserves local running and queue state, refreshes the authoritative snapshot, and restores observation instead of pretending the turn stopped. Older Relays ignore the additive request field, while older mobile bundles ignore the additive response field and continue using the existing server-side claim checks.
- The server change is backward compatible without a mobile update. Updating the mobile JS bundle is required only to activate client-supplied stale-owner rejection on the phone.

Checkpoint 17 adds bounded durable event retention and optional owner leases:

- Thread event compaction records a durable sequence boundary. A stale cursor receives `resetRequired` and mobile resumes from an authoritative thread-detail refresh rather than replaying a missing range forever.
- `CODEX_RELAY_MAX_THREAD_EVENTS` enables bounded per-thread retention; the default remains unbounded for rolling compatibility.
- `CODEX_RELAY_OWNER_LEASE_MS` enables a renewable process owner lease. A different Relay cannot take over a live lease, while an expired lease permits a new epoch; the active owner renews every third of the configured duration.
- Both controls are disabled by default, so existing single-Relay mobile/server traffic is unchanged until an operator opts in.

Checkpoint 18 closes the accepted `turn/start` / runtime-ID persistence gap:

- `relay-state.db` schema v6 records `dispatch_started_at` on an active claim immediately before every Relay-managed app-server `turn/start` call.
- Startup recovery reads authoritative thread turns and binds an unbound dispatched claim only when exactly one turn started inside the strict dispatch window.
- Zero candidates, multiple candidates, unknown turn states, stale owners, and late external desktop turns leave the claim untouched; recovery never calls `turn/start`.
- Initial input, steer, FIFO queue handoff, and recovered queue dispatch all use the same marking boundary before app-server mutation.

Checkpoint 19 persists and restores pending app-server approvals:

- `relay-state.db` schema v7 stores pending command, file, permission, structured-input, and MCP elicitation requests before they become visible to mobile.
- Shared-mode Relay startup hydrates unresolved requests onto the current shared app-server client, preserving the original request ID, questions, turn identity, and approval message. Private stdio app-server requests are process-bound and intentionally remain live-only.
- A successful app-server response marks the durable request resolved; a persistence failure remains fail-open for the current live interaction and is recorded in diagnostics.
- Content-safe diagnostics, online-consistent SQLite backup, explicit event compaction, and expired-owner repair are available through the CLI.

Checkpoint 20 repairs early schema v7 approval stores:

- `relay-state.db` schema v8 detects an existing `pending_approvals` table without `message_json` and adds the column in place before approval hydration runs.
- Existing pending rows remain readable with no message payload, while newly persisted command and file approvals retain their mobile status message across restart.

Checkpoint 21 closes the current runtime-preference acknowledgement UX:

- Mobile stages model, service-tier, reasoning, and runtime-mode revisions per workspace, serializes writes, and keeps the optimistic value visible until the latest revision is acknowledged.
- Runtime and model controls are disabled while that workspace has an unacknowledged revision, preventing overlapping picker changes from appearing settled.
- Accepted responses replace cached preferences with the server response. Rejected writes clear the optimistic revision and refresh authoritative status, restoring the observed value.
- Collaboration mode remains thread/composer state and app-server turn input; approval and structured input requests use their separate durable pending/resolve protocol.

Optional Desktop Bridge is deferred as a separate vertical integration. Shared app-server is the supported desktop-session path. A bridge will only be implemented together with a real desktop runtime adapter that can register, heartbeat, publish canonical events, accept or queue input, and acknowledge controls; Relay-only registration endpoints would be unusable scaffolding and an unnecessary local attack surface.

Checkpoint 22 improves mobile conversation responsiveness without changing server contracts:

- Workspace refresh opportunistically prefetches up to four likely-to-open thread snapshots with concurrency capped at two; running threads receive priority, while the active thread is excluded because its foreground hydration owns the latest request.
- Prefetch failures are isolated from the active screen and never replace cached content or connection state.
- Thread hydration exposes cache, latest-sync, older-history hydration, synced, and stale states. Cached messages remain visible while network work continues, and older pagination runs in the background.
- The conversation list continues using the existing virtualized `LegendList` and memoized message bubbles; no new list dependency or risky recycling behavior is introduced.

Checkpoint 23 begins the Phase 9 semantic identity migration without removing compatibility paths:

- Chat messages expose an optional `semanticEventId`; mobile optimistic run and steering messages derive it from the stable `clientEventId` accepted by Relay.
- Relay passes that identity to app-server as `clientUserMessageId`, preserves it on canonical user items, and emits one canonical replacement when item lifecycle notifications repeat.
- Mobile message merging prefers canonical messages sharing the same semantic identity even when attachment or skill normalization changes the rendered content.
- Startup refresh keeps a cached active thread when its detail snapshot fails transiently; only an authoritative missing-thread response may replace that navigation with a list fallback.
- Push payloads add Relay, workspace, turn, and deterministic semantic notification identities. Mobile rejects identified notifications from another Relay, activates the exact workspace/thread, and keeps a bounded processed-event history while accepting legacy thread-only payloads.
- Persisted navigation records the Relay identity. Cold start preserves matching and legacy selections but discards workspace/thread selection when the stored plan identifies a different Relay.
- React Query server-state keys include the stable Relay identity in addition to URL, workspace, and thread. URL-only persisted keys are promoted once into the current Relay scope, while keys for another URL or an already identified Relay are never reused.
- One shared attention function defines and applies `blocked > failed > completed-unseen > paused > working > idle > unknown` to background catch-up and conversation-list status.
- A Relay/workspace/thread-scoped seen ledger baselines existing history on first upgrade, records active-thread snapshot and stream activity, and marks only newer background completions unseen. Opening a conversation clears its unseen completion without affecting another Relay or workspace.
- Seen baselines are tracked per Relay plus workspace identity rather than per Relay alone. Introducing a second workspace therefore baselines its existing completed threads without misclassifying them as new completions; the v2 store intentionally rebaselines v1 data.
- Older Relays and mobile bundles continue using message IDs, replacement metadata, bounded content heuristics, legacy notification routing, and URL-only cache keys through compatibility readers.

Checkpoint 24 expands the Phase 8 content-safe operator surface:

- `status` summarizes recorded listen/connect configuration, database schema and counts, paired clients, owners, claims, approvals, and events without printing pairing payloads or credentials.
- `connections`, `workspaces`, `owners`, and `events <thread-id>` expose route candidates and durable coordination metadata while omitting event payload JSON, prompts, file content, tokens, and approval codes.
- `doctor` checks server metadata, schema migration level, authentication storage, route candidates, workspace availability, expired owners, and managed shared app-server socket configuration with JSON and human-readable output.
- The existing atomic `repair-owner` command closes the diagnostic loop. Local validation detected and repaired one expired owner with no active claim, after which every doctor check passed.
- Three-phase quiesce, drain, and close remains the next Phase 8 lifecycle increment.

Checkpoint 25 implements the Phase 8 shutdown lifecycle:

- One idempotent lifecycle coordinator runs `quiesce -> drain -> close`, reuses the same shutdown Promise across repeated signals, records hook failures, and always closes after a bounded drain timeout.
- Quiescing stops the HTTP listener from accepting new connections and returns retryable `503 service_shutdown` responses for mutation and new stream requests that arrive on existing connections, while ordinary reads remain available during drain.
- Draining waits for serialized thread operations, app-server mutations, workspace registration, and durable event publisher flushes.
- Closing terminates active SSE readers and workspace PTYs before closing HTTP connections, the Relay app-server client, pairing storage, and durable Relay state storage. SQLite close is idempotent for the process-exit fallback.
- Shutdown debug writes are serialized and explicitly flushed before process exit, preserving terminal lifecycle evidence.
- An isolated runtime smoke test returned `/version` successfully, exited with the expected SIGTERM code, released its ephemeral port, wrote both shutdown phases, and reopened schema-v8 state after close.

Checkpoint 26 advances Phase 9 durable semantic identity and recovery:

- Prompt-stream user events derive deterministic durable IDs from the stable `clientEventId`, thread identity, user-message role, and explicit accepted-versus-canonical lifecycle stage.
- The accepted Relay user message and canonical app-server replacement remain distinct durable events, while repeated canonical notifications converge on one event ID. Delta and thread-state events remain sequence-ordered and intentionally do not use semantic deduplication.
- Structured input request creation and resolution receive separate deterministic identities from the durable request ID.
- App-server integration coverage confirms the derived IDs commit through the publisher into SQLite and replay metadata, not only in a pure helper.
- One mobile recovery ladder now chooses event replay, message cursor refresh, or a recent authoritative snapshot. Cursor reset and sequence gap require the authoritative snapshot, and the event cursor advances only after that snapshot materializes successfully.
- Older history hydration remains a returned background promise, preserving immediate recent-message rendering while pagination continues.
- Older-history requests carry a Relay-scoped thread generation. An authoritative reset invalidates the prior generation, so an already in-flight old page is discarded on return instead of merging incompatible history into the new snapshot.

Checkpoint 27 completes the push activation materialization gate:

- Notification response handling persists an exact pending target and returns to the chat surface without mutating workspace or thread navigation.
- The mounted chat screen receives an in-process staging signal; cold starts recover the same target from MMKV after persisted query hydration.
- Activation waits for the current Relay identity and an authoritative thread detail snapshot, then validates the optional workspace identity before changing navigation.
- Relay or workspace mismatch and authoritative missing-thread responses clear and deduplicate the target. Unknown Relay identity and transient thread fetch failures remain pending for the next refresh.
- Processed push identities are scoped by Relay plus semantic event ID, so identical thread/turn identifiers from different Relays cannot suppress one another.
- The event is marked processed only after successful activation or explicit rejection, avoiding notification loss if the app exits during materialization.
- The processed claim key includes Relay, workspace, thread, turn, and semantic event identity. A successfully materialized push target consumes but cannot be replaced by the older hydrated-default fallback.
- Durable input coverage now exercises ten concurrent retries with one `clientEventId`, proving one created input and one shared durable identity.

Checkpoint 28 closes a shared-TUI terminal-state mismatch:

- App-server `TurnStatus` values now classify `interrupted` as terminal even when its optional `completedAt` remains null, matching the generated protocol schema and the state observed after a TUI turn ends.
- Authoritative thread refresh can therefore clear Relay and mobile `Working` state instead of treating an interrupted final turn as an unknown running state.
- Common cancellation aliases remain terminal for rolling protocol compatibility, while unknown future turn states retain the conservative running fallback.
- Route coverage reproduces the live `thread.status=notLoaded`, `turn.status=interrupted`, and `completedAt=null` shape. This is a server-only correction and requires no mobile bundle update.

Checkpoint 29 adds content-safe compatibility telemetry and an explicit retirement gate:

- `relay-state.db` schema v9 aggregates only fixed compatibility feature names, counts, and first/last timestamps. Prompt text, event payload JSON, tokens, pairing data, file content, thread IDs, and workspace paths are never recorded.
- Relay observes legacy prompt streams, attach streams, mutations without `clientEventId`, and `workspacePath` selections without `workspaceId`. Observation writes are asynchronous and fail-open, so storage failure cannot change request status or mobile/server interaction.
- `codex-relay compatibility [--json]` reports only the content-safe aggregate, observation start, quiet-window cutoff, and blocking feature names. `doctor` exposes the same retirement gate as a warning rather than a service error.
- Compatibility readers cannot be retired until schema-v9 observation has run for 30 days and no `legacy.*` feature was observed inside that entire quiet window. A missing database, pre-v9 database, or incomplete window remains explicitly not ready.
- Persistence/restart, route classification, fail-open behavior, quiet-window assessment, operator privacy, and real CLI JSON output have regression coverage.

Checkpoint 30 establishes the optional Tailcat server foundation without changing current mobile routing:

- The authenticated Connection Plan accepts an additive Tailcat candidate union containing an opaque token and Relay target port. HTTP candidate shapes and ordering remain backward compatible.
- Tailcat candidates are returned only when the request declares `tailcat` capability and the owned sidecar still reports healthy. Mobile builds without the native module declare no capability, ignore unsupported transport entries if encountered, and continue probing HTTP candidates within the existing bounded failover budget.
- `CODEX_RELAY_TAILCAT_TRANSPORT=1` starts one Relay-owned sidecar against only the configured Relay port using an existing persistent key. Startup failure is fail-open, and the existing lifecycle close phase terminates the owned process.
- The sidecar receives its token through a mode-0600 address file. Child stdout/stderr are drained but never logged, thrown startup errors are generic, and server-state/CLI diagnostics expose only enabled state, health, PID, target port, timestamps, and exit code.
- Schema, capability gate, unhealthy-sidecar omission, unsupported-mobile fallback, token privacy, startup failure, and sidecar lifecycle have regression coverage. A real Tailcat 0.3.0 smoke run produced a healthy candidate and reached `stopped` after close without printing the token.
- The embedded iOS loopback proxy and native capability declaration are delivered in Checkpoint 31. Device benchmarks and staged rollout remain subsequent Phase 10 increments.

Checkpoint 31 embeds Tailcat beneath the existing iOS HTTP/SSE client:

- A private Expo module binds a scalar-only Go facade around Tailcat v0.3.0. It listens on one ephemeral IPv4 loopback port and forwards each connection through `Client.DialTCPPort` to the Relay target; it does not install routes, DNS, a VPN profile, or a NetworkExtension.
- The pinned Go module, `go.sum`, reproducible gomobile build script, arm64 device plus universal arm64/x86_64 simulator XCFramework, Tailcat BSD license, and third-party notice live together. Rebuilding the framework requires Go 1.26.5+, Xcode, and the pinned `x/mobile` tool version.
- Mobile declares `x-codex-relay-capabilities: tailcat` only when Expo autolinking finds the native module and the internal-build flag `EXPO_PUBLIC_CODEX_RELAY_TAILCAT_TRANSPORT=1` is set. That flag also changes the iOS non-exempt-encryption declaration; ordinary distribution builds remain disabled pending export-compliance and App Store review. A Tailcat plan candidate is materialized into a loopback HTTP candidate, validated through the existing encrypted `/v1/health` probe, and cleaned up before bounded fallback when materialization or health fails.
- Starting the same token/port is idempotent, so plan refresh cannot tear down active SSE streams. Switching back to HTTP, replacing the paired session, a stale refresh generation, or signing out closes the native listener and client.
- Tailcat tokens remain memory-only: persisted Connection Plans retain HTTP candidates only, diagnostics and errors omit the token, and the ephemeral loopback URL never replaces the persisted reconnectable server URL. A JS runtime restart therefore returns to HTTP bootstrap before rematerializing Tailcat.
- Route diagnostics use Tailcat's `Client.DiscoPing` only after the loopback health probe has selected the Tailcat route. The post-selection probe is asynchronous and cannot consume the connection-plan fallback budget. The native facade returns only `direct`, `derp`, `unknown`, or `stopped`; IP endpoints, DERP region identity, tokens, and loopback URLs never enter diagnostic state. Older binaries without the optional native `path` method remain compatible and report `unknown`.
- The native client persists Tailcat's public DERP map response, ETag, and storage time under the iOS app `Caches` directory so reconnect after an App process restart can use Tailcat's one-hour fresh-cache and stale-on-fetch-failure behavior. Cache files use hashed URL names, atomic replacement, `0600` permissions, and an 8 MiB raw-map limit. Corrupt, oversized, missing, or system-evicted entries fail open to Tailcat's normal map fetch; tokens and Relay payloads are never written to this cache.
- Go unit tests, JS materialization/fallback/privacy/path tests, Expo autolinking, CocoaPods integration, standalone simulator/device pod builds, and a full generic-device Release App build pass. A full Debug App link remains blocked by the repository's existing prebuilt-React Debug symbol mismatch, which contains no Tailcat/Go missing symbols. Fresh repository verification also passes the Relay test suite, workspace typecheck, production build, oxlint, and scoped formatting checks; the full formatter still reports only excluded generated evidence under `.playwright-mcp/` and `work/`.
- Because the framework is native, existing binaries and OTA-only updates do not activate this checkpoint. A signed internal iOS 1.4.0 build with the Tailcat JS capability, Swift/Go start-stop-path symbols, and non-exempt-encryption declaration enabled has been installed on a physical device. Launch, direct/DERP routing, SSE, and bounded HTTP fallback acceptance remain pending until that device is unlocked for runtime verification.

Checkpoint 32 adds explicit Tailcat server-key rotation without changing Relay identity or pairing state:

- `tailcat-key rotate` requires an explicit DERP region ID, code, or custom hostname. It generates into a sibling temporary file, discards all Tailcat stdout/stderr so the new connection token cannot reach logs, validates the bounded JSON file with Tailcat's own `printpub` command, and atomically replaces the configured key.
- The previous key is retained as one mode-0600 `.previous` rollback file. The command reports only local paths plus `restartRequired`; it never touches `auth.db`, `relay-state.db`, paired sessions, workspaces, threads, or event cursors.
- Rotation does not pretend to be active immediately: the running sidecar continues using its in-memory key until Relay restarts. Only that restart invalidates old Tailcat tokens, while ordinary HTTP candidates remain available throughout.
- Unit tests cover successful replacement, rollback preservation, permissions, and content-safe failure. A real Tailcat 0.3.0 smoke rotation in a temporary directory produced different old/new key hashes with mode-0600 files and no token output. Rotation of the live key remains an explicit destructive acceptance step and has not been run automatically.

Checkpoint 33 establishes a reproducible, content-safe transport benchmark artifact before device sampling:

- A strict versioned JSONL schema covers LAN, direct Tailcat, DERP Tailcat, Tailnet, and Cloudflare across connect, reconnect, sustained SSE, and large-history scenarios. Samples contain only an opaque UUID, timestamp, app version, success, duration, and optional byte, event-count, and battery measurements.
- Unknown fields are rejected, so URLs, connection tokens, Relay/workspace/thread/turn/message identity, prompts, responses, file paths, and free-form notes cannot enter the artifact. Parse failures report only a line number and never echo the rejected sample.
- `transport-benchmark FILE` groups by route and scenario and reports only sample/success counts, success rate, and nearest-rank P50/P95 latency, throughput, event count, and battery use. Raw sample IDs are not retained in output.
- Parser, privacy rejection, deterministic grouping, percentile, throughput, and battery aggregation have regression coverage. This checkpoint defines the measurement contract; collection of real samples and pass/fail thresholds still requires the unlocked physical device.

Checkpoint 34 closes the iOS Release simulator packaging and visual-verification gap:

- The default gomobile build now targets the complete iOS and iOS Simulator platforms. Its generated simulator framework contains both arm64 and x86_64, matching the architectures requested by a Release simulator build; a post-build guard fails immediately if either architecture is missing.
- CocoaPods integration was regenerated from the universal XCFramework, and a full Release build for `RemoteForge Picker iPhone 17` completed with the embedded Tailcat module and production JS bundle.
- The built app installed and launched in the simulator without a native-module crash. The 1206x2622 Settings capture shows the compact Diagnostics row, sample count, export action, and clear action without overlap, truncation, or viewport overflow.
- The simulator downloaded and cryptographically verified production OTA deployment `01a059be-7add-74ad-bd37-c6d604f08b85`, then restarted onto visible bundle `04f08b85`. This provides runtime evidence for the same mobile state fix delivered to iOS 1.4.0. Physical-device direct/DERP, SSE, and bounded HTTP-fallback acceptance remain pending.

Checkpoint 35 makes Tailcat activation OTA-stable and closes simulator direct/fallback acceptance:

- Internal native builds write `CodexRelayTailcatTransportEnabled=true` into Info.plist. The Swift Expo module exposes that immutable native value, and JavaScript declares Tailcat capability only when both the native gate and module are present. OTA manifests can no longer accidentally enable an ordinary distribution build or disable an enabled internal binary.
- A higher-priority transport candidate may supersede a lower-priority fresh HTTP route; fresh-success remains authoritative for equal or higher-priority HTTP candidates. This allows the intended Tailcat priority 550 experiment to run for upgraded clients instead of being perpetually hidden behind a renewed 24-hour Tailscale success.
- Release simulator deployment `01a059fa-1fe3-71f2-b1dc-4a5459143a92` loaded against the native-gated binary. Relay content-safe diagnostics confirmed capability requested and Tailcat candidate included; the mobile benchmark recorded `tailcat_direct`, and process inspection showed one loopback listener, bidirectional loopback traffic, UDP sockets, and a DERP 8443 connection.
- With Relay Tailcat disabled at configuration and the App cold-started, the same authenticated client requested capability but received four HTTP candidates with no Tailcat candidate. Cached conversation content stayed visible and the client continued through Tailscale. The original Relay configuration and one healthy sidecar were restored afterward without restarting the shared app-server.
- Sidecar ownership now uses a mode-0600 PID file with command validation before stale-process termination. The watchdog owns a dedicated process group and terminates the entire pnpm/tsx/Relay/Tailcat tree on stop or unhealthy exit. Two consecutive LaunchAgent SIGTERM restarts retained exactly one PID-file-matched sidecar and preserved the shared app-server PID. A conflicting standalone Tailcat LaunchAgent was disabled locally; the Relay-owned and standalone modes must not run together.
- The simulator also completed a secure deep-link pairing without exposing the QR payload or approval code, rendered the same cached history at 3 and 9 seconds while Relay was completely offline, recovered after Relay restart, and isolated four stable workspace cache identities for `/Users/aias`, `competition`, `Chat2DB`, and `iggy`.

Checkpoint 36 closes external-TUI terminal convergence and the large-thread foreground refresh loop:

- Global app-server terminal notifications for TUI-owned turns now persist completed canonical items followed by one authoritative `thread.state.changed` event. A cold Relay with no in-memory thread snapshot reads the exact thread with turns before publishing, so mobile terminal convergence no longer depends on the phone having opened that thread since the last Relay restart.
- A real isolated `codex --remote unix://` smoke turn confirmed that the shared app-server does not broadcast unknown thread notifications to clients that never subscribed. Shared-socket startup, workspace-summary warmup, and `/v1/threads` listing now schedule an idempotent `thread/resume` with `excludeTurns=true` for active external threads only. Subagents, idle threads, current Relay claims/runtime turns, active durable streams, and already subscribed threads are skipped; subscription failure cannot delay startup or a list response. A second production smoke held a turn active with a bounded shell sleep, restarted Relay, observed `subscribed_from_list`, and then persisted one gap-free external sequence: reasoning item, tool item, completed assistant item, and one final completed thread state.
- Stable external event IDs deduplicate repeated terminal callbacks. Active turn claims, runtime turn IDs, current durable SSE contexts, and recently terminal Relay-owned turn IDs prevent prompt streams and restart recovery from being republished as external work. Regression coverage includes a cold external TUI completion, a duplicate recovered completion, and a normal mobile durable prompt stream.
- A running mobile snapshot now performs a zero-stale-time lightweight detail read instead of forcing recent history reconstruction. A non-running server detail is authoritative at the fetch boundary, so an `idle`, `completed`, or `failed` response clears stale local `Working` state without scanning old turns.
- Recovery after a successful detail read carries that fresh baseline into the event recovery ladder. Event replay still wins when available; replay unavailability or reset reuses the baseline and continues older-history hydration in the background. Full recent-history refresh remains reserved for explicit refresh, stream loss, cursor failure, or a sequence gap with no baseline.
- Physical iOS 1.4.0 validation recorded three successful `tailcat_direct/connect` samples at 403-598 ms. Stopping the Relay-owned Tailcat sidecar removed the Tailcat candidate, left four HTTP candidates, and the same phone completed an authoritative large-thread read before Relay restored one healthy sidecar.
- Production OTA `01a05a3f-3fa2-7842-bcf4-e93a524c85e0` is downloaded and active on the physical device. After activation, foreground large-thread reads used `forceRefresh=false`; normal detail responses were typically 2-26 ms and no automatic `forceRefresh=true` occurred after the final cold start.
- HTTP probe benchmarks now classify `public_https` as `cloudflare` while preserving the content-safe duration/route/success-only payload. Regression coverage confirms that URL, route ID, token, and Relay identity remain absent. OTA `01a05a47-6408-788a-9530-4adbfb400fb3` contains this classification, but the physical device locked before launch; activation and the first real `cloudflare/connect` sample remain pending.
- Manual exact-route benchmark collection is published in OTA `01a05a65-8140-76e8-9806-64274ac2bc3a`. A subsequent stale-`Working` reproduction proved that Relay had already persisted the external TUI terminal sequence and returned a non-running detail snapshot while mobile still displayed the cached running state. Mobile had only auto-attached the durable terminal stream for `source=app` threads; OTA `01a05a6c-1c2a-7533-8202-36543989c660` removes that source gate for every running thread and retains the 1.5-second detail polling fallback after a stream failure. The later aggregate production OTA `01a05bd0-4e1c-7a2f-a6c4-94da20602298` includes that work plus durable checkpoint settlement and Relay-scoped cache hydration. An iOS 1.4.0 Release simulator downloaded and verified the update, and the physical device now reports active bundle suffix `20602298`. Relay subsequently observed terminal convergence and non-running lightweight detail reads for both active Codex Relay workspace threads.
- The content-safe compatibility report currently contains no legacy observations, and Relay doctor passes server state, schema v9, auth, routes, all 36 registered workspaces, active owners, shared app-server, and Tailcat checks. Phase 8 retirement remains correctly gated because the 30-day observation window started on 2026-08-31 and does not complete until 2026-09-30; legacy paths must remain enabled until that window closes without usage.
- Mobile recovery policy now has focused regression coverage proving that every running source initially attaches the durable stream, while only an external thread whose stream actually failed falls back to bounded polling. The opt-in live app-server suite also passes all five real scenarios: independent shared-socket clients, a mobile turn after TUI attachment, server SSE through the mobile reducer, continuation of a not-yet-loaded thread, and real delegation surfaced as mobile subagent activity. Full verification passes all 568 tests, all workspace typechecks, all builds, oxlint, repository formatting, and diff whitespace checks.
- Forced physical DERP remains pending. The upstream Tailscale DERP-only debug knobs are compiled out on iOS, and closing sidecar UDP descriptors is self-healed by magicsock. Live Tailcat key rotation, DERP-path sampling, and complete LAN/Tailnet/Cloudflare benchmark matrices remain explicit subsequent acceptance steps.

Prompt-stream token deltas are persisted before delivery through the durable publisher. Attach streams intentionally do not republish deltas because multiple subscribers would create duplicate durable events; recovered turns persist completed canonical items and terminal snapshots.

## Summary

Codex Relay currently combines thread mutation and live streaming in request-scoped flows. That works while one mobile connection remains healthy, but it leaves recovery dependent on snapshot refreshes and app-server availability. It also uses raw workspace paths as identities and keeps queued input and active-writer state primarily in memory.

The target design makes the Relay the durable coordination boundary:

```text
Mobile client / terminal TUI
             |
             v
Codex Relay
  |- connection plan and route health
  |- stable workspace registry
  |- thread coordinator
  |- durable event and input store
  |- owner, epoch, and claim validation
  |- runtime and permission controls
  `- app-server / bridge adapters
             |
             v
Codex app-server or a bridge-enabled desktop runtime
```

The Relay owns accepted inputs and canonical thread events. Mobile SSE connections are observers: losing the phone connection must not cancel a Codex turn. A reconnect first replays durable events and then resumes realtime delivery without gaps or duplicates.

## Goals

- Recover every accepted mobile input and canonical thread event after transient network loss or process restart.
- Show cached conversation content immediately instead of blocking the chat screen behind an unbounded loading state.
- Support multiple local projects through stable workspace identities rather than raw path strings.
- Share sessions through the existing Codex shared app-server transport when available.
- Distinguish Relay-managed, shared app-server, bridge-enabled, and external standalone writers.
- Make start, queue, steer, interrupt, approval, and runtime configuration explicit, idempotent operations.
- Preserve backward compatibility while server and mobile versions roll out independently.
- Provide enough diagnostics to identify route, replay, ownership, queue, and app-server failures locally.

## Non-Goals

- Injecting input into an arbitrary already-running standalone Codex CLI process.
- Uploading workspace source code or full conversation content to a hosted Relay service.
- Replacing Codex app-server's thread and turn semantics.
- Treating optimistic conflict recovery as permission to bypass an active writer.
- Copying Telegram/Discord message-tree behavior into the linear Codex thread UI.
- Making a configured Cloudflare or Tailscale endpoint publicly available automatically.

## Current Baseline

The current repository already provides useful foundations:

- Pairing, encrypted mobile payloads, and local authentication.
- Multiple connection URL candidates and mobile route storage.
- Multi-workspace thread discovery using `workspacePath` and thread `cwd`.
- Relay-managed Codex app-server operation.
- Experimental shared app-server socket mode through `--shared-app-server`.
- Queue, steer, interrupt, approval, and runtime preference endpoints.
- Detection of external active writers through `thread_active_writer`.
- Mobile workspace caches and stream fallback refresh behavior.
- A libSQL-compatible database adapter already used by pairing state.

The remaining reliability gaps are:

- Run SSE has no durable cursor, canonical replay log, or resume contract.
- Input acceptance and live output delivery are coupled to a client request lifetime.
- In-memory queue and writer state do not survive Relay restarts.
- A raw absolute path acts as workspace identity across much of the API.
- Mobile cannot always distinguish persisted, queued, steered, running, and terminal delivery.
- Runtime controls are preference snapshots rather than request/acknowledgement operations.
- A standalone desktop Codex process cannot be converted into a shared session in place.

## Design Principles

1. **Persist before acknowledgement.** An input is accepted only after its durable record commits.
2. **Separate commands from observation.** Input/control POSTs mutate state; event GET/SSE endpoints observe it.
3. **One canonical order.** Each thread has a monotonically increasing event sequence.
4. **Validate every stale actor.** Owner epoch, turn claim, and client event identity protect different boundaries.
5. **Disconnect does not imply cancellation.** Mobile transport lifetime is independent from turn lifetime.
6. **Use official sharing first.** Shared app-server is the primary desktop/mobile path; a bridge is a compatibility adapter.
7. **Reject unsupported ownership explicitly.** External desktop occupation never appears as mobile success.
8. **Keep local filesystem authority local.** Workspace registration does not copy or upload project content.
9. **Roll out additively.** New storage and APIs coexist with the current paths until both clients are migrated.
10. **Keep transport below protocol.** LAN, Tailnet, Cloudflare, and optional Tailcat routes carry the same authenticated Relay HTTP/SSE protocol; no transport owns thread semantics.

## Workspace Model

A workspace is the local project directory in which Codex reads files, runs commands, loads project instructions and skills, and evaluates Git state. The Relay source directory is only the default workspace when the Relay was started there.

Examples:

```text
/Users/aias/Work/github/codex-relay  -> workspace A
/Users/aias/Work/github/achub        -> workspace B
/Users/aias/Work/github/remoteforge  -> workspace C
```

Raw paths remain execution metadata, but clients address workspaces by a persisted random identity:

```ts
type Workspace = {
  workspaceId: string;
  canonicalPath: string;
  displayName: string;
  repositoryIdentity?: string;
  createdAt: string;
  lastSeenAt: string;
  state: "available" | "missing" | "unauthorized";
};
```

The registry stores path aliases separately so path normalization or a moved checkout does not create accidental duplicate UI groups. Repository remote data may assist migration, but it must not be the primary key because multiple worktrees and clones can share a remote.

Every thread, event, runtime snapshot, terminal session, file operation, and Git operation is scoped by `workspaceId`. During migration, `workspacePath` remains a compatibility field and is resolved through the registry.

Mobile requests cannot register arbitrary directories. New paths enter the registry only through Relay startup configuration, an existing Codex thread `cwd`, or an explicit local operator command.

### Working Directory Semantics

Relay process cwd, package-manager cwd, shared app-server daemon cwd, workspace selection, and thread cwd are distinct values. They must never be inferred from one another after startup.

- `CODEX_RELAY_WORKSPACE_PATH` selects the Relay's default workspace and startup registration path.
- `CODEX_RELAY_APP_SERVER_CWD` selects only the detached shared app-server daemon's fallback cwd. It defaults to the configured Relay workspace, then the user home directory, never `packages/codex-relay` merely because pnpm launched the server there.
- A new terminal session must explicitly carry the operator's current directory: `codex --remote unix:// -C "$PWD"`.
- A resumed thread keeps its persisted original cwd. `-C`, Relay restart, LaunchAgent changes, and mobile workspace selection do not rewrite an existing thread's execution root.
- Mobile new-thread requests carry the selected stable workspace identity and resolved canonical path to `thread/start`; they never inherit daemon process cwd.
- `resume --all` is discovery across workspaces, not permission to migrate a thread between workspaces.

Startup diagnostics report all four values separately: Relay process cwd, configured default workspace, daemon cwd, and selected thread cwd. A mismatch is informational unless a new thread omitted explicit workspace metadata, in which case creation fails rather than silently using a package directory.

## Connection Plan

Pairing bootstrap data includes enough candidates to reach the Relay once. After authentication, the mobile client obtains a server-issued connection plan:

```ts
type ConnectionPlan = {
  relayId: string;
  serverEpoch: string;
  expiresAt: string;
  refreshPath: string;
  candidates: Array<
    | {
        routeId: string;
        transport: "http";
        url: string;
        kind: "last_success" | "tailscale" | "lan" | "link_local" | "public_https";
        priority: number;
      }
    | {
        routeId: string;
        transport: "tailcat";
        token: string;
        localTargetPort: number;
        priority: number;
      }
  >;
};
```

Candidate policy:

- Try the last successful route for the same `relayId` first while its health record is fresh.
- Probe candidates with a small `/v1/health` request before loading thread data.
- Confirm `relayId` and `serverEpoch` in the health response to prevent cross-Relay cache reuse.
- Keep `169.254.*` link-local candidates, but rank them below previously proven routes.
- Prefer a configured HTTPS public route when iOS App Transport Security blocks a plain HTTP candidate.
- Apply a short per-candidate timeout and a bounded total failover budget.
- Refresh the plan after all candidates fail instead of repeating the same list indefinitely.
- Persist success and failure observations by `relayId + routeId`, not as one global server URL.

Changing routes does not invalidate pairing, thread cursors, workspace caches, or pending input identities.

### Optional Tailcat Transport

Tailcat is an optional userspace transport adapter built from Tailscale's open-source data plane without the Tailscale control plane. It uses WireGuard encryption, DERP bootstrap and fallback, and magicsock NAT traversal. It does not require a Tailnet account, root privileges, route-table changes, or DNS ownership.

The integration keeps Relay HTTP and SSE unchanged:

```text
Relay 127.0.0.1:8788
  -> Mac Tailcat sidecar
  -> WireGuard over direct UDP or DERP
  -> embedded iOS Tailcat transport
  -> app-local loopback proxy
  -> existing Codex Relay API client
```

The Mac sidecar exposes only the configured Relay loopback port. The mobile native transport binds an ephemeral loopback port inside the App process; React Native continues using ordinary HTTP/SSE against that local endpoint. Route selection observes one logical Tailcat route while diagnostics may report its current path as `direct` or `derp`.

Tailcat bootstrap metadata is distributed through the existing authenticated pairing and connection-plan flow. A short token may reference a DERP region; a resolved self-contained token may embed DERP nodes to remove the initial map fetch. Persistent server keys provide a stable route across Relay restarts, while explicit rotation invalidates previously distributed tokens. Ephemeral keys are reserved for one-time diagnostics and pairing experiments.

Tailcat is not an authentication replacement. Possession of a persistent Tailcat token grants network reachability, but every Relay request still requires the existing paired session and encrypted payload contract. Tokens are treated as secrets, omitted from logs and diagnostics, and scoped to the Relay port. Production use requires an explicit decision between the rate-limited public DERP map and an operator-controlled DERP deployment.

The first implementation is an experiment behind `CODEX_RELAY_TAILCAT_TRANSPORT`. It is not advertised unless the sidecar is healthy and the mobile bundle declares Tailcat capability. Older mobile clients ignore the additive route. Failure immediately returns control to the ordinary connection-plan candidate budget; it never blocks LAN, Tailnet, or Cloudflare fallback.

## Durable Storage

Use the existing libSQL adapter and create a separate `relay-state.db`. Pairing credentials remain in `auth.db` so operational schema changes cannot block authentication recovery.

Initial tables:

```text
relay_meta
schema_migrations
workspaces
workspace_path_aliases
threads
thread_snapshots
thread_events
thread_inputs
thread_owners
turn_claims
runtime_snapshots
control_requests
```

Important constraints:

- `thread_events`: unique `(thread_id, sequence)` and unique `event_id`.
- `thread_inputs`: unique `(client_id, client_event_id)`.
- `turn_claims`: one active claim per thread.
- `thread_owners`: one current owner epoch per thread.
- State transitions and their corresponding events commit in one transaction.

Existing `server-state.json`, workspace paths, runtime preferences, and in-memory compatible state are imported through additive, idempotent migrations. Legacy files are retained for at least one release and are never deleted by migration.

## Canonical Thread Events

Every canonical thread event has durable ordering and ownership metadata:

```ts
type ThreadEvent = {
  eventId: string;
  threadId: string;
  workspaceId: string;
  sequence: number;
  ownerEpoch: number;
  turnId?: string;
  claimId?: string;
  type: string;
  payload: unknown;
  createdAt: string;
};
```

The event log contains canonical user messages, assistant deltas and completion, reasoning/tool activity, approvals, runtime changes, input delivery state, turn state, errors, and ownership changes. Ephemeral keep-alives and route probe diagnostics are not thread events.

The Relay periodically writes a thread snapshot at a known sequence. Retention may compact events older than a checkpoint. When a mobile cursor predates the retained range, the server returns `resetRequired` with the latest snapshot and its base sequence. This allows bounded storage without silently dropping history.

## Replay and Realtime Delivery

New observation endpoints:

```text
GET /v1/threads/:threadId/events?afterSequence=123&limit=500
GET /v1/threads/:threadId/events/stream
Last-Event-ID: 123
```

Mobile hydration order:

1. Render the local thread snapshot immediately.
2. Read its last applied sequence.
3. Fetch all missing durable events in bounded pages.
4. Apply events through one deterministic reducer and persist the new cursor.
5. Open realtime SSE from the final sequence.
6. If a sequence gap is detected, stop applying realtime events and replay the missing range.

History replay and realtime ingress pass through one ordering gate. Events are deduplicated by `eventId`, then ordered by `sequence`. Repeated or delayed SSE delivery is harmless.

The realtime connection does not own the Codex run. Cancelling or losing SSE removes only that subscriber. The Thread Coordinator continues persisting app-server events until the turn reaches a terminal state.

## Input Delivery

Command submission is separate from event observation:

```text
POST /v1/threads/:threadId/inputs
```

The mobile client creates a UUID `clientEventId` before its first attempt and reuses it for every network retry.

Input delivery uses two coordinated paths without creating two sources of truth:

- The durable path commits the input and its delivery state before the Relay acknowledges acceptance.
- When an app-server owner is already connected, a low-latency dispatch RPC may offer the complete input to that owner immediately.
- The RPC acknowledgement means only that the owner accepted responsibility for the input; it is not a turn-completion result.
- A lost RPC falls back to the durable coordinator. An RPC that wins the race is reconciled by `inputId`, `clientEventId`, and owner epoch so the durable path cannot dispatch it twice.
- Every accepted input enters the same per-thread serialized dispatch chain regardless of which path woke the coordinator. Interrupt and cancellation use a separate serialized control chain so they are not blocked behind a long-running turn.

```ts
type ThreadInput = {
  inputId: string;
  clientId: string;
  clientEventId: string;
  threadId: string;
  workspaceId: string;
  expectedOwnerEpoch?: number;
  prompt: string;
  state:
    | "created"
    | "persisted"
    | "dispatched"
    | "accepted"
    | "queued"
    | "steered"
    | "running"
    | "completed"
    | "failed"
    | "rejected"
    | "cancelled";
};
```

The server returns the existing result for a duplicate `clientEventId`. It must not start another turn or create another queue entry.

Delivery behavior:

| Runtime state                                          | Result                                                                        |
| ------------------------------------------------------ | ----------------------------------------------------------------------------- |
| Relay-managed app-server, thread idle                  | Start a turn and return `accepted`.                                           |
| Relay-managed active turn with steer capability        | Dispatch steering and return `steered` only after app-server acknowledgement. |
| Relay-managed active turn without steer, queue allowed | Persist FIFO entry and return `queued` with position.                         |
| Shared app-server with a controllable active turn      | Steer or queue according to negotiated capabilities.                          |
| Bridge-enabled desktop owner                           | Dispatch through the bridge and wait for app-server/CLI acceptance.           |
| Standalone external CLI writer                         | Return `thread_external_writer`; never show success.                          |
| Owner epoch changed                                    | Return `stale_owner_epoch` and require state refresh.                         |

`processed` is not acknowledged when a bridge merely receives a prompt. It is acknowledged only after the execution runtime accepts the input or durably queues it.

## Owner, Epoch, and Turn Claim

Ownership and execution identity are separate:

```ts
type ThreadOwner = {
  ownerId: string;
  ownerType: "relay_app_server" | "shared_app_server" | "desktop_bridge" | "external_cli";
  epoch: number;
  leaseExpiresAt?: string;
  capabilities: {
    view: boolean;
    send: boolean;
    steer: boolean;
    queue: boolean;
    interrupt: boolean;
    approve: boolean;
    configure: boolean;
  };
};

type TurnClaim = {
  claimId: string;
  threadId: string;
  inputId: string;
  ownerId: string;
  ownerEpoch: number;
  state: "active" | "completed" | "failed" | "cancelled";
  createdAt: string;
};
```

- `ownerEpoch` prevents an old app-server or bridge instance from writing after replacement.
- `claimId` prevents an old task in the same owner generation from finishing a newer turn.
- `clientEventId` prevents a mobile retry from creating duplicate input.

All terminal writes match the current owner epoch and active claim. Cancelling a claim creates a durable tombstone. A late completion for a cancelled or replaced claim is recorded as a diagnostic but cannot revive the turn or overwrite the user-visible state.

Relay-owned app-server processes use a process-lifetime epoch. Shared or bridge runtimes use heartbeat leases. A recommended initial heartbeat is five seconds with a fifteen-second expiry, but expiry values remain configurable and tested with fake clocks.

## Desktop Sharing Strategy

### Preferred: Shared Codex App-Server

The existing `--shared-app-server` path remains the primary solution. Relay and a terminal TUI connect to the same Codex app-server through the supported remote transport:

```text
codex-relay --shared-app-server
codex resume --remote unix://
```

The Thread Coordinator must treat the app-server as the execution authority even when the Relay did not start its process. Relay reconnects its own control socket without stopping an attached shared app-server.

Capabilities are discovered from the connected app-server version and observed thread state. Relay must not assume that a turn initiated by another remote client is steerable. When the app-server cannot confirm control, mobile submission returns an explicit external-writer result or remains in a Relay-owned queue according to product policy.

Relay starts the shared app-server as a detached process before attaching, so Relay restarts do not own or terminate the execution authority. A terminal TUI attaches through `codex resume --remote unix://`; after a terminal disconnect it resumes the same thread ID against the surviving daemon.

### Optional Codex Desktop Adapter

On macOS, compatible Codex Desktop builds may connect to the same daemon through an explicit Relay launcher. This is an optional adapter, not the primary workflow. The launcher verifies bundle support and the app-server handshake, refuses to reuse an already-running stdio App process, and waits for the new Desktop PID to connect to the expected Unix socket before reporting success.

### Compatibility: Desktop Bridge

A bridge remains optional for desktop runtimes that cannot expose their active session through the shared app-server transport. A bridge-enabled process registers itself, receives a lease, publishes events, and injects accepted input into its own command queue.

Bridge protocol:

```text
register -> lease granted
heartbeat
publish snapshot/events
dispatch input -> accepted/queued/steered/rejected
control request -> acknowledged/rejected
permission request/resolution
session closed
```

The bridge is loaded only by an explicit Relay launcher or integration. Relay never discovers and injects into arbitrary operating-system processes.

### Unsupported: Standalone External CLI

An already-running standalone TUI cannot be converted in place. The mobile client shows that the desktop session owns the thread and does not clear the composer or display a successful send.

## Runtime Configuration and Control

Runtime state is an observed, versioned snapshot rather than an optimistic mobile preference:

```ts
type RuntimeSnapshot = {
  threadId: string;
  ownerEpoch: number;
  revision: number;
  model: string;
  reasoningEffort?: string;
  serviceTier?: string;
  collaborationMode: string;
  approvalPolicy: string;
  sandboxMode: string;
  source: "app_server" | "desktop_bridge";
  updatedAt: string;
};
```

Mobile changes create a `ControlRequest` containing `requestId`, expected revision, expected owner epoch, and the desired patch. The UI shows a pending state until app-server or bridge acknowledgement. Rejection restores the observed value and reports a reason.

The same request/acknowledgement contract applies to:

- Model and service tier.
- Reasoning effort.
- Collaboration mode.
- Approval policy and sandbox mode.
- Interrupt.
- Approval and structured-input resolution.

Interrupt and approval operations are idempotent. A request from an old owner epoch or runtime revision cannot affect a replacement runtime.

Steer has one additional acknowledgement boundary: `accepted` means the active runtime received the request, while `applied` means Codex committed the instruction to the active turn. A steer that was never applied returns to ordinary queued dispatch without being shown as successful. A steer requesting model, reasoning, mode, or other configuration that differs from the active turn is rejected or explicitly converted into interrupt-and-send; it is never silently applied under different settings.

## Permission Protocol

Permission requests are durable action-required events with an opaque request identity, owner epoch, optional turn/claim identity, expiry, and supported responses. Resolution commits once and is then dispatched to the active runtime.

The Relay never silently upgrades sandbox or approval policy. A full-access change remains an explicit control request and produces an auditable event. Mobile retries return the prior resolution instead of resolving twice.

## Mobile State and User Experience

Mobile stores state by `relayId + workspaceId + threadId`:

```text
thread snapshot
last applied sequence
pending input identities and delivery states
runtime snapshot and revision
last successful route
```

The chat screen distinguishes these states:

- Connecting to Relay.
- Showing cached content while catching up.
- Replaying missing events.
- Live.
- Input persisted.
- Input queued with position.
- Input steered into the active turn.
- Desktop writer active.
- Route switched.
- Reconnect required.

The screen does not replace cached messages with a full-screen loading indicator during refresh. Pending prompt text is removed from the composer only after durable acceptance. Rejected external-writer input is restored to the composer.

Workspace switching cancels only the old view's requests. It does not clear another workspace's cache or global route state. Each thread reducer validates `workspaceId` and `threadId` before applying an event.

After workspace metadata is available, mobile performs bounded background catch-up for likely-to-open threads instead of waiting for navigation. Candidates are prioritized by visible, running, unread, pinned, and recent activity state. Each one-shot prefetch starts from the persisted event high-water mark, uses bounded concurrency and timeout budgets, and releases its live subscription after catch-up. Prefetch failures never replace cached conversation content with a blocking loading screen.

## Stream Assembly

App-server notification parsing uses a per-turn output ledger that tracks open message, reasoning, tool, command, file-change, and approval blocks. Terminalization closes every open block exactly once and emits one terminal turn event.

If an upstream stream ends without a terminal notification, the coordinator writes a classified terminal failure rather than leaving the thread permanently running. Stderr and debug payload retention are bounded, and logs contain identifiers and classifications rather than full prompt or file content.

## Lifecycle and Shutdown

Relay shutdown has three explicit phases:

1. **Quiesce:** stop accepting new inputs, controls, bridge registrations, and stream subscribers.
2. **Drain:** finish committed state transitions, persist pending app-server events, resolve or cancel owned claims, and checkpoint snapshots.
3. **Close:** release app-server/bridge transports, SSE subscribers, database clients, terminal sessions, and logging resources.

Once quiescing starts, new command endpoints return a retryable service-shutdown response. Cleanup is idempotent and awaited even if the initiating HTTP request is cancelled.

Shared app-server shutdown closes only Relay's connection unless Relay has explicit process ownership. It does not terminate an app-server owned by another client.

## Security Boundaries

- Pairing authentication and encrypted mobile payloads continue to protect remote APIs.
- `relay-state.db` contains operational metadata and conversation events and follows the existing local-state file permissions.
- A bridge listens only on a Unix socket or loopback address and requires a short-lived registration secret.
- Workspace file, terminal, Git, and turn requests resolve through the registered workspace allowlist.
- Capabilities are server-observed; client-declared capabilities are never trusted without runtime confirmation.
- Push notifications contain only opaque identifiers and generic action state.
- Logs redact tokens, prompt content, file content, authorization headers, and encrypted payloads.
- A public tunnel is used only when explicitly configured by the local operator.

## Observability and Operator Commands

Add correlated structured diagnostics using:

```text
relayId
serverEpoch
workspaceId
threadId
turnId
claimId
inputId
clientEventId
ownerId
ownerEpoch
eventSequence
routeId
requestId
```

Operator surfaces:

```text
codex-relay status
codex-relay doctor
codex-relay connections
codex-relay workspaces
codex-relay owners
codex-relay events <thread-id>
```

`doctor` checks database migrations, app-server reachability/version, shared socket ownership, workspace availability, route candidates, public URL health, and stale owner/claim records. Diagnostics remain local and content-safe.

## API Compatibility

The current `/v1/threads/:threadId/runs/stream` endpoint remains available during migration. Internally it delegates input submission to the coordinator and streams canonical events. New mobile versions use separate input and event endpoints.

Schema changes are additive:

- Existing `workspacePath` fields remain while `workspaceId` is introduced.
- Existing queue response fields remain while delivery identity and state are added.
- Existing stream event shapes remain readable through a compatibility adapter.
- Servers expose capabilities so older mobile clients can avoid unsupported routes.

Suggested feature flags:

```text
CODEX_RELAY_EVENT_LOG_V2
CODEX_RELAY_CONNECTION_PLAN_V2
CODEX_RELAY_WORKSPACE_REGISTRY_V2
CODEX_RELAY_OWNER_LEASES
CODEX_RELAY_DESKTOP_BRIDGE
CODEX_RELAY_TAILCAT_TRANSPORT
```

Flags select the internal implementation without changing persisted identifiers. Each phase has a tested rollback to the prior read path until the migration is declared stable.

## Module Boundaries

The current `packages/codex-relay/src/app.ts` is the HTTP composition surface. New behavior should move into focused modules:

```text
packages/codex-relay/src/storage/relay-state-database.ts
packages/codex-relay/src/storage/event-store.ts
packages/codex-relay/src/workspaces/workspace-registry.ts
packages/codex-relay/src/connections/connection-plan.ts
packages/codex-relay/src/threads/thread-coordinator.ts
packages/codex-relay/src/threads/thread-owner-store.ts
packages/codex-relay/src/threads/turn-claim-store.ts
packages/codex-relay/src/threads/input-delivery.ts
packages/codex-relay/src/controls/runtime-control.ts
packages/codex-relay/src/bridge/bridge-protocol.ts
packages/codex-relay/src/bridge/bridge-server.ts
```

Shared request and event contracts remain in `packages/codex-relay/src/api-schema.ts`. `app-server.ts` remains an adapter to Codex app-server and does not become the durable business-state owner.

Mobile additions:

```text
apps/mobile/src/lib/connection-plan.ts
apps/mobile/src/lib/thread-event-client.ts
apps/mobile/src/lib/thread-event-reducer.ts
apps/mobile/src/lib/input-delivery-state.ts
apps/mobile/src/lib/runtime-control-client.ts
```

Existing server state modules adopt these boundaries incrementally rather than being replaced in one large refactor.

## Delivery Phases

### Phase 0: Baseline and Compatibility Tests

- Lock current multi-workspace, queue, steer, writer-conflict, shared socket, SSE, and mobile cache behavior with regression tests.
- Add contract fixtures for old mobile/new server and new mobile/old server combinations.
- Document event and input state invariants before implementation.

**Rollback:** No runtime change.

### Phase 1: Durable Events and Replay

- Add `relay-state.db`, migrations, event store, snapshots, sequence allocation, replay API, and realtime event stream.
- Persist app-server events independently from SSE subscriber lifetime.
- Update mobile hydration to render cache, replay gaps, and then attach realtime.

**Primary result:** Fix missing final assistant messages and indefinite loading after reconnect.

**Rollback:** Keep writing the new event store while old clients read the legacy snapshot/SSE path.

### Phase 2: Connection Plan and Failover

- Add Relay identity, server epoch, health probe, connection-plan endpoint, route observations, and candidate refresh.
- Update mobile route selection and per-Relay storage.

**Primary result:** Recover automatically from stale LAN, Tailscale, link-local, or tunnel addresses.

**Rollback:** Fall back to the existing candidate list and stored URL.

### Phase 3: Workspace Registry

- Add stable workspace identities and path aliases.
- Import default paths and thread `cwd` values.
- Add `workspaceId` to APIs, caches, preferences, and thread records.

**Primary result:** Switching local projects no longer depends on matching path strings across caches and requests.

**Rollback:** Resolve `workspaceId` back to the compatibility `workspacePath` field.

### Phase 4: Durable Input, Owner Epoch, and Turn Claims

- Persist inputs and queues.
- Add `clientEventId`, delivery state, owner records, epochs, claims, and cancellation tombstones.
- Move start/queue/steer decisions into the Thread Coordinator.
- Restore queued work safely after restart without duplicating accepted turns.

**Primary result:** Mobile retries and Relay restarts cannot lose or duplicate accepted input.

**Rollback:** Disable owner leases and use current active writer checks while retaining input audit records.

### Phase 5: Shared App-Server Hardening

- Negotiate capabilities by app-server version.
- Reconstruct active turn state after Relay reconnect.
- Separate Relay connection ownership from app-server process ownership.
- Classify external remote-client turns without pretending they are Relay-controlled.

**Primary result:** Terminal and mobile can share supported sessions without corrupting active writer state.

**Rollback:** Return explicit writer conflicts and require a new mobile thread.

**Current delivery:** Relay supports terminal attachment through the shared remote transport, optional verified Codex Desktop launch on macOS, and keeps the shared app-server alive independently across Relay restarts. Existing standalone stdio turns retain explicit writer-conflict behavior until they finish and are reopened on the shared app-server.

### Phase 6: Runtime Controls and Permissions

- Add versioned runtime snapshots, control requests, acknowledgements, interrupt identity, and durable permission requests.
- Update mobile controls to display pending, accepted, and rejected states.

**Primary result:** Model, reasoning, collaboration, approval, sandbox, and interrupt state match the active runtime.

**Rollback:** Expose snapshots read-only and retain current preference behavior for new turns.

**Current delivery:** Workspace runtime preferences have pending/acknowledged/rejected UI behavior and durable permission requests are restored in shared mode. Full active-runtime reconfiguration remains capability-dependent and is applied at the next authoritative turn start when the app-server does not expose a live configure method.

### Phase 7: Optional Desktop Bridge

- Implement bridge registration, lease, heartbeat, event publication, input dispatch, and control acknowledgement.
- Provide an explicit Relay launcher or integration entrypoint.
- Keep external standalone CLI behavior unchanged.

**Primary result:** Share supported desktop runtimes that cannot use the official shared app-server transport.

**Rollback:** Disable bridge registration and continue with shared app-server or explicit writer rejection.

**Delivery decision:** Deferred until a concrete non-app-server desktop runtime adapter is in scope. The current repository has no desktop process that could consume bridge dispatches, so a Relay-only protocol would not satisfy the primary result.

### Phase 8: Operations, Compaction, and Legacy Retirement

- Add operator commands, retention checkpoints, stale ownership repair, and database backup/diagnostics.
- Remove legacy paths only after compatibility telemetry and release notes confirm migration.

**Rollback:** Retain the last compatibility reader for one additional release.

### Phase 9: Semantic Event Identity and Restoration Hardening

- Promote `clientEventId` into one end-to-end semantic event identity spanning optimistic mobile state, durable input, canonical app-server user items, SSE, message cursors, and push routing.
- Keep a bounded processed-event history in every consumer and use the same identity as the idempotency key; replacement metadata remains a compatibility bridge, not the primary dedupe mechanism.
- Add a restoration materialization gate: startup may replace persisted navigation or thread state only after a valid Relay, workspace, and thread snapshot has materialized. Transient empty startup state cannot erase a recoverable cache.
- Implement one recovery ladder: event cursor, message cursor, recent authoritative snapshot, then bounded older-history hydration. Cursor reset is explicit and never merges incompatible histories.
- Define one attention priority function for thread and turn rollups: blocked, failed, completed-unseen, paused, working, idle, unknown.
- Route push notifications with opaque `relayId`, `workspaceId`, `threadId`, `turnId`, and semantic event ID so activation opens the exact conversation without consulting stale navigation state.

**Primary result:** Remove the remaining duplicate bubble, missing optimistic message, stale restoration, and wrong-thread notification classes with one identity and recovery model.

**Rollback:** Continue accepting legacy message IDs and replacement metadata while disabling semantic-ID-only optimizations.

### Phase 10: Optional Tailcat Transport Experiment

- Build a Mac sidecar that exposes only Relay loopback TCP through a persistent Tailcat server key.
- Add an iOS native Tailcat transport with an App-local loopback proxy so the React Native API client remains unchanged.
- Extend pairing and Connection Plan with a capability-gated Tailcat route and content-safe direct-versus-DERP diagnostics.
- Benchmark LAN, direct Tailcat, public DERP, Tailnet, and Cloudflare for connect latency, sustained SSE delivery, reconnect time, battery use, and large-history transfer.
- Verify token rotation, sidecar restart, DERP-map cache fallback, public DERP rate limits, and optional self-hosted DERP operation.
- Complete App Store review analysis before shipping the embedded userspace WireGuard transport outside internal builds.

**Primary result:** Provide account-free encrypted reachability when LAN, Tailnet, or public HTTPS routes are unavailable, without changing Relay's message protocol.

**Rollback:** Disable the Tailcat capability and continue with existing HTTP candidates; no thread, cursor, pairing, or workspace migration is required.

## Verification Strategy

### Server Tests

- Event sequences remain monotonic under concurrent notification delivery.
- Replay returns every event after a cursor exactly once in canonical order.
- A snapshot reset is returned when a cursor predates retained history.
- Reusing `clientEventId` returns the original result and creates one turn.
- Stale owner epochs and stale claim completions cannot mutate current state.
- Cancellation tombstones prevent late completion from reviving a turn.
- Queued inputs remain FIFO and survive process restart.
- Shared app-server reconnect does not terminate an attached server.
- Quiesce rejects new work while drain commits already accepted state.
- Migrations are idempotent and preserve old local state.

### Mobile Tests

- Cached messages render before network hydration completes.
- Replay and realtime overlap does not duplicate messages.
- Sequence gaps trigger catch-up instead of silent application.
- Workspace caches remain isolated by Relay, workspace, and thread identity.
- Route switching preserves pairing and pending inputs.
- Writer rejection restores composer content.
- Delivery state progresses through persisted, queued/steered, running, and terminal states.
- Runtime controls remain pending until acknowledgement and revert on rejection. Covered by the workspace revision coordinator and disabled control state.

### Integration and Device Tests

- Disconnect the phone for five minutes during a turn, reconnect, and verify no missing or duplicate content.
- Kill and reopen the mobile app during streaming and verify sequence recovery.
- Restart Relay after accepting a queued input and verify one resulting turn.
- Switch among at least three workspaces with active and completed threads.
- Disable the active Tailscale/LAN route and verify bounded failover to another candidate.
- Exercise Tailcat through both a direct UDP path and DERP fallback, then terminate the sidecar and verify bounded failover to HTTP routes.
- Rotate the Tailcat server key and confirm old tokens lose reachability while Relay pairing credentials remain otherwise valid.
- Exercise `169.254.*` as a retained but low-priority candidate.
- Share a thread through `--shared-app-server`, run from terminal and mobile, and verify writer classification.
- Reset the Relay socket while the shared app-server remains alive and verify recovery.
- Cancel a turn immediately before a late completion event and verify it remains cancelled.
- Change each runtime control from mobile and verify the app-server-observed value.

## Acceptance Criteria

- A network or app restart after server acknowledgement does not lose an input or canonical message.
- Reconnection never requires an empty full-screen loading state when cached data exists.
- A mobile cursor produces a gap-free, duplicate-free timeline after replay.
- Ten retries with one `clientEventId` produce one accepted input and at most one turn.
- Three workspaces can be switched repeatedly without thread, event, or runtime-state leakage.
- Route failure triggers bounded candidate failover and plan refresh.
- Optional Tailcat failure cannot block or invalidate LAN, Tailnet, or Cloudflare candidates.
- External standalone CLI occupation produces a visible rejection, not apparent success.
- Shared app-server sessions recover Relay connectivity without stopping the shared runtime.
- Stale owners, claims, approvals, interrupts, and control requests cannot affect a replacement runtime.
- `pnpm test`, `pnpm typecheck`, and `pnpm lint` pass, with device validation recorded for connection and lifecycle scenarios.

## Reference Implementations

The design combines patterns from these references without treating any one implementation as directly portable:

- **RemoteForge:** server-issued connection plans, candidate refresh, workspace registry, credential recovery, and replay/resume concepts.
- **Claude Code package extraction:** durable history plus realtime delivery, cursor pagination, client-generated UUID idempotency, and explicit permission protocols.
- **Local `claude-code` reconstruction:** desktop worker registration, lease/heartbeat/epoch, event delivery acknowledgement, runtime controls, bridge pointer recovery, and ordered initial-history flushing. This is a reconstructed/custom repository with sparse bridge tests and no configured Git remote, so it is an architectural reference only.
- **free-claude-code at `821941785496d2f9ccdaf47494c09a2c79d188dd`:** managed CLI lifecycle, temporary-to-real session registration, FIFO claim ownership, cancellation tombstones, outbound deduplication, atomic generation-based persistence, stream cleanup, and two-phase runtime shutdown.
- **Lody at `d5639f2515c9a1f983f05385356f5304735697e3`:** ACP-owned machine sessions, local-first workspace replicas, workspace-scoped stream and cursor identities, durable CRDT input plus Machine RPC fast-path acknowledgement, idempotent turn reconciliation, acknowledged active-turn steering, bounded room recovery, and activity-driven background session catch-up.
- **rootshell:** stable semantic attention-event IDs with bounded dedupe history, one shared attention-priority ladder, restoration guarded against transient empty startup state, credential-first session resume with explicit fallback, and end-to-end encrypted push routing keyed by one event ID. Its terminal screen classification, Metal renderer, and mosh/tssh transport are out of scope for Relay.
- **Tailcat:** control-plane-free Tailscale data-plane transport using compact out-of-band connection tokens, WireGuard encryption, DERP bootstrap/fallback, magicsock direct-path upgrade, optional persistent server keys, DERP-map caching, and userspace TCP forwarding. Its unstable wire/API contract and public DERP limits require capability gating and an experimental rollout.

Important adaptations:

- Do not copy free-claude-code's client-disconnect cancellation behavior. Relay turns outlive mobile observers.
- Do not copy its JSON snapshot store as the event system. Relay uses durable SQLite events and cursors.
- Do not model Codex threads as Telegram/Discord reply trees. Use a linear per-thread queue and claims.
- Do not acknowledge bridge input as processed until the execution runtime accepts or queues it.
- Do not attempt to bypass active writer protection through replay or optimistic conflict recovery.
- Do not replace Relay's ordered SQLite event log with Lody's CRDT document model. Codex threads are linear, owner-coordinated event streams and do not need general multi-writer document merging.
- Do not copy Lody's hosted Loro Streams dependency into the direct local Relay architecture. Cross-device Lody collaboration still depends on its hosted sync plane and does not provide a self-contained mobile transport implementation in the open-source repository.
- Adopt Lody's two-path delivery semantics, not two independent dispatchers: durable input remains canonical, the app-server RPC is an acknowledgement fast path, and both converge through one idempotent coordinator.
- Adopt its `accepted` versus `applied` steer distinction and high-water background catch-up as protocol and scheduling patterns over the existing Relay event APIs.
- Adopt rootshell's identity and restoration invariants, not its screen-scraping detector: Relay has structured app-server events and must not infer canonical Codex state from rendered terminal text.
- Bind push dedupe, durable event dedupe, optimistic replacement, and activation routing to one semantic event ID. Do not run independent app and notification-extension consumers against the same event without an atomic dedupe claim.
- Adopt Tailcat only as a transport adapter beneath Relay HTTP/SSE. Do not let connection tokens replace pairing authentication, expose arbitrary host ports, or make Tailcat availability a prerequisite for startup.

## Final Decision

Implementation proceeds in this order:

```text
durable events/replay
  -> route failover
  -> stable workspace identity
  -> durable inputs + owner/claim safety
  -> shared app-server hardening
  -> runtime and permission controls
  -> optional desktop bridge
  -> semantic identity/restoration hardening
  -> optional Tailcat transport experiment
```

This order addresses the current missing-message and loading failures first, preserves the existing shared app-server investment, and postpones the highest-complexity desktop bridge until the official app-server path and durable coordination model are proven.
