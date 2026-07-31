# Configuration

The daemon reads settings from layered JSON files and exposes them through one command:

```sh
goodvibes-daemon config list [--json]
goodvibes-daemon config get <key> [--json]
goodvibes-daemon config set <key> <value>
goodvibes-daemon config unset <key>
```

This is the way in for every key below — there is no separate settings UI shipped with
the daemon itself (the terminal app's `/config` workspace and the web UI edit the same
files). `config set`/`unset` write to disk immediately and work whether or not a daemon
is running; a running daemon picks up most changes live, and any that only take effect
at bind time say so in the command's own receipt.

**Reads are redacted.** Every value `config list`/`config get` prints goes through a
redaction pass first: a key whose name ends in `token`, `secret`, `password`,
`apiKey`, `botToken`, `signingSecret`, `webhookSecret`, `verifyToken`,
`verificationToken`, or `keyFile` (plus a short list of named exceptions such as
`surfaces.email.imapPassword` and `cluster.secret`) prints as `<redacted>` whatever it
actually holds. `config set` still writes the real value — only the *output* is
cleaned, so a settings dump pasted into a bug report carries no credential. A
`goodvibes://secrets/...` reference is left visible on purpose: it is a pointer, not a
secret.

## Where a value lands

Two files matter for an operator:

- `<GOODVIBES_HOME>/.goodvibes/tui/settings.json` — the shared settings file. Most
  keys live here.
- `<daemon home>/settings.json` (default `<GOODVIBES_HOME>/.goodvibes/daemon/settings.json`,
  relocatable with `GOODVIBES_DAEMON_HOME`/`--daemon-home`) — the **daemon tier**.
  Daemon-owned keys — `controlPlane.*`, `hostedSessions.*`, `update.*`, `daemon.*`, and
  more — are written here instead, and overlay the shared file last, so a stale value
  left behind in the shared file can never win. `config set`/`config list` name which
  file a key actually came from; you never have to guess.

## Channels (`surfaces.*`)

Each channel surface has its own `surfaces.<id>.enabled` key plus the connection keys
it needs. `goodvibes-daemon send --list` shows which are actually usable right now; a
channel whose keys are unset is refused rather than accepted and dropped.

| Channel | Required keys |
| --- | --- |
| `slack` | `surfaces.slack.signingSecret`, `surfaces.slack.botToken` |
| `discord` | `surfaces.discord.publicKey`, `surfaces.discord.botToken`, `surfaces.discord.applicationId` |
| `telegram` | `surfaces.telegram.botToken` |
| `webhook` | `surfaces.webhook.secret` |
| `ntfy` | `surfaces.ntfy.baseUrl` |
| `googleChat` | `surfaces.googleChat.webhookUrl` |
| `signal` | `surfaces.signal.bridgeUrl`, `surfaces.signal.account` |
| `whatsapp` | `surfaces.whatsapp.accessToken`, `surfaces.whatsapp.phoneNumberId` |
| `imessage` | `surfaces.imessage.bridgeUrl`, `surfaces.imessage.account` |
| `msteams` | `surfaces.msteams.appId`, `surfaces.msteams.appPassword` |
| `bluebubbles` | `surfaces.bluebubbles.serverUrl`, `surfaces.bluebubbles.password` |
| `mattermost` | `surfaces.mattermost.baseUrl`, `surfaces.mattermost.botToken` |
| `matrix` | `surfaces.matrix.homeserverUrl`, `surfaces.matrix.accessToken`, `surfaces.matrix.userId` |

Example — configure Telegram and confirm it is usable:

```sh
goodvibes-daemon config set surfaces.telegram.botToken 123456:AA...
goodvibes-daemon config set surfaces.telegram.enabled true
goodvibes-daemon send --list
```

Every channel key that looks like a credential (`botToken`, `signingSecret`,
`accessToken`, `password`, and so on) is redacted on read, same as any other setting.

## The browser operator surface (`controlPlane.webui.*`, `web.*`)

The web UI is served **by the control-plane listener**, same origin as the API — not
on the port named by `web.port`. Prefer `goodvibes-daemon webui enable|disable|status`
over editing these directly (see [commands-reference.md](commands-reference.md)); the
keys themselves are:

| Key | Default | Meaning |
| --- | --- | --- |
| `controlPlane.webui.serve` | `false` | Serve a built web UI bundle same-origin from the daemon |
| `controlPlane.webui.bundleDir` | `""` | Directory holding the built bundle (`index.html` + assets). Takes precedence over `web.staticAssetsDir` |
| `web.enabled` | `true` | Enable the browser-based operator surface at all |
| `web.hostMode` | `local` | `local` \| `network` \| `custom` — widening this is what actually exposes the webui to your LAN |
| `web.host` | `127.0.0.1` | Bind host when `web.hostMode` is `custom` |
| `web.port` | `3423` | The surface's *declared* endpoint (used for links); nothing binds it directly — the control-plane port is what actually answers |
| `web.publicBaseUrl` | `http://127.0.0.1:3423` | Public base URL for web links and notification deep links |
| `web.staticAssetsDir` | `dist/web` | Fallback bundle directory when `controlPlane.webui.bundleDir` is empty |

