# goodvibes-daemon

[![CI](https://github.com/mgd34msu/goodvibes-daemon/actions/workflows/ci.yml/badge.svg)](https://github.com/mgd34msu/goodvibes-daemon/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Version](https://img.shields.io/badge/version-1.28.21-blue.svg)](https://github.com/mgd34msu/goodvibes-daemon)

The GoodVibes daemon is the one long-running process per machine that holds the control plane
every GoodVibes client talks to. It:

- answers the operator verb families over HTTP
- reads and replies on your channels
- elects a leader among the machines you have grouped together, so only one of them answers a
  shared inbox
- runs scheduled and triggered work
- keeps the session, memory, knowledge and code-index stores
- serves the payment verbs, with stored cards, a daily budget that survives a restart,
  and checkouts driven through the browser it operates
- provisions the local voice and wake-word models
- updates itself at an idle moment, with a rollback if the new binary will not start

The terminal app (`goodvibes`), the conversational agent (`goodvibes-agent`) and the web app are
clients of this process. They render, they capture input, and they call verbs; the work happens
here.

## What this repository is

A **product** over `@pellux/goodvibes-sdk`, exactly like the TUI and the agent are:

- the composition root that builds the daemon's service graph,
- the product handler families the SDK does not own, tabled below,
- the CLI, every command of which is documented in
  [docs/commands-reference.md](docs/commands-reference.md),
- packaging: the compiled `goodvibes-daemon-<os>-<arch>` binaries.

The handler families under `src/daemon/handlers/`:

| Family | What it serves |
| --- | --- |
| inbox | `channels.inbox.list`, the unified inbound-message list, with provider adapters for Slack, Discord and email |
| triage | the email auto-tag and spam-triage pass that decorates the inbox list with persisted triage metadata |
| drafts | `channels.drafts.*`, daemon-mirrored channel drafts for cross-device sync, webhook values stored redacted |
| routing | `channels.routing.*`, the daemon-persisted channel-to-profile routing table |
| remote | `remote.peers.*`, the peer registry and the dispatcher routing work to docker, ssh, cloud-terminal and local-process backends |
| credentials | the daemon credential store that resolves `goodvibes://secrets/...` references for the other handlers |
| payments | the `payments.*` verbs: cards, budget, purchase ledger, owner approvals and browser checkout |

Every engine (the facade, the routes, the brokers, the updater, the channel adapters, the
schedulers) lives in the SDK and is consumed from the published package. Nothing was moved out of
the SDK to build this repository, and nothing should be: a capability that both a client and the
daemon need belongs in the SDK, not here.

## Version line

The daemon versions on the continuous **1.28** line; this release is **1.28.21**. Live
installs already carry a settings reader-floor
(`$goodvibes.minReaderVersion`), the update handover compares versions monotonically, and the
rejected-version record is keyed by version. Those three mechanics all depend on the version
line staying continuous and monotonically increasing.

## Install

```sh
curl -fsSL https://goodvibes.sh/install.sh | sh
```

This installs the whole GoodVibes suite (the daemon, the terminal app, the
agent, and the browser operator surface) from checksum-verified binaries,
with no package manager involved. The product-by-product table of what
lands from where is in [docs/getting-started.md](docs/getting-started.md#install).

The browser surface is not a fourth binary and not a fourth service: the bundle
unpacks to `<install dir>/webui/<version>` and this daemon serves it on its own
listener, same origin as the API. Installing it exposes nothing new to your
network. The shipped binding is loopback and the installer does not change it.
`goodvibes-daemon webui --lan` is the deliberate act that widens it, and
`goodvibes-daemon webui status` says which posture is in force.

Or install from the npm registry with [Bun](https://bun.sh):

```sh
bun add -g @pellux/goodvibes-daemon
bun pm trust -g goodvibes-daemon
goodvibes-daemon install-service
```

Bun blocks lifecycle scripts for untrusted global packages, so the second line
lets the package's postinstall place the matching daemon binary. If you skip it,
the `goodvibes-daemon` launcher still self-heals on first run by fetching and
checksum-verifying the binary. `npm install -g @pellux/goodvibes-daemon` also works when
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
load-bearing: the installer and the running daemon's own updater both resolve release assets by
these exact names, so changing one without the other breaks installs and self-updates.

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

## Documentation

- [Getting started](docs/getting-started.md): install, first boot, pairing, where state lives, health checks
- [Command reference](docs/commands-reference.md): every command, its flags, and its exit codes
- [Configuration](docs/configuration.md): the settings this daemon reads, by key
- [Service and deployment](docs/service-and-deployment.md): the host service, migration from an older install, `--daemon-home` vs the data home
- [Updates and rollback](docs/updates-and-rollback.md): the hourly self-update loop, automatic crash-loop rollback, `.previous`
- [Daemon-hosted sessions](docs/hosted-sessions.md): conversations that run inside the daemon and outlive any one client
- [Troubleshooting](docs/troubleshooting.md): startup failures, log locations, port conflicts, service-status oddities

## License

MIT
