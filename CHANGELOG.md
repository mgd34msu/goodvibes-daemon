# Changelog

All notable changes to the GoodVibes daemon.

---

## [Unreleased]

## [1.28.7] - 2026-08-02

### Changes

- **Changed: payment limits hold the amount you would say out loud.** The
  budget settings drop their unit suffix — `payments.budget.perPurchaseCeiling`,
  `dailyItem`, `dailyOverage`, `overageToleranceDailyAllowance` — and hold
  plain amounts in the configured currency, written exactly as you give them:
  `100` is a hundred dollars, `19.99` is nineteen ninety-nine, and `$100`,
  `100.00` and `100` all mean the same hundred. This daemon migrates its
  settings file on load with a receipt; your limits are unchanged, only how
  they are written (platform runtime 2.0.5).
- Fixed: every platform state store this daemon keeps writes atomically and
  quarantines a corrupt file with a receipt instead of failing on it — the
  watcher-snapshot fix from 1.28.6 is now the platform-wide rule. The daemon
  settings file itself deliberately keeps its stricter contract: an
  unparseable settings file still refuses the boot loudly, because defaults
  may be more permissive than what the file held.

## [1.28.6] - 2026-08-02

### Changes

- **Fixed: a corrupt watcher snapshot no longer crash-loops this daemon.**
  A host freeze left the snapshot file as valid JSON followed by NUL bytes,
  and the daemon died parsing it — once at boot, and once on a periodic tick
  47 seconds after every restart, so the service never stayed up. The
  platform runtime (2.0.4) now writes that file atomically and quarantines a
  corrupt one with a receipt beside it, rebuilding watcher state from live
  registrations. A torn file costs a rebuilt cache instead of the daemon.
- Fixed: refusing an unknown owner-profile field id now names the valid ids
  instead of citing a documentation section.

## [1.28.5] - 2026-08-01

### Changes

- Fixed: a client that inherited this daemon's bind host is no longer refused
  as "insecure PUBLIC transport" when that host is a wildcard. The platform
  runtime (2.0.3) classifies `0.0.0.0` and `::` with loopback and the other
  private-network origins — a wildcard is a listen address, and dialing it
  reaches the local machine. Until this fix, a daemon deliberately bound to
  `0.0.0.0` for LAN access left local clients unable to call it over plain
  http, profile reads included.

## [1.28.4] - 2026-08-01

### Changes

- Fixed: the platform runtime is 2.0.2, which removes the last pre-split
  remnants of in-process daemon composition from the shared bootstrap. In the
  terminal products those remnants broke the packaged bundle's module
  initialization and killed every conversation turn; this daemon consumes the
  same runtime and picks up the cleaned composition path. A hosted-session
  turn is exercised against the built binary as part of this release's gates.

## [1.28.3] - 2026-08-01

### Changes

- Fixed: importing settings that include `display.themeMode` no longer prints
  an "unknown key" warning. The SDK's configuration schema (2.0.1) now declares
  the key — `auto` probes the terminal background once at startup, `dark` and
  `light` force a fixed appearance — so every component ingests it as a real,
  documented setting.

## [1.28.2] - 2026-08-01

### Changes

- This repository's releases carry the daemon's own artifacts; the suite
  installer at `https://goodvibes.sh/install.sh` is unchanged.

## [1.28.1] - 2026-08-01

- Changed: the npm package is `@pellux/goodvibes-daemon`, scoped like every other
  package on the platform. The executable, the service unit, and the release
  assets keep their names; only the registry entry moved.
  `npm install -g @pellux/goodvibes-daemon` is the npm-channel install from here
  on. The 1.28.0 registry entry under the same scoped name carries identical
  contents.

### Changes

- `pair --host <name>` now reaches a DIFFERENT daemon instead of being refused.
  It asks that daemon to mint a brand-new per-device pairing token over
  `pairing.handoff.create` and prints the pairing block for it — a different
  act than the plain `pair` reprint, which still just reprints this machine's
  existing shared token and never mints. Because it changes state on a daemon
  that may not be this process's own, it states the plan and asks for
  confirmation first; `-y`/`--yes` answers non-interactively, same as
  `migrate-service`. An unreachable daemon, a rejected token, and a daemon too
  old to serve the verb are each refused by name, never a stack trace, and a
  target with no web origin configured still gets its token and fragment
  printed honestly rather than a fabricated link.
