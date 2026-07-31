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
- the CLI (`send`, `cluster`, `provision-wake-model`, `install-service` and friends),
- packaging: the compiled `goodvibes-daemon-<os>-<arch>` binaries.

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
goodvibes-daemon provision-wake-model
```

State lives under `~/.goodvibes` (`GOODVIBES_HOME` relocates the tree; `GOODVIBES_DAEMON_HOME`
relocates only the daemon's own identity directory — its operator tokens, its users, its daemon
settings).

## License

MIT
