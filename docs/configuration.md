# Configuration

The daemon reads settings from layered JSON files and exposes them through one command:

```sh
goodvibes-daemon config list [--json]
goodvibes-daemon config get <key> [--json]
goodvibes-daemon config set <key> <value>
goodvibes-daemon config unset <key>
```

This is the way in for every key below. There is no separate settings UI shipped with
the daemon itself (the terminal app's `/config` workspace and the web UI edit the same
files). `config set`/`unset` write to disk immediately and work whether or not a daemon
is running; a running daemon picks up most changes live, and any that only take effect
at bind time say so in the command's own receipt.

**Reads are redacted.** Every value `config list`/`config get` prints goes through a
redaction pass first. A key whose last segment is exactly `token`, `secret`,
`password`, `apiKey`, `accessToken`, `botToken`, `appToken`, `signingSecret`,
`webhookSecret`, `verifyToken`, `verificationToken`, or `keyFile` prints as
`<redacted>` whatever it actually holds. A declared list of keys the suffix rule
misses is redacted by name on top of that, covering the mailbox and CalDAV passwords
(`surfaces.email.imapPassword` and its relatives), `surfaces.telephony.authToken`,
`surfaces.msteams.appPassword`, `cluster.secret`, the `cloudflare.*Ref` token
references, and the flat `payments.card*` fields.

`config set` still writes the real value; only the *output* is cleaned, so a settings
dump pasted into a bug report carries no credential. A `goodvibes://secrets/...`
reference is left visible on purpose, since it is a pointer rather than a secret.

## Where a value lands

Two files matter for an operator:

- `<GOODVIBES_HOME>/.goodvibes/tui/settings.json`. The shared settings file. Most
  keys live here.
- `<daemon home>/settings.json` (default `<GOODVIBES_HOME>/.goodvibes/daemon/settings.json`,
  relocatable with `GOODVIBES_DAEMON_HOME`/`--daemon-home`). This is the **daemon tier**.
  Daemon-owned keys are written here instead, and overlay the shared file last, so a
  stale value left behind in the shared file can never win. `config set`/`config list`
  name which file a key actually came from; you never have to guess.

A key is daemon-owned when the daemon is the process that executes it unattended,
with every client closed. The owned domains:

| Daemon-tier domain | What it configures |
| --- | --- |
| `surfaces.*` | the channel connections and their credentials |
| `controlPlane.*`, `httpListener.*`, `web.*`, `relay.*` | the endpoint bindings, the browser surface, and the relay rendezvous |
| `watchers.*`, `automation.*`, `checkin.*`, `occasions.*` | scheduled and triggered background work: watcher polling, automation runs, check-in cadence, the occasions sweep |
| `device.*` | paired-device capabilities and grants |
| `integrations.*` | channel delivery tracking and route binding |
| `atRest.*` | at-rest redaction and retention |
| `payments.*` | every payment setting, since the daemon is the process that holds the card and rolls the budget over |
| `voice.local.*` | local voice model provisioning |
| `conversationGate.*` | whether an inbound channel message becomes a conversation |
| `hostedSessions.*` | the hosted-session policies the daemon enforces |
| `cluster.*` | the shared-inbox group and its leader election |
| `profile.*` | the owner profile and its write policy |
| `email.*`, `calendar.*`, `google.*` | the mail and calendar connector |
| `danger.httpListener`, `daemon.timezone` | two individual keys owned without their whole prefix |

`update.*`, `service.*`, and the rest of `daemon.*` are deliberately **not**
daemon-owned. "Does this installation run a daemon at all" is a property of each
installation, not of the daemon, so those keys land in the shared file; the daemon
still reads them through the same layered resolution.

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

Example: configure Telegram and confirm it is usable.

```sh
goodvibes-daemon config set surfaces.telegram.botToken 123456:AA...
goodvibes-daemon config set surfaces.telegram.enabled true
goodvibes-daemon send --list
```

Every channel key that looks like a credential (`botToken`, `signingSecret`,
`accessToken`, `password`, and so on) is redacted on read, same as any other setting.

## The browser operator surface (`controlPlane.webui.*`, `web.*`)