- The unified inbox is served. `channels.inbox.list` has had a handler in this
  repository for a while and no client could reach it: the SDK descriptor
  carried `invokable: false`, so the method-dispatch endpoint refused the call
  before the handler was consulted, and `GET /api/channels/inbox` was in no
  route table. The agent's inbox asked on every refresh and wrote down
  `method_unavailable` every time. It answers now, over both the gateway invoke
  and the advertised REST path.

  What a client gets is one merged timeline, newest first, across every
  provider — items interleave by arrival rather than being grouped, and each
  carries its own `provider`, so an inbox reads like an inbox. Pages are bounded
  and walked with an opaque `nextCursor`; `cursor` stays what it was, the
  freshness watermark you hand back as `since`. That is a keyset, not an offset:
  the feed is written to while it is read, and an offset page re-anchors on
  every insert, so a caller walking pages during a poll would see items twice
  and miss others.

  The answer is served from this daemon's SYNCED MIRROR — the sqlite store the
  Slack, Discord and IMAP adapters already write into on their own cadences —
  and not from a fresh remote fetch per call. Four reasons, all of them about
  what a fetch-per-call would cost: a third-party rate limit would sit behind a
  read verb any client may call at any rate; the cluster hands FETCHING for each
  inbox account to one elected node, and a read that fetched would make every
  standby fetch too, which is the double-read the election exists to prevent;
  triage scores are applied as items are persisted, so inline-fetched items
  would come back unscored and the verb would answer two shapes depending on
  timing; and a provider outage would turn a read into a hang instead of an
  answer.

  The price of serving a mirror is that its age is invisible in the items, so it
  is not left implicit. Every call reports `providers`: one entry per provider
  this daemon knows about, whether or not it contributed anything, with its
  state, when it last synced, how much of the mirror is its, and whether this
  node is the one fetching it. `ready`, `empty`, `unconfigured`, `error` and
  `pending` are five different things, and a caller does something different
  about each — a fresh install with no tokens is not an outage, and a node that
  has not looked yet is not a node reporting an empty inbox. A provider whose
  sync failed contributes no items, says why, and sets `partial`, so a short
  list is never mistaken for a quiet week. Nothing configured is an empty list
  with three unconfigured statuses, not an error: the verb is callable in every
  state.

- Two saves of one daemon SQLite store in the same millisecond raced. The temp
  filename was `<path>.<pid>.<Date.now()>.tmp`, so both writes picked the same
  path, the first rename moved it away, and the second failed with ENOENT on a
  file it had just written. Not hypothetical: the inbox poller flushes once per
  provider and polls every provider concurrently, so an ordinary two-provider
  startup hit it — and once `channels.inbox.list` began reporting per-provider
  health, the failure showed up as a provider reporting a filesystem error for
  its feed. The temp name now carries a per-process counter. Every store on
  `HandlerSqliteStore` shared the hazard, so the fix is there.

- A gateway invocation that carries no context no longer throws a TypeError out
  of the handler wrapper. `normalizeContext` read `.metadata` off the context
  unconditionally, and an in-process invoke that builds the invocation by hand
  can omit it; an absent context now reads as the empty one — no principal, no
  scopes, not admin, nobody claiming a person asked — which can only cost a
  caller an authorization it never proved, never grant one.

- Three config modules the terminal app carried a byte-identical copy of are the
  SDK's: `config/goodvibes-home.ts` (tree-root and daemon-home resolution),
  `config/provider-model.ts` (`provider:model` parsing) and `config/index.ts`
  (a barrel over the SDK plus derivation helpers, all of which moved). Every
  importer here reads them from `@pellux/goodvibes-sdk/platform/config` and
  `.../platform/providers`.

