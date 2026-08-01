# Command Reference

Every command `goodvibes-daemon` accepts, generated from the command catalog
(`src/cli/command-catalog.ts`) as of daemon `1.28.0` and fleshed out with the exact
help text and behavior. This vocabulary is the complete set — a word that matches
none of it is refused with `Unknown command: <word>` and exit code 2, it does not
fall through to starting a daemon. There is no `docs:*` script that regenerates this
file automatically; when a command or flag changes in the catalog, update this page
by hand in the same change.

## Global options

Accepted before or after any command:

| Flag | Takes | Meaning |
| --- | --- | --- |
| `--daemon-home <dir>` | value | The daemon's own identity directory (operator tokens, auth users, daemon settings) |
| `-C`, `--cd`, `--working-dir <dir>` | value | The directory the daemon treats as its workspace |
| `-h`, `--help` | — | Print help and exit 0 |
| `-v`, `--version` | — | Print the version and exit 0 |

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | the command did what it says |
| `1` | it ran and failed — the reason is printed |
| `2` | the command line was wrong: an unknown command, an unknown flag, a flag this command does not take, or a missing value |
| `3` | `service-status` only: installed, but not running |
| `4` | `service-status` only: not installed |

## The remote-target convention

Every command that talks to an already-running daemon (`status`, `update`, `pair`,
`sessions`) accepts the same three flags, all optional:

| Flag | Default |
| --- | --- |
| `--host <name>` | the control plane's configured host (`127.0.0.1` on a default install) |
| `--port <n>` | the control plane's configured port |
| `--token <t>` | this machine's own operator token, read from `<daemon home>/operator-tokens.json` |

Authentication is `Authorization: Bearer <operator token>` against the control plane —
the same credential the terminal app and the web UI already use. The defaults are the
point: a headless box the operator has SSHed into works with no flags at all; the flags
exist for driving a machine in the next room, or for scripting. A missing token is a
refusal rather than an anonymous attempt — the daemon on this machine has never started
and so has never minted one, or the wrong directory was named.

## Commands

### `serve` (default)

```
goodvibes-daemon [serve] [OPTIONS]
```

Start the control plane, the channel pollers, the cluster membership and every verb
family a GoodVibes client calls, and keep running until stopped. This is what a bare
invocation does; running with no command or with `serve` are the only two ways to
start serving — any other first word is a command, and an unrecognized one is refused
rather than treated as "start serving" anyway.

Flags (beyond the global ones):

| Flag | Meaning |
| --- | --- |
| `--hostname`, `--host <host>` | Bind address for the control plane. `0.0.0.0` means every interface |
| `--port <n>` | Control-plane port to bind |
| `--provider <id>` | Run with this provider instead of the configured one. Not written to settings |
| `-m`, `--model <registryKey>` | Run with this model. A `provider:model` key also sets the provider |
| `-c`, `--config <key=value>` | Override one settings key for this run only. Repeatable. Never written to disk |
| `--enable <feature>` | Switch a capability on for this run through its real settings key. Repeatable |
| `--disable <feature>` | Switch a capability off for this run. Repeatable |

To have it survive reboots instead: `goodvibes-daemon install-service`.

### `install-service`

```
goodvibes-daemon install-service
```

Write the service definition for this platform, then start it, so the daemon comes
back after a reboot with nobody logged in required. Refused when a unit from the
older install script is still present — installing beside it would leave two daemons
competing for one port. Take that one over with `migrate-service` first. Refuses an
explicit `--hostname`/`--port` (the installed unit carries no endpoint flags; use
`config set controlPlane.host` / `controlPlane.port` instead).

### `uninstall-service`

```
goodvibes-daemon uninstall-service
```

Stop the service and delete its definition file. On systemd this does not run
`disable`, so a stale enablement symlink can remain until
`systemctl --user daemon-reload`; the receipt says so when it applies.

### `service-status`

```
goodvibes-daemon service-status [--json]
```

Report the platform, the service name, the definition path, and whether the service
is installed and currently running (queried live, not inferred from a pid file). Exit
codes: `0` installed and running, `3` installed but not running, `4` not installed,
`1` the platform refused the query (the error is printed).

### `migrate-service`

```
goodvibes-daemon migrate-service [-y]
```

Move from the older install script's `goodvibes-daemon.service` unit to the one this
binary manages (`goodvibes.service`). Without `-y`/`--yes` it prints the exact plan
and changes nothing — this command never auto-migrates. The new service is installed,
started and verified healthy **before** the old one is stopped or removed; a new
service that does not come up rolls itself back and leaves the working one alone. A
process merely listening on the port with no unit behind it is reported, never killed.