The web UI is served **by the control-plane listener**, same origin as the API, not
on the port named by `web.port`. Prefer `goodvibes-daemon webui enable|disable|status`
over editing these directly (see [commands-reference.md](commands-reference.md)); the
keys themselves are:

| Key | Default | Meaning |
| --- | --- | --- |
| `controlPlane.webui.serve` | `false` | Serve a built web UI bundle same-origin from the daemon |
| `controlPlane.webui.bundleDir` | `""` | Directory holding the built bundle (`index.html` + assets). Takes precedence over `web.staticAssetsDir` |
| `web.enabled` | `true` | Enable the browser-based operator surface at all |
| `web.hostMode` | `local` | `local` \| `network` \| `custom`. Widening this is what actually exposes the webui to your LAN |
| `web.host` | `127.0.0.1` | Bind host when `web.hostMode` is `custom` |
| `web.port` | `3423` | The surface's *declared* endpoint (used for links); nothing binds it directly, the control-plane port is what actually answers |
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
| `controlPlane.publicBaseUrl` | `""` | Override for a genuinely external address (tunnel or reverse proxy); leave empty otherwise, since it is derived |
| `controlPlane.streamMode` | `sse` | `sse` \| `websocket` \| `both` |
| `controlPlane.allowRemote` | `false` | Allow remote clients to connect to the control plane |
| `controlPlane.trustProxy` | `false` | Trust `x-forwarded-for`/`CF-Connecting-IP`-style forwarding headers |
| `controlPlane.tls.mode` | `off` | `off` \| `proxy` \| `direct` |
| `controlPlane.tls.certFile` / `controlPlane.tls.keyFile` | `""` | PEM paths for `direct` TLS (empty = `~/.goodvibes/certs/fullchain.pem` / `privkey.pem`) |

`--host`/`--port` on `serve` are runtime-only overrides for one launch; `install-service`
and `migrate-service` refuse those same flags because the installed unit re-resolves
these keys from disk at every boot. Set the persistent binding with `config set`
instead.

## Daemon-hosted sessions (`hostedSessions.*`)

See [hosted-sessions.md](hosted-sessions.md) for what a hosted session is. The
settings:

| Key | Default | Meaning |
| --- | --- | --- |
| `hostedSessions.detachPolicy` | `kill` | What happens when a hosted session's last client detaches. `kill` ends the session (what closing a client has always done); `survive` leaves it idle and reattachable. A single session can override this at creation |
| `hostedSessions.maxSessions` | `8` | How many hosted sessions may be live at once. Creating one past this is refused with the count and this setting named. Terminated sessions do not count |
| `hostedSessions.maxMessagesPerSession` | `500` | How many of a session's most recent messages are written to disk. Bounds what a restart can restore, not the in-memory transcript |
| `hostedSessions.terminatedRetentionMs` | `86400000` (24h) | How long a terminated session's record is kept, listable with its termination reason, before it is retired |
| `hostedSessions.attachmentTtlMs` | `600000` (10 min) | How long an attachment stands without being renewed, clamped to between 30 seconds and a day. Attaching again renews it, and a client whose control-plane connection is still open renews automatically. A client that crashed or closed its tab never calls detach; when its attachment lapses the session is treated as detached and the detach policy decides |
| `hostedSessions.promoteInboundConversations` | `false` | Off: an inbound channel message (Telegram, Slack, email, ...) is answered by the process that received it. On: the first message of a conversation creates a hosted session and every later message steers into it, so the conversation keeps running while no surface is open |

## Payments (`payments.*`)

The daemon answers seven `payments.*` verbs over the control plane, one family for
the cards, the budget, the audit trail, and the checkout itself:

| Verb | What it does |
| --- | --- |
| `payments.budget.status` | Today's budget pools and what remains in each, plus whether this node is the one allowed to spend on a clustered install |
| `payments.cards.list` | The stored cards' metadata. No verb in the family ever returns card material |
| `payments.cards.create` | Validate and store a card, refusing each bad field with a 400 that names it. Metadata goes to the card file, the material one field per key into the daemon secret tier |
| `payments.cards.delete` | Remove a card's row and sweep its stored material out of the secret tier with it |
| `payments.purchases.list` | A page of the purchase audit ledger, newest first. `limit` defaults to 100 and is capped at 500 |
| `payments.checkout.begin` | Start a checkout in the browser the daemon operates. Refused honestly when no browser is composed, and gated by the budget reservation and the notice and decision windows below |
| `payments.checkout.fillCard` | Type the stored card into the open checkout's payment form, with the card-material guard armed only immediately before typing |