- `config set <key> <value>` reads its value with the terminal shell's
  `parseConfigValueText`. `src/cli/config-value.ts` held a byte-identical copy
  of that function and its `cli/index.ts` re-export is gone with it. The copy
  existed because the shared one was private; it is exported now, and one
  implementation is the whole point — `--config x=false` and `config set x
  false` must write the same thing.

- The local `sql.js` ambient declaration is gone. The SDK ships the declaration
  now, and `daemon/handlers/sqlite-store.ts` picks it up with
  `/// <reference types="@pellux/goodvibes-sdk/sql-js" />`.

- The test helpers this repo and the terminal app both carry now say so in a
  header. They are byte-identical on purpose: each binds to its own repo's
  working tree, source layout and Bun test lifecycle, so a shared home would
  mean inventing a test-only published package rather than hoisting anything.

---

## [1.28.0] - 2026-07-30

### Changes

- Hosted third-party coding agents (Claude Code, Codex CLI, opencode) now work
  over this daemon's own gateway. `acp.agents.list` (read-only discovery of
  installed agents) and `acp.sessions.create` (spawn one as a long-lived
  session) were cataloged and advertised as callable on every build, and
  answered nothing: the composition never constructed the ACP host they are
  handlers for. `runtime/services.ts` now builds that host — permission asks
  from a hosted agent route through the same shared approval broker every
  other confirmation rides, and each hosted agent registers onto a shared
  session so it is attachable and steerable like any native one — and threads
  it into the gateway registration and the fleet registry, so a hosted agent
  also shows up as a fleet row.

- The command line is the daemon's, and it is an operator surface rather than a
  way to start a process. It shipped carrying the terminal app's parser: a table
  of two dozen command words — `tui`, `run`, `doctor`, `models`, `providers`,
  `auth`, `secrets`, `plugin` — against an entry point that dispatched on help,
  version and four service verbs. Everything else fell through to "start a
  daemon in the foreground", so `goodvibes-daemon status` served, and so did
  `goodvibes-daemon install-servce`. The parser's own unknown-command error was
  unreachable, because no word could fail to match.

  The vocabulary is now exactly this binary's real commands, held in one catalog
  (`src/cli/command-catalog.ts`) that the parser, the help text and the shell
  completions all read. Serving happens on a bare invocation or on `serve`, and
  on nothing else; any other unrecognized word exits 2 with `Unknown command: X`
  and the help. The terminal app's conversation flags — `--resume`, `--continue`,
  `--fork`, `--print`, `--prompt`, `-o/--output`, `--open`, `--no-alt-screen`,
  `--session`, `--strict` — were accepted in silence and read by nothing; each is
  now refused by name and says which surface owns it.

- New commands, all of them things a headless box's operator previously had no
  way to do:

  - `status [--json]` asks a RUNNING daemon what it is doing: version, uptime,
    the address it actually bound, its health roll-up, its channels, its place in
    the cluster, how many sessions it is hosting, and what its last update or
    rollback did. `--host`/`--port`/`--token` ask a daemon on another machine,
    over the same convention `cluster` uses.
  - `sessions list` and `sessions kill <id>` over the daemon's hosted-session
    verbs, which are ws-only and so are reached over the control-plane socket
    with the same operator token.
  - `config list|get|set|unset` reads and writes this machine's settings
    directly, so it works whether or not a daemon is running. Every value it
    PRINTS goes through the redaction rules first — a token, a password or an API
    key reads as `<redacted>` — while `config set` still writes the real value.
  - `pair` prints the pairing link and QR again, from the same renderer the
    daemon uses at startup and carrying the same existing token, so the block is
    no longer lost when the boot banner scrolls away.
  - `update [--check]` reports the running version, the receipts the daemon wrote
    about its own swaps and restarts, the version an automatic rollback rejected,
    and whether a rollback is in force. `--check` states plainly that no verb
    exists to trigger an early check and names what does work, rather than
    calling a verb the daemon does not answer.
  - `start-service`, `stop-service` and `restart-service`, on the same service
    manager `install-service` already used. A verb aimed at a service that is not
    installed says so and exits 4 instead of dispatching a doomed platform call.
  - `completion bash|zsh|fish`, generated from the catalog, and `help <command>`
    for any command's own arguments and flags.