## The control-plane endpoint (`controlPlane.*`)

| Key | Default | Meaning |
| --- | --- | --- |
| `controlPlane.enabled` | `false` | Enable the standalone control-plane HTTP server |
| `controlPlane.gateway` | `true` | The shared gateway host serving state snapshots, live streams (SSE/WS), and authenticated control APIs |
| `controlPlane.hostMode` | `local` | `local` (127.0.0.1, default port) \| `network` (0.0.0.0, default port) \| `custom` (editable host and port) |
| `controlPlane.host` | `127.0.0.1` | Bind host when `hostMode` is `custom` |
| `controlPlane.port` | `3421` | Bind port for the control-plane HTTP server |
| `controlPlane.publicBaseUrl` | `""` | Override for a genuinely external address (tunnel or reverse proxy); leave empty otherwise — it is derived |
| `controlPlane.streamMode` | `sse` | `sse` \| `websocket` \| `both` |
| `controlPlane.allowRemote` | `false` | Allow remote clients to connect to the control plane |
| `controlPlane.trustProxy` | `false` | Trust `x-forwarded-for`/`CF-Connecting-IP`-style forwarding headers |
| `controlPlane.tls.mode` | `off` | `off` \| `proxy` \| `direct` |
| `controlPlane.tls.certFile` / `controlPlane.tls.keyFile` | `""` | PEM paths for `direct` TLS (empty = `~/.goodvibes/certs/fullchain.pem` / `privkey.pem`) |

`--host`/`--port` on `serve` are runtime-only overrides for one launch; `install-service`
and `migrate-service` refuse those same flags because the installed unit re-resolves
these keys from disk at every boot — set the persistent binding with `config set`
instead.

## Daemon-hosted sessions (`hostedSessions.*`)

See [hosted-sessions.md](hosted-sessions.md) for what a hosted session is. The
settings:

| Key | Default | Meaning |
| --- | --- | --- |
| `hostedSessions.detachPolicy` | `kill` | What happens when a hosted session's last client detaches. `kill` ends the session (what closing a client has always done); `survive` leaves it idle and reattachable. A single session can override this at creation |
| `hostedSessions.maxSessions` | `8` | How many hosted sessions may be live at once. Creating one past this is refused with the count and this setting named. Terminated sessions do not count |
| `hostedSessions.maxMessagesPerSession` | `500` | How many of a session's most recent messages are written to disk — bounds what a restart can restore, not the in-memory transcript |
| `hostedSessions.terminatedRetentionMs` | `86400000` (24h) | How long a terminated session's record is kept, listable with its termination reason, before it is retired |
| `hostedSessions.promoteInboundConversations` | `false` | Off: an inbound channel message (Telegram, Slack, email, ...) is answered by the process that received it. On: the first message of a conversation creates a hosted session and every later message steers into it, so the conversation keeps running while no surface is open |

## Self-update (`update.*`)

See [updates-and-rollback.md](updates-and-rollback.md) for the mechanics. The
settings:

| Key | Default | Meaning |
| --- | --- | --- |
| `update.auto` | `true` | Check for a new release hourly, download and checksum-verify it, swap at a no-active-work moment, and restart |
| `update.intervalMinutes` | `60` | Minutes between update checks (5–1440) |
| `update.firstCheckSeconds` | `30` | Seconds after start before the first check, so a daemon that was down while releases shipped does not stay stale for a whole interval |
| `update.releasesUrl` | `https://github.com/mgd34msu/goodvibes-daemon/releases/latest` | Where the daemon resolves its own update tags and assets from. A value written to settings overrides this and is never re-derived |
| `update.rollbackAfterFailedStarts` | `3` | Consecutive rapid boots that fail to reach a fully-started daemon before the previous binary is automatically restored (`0` leaves a bad update in place for a hand-run rollback) |
| `update.alertAfterFailedChecks` | `3` | Consecutive failed checks before the daemon tells you over a channel that still works that it can no longer update itself |

## Service and daemon process (`service.*`, `daemon.*`, `danger.*`)

| Key | Default | Meaning |
| --- | --- | --- |
| `service.enabled` | `true` | Enable service-install and daemon-management verbs, including boot-time self-promotion to a supervised service |
| `service.autostart` | `false` | Start GoodVibes automatically at host boot/login |
| `service.restartOnFailure` | `true` | Restart the service automatically after failure |
| `service.platform` | `auto` | `auto` \| `systemd` \| `launchd` \| `windows` \| `manual` |
| `service.serviceName` | `goodvibes` | Service name used for host integration and install scripts |
| `service.logPath` | `""` | File path for daemon/service logs (empty = platform default) |
| `daemon.enabled` | `true` | Run the local session daemon at all |
| `danger.httpListener` | `false` | Enable the separate HTTP webhook listener (port `httpListener.port`, default `3422`) |

## Everything else

`config list` enumerates every settings key with its current value and source — run it
after any change you are not sure landed where you expected. `config list --json`
returns the same data as a structured document, including which keys were redacted.