Everything is off until configured. `payments.enabled` defaults to `false`, and every
budget defaults to zero, which the purchase decision treats as a terminal refusal, so
a daemon nobody configured cannot spend anything.

Card metadata, the purchase ledger, and the budget's day state are stored beside the
daemon's other control-plane files as `payments-cards.json`, `payments-purchases.json`
and `payments-budget.json` under `<GOODVIBES_HOME>/.goodvibes/tui/control-plane/`.
Card material itself (the number, expiry, CVV, cardholder name) never touches those
files; it is written one field per key into the daemon tier of the secret store. The
budget file is written back after every reservation, commit and release, so a daemon
restarted mid-day comes back knowing what it already spent rather than handing the
full daily budget out again.

Budget amounts are written the way the owner would say them, in whatever
`payments.currency` names, so `100` is a hundred and `19.99` is nineteen ninety-nine.
The keys:

| Key | Default | Meaning |
| --- | --- | --- |
| `payments.enabled` | `false` | Answer the payment verbs at all |
| `payments.currency` | `USD` | The currency every budget amount is read in |
| `payments.defaultCardId` | `""` | The stored card a checkout uses when the call names none |
| `payments.cvvHandling` | `stored` | `stored` keeps the CVV in the secret store so purchasing can run unattended; `prompt` stops every purchase to ask a human for it |
| `payments.notifyChannels` | `""` | Comma-separated channel ids a purchase notice is delivered to |
| `payments.budget.dailyItem` | `0` | The daily item budget. Zero refuses every purchase |
| `payments.budget.dailyOverage` | `0` | The daily allowance for totals that exceed the quoted item price (shipping, tax) |
| `payments.budget.perPurchaseCeilingEnabled` | `true` | Enforce a per-purchase ceiling |
| `payments.budget.perPurchaseCeiling` | `0` | The ceiling for any single purchase |
| `payments.budget.overageToleranceEnabled` | `false` | Tolerate small overages past a window's approved amount |
| `payments.budget.overageToleranceDailyAllowance` | `0` | How much total overage a day may absorb when tolerance is on |
| `payments.windows.approvalMinutes` | `60` | How long a purchase that needs an approval waits for one before it is denied |
| `payments.windows.vetoMinutes` | `10` | How long a purchase notice waits so the owner can veto before the checkout proceeds |
| `payments.shipping.preferredTier` | `normal` | The shipping rung a checkout picks when the merchant offers a choice |
| `payments.shippingAddress.*` / `payments.billingAddress.*` | `""` | The stored addresses a checkout fills in, seven flat fields each (`name`, `line1`, `line2`, `city`, `region`, `postalCode`, `country`). An address with every field blank reads as not stored |
| `payments.majorRetailersAdditional` | `""` | Merchant domains treated as major without asking the judge |
| `payments.majorRetailersExcluded` | `""` | Merchant domains never treated as major, whatever the judge says |
| `payments.ebayMinSellerFeedbackCount` | `0` | Minimum eBay seller feedback count before a listing is purchasable |
| `payments.ebayMinSellerPositivePercent` | `0` | Minimum eBay seller positive-feedback percent |
| `daemon.timezone` | `UTC` | The timezone whose midnight resets the daily budget. The owner profile maps `location.timezone` onto this key |

An unfamiliar merchant is judged for recourse through the currently configured model;
the two `majorRetailers*` keys are the owner's overrides and win in both directions.
On a clustered install only the payments leader is allowed to spend, and
`payments.budget.status` reports which this node is, so grouping machines cannot turn
one budget into several.

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

`config list` enumerates every settings key with its current value and source. Run it
after any change you are not sure landed where you expected. `config list --json`
returns the same data as a structured document, including which keys were redacted.
