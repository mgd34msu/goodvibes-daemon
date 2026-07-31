# Service and Deployment

The daemon is meant to run as a durable host service — one process per machine,
started once and surviving reboots — rather than a session-scoped process someone
starts by hand each time. `install-service`, `uninstall-service`, `start-service`,
`stop-service`, `restart-service`, `service-status`, and `migrate-service` manage that
service. See [commands-reference.md](commands-reference.md) for each command's flags
and exit codes; this page covers what they actually install and why.

## systemd vs launchd (vs Windows)

| Platform | Mechanism | Unit name |
| --- | --- | --- |
| Linux | systemd **user** unit | `goodvibes.service` |
| macOS | launchd **user** agent | label `goodvibes` (installed by this tool); the curl installer's own first-run setup uses `sh.goodvibes.daemon` |
| Windows | Scheduled Task | — |

`service-status` names the service kind actually in use on the host it runs on, and
every command's help text states it correctly per platform (an earlier build's help
text said "systemd" unconditionally, including on macOS, where `install-service`
writes a launchd agent — that has been fixed).

## Unit location

Unit files are written under the **login user's home**, never under a relocated
`GOODVIBES_HOME`/`GOODVIBES_DAEMON_HOME` tree:

- Linux: `~/.config/systemd/user/goodvibes.service`
- macOS: `~/Library/LaunchAgents/sh.goodvibes.daemon.plist` (curl installer) or
  `~/Library/LaunchAgents/goodvibes.plist` (`install-service`)

This split matters because a daemon started with `--daemon-home` pointing at a
throwaway directory must never register itself as *the* machine's service — doing so
once had systemd supervise a scratchpad daemon as the real one for hours. The unit's
`ExecStart` deliberately carries **no endpoint flags** (no baked `--hostname`/`--port`):
the daemon re-resolves `controlPlane.hostMode`/`host`/`port` from persisted settings at
every boot, so a host configured for `hostMode=network` or a non-default port keeps
that endpoint across upgrades. Only `--daemon-home` is baked into the unit, naming
where the *settings* live — never what they say.

On Linux, a user unit alone only starts when its user logs in. The curl installer
tries to enable **lingering** (`loginctl enable-linger <user>`) so the daemon also
comes up on a headless box nobody has logged into; if it cannot (no `loginctl`, or a
polkit prompt requiring an interactive session), it prints the one command to run by
hand.

## `install-service` / `uninstall-service` / `start-service` / `stop-service` / `restart-service`

`install-service` writes the unit, then starts it — so "installed" implies "enabled
and running" the way an operator expects. It refuses outright when a unit from the
**older install script** (`goodvibes-daemon.service`, the retired name) is already
present, because installing this tool's `goodvibes.service` beside it risks two
daemons competing for the same port; take that one over with `migrate-service` first.

`uninstall-service` stops the service and removes its unit file, but does not run
`systemctl --user disable` — a stale enablement symlink can remain until
`systemctl --user daemon-reload`, and the command's own receipt says so when it
applies.

`start-service`/`stop-service`/`restart-service` act on the service this binary
manages. A verb aimed at an uninstalled service reports that plainly (exit 4) rather
than dispatching a systemd/launchd call that was always going to fail with a less
useful error.

## What `migrate-service` does

`migrate-service` is the guided, consented takeover of a unit the **older install
script** created (`goodvibes-daemon.service`). Design rules, all load-bearing:

- **Never auto-migrate.** Without `-y`/`--yes` it prints the exact plan and changes
  nothing.
- **New-up-then-old-down.** The new `goodvibes.service` unit is installed, started,
  and verified healthy — a fresh, honest `is-active` read — **before** the old
  `goodvibes-daemon.service` unit is stopped, disabled, or removed. A new unit that
  fails or does not come up healthy rolls itself back (uninstalled) and never touches
  the old one, so a botched takeover never costs you the working daemon.
- **Adopt-or-warn, never kill.** If the old unit file is simply absent but something
  is already listening on the configured host:port — a manually `nohup`'d daemon with
  no unit at all is the real case this guards — that is an unidentified process, not
  a managed unit. Nothing is stopped or disabled; the command warns and leaves the
  decision to you.
- Every action (stop/disable the old unit, remove its file, `daemon-reload`) runs
  through the same seams the test suite exercises — there is no separate code path
  that could bypass them in production.

`migrate-service` also refuses an explicit `--hostname`/`--port`, for the same reason
`install-service` does.

## `--daemon-home` / `GOODVIBES_DAEMON_HOME` vs the data home

Two directories, both resolvable independently, and it matters which one a given flag
or variable moves:

- **`GOODVIBES_HOME`** relocates the **tree root** — settings, workspace state,
  discovery roots, and every tier of the secret store. This is what an isolated test
  harness or a from-scratch deployment sets.
- **`GOODVIBES_DAEMON_HOME`** (or `--daemon-home <dir>`) relocates only the
  **daemon's own identity directory** — `operator-tokens.json` and the daemon's own
  `settings.json`. It falls under the tree root (`<GOODVIBES_HOME>/.goodvibes/daemon/`)
  unless set separately; it is not a second way to move the whole tree.

Neither variable ever affects **unit-file path resolution** — the systemd/launchd
files always live under the real login home (`homedir()`), regardless of either
override. A daemon started with either variable set (`isOverridden` in
`resolveGoodVibesHomeOwnership()`) is treated as a throwaway run and refuses to adopt
the machine's real service unit, which is exactly the guard the incident above led to.

See [getting-started.md](getting-started.md#where-state-lives) for the full picture of
what lives where, and [configuration.md](configuration.md) for the `controlPlane.*`
keys the endpoint binding above resolves from.