### `start-service` / `stop-service` / `restart-service`

```
goodvibes-daemon start-service
goodvibes-daemon stop-service
goodvibes-daemon restart-service
```

Start, stop, or restart the service this binary manages, reporting what the platform
did. A verb aimed at a service that is not installed reports that (exit 4) rather than
dispatching a call that was always going to fail. `restart-service` is the usual way to
pick up a settings change that only applies at boot (an endpoint binding, for example).

### `status`

```
goodvibes-daemon status [--json] [--host <name>] [--port <n>] [--token <t>]
```

Talk to a daemon that is already running and report: its version, how long it has
been up, the address it actually bound, what its last update did, whether its channels
and inbox are healthy, its place in the cluster, and how many sessions it is hosting.
With no flags it asks the daemon on this machine. The uptime/update/rollback lines are
read from files on the daemon's own host, so they are reported for a local daemon and
named as unavailable for a remote one. Exit 0 when the daemon answered, 1 when it
could not be reached.

### `pair`

```
goodvibes-daemon pair [--json] [--host <name>] [--port <n>] [--token <t>] [-y]
```

Two forms.

**Local** — no `--host`, or one naming this machine: print the same pairing block a
daemon prints once at startup, reusing the existing shared token (never minting a new
one), so a link printed here and one printed at boot are identical. The link is
assembled from this machine's own token store.

**Remote** — `--host` naming a different machine: ask THAT daemon to mint a brand-new
per-device pairing token over `pairing.handoff.create` and print the pairing block for
it. Minting is a different act than reprinting: it is a fresh token, and every token
that daemon already issued — its shared token included — is left untouched. Because it
changes state on a daemon that may not be this process's own, it states the plan and
asks for confirmation before acting; `-y`/`--yes` answers non-interactively, the same
convention `migrate-service` uses. Without `-y` nothing is called and nothing changes.

An unreachable daemon, a rejected token, and a daemon too old to serve the mint verb are
each refused by name, never a stack trace. A target daemon with no web origin
configured still gets its token and pairing fragment printed honestly — there is
nothing to build a scannable link or QR from in that case, so none is fabricated.

### `sessions`

```
goodvibes-daemon sessions list|kill <id> [--json] [--all] [--host <name>] [--port <n>] [--token <t>]
```

| Subcommand | Effect |
| --- | --- |
| `sessions list` | every daemon-hosted session, most recently used first |
| `sessions kill <id>` | end one: its in-flight turn is interrupted and its loop taken apart, whoever is attached and whatever its detach policy says |

`--all` includes sessions that have already ended; they are kept, with the reason they
ended, until the retention window retires them. These are the daemon's own hosted
sessions — see [hosted-sessions.md](hosted-sessions.md) — not sessions a terminal runs
locally on this machine. `kill` with no id is a usage refusal (exit 2), never "kill
everything."

### `config`

```
goodvibes-daemon config list|get <key>|set <key> <value>|unset <key> [--json]
```

| Subcommand | Effect |
| --- | --- |
| `config list` | every setting with a value, and where the value came from |
| `config get <key>` | one setting |
| `config set <key> <value>` | write one setting to disk (checked against the schema first) |
| `config unset <key>` | put one setting back to its shipped default |

Values are read and written on this machine's settings files directly, so every verb
works whether or not a daemon is running. A running daemon picks up most changes live;
ones that only apply at bind time say so in the receipt. Anything that reads like a
credential — a token, a password, an API key — prints as `<redacted>` in every read
path; `config set` still writes the real value, only the *output* is cleaned. See
[configuration.md](configuration.md) for the settings themselves.

### `update`

```
goodvibes-daemon update [--check] [--json] [--host <name>] [--port <n>] [--token <t>]
```

Report the running version, the receipts the daemon has written about its own updates
and restarts, the version an automatic rollback rejected (if any), and whether a
rollback is currently in force. `--check` is honest about a gap: the control plane
publishes no verb to trigger an update check early, so `--check` states that plainly
and names the two things that do work — waiting for the hourly check, or restarting
the service (which checks on the way up). See
[updates-and-rollback.md](updates-and-rollback.md).

### `send`

```
goodvibes-daemon send [message] [--channel <id>] [--to <address>] [--title <text>] [--list]
```