- `service-status` answers with an exit code — 0 installed and running, 3
  installed but not running, 4 not installed — and takes `--json`. A script no
  longer has to read the prose to find out.

- The help text describes the binary that exists: every command, the flags that
  work, `-y/--yes`, `--config`, `--enable`/`--disable`, `--json`, the exit codes,
  and a systemd user service, a launchd agent or a Scheduled Task depending on
  the platform it is printed on — it used to say systemd on every platform,
  including macOS, where `install-service` writes a launchd agent.

- `status` reads the daemon's identity, health and channel routes with the
  envelope they actually use. Those routes answer with the payload itself while
  the cluster routes wrap theirs in `{ ok, data }`, and the wrapped reader turned
  a healthy 200 into "the daemon refused the request".

- Four never-called functions the terminal app left behind
  (`applyTuiRuntimeConfigDefaults`, `applyConfiguredHitlMode`,
  `applyRuntimeConfigDefault`, `applyRuntimeCommandEndpointFlagOverrides`) are
  gone, verified to have no importers first.

- The daemon can run a conversation, not just watch one. Stating how a workspace
  floor is built (`DaemonConfig.hostedSessions`, wired in
  `runtime/hosted-session-composition.ts`) turns on the SDK's hosted-session
  engine and its `sessions.hosted.create/attach/detach/kill/list` verbs: a full
  loop composed inside this process — the same orchestrator, the same tool
  registry rooted at the named workspace, the same permission machinery a
  terminal runs. Driving one uses the verbs that already existed
  (`sessions.steer`, `sessions.followUp`, `sessions.toolCalls.cancel`,
  `sessions.queuedMessages.*`), and its streamed output rides the `turn` and
  `tools` event domains stamped with the session id, so a client watches a
  hosted turn exactly as it watches a local one.

  What this daemon states is where a hosted run's asks are gated: the workspace
  trust decision, scoped to the SESSION's workspace rather than the daemon's own
  directory. An undecided workspace raises the trust question as an approval
  record any attached surface can answer, a restricted one refuses non-read
  categories without asking, and a daemon hosting three sessions in three
  directories asks three separate questions.

  Detaching is governed by `hostedSessions.detachPolicy`, which defaults to
  `kill` — closing a client has always ended its work. `survive` opts into
  sessions that outlive both the client and a restart of this daemon; a single
  session may override the setting when it is created. `hostedSessions.maxSessions`
  caps how many loops this machine holds at once, and the transcript bound and
  retention window govern what a restart can restore.

  A floor is also seeded with the local models this daemon discovered, so the
  machine's own Ollama or LM Studio is routable inside a hosted session rather
  than only for the daemon's own agents.

- `bun run smoke:hosted` drives the whole story against the COMPILED binary on an
  isolated home and a high port: create, a real turn through `sessions.steer`
  against a local stub model, attach with history, detach under both toggle
  positions, a per-session override, reattach, kill, and the refusal a relative
  workspace path earns.

- A paired phone is now reachable from a surface that is not this process. Binding the
  gateway catalog to the device posture runtime already served the grants surface;
  it now also serves `devices.capability.request` and `devices.artifacts.list`/`read`,
  so a client with no device runtime of its own can ask for a photo, a screen capture,
  a location fix, the clipboard, or a device command, and read the capture bytes back
  by id. The runtime is handed over whole, deliberately: the verbs and the `phone`
  tool must reach the same service, because a second path to a phone would be a second
  place the confirmation prompt and the durable grants could be decided differently.
  Nothing about the gates moved — the prompt still rides this daemon's shared approval
  seam and appears wherever the person is looking.

- Conversation-scope rewind stopped answering for sessions it holds nothing for.
  `conversation-rewind-port.ts` resolves a session's conversation from an in-process
  registry, and while the conversation loops run in the surfaces that registry is
  empty here. It reported "0 messages to drop" — the same answer a conversation
  already at the anchor gives, so a caller could not tell a rewind that found nothing
  from one that reached nobody. It now reports the anchor as unavailable with the
  reason, which `rewind.plan` surfaces as a warning and `rewind.apply` records instead
  of a truncation it never performed.

  The surfaces reach conversation rewind a different way now: they offer their live
  conversation over the control plane (`rewind.conversation.*`, served on this
  catalog), and the daemon puts its question to whichever surface is actually running
  the loop. This port is what that falls through to for sessions the daemon hosts
  itself.

