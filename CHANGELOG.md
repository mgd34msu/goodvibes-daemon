# Changelog

All notable changes to the GoodVibes daemon.

---

## [1.28.0] - 2026-07-30

### Changes

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
  `update.releasesUrl` now names `mgd34msu/goodvibes-daemon`, and a daemon update no
  longer replaces the terminal app binary beside it — each product updates its own.
  Asset names are unchanged and the service unit's ExecStart is path-stable, so a
  daemon installed from the old repository hands itself over on its next hourly check
  with nothing to do by hand.