Send a message through Telegram, ntfy, Discord, Slack, Google Chat, Signal, WhatsApp,
iMessage, Teams, BlueBubbles, Mattermost, Matrix, or a webhook. The message is an
argument or stdin, so it composes with other tooling.

| Flag | Meaning |
| --- | --- |
| `--channel <id>` | Channel to send to. With none named, your one configured channel is used and the receipt says which |
| `--to <address>` | Where within that channel: an ntfy topic, a Telegram chat, etc. |
| `--title <text>` | Title for channels that show one (ntfy) |
| `--list` | Show every channel, whether it is on, and where it sends |

A channel that is switched off is refused rather than silently redirected to the
default, and a failed send exits non-zero carrying the provider's own error. It works
with no daemon running — most of the point of a self-notification command is that
something has already stopped. This command's own flags follow the command word
(`send` is a passthrough command — see below).

### `cluster`

```
goodvibes-daemon cluster status|create|join|key|nodes|forget|rotate|leave|rename|groups
```

| Subcommand | Effect |
| --- | --- |
| `status` | what this machine is doing in its group |
| `create` | start a group here |
| `join` | join one (interactively, or with `--group` and `--key`) |
| `key` | print the join key for another machine to use |
| `nodes` | every machine in the group |
| `groups` | groups advertising themselves on this network |
| `forget <machine>` | drop a machine from the group |
| `rotate [--now]` | change the shared key |
| `rename <name>` | rename the group |
| `leave` | leave the group |

Talks to a running daemon over the same `--host`/`--port`/`--token` convention
`status` uses; `--json` gives a scriptable answer.

### `webui`

```
goodvibes-daemon webui enable|disable|status [--bundle-dir <dir>] [--lan|--loopback]
```

The web UI is a built bundle of static files served by the daemon's own control-plane
listener, on the same origin as the API — the URL to open is the control-plane
origin, not the declared `web.port`.

| Subcommand | Effect |
| --- | --- |
| `enable [--bundle-dir <dir>]` | serve the bundle at that directory |
| `disable` | stop serving it; the bundle stays on disk |
| `status` | what is served, from where, and who can reach it |

`enable` changes no network exposure on its own — a daemon bound to loopback keeps
serving to this machine only. `--lan` binds every interface, `--loopback` takes it
back, and both are stated in the receipt.

### `provision-wake-model`

```
goodvibes-daemon provision-wake-model
```

Fetch the wake-word model files that are missing from the managed voice tree. The
installer runs this on a binary it has just placed, and a daemon start retries it, so
an install that happened offline heals on its own. A download that fails is reported
and exits 0 by default — a machine with no wake word still has a perfectly good
daemon; pass `--strict` to have a degraded outcome exit 1 instead.

### `completion`

```
goodvibes-daemon completion bash|zsh|fish
```

Print a completion script for the named shell on stdout, generated from the same
catalog the parser and the help text use, so it cannot drift from what the binary
accepts. Install by writing it somewhere the shell reads, for example:

```sh
goodvibes-daemon completion bash > ~/.local/share/bash-completion/completions/goodvibes-daemon
goodvibes-daemon completion zsh  > ~/.zfunc/_goodvibes-daemon
goodvibes-daemon completion fish > ~/.config/fish/completions/goodvibes-daemon.fish
```

### `help`

```
goodvibes-daemon help [command]
```

With no argument, print the command list and the global options. With a command
name, print that command's arguments, flags and behavior. `goodvibes-daemon <command>
--help` does the same thing for a real command.

### `version`

```
goodvibes-daemon version
```

Print the binary name and its version, and exit 0. Same as `--version`/`-v`.

## Passthrough commands

`send`, `cluster`, `webui`, and `provision-wake-model` are dispatched **before** this
binary's own flag parser runs and **before** any runtime is composed — every token
after the command word belongs to that command's own vocabulary rather than to the
daemon parser (a `send` message may itself start with a dash, or contain `--port`).
This means each of them only works as the first argument: `goodvibes-daemon --json
send hello` is refused with `send has to be the first argument`, not silently
misparsed.

## Flags this binary refuses by name

This binary's parser used to accept these silently. They are now refused,
naming the surface that actually owns them:

`--resume`, `-r`, `--continue`, `--fork`, `--print`, `--prompt`/`-p`,
`--output`/`--output-format`/`-o`, `--open`, `--no-alt-screen`, `--session`/`-s`,
`--strict` (outside `provision-wake-model`). Every one of them means "start or resume
a conversation," which this binary does not do.