- The daemon is its own product. It was built and shipped out of the terminal app's repository,
  which meant one repository held two programs with very different jobs and every daemon change
  rode a terminal-app release. It now has its own repository, its own release line and its own
  binary, and the terminal app and the agent become clients of it.

- The suite installer lives here now. `scripts/install.sh` — the script behind
  `curl -fsSL https://goodvibes.sh/install.sh | sh` — moved out of the terminal app's
  repository into this one, because the daemon is the product everything else is
  installed alongside and this repository's release lane is the one that publishes it.
  There is exactly one copy: two installers in two repositories is how two installers
  drift apart.

  It resolves a release tag per repository and verifies every file against that
  repository's own SHA256SUMS.txt, so one curl still installs the whole suite: the
  daemon and the sqlite-vec addon from here, the terminal app from `goodvibes-tui`,
  the agent and its browser driver from `goodvibes-agent`, and the web UI bundle from
  `goodvibes-webui`. `GOODVIBES_DAEMON_VERSION` pins the daemon's tag the way
  `GOODVIBES_VERSION` and `GOODVIBES_AGENT_VERSION` already pinned theirs.

  The installer itself now ships as a release asset of this repository, checksummed by
  the same SHA256SUMS.txt as the binaries, and the release workflow publishes it to
  goodvibes.sh. It used to say in its own header that it was "published to goodvibes.sh
  on release" while nothing anywhere did that.

- **The browser operator surface installs with everything else.** It is not a fourth
  binary and not a fourth service: the installer unpacks a checksum-verified bundle to
  `~/.local/bin/webui/<version>` and the daemon serves it on its own listener, same
  origin as the API. One curl now installs all four consumption paths.

  It is served to THIS MACHINE ONLY by default. The daemon's shipped binding is
  loopback and installing the web UI does not change it, so nothing new is exposed to
  your network by installing. Reaching it from another device is a deliberate separate
  act, and the install receipt prints both the URL and the one command that does it.

- **New: `goodvibes-daemon webui enable | disable | status`.** The command that owns
  serving the web UI — which directory, whether it is served at all, and the honest
  answer to "what URL do I open and who can reach it". `enable --bundle-dir <dir>`
  refuses a directory with no index.html rather than pointing the daemon at something it
  cannot serve; `--lan` is the one act that widens exposure and `--loopback` takes it
  back; `status` says whether a configured bundle is still on disk.

  The URL it reports is the control-plane origin, because that is the listener serving
  the bundle. `web.port` is the surface's declared endpoint and nothing binds it, so
  `enable` also replaces the shipped `web.publicBaseUrl` placeholder (`http://127.0.0.1:3423`)
  with the origin that actually answers — leaving any value an operator chose alone, and
  saying so when the two differ.

