# Getting Started

`goodvibes-daemon` is the one long-running process per machine that holds the control
plane every GoodVibes client talks to. It answers the operator verb families over HTTP
and WebSocket, reads and replies on your channels, elects a leader among machines you
have grouped together, runs scheduled and triggered work, keeps the session, memory,
knowledge and code-index stores, provisions the local voice and wake-word models, and
updates itself at an idle moment with a rollback if the new binary will not start.

The terminal app (`goodvibes`), the conversational agent (`goodvibes-agent`) and the
browser operator surface are clients of this process. They render and capture input;
the work happens here.

## Install

### The one-line installer

```sh
curl -fsSL https://goodvibes.sh/install.sh | sh
```

It is pure-binary and checksum-verified — nothing is fetched through a package
manager. By default it installs all four products from their own
repositories' releases:

| Product | Repository | What lands |
| --- | --- | --- |
| `goodvibes-daemon` | `mgd34msu/goodvibes-daemon` | this binary, plus the `sqlite-vec` native addon |
| `goodvibes` | `mgd34msu/goodvibes-tui` | the terminal app binary |
| `goodvibes-agent` | `mgd34msu/goodvibes-agent` | the agent binary, plus its browser driver |
| the web UI | `mgd34msu/goodvibes-webui` | a built bundle this daemon serves |

Binaries land in `~/.local/bin` by default. Useful environment variables (the pipe-to-`sh`
form stays one command, so these are set before the pipe):

| Variable | Default | Effect |
| --- | --- | --- |
| `GOODVIBES_INSTALL_DIR` | `~/.local/bin` | target directory for every installed binary |
| `GOODVIBES_DAEMON_VERSION` | `latest` | install a specific daemon tag |
| `GOODVIBES_AGENT` | `1` | set `0` to skip installing `goodvibes-agent` |
| `GOODVIBES_WEBUI` | `1` | set `0` to skip installing the browser operator surface |
| `GOODVIBES_VECTOR` | `1` | set `0` to skip the `sqlite-vec` native addon |
| `GOODVIBES_DAEMON_SERVICE` | `1` | set `0` to skip first-run daemon service registration |
| `GOODVIBES_RESTART_DAEMON` | `1` | set `0` to leave an already-running daemon/agent untouched on upgrade |
| `GOODVIBES_UNINSTALL` | `0` | set `1` to remove installer-managed files and stop the daemon/agent, then exit (no downloads) |

When no daemon is running and no service unit exists yet, a fresh install registers the
daemon as a user service (a systemd user unit on Linux, a launchd agent on macOS) so it
comes up now and again on every login — see
[service-and-deployment.md](service-and-deployment.md). Uninstalling deliberately
preserves `~/.goodvibes` (your data); it removes only the files the installer itself
placed.

If `~/.local/bin` (or your chosen install directory) is not already on `PATH`, the
installer adds an idempotent, marker-tagged line to your shell's rc file — it is removed
again by `GOODVIBES_UNINSTALL=1`.

### The npm/Bun alternative

```sh
bun add -g @pellux/goodvibes-daemon
bun pm trust -g goodvibes-daemon
goodvibes-daemon install-service
```

Bun blocks lifecycle scripts for untrusted global packages, so the second line lets the
package's postinstall place the matching daemon binary (a GitHub release asset of this
repository — the npm package itself carries the product source and a launcher, not the
compiled daemon). If you skip trusting it, the `goodvibes-daemon` launcher self-heals on
first run by fetching and checksum-verifying the binary. `npm install -g @pellux/goodvibes-daemon`
also works once `bun` is on `PATH`.

## First boot

Running the binary with no arguments (or with `serve`) starts the daemon in the
foreground:

```sh
goodvibes-daemon
```

It prints a one-line startup banner naming its resolved version, the home directory,
and the host/port it actually bound, then a pairing block: the web origin, what a newly
paired device will be able to do, and a QR code encoding a deep link that opens the web
app already signed in. The pairing token is minted once and reused on every later boot,
so scrolling the banner off screen costs nothing — reprint it any time with:

```sh
goodvibes-daemon pair
```

To have the daemon survive a reboot instead of running in one foreground terminal,
install it as a host service:

```sh
goodvibes-daemon install-service
```

See [service-and-deployment.md](service-and-deployment.md) for what that registers on
each platform.

## Where state lives

Every entry point resolves the same two roots:

- **`GOODVIBES_HOME`** (or nothing — it defaults to your login home) — the tree root:
  the directory `.goodvibes/` sits under. Setting it relocates settings, workspace state,
  discovery roots, and every tier of the secret store.
- **`GOODVIBES_DAEMON_HOME`** (or `--daemon-home <dir>`) — the daemon's own identity
  directory, holding `operator-tokens.json` (the shared bearer token every client
  authenticates with) and the daemon's own `settings.json` (every daemon-owned config
  key — `controlPlane.*`, `hostedSessions.*`, `update.*`, and the rest — lands here
  rather than in the shared settings file). It falls under the tree root
  (`<GOODVIBES_HOME>/.goodvibes/daemon/`) unless set separately.

General settings, local auth users, sessions, watchers, memory and the code index live
under `<GOODVIBES_HOME>/.goodvibes/tui/` — the daemon's shared-surface state directory.
The daemon's own activity log (`activity.md`, rotated to `activity.md.1` at 10 MB) is
written under `<working directory>/.goodvibes/logs/`, where the working directory is the
one the daemon was started from (or `--working-dir`/`GOODVIBES_WORKING_DIR`) — for a
service-managed daemon that is your login home.

See [configuration.md](configuration.md) for the full settings reference and
[troubleshooting.md](troubleshooting.md) for what to check when something looks wrong.

## Is it healthy?

```sh
goodvibes-daemon status
```

Reports the version, uptime, the address it actually bound, a health roll-up, its
configured channels and whether each is healthy, its place in any cluster group, how
many sessions it is hosting, and what its last update or automatic rollback did. Exit 0
means the daemon answered; exit 1 means it could not be reached. Pass `--json` for a
scriptable version, or `--host`/`--port`/`--token` to ask a daemon on another machine —
see [commands-reference.md](commands-reference.md) for the full remote-target
convention.

```sh
goodvibes-daemon service-status
```

Answers a narrower, host-service-specific question — is the service installed, and is
it running — with exit codes a script can read directly (`0` running, `3` installed but
not running, `4` not installed) instead of parsing prose.
