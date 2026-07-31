# goodvibes-daemon

[![CI](https://github.com/mgd34msu/goodvibes-daemon/actions/workflows/ci.yml/badge.svg)](https://github.com/mgd34msu/goodvibes-daemon/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Version](https://img.shields.io/badge/version-1.28.0-blue.svg)](https://github.com/mgd34msu/goodvibes-daemon)

The GoodVibes daemon: one long-running process per machine that holds the control plane every
GoodVibes client talks to. It answers the operator verb families over HTTP, reads and replies on
your channels, elects a leader among the machines you have grouped together so only one of them
answers a shared inbox, runs scheduled and triggered work, keeps the session, memory, knowledge
and code-index stores, provisions the local voice and wake-word models, and updates itself at an
idle moment with a rollback if the new binary will not start.

The terminal app (`goodvibes`), the conversational agent (`goodvibes-agent`) and the web app are
clients of this process. They render, they capture input, and they call verbs; the work happens
here.

## What this repository is

A **product** over `@pellux/goodvibes-sdk`, exactly like the TUI and the agent are:

- the composition root that builds the daemon's service graph,
- the product handlers the SDK does not own (inbox, triage, drafts, routing, remote peers,
  credentials),
- the CLI (`send`, `cluster`, `webui`, `provision-wake-model`, `install-service` and friends),
- packaging: the compiled `goodvibes-daemon-<os>-<arch>` binaries,
- `scripts/install.sh` — the suite installer behind `https://goodvibes.sh/install.sh`, which
  installs all four products (this daemon, the terminal app, the agent, the browser operator
  surface) from their own repositories' releases. It lives here because the daemon is the product
  everything else is installed alongside, and because this repository's release lane publishes it.

Every engine — the facade, the routes, the brokers, the updater, the channel adapters, the
schedulers — lives in the SDK and is consumed from the published package. Nothing was moved out of
the SDK to build this repository, and nothing should be: a capability that both a client and the
daemon need belongs in the SDK, not here.

## Provenance

The daemon's source was extracted from `goodvibes-tui` (which built and shipped the daemon binary
from `src/daemon/**` plus the daemon half of `src/runtime/**`) and from `goodvibes-agent` (which
carried daemon-grade capabilities the TUI's daemon lacked: the trigger family, registration-gated
checkpoints, the launch-tolerant provider registry). Git history was not carried across; the files
are clean copies, unified to one implementation per capability where the two forks had drifted.

## Version line

The daemon continues the platform's version line at **1.28.0** rather than restarting at 1.0.0.
Live installs already carry a settings reader-floor (`$goodvibes.minReaderVersion`), the update
handover compares versions monotonically, and the rejected-version record is keyed by version — a
restart would break all three on machines that are already running.

## Install

The one-line installer downloads checksum-verified binaries and needs no package
manager. It installs the whole suite — this daemon and the sqlite-vec addon from
this repository's release, the terminal app from `goodvibes-tui`, the agent and
its browser driver from `goodvibes-agent`, and the browser operator surface's
bundle from `goodvibes-webui` — resolving a tag per repository and verifying
every file against that repository's own `SHA256SUMS.txt`:

```sh
curl -fsSL https://goodvibes.sh/install.sh | sh
```

The installer is `scripts/install.sh` in this repository and ships as a release
asset of it, so the current published copy is always at
`https://github.com/mgd34msu/goodvibes-daemon/releases/latest/download/install.sh`.

The browser surface is not a fourth binary and not a fourth service: the bundle
unpacks to `<install dir>/webui/<version>` and this daemon serves it on its own
listener, same origin as the API. Installing it exposes nothing new to your
network — the shipped binding is loopback and the installer does not change it.
`goodvibes-daemon webui --lan` is the deliberate act that widens it, and
`goodvibes-daemon webui status` says which posture is in force.

Or install from the npm registry with [Bun](https://bun.sh):

```sh
bun add -g goodvibes-daemon
bun pm trust -g goodvibes-daemon
goodvibes-daemon install-service
```

Bun blocks lifecycle scripts for untrusted global packages, so the second line
lets the package's postinstall place the matching daemon binary. If you skip it,
the `goodvibes-daemon` launcher still self-heals on first run by fetching and
checksum-verifying the binary. `npm install -g goodvibes-daemon` also works when
`bun` is already on `PATH`.

The npm package carries the product source and the launcher; the daemon itself is
a compiled binary published as a GitHub release asset of this repository, and the
release always lands before the registry publish so a fresh install can never
resolve a version whose binary does not exist yet.

## Build

```sh
bun install
bun run typecheck
bun run test
bun run build            # host target
bun run build:all        # every release target
```

The compiled artifact names (`goodvibes-daemon-linux-x64`, `goodvibes-daemon-macos-arm64`, …) are
unchanged from the TUI's daemon leg, so the installer and the running daemon's own updater resolve
release assets by the names they already use.

## Running it

```sh
goodvibes-daemon                      # run in the foreground
goodvibes-daemon install-service      # install and start the user service unit
goodvibes-daemon service-status
goodvibes-daemon send --channel telegram "message"
goodvibes-daemon cluster status
goodvibes-daemon webui status         # is the browser surface served, from where, to whom
goodvibes-daemon provision-wake-model
```

State lives under `~/.goodvibes` (`GOODVIBES_HOME` relocates the tree; `GOODVIBES_DAEMON_HOME`
relocates only the daemon's own identity directory — its operator tokens, its users, its daemon
settings).

## License

MIT