- The daemon updates itself from this repository. The platform default for
  `update.releasesUrl` now names `mgd34msu/goodvibes-daemon`, so a daemon built from
  this repository resolves its own release line without being configured. Asset names
  are unchanged and the service unit's ExecStart is path-stable, so replacing the
  binary at its installed path is all a version change takes.

  **A daemon from the old repository cannot hand ITSELF over, and an earlier draft of
  this entry said it could.** Every daemon shipped at 1.27.1 or below was compiled
  against SDK 1.20.0, whose baked `update.releasesUrl` default names
  `mgd34msu/goodvibes-tui`. That default is compiled in rather than persisted: no
  settings file carries it and no migration rewrites it. The terminal repository no
  longer builds daemon binaries, so those daemons resolve a release with no
  `goodvibes-daemon-<os>-<arch>` asset and fail. Pointing them at this repository
  instead does not rescue them either — their shipped updater adds the terminal binary
  beside them to the same all-or-nothing download whenever `goodvibes` sits in the
  install directory, which `scripts/install.sh` guarantees, and this repository
  deliberately publishes no terminal binary. There is also no remote write path to
  reconfigure them: the control plane's `config.set` verb exists as a catalog
  descriptor with no handler registered behind it.

  What performs the handover is the terminal, once, at launch: it reads the version of
  the `goodvibes-daemon` binary installed beside it and, when that binary predates this
  split, downloads the current daemon from this repository's releases,
  checksum-verifies it against `SHA256SUMS.txt`, swaps it with the outgoing build kept
  at `<path>.previous`, and restarts the service. It replaces that one file and nothing
  around it. The mechanism is `src/runtime/daemon-handover.ts` in `goodvibes-tui`; it
  reaches hosts with that product's next release, and until then a pre-split daemon is
  moved across by re-running the installer.

  Named rather than implied away: the SDK's `resolveDaemonInstalledFiles` still adds
  the terminal binary to the daemon's OWN update target set when one sits beside it, so
  on a three-binary install a daemon from this repository cannot yet complete an
  unattended self-update either — it asks for a `goodvibes-<os>-<arch>` asset this
  repository does not publish and takes the 404. Making each product update strictly
  its own files is an SDK change, not one this repository can make.

- The daemon stopped keeping its own copy of code the platform owns. Forty-five
  modules under `src/` held the same implementation `@pellux/goodvibes-sdk` or
  `@pellux/goodvibes-terminal-shell` exports, because both products grew out of
  one repository and the split copied files rather than pointing at them. Each
  is now deleted here and imported from where it lives: the transcript journal,
  the durability sweep and its housekeeping, the session-liveness markers, the
  work-plan store, the workstream engine and its draft journal, the turn
  anchors, the versioned-read quarantine, the atomic write, the pairing family
  (stable host, handoff mint, offer copy, web origin), the session-cost
  resolver, the credential-availability read, the memory-status projection, the
  alert gate, the focus tracker, the consolidation receipt, the grid types, the
  cluster command family and its remote-target convention, the CLI redaction,
  endpoint resolution and config overrides, and thirteen composition helpers
  that construct the platform's own objects.

  Nothing about where this daemon keeps its state changed. The hoisted modules
  that used to spell the storage scope now take it as a parameter, and every
  call site here passes the daemon's own — the work plan, the session surface,
  the workspace trust file, the code-index database and the operator-token
  pruning candidates all resolve to exactly the paths they resolved to before.

  Two behaviours the shared modules do not carry are stated here instead of
  dropped: `src/cluster/raw-reply-route.ts`, because `/status`, `/api/health`
  and `/api/channels/status` answer with their payload rather than the wrapped
  `{ ok, data }` every `/api/cluster/*` route uses, and reading one as the
  other called a healthy daemon a refusing one; and `src/cli/config-value.ts`,
  because `config set <key> <value>` needs a settings value coerced on its own,
  which the shared override path only does for whole `key=value` strings.

- The command line is parsed by the shared argument engine, driven by this
  binary's catalog. `src/cli/parser.ts` was a full engine — the command-word
  pre-scan, arity skipping, `--`, inline `=value`, per-kind application — with
  a switch over one product's flag field names. The engine is now
  `parseWithCatalog`, and `src/cli/command-catalog.ts` is the vocabulary it
  reads: the same commands, the same aliases, the same flags per command, the
  same refusal that an unrecognized word exits 2 rather than starting a daemon.
  One sentence reads differently — a conversation flag this binary does not
  have is now refused as "`--resume` is not a goodvibes-daemon flag — resuming
  a conversation, a terminal app concern that belongs to another surface."

- The packages a hosted session's tools need are pinned by this product rather
  than inherited as optional. A session this daemon hosts parses with
  tree-sitter, spawns language servers, reads sql.js, matches with fuse.js and
  bundles with jszip; the platform declares all of them optional, which is
  right for a surface that never opens a file and leaves a hosted turn without
  its tools when an optional install quietly fails. They are declared here at
  the ranges the platform states, and a dependency check makes a missing one
  fail at build time instead of at the first hosted turn. `@anthropic-ai/vertex-sdk`
  and `@aws/bedrock-token-generator` are removed — nothing in this repository or
  the platform imports either.
