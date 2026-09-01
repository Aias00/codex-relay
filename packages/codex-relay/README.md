# Codex Relay CLI

Codex Relay runs a local bridge server for the Codex Relay mobile app. Keep Codex on your computer, then use your phone to pair with that local session, send prompts, watch streamed output, and respond to approval requests.

Codex Relay is an independent project. It is not affiliated with, endorsed by, or sponsored by OpenAI or the OpenAI Codex team.

## Requirements

- Node.js 22.14 or newer
- Codex CLI installed and signed in on the computer running the relay
- The Codex Relay mobile app on the same network, Tailscale network, or another route that can reach your computer

## Start the Relay

Run the server from the workspace you want Codex to use:

```sh
npx @aias00/codex-relay@latest
```

The CLI prints a QR code, a mobile URL, and a `codex-relay://pair...` pairing payload. Scan the QR code from the mobile app. If the relay detects multiple possible network addresses, the QR includes them and the app automatically uses the first address it can reach. If scanning is not available, paste the full pairing payload into the app.

When the app shows an approval code, approve it on the computer:

```sh
npx @aias00/codex-relay@latest approve XXXX-XXXX
```

After approval, the phone can list Codex threads, start new work, stream messages, and handle approval prompts from the local Codex runtime.

## Shared Terminal and Mobile Sessions

On macOS, Codex Relay prefers Codex's shared Unix socket so terminal and mobile clients can follow the same live sessions. If the shared app-server cannot start or initialize, the relay prints a warning and continues with a private app-server.

Linux, WSL, and native Windows keep using a private app-server by default. A terminal TUI that was started separately can resume the same saved thread, but it does not receive the relay process's live events.

Require the shared app-server on any platform:

```sh
npx @aias00/codex-relay@latest --shared-app-server
```

This explicit mode does not fall back to a private app-server when shared startup fails.

When a shared app-server is already running, the relay attaches to it instead of starting another one. If the relay's own socket connection resets, it reconnects without deliberately stopping the shared app-server.

Then connect a new terminal TUI to the shared app-server. On macOS, Linux, or WSL:

```sh
codex resume --remote unix://
```

On native Windows, use the loopback WebSocket endpoint:

```powershell
codex resume --remote ws://127.0.0.1:8788
```

Pass a thread ID after the remote endpoint to open a specific thread. The relay prints the attach command at startup. Mobile and the connected terminal can then observe the same live sessions through one socket-backed app-server. An already-running standalone TUI cannot be converted in place; exit it and reconnect with `--remote`.

Shared mode uses Codex's experimental app-server transport. A directly connected terminal TUI has its own WebSocket connection, which the relay cannot observe or reconnect. If that terminal reports a socket reset while the thread continues on mobile, reconnect it with the matching remote endpoint above and append the thread ID if needed.

Shared mode requires a recent Codex CLI with app-server and `resume --remote` support. It uses a Unix socket on macOS, Linux, and WSL, or a loopback-only WebSocket on Windows. If explicit shared mode is unavailable, update Codex or omit `--shared-app-server`. On macOS, set `CODEX_RELAY_APP_SERVER_MODE=stdio` to force private mode instead of using the shared-first default.

On macOS, Linux, and WSL, Relay starts the shared app-server as a detached local daemon before attaching. Restarting or stopping Relay does not terminate that daemon or an active terminal turn. Reconnect a disconnected TUI with `codex resume --remote unix:// THREAD_ID`.

## Optional Codex Desktop Sharing

TUI users do not need this step. On macOS, compatible Codex Desktop builds can connect to the same detached daemon:

```sh
npx @aias00/codex-relay@latest desktop
npx @aias00/codex-relay@latest desktop --launch
```

Fully quit an already-running Desktop app before `--launch`. The launcher verifies app support and the app-server handshake, then waits for an observable connection to the expected Unix socket before reporting success.

## Background Mode

To keep the relay running after the command returns:

```sh
npx @aias00/codex-relay@latest --bg
```

Background mode writes runtime files under `.codex-relay/` in the current directory:

- `.codex-relay/server.log`
- `.codex-relay/server.pid`
- `.codex-relay/server-state.json`
- `.codex-relay/auth.db`

Print the current pairing QR again:

```sh
npx @aias00/codex-relay@latest qr
```

Stop a background server:

```sh
npx @aias00/codex-relay@latest stop
```

## Commands

```sh
npx @aias00/codex-relay@latest
```

Start the relay in the foreground.

```sh
npx @aias00/codex-relay@latest --bg
```

Start the relay in the background.

```sh
npx @aias00/codex-relay@latest stop
```

Stop the background relay. Repeating this command is safe when no background server is running.

```sh
npx @aias00/codex-relay@latest --shared-app-server
```

Require the relay to start through Codex's shared app-server socket.

```sh
npx @aias00/codex-relay@latest qr
```

Print the latest pairing QR for an already running relay.

```sh
npx @aias00/codex-relay@latest approve XXXX-XXXX
```

Approve a pending mobile pairing request.

```sh
npx @aias00/codex-relay@latest --dangerously-auto-approve
```

Start the relay and automatically approve mobile pairing requests. Use this only for controlled review or demo environments.

```sh
npx @aias00/codex-relay@latest diagnostics
npx @aias00/codex-relay@latest compatibility
npx @aias00/codex-relay@latest backup
npx @aias00/codex-relay@latest compact THREAD_ID --through 2000
npx @aias00/codex-relay@latest repair-owner THREAD_ID
npx @aias00/codex-relay@latest tailcat-key rotate --region derp.example.com
npx @aias00/codex-relay@latest transport-benchmark transport-samples.jsonl
```

Inspect content-safe state and compatibility counts, create online-consistent database backups, compact one thread at an explicit durable sequence, repair an expired owner lease, rotate the optional Tailcat server key, or summarize strict content-safe transport benchmark JSONL. `repair-owner` refuses active and non-expiring owners. Tailcat key rotation discards connection-token output, validates the generated key, atomically replaces it, preserves one mode-0600 `.previous` rollback copy, and requires a Relay restart before old tokens become invalid; pairing sessions and durable state are unchanged. Transport benchmark input rejects URLs, credentials, Relay/thread/workspace identity, conversation content, and free-form notes; output contains grouped success rates and P50/P95 metrics only.

## Configuration

The relay listens on `0.0.0.0:8787` by default. Configure it with environment variables:

| Variable                               | Purpose                                                                                                                                                         |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                                 | Server port. Defaults to `8787`.                                                                                                                                |
| `HOST`                                 | Listen host. Defaults to `0.0.0.0`.                                                                                                                             |
| `CODEX_RELAY_WORKSPACE_PATH`           | Workspace path Codex should use. Defaults to the directory where you run `npx @aias00/codex-relay@latest`.                                                      |
| `CODEX_RELAY_AUTH_DB_PATH`             | Pairing and session database path. Defaults to `.codex-relay/auth.db`.                                                                                          |
| `CODEX_RELAY_MAX_THREAD_EVENTS`        | Optional per-thread durable event retention limit. Unset keeps all events; clients with compacted cursors reset from the authoritative thread detail.           |
| `CODEX_RELAY_OWNER_LEASE_MS`           | Optional cross-process owner lease duration in milliseconds. Unset disables lease enforcement; an active lease prevents another Relay from starting a turn.     |
| `CODEX_RELAY_APPROVAL_SECRET`          | Secret used by the local approve command. Usually generated automatically.                                                                                      |
| `CODEX_RELAY_PUBLIC_URL`               | Public URL printed first and embedded first in the pairing QR, for example a Cloudflare Tunnel URL proxying the relay port.                                     |
| `CODEX_RELAY_THREAD_LIST_CACHE_TTL_MS` | Short server-side cache for app-server thread list reads. Defaults to `3000`; set to `0` to disable.                                                            |
| `CODEX_RELAY_DANGEROUSLY_AUTO_APPROVE` | Set to `1` to auto-approve mobile pairing requests. Prefer the CLI flag for local use.                                                                          |
| `CODEX_RELAY_APP_SERVER_MODE`          | Set to `socket` to require shared mode or `stdio` to require private mode. Unset prefers shared mode with startup fallback on macOS and private mode elsewhere. |
| `CODEX_RELAY_DESKTOP_APP_PATH`         | Optional macOS Codex Desktop or ChatGPT application bundle path.                                                                                                |
| `CODEX_RELAY_TAILCAT_TRANSPORT`        | Experimental. Set to `1` to start an owned Tailcat sidecar; disabled by default.                                                                                |
| `CODEX_RELAY_TAILCAT_BINARY`           | Optional Tailcat executable path. Defaults to `tailcat` on `PATH`.                                                                                              |
| `CODEX_RELAY_TAILCAT_KEY_PATH`         | Persistent Tailcat server key path. Defaults under the Relay data directory and must already exist.                                                             |
| `CODEX_RELAY_TAILCAT_ADDRESS_PATH`     | Private address-token output path. Defaults under the Relay data directory.                                                                                     |
| `CODEX_RELAY_TAILCAT_PID_PATH`         | Mode-0600 sidecar PID file used to validate and clean stale Relay-owned processes. Defaults beside the address file.                                            |
| `CODEX_RELAY_TAILCAT_START_TIMEOUT_MS` | Optional positive sidecar startup timeout in milliseconds. Defaults to `10000`.                                                                                 |
| `CODEX_HOME`                           | Codex home directory, used when reading Codex session metadata.                                                                                                 |
| `CODEX_BIN`                            | Codex CLI executable path.                                                                                                                                      |

Tailcat remains capability-gated. The server returns its token only from the authenticated Connection Plan endpoint when the client declares `tailcat` support and the owned sidecar is healthy. Expo Go and older installed builds do not declare this capability and continue using ordinary HTTP candidates. A new native iOS build is required; OTA updates cannot add the embedded framework. Do not run a separate `tailcat --serve` LaunchAgent for the same port while `CODEX_RELAY_TAILCAT_TRANSPORT=1`; Relay owns, records, and cleans that process itself.

Examples:

```sh
PORT=8788 npx @aias00/codex-relay@latest
```

```sh
PORT=8788 CODEX_RELAY_PUBLIC_URL=https://codex-relay.example.com npx @aias00/codex-relay@latest
```

```sh
CODEX_RELAY_WORKSPACE_PATH=/path/to/project npx @aias00/codex-relay@latest
```

## Network Notes

The phone must be able to reach one of the URLs printed by the relay.

- On the same Wi-Fi network, the relay usually prints a local network address.
- On Tailscale, the relay prefers your Tailscale address when it can detect one.
- If several Wi-Fi, VPN, or virtual network addresses are available, the QR includes all detected candidates and the app tries them automatically.

## Troubleshooting

If `npx @aias00/codex-relay@latest qr` cannot find a server, start one first:

```sh
npx @aias00/codex-relay@latest
```

If the relay says another process is using the local pairing database, use the existing server:

```sh
npx @aias00/codex-relay@latest qr
```

Or stop the background process shown by the CLI:

```sh
npx @aias00/codex-relay@latest stop
```

If the mobile app cannot connect, confirm that the phone can reach the printed `Mobile:` URL and that the chosen port is not blocked by a firewall.

Connection checklist:

- Are the phone and computer on the same Wi-Fi or LAN?
- If keeping the same network is difficult, are both devices connected through Tailscale or another reachable private network?
- Can the phone open the exact `Mobile:` URL printed by the relay?
- Does the computer firewall allow inbound traffic on the relay port, usually `8787`?
