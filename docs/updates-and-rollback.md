# Updates and Rollback

## The hourly self-update loop

For a compiled binary install, the daemon checks for a new release once an hour
(`update.intervalMinutes`, default `60`), with the first check delayed
`update.firstCheckSeconds` (default `30`) after start so a boot doesn't compete with
the rest of startup. When a newer release exists it downloads and checksum-verifies
the new binary, then **swaps only at an idle moment** — never mid-turn, never while a
hosted session is actively working — and restarts through the service manager. This
loop only runs for a genuine compiled-binary install; see
[install-kind guard](#install-kind-guard) below.

`update.auto` (default `true`) turns the whole loop off when set `false`. `update.releasesUrl`
(default `https://github.com/mgd34msu/goodvibes-daemon/releases/latest`) names the
repository the daemon resolves its own tags and assets from — a daemon built from this
repository updates from this repository's own release line, independent of the
terminal app's or the agent's.

## Restart-at-idle

"Idle" is a real, checked condition, not a fixed delay — the swap waits for a moment
when nothing is actively running so an in-flight hosted session or channel delivery
is never interrupted by the binary underneath it changing.

## `.previous` rollback

Every swap keeps the outgoing binary at `<path>.previous` beside the new one. This
daemon's own CLI does not expose a manual rollback verb — there is no
`goodvibes-daemon update rollback` command in this build's catalog. A connected
terminal client's `/update rollback` command is the one-command path when a client is
attached; on a headless box with only the daemon installed, the safety net below
(automatic crash-loop rollback) is what actually protects you, and the kept
`<path>.previous` file is there to restore by hand if you ever need to.

## Automatic rollback and rejected-version memory

If the daemon crash-loops after an update — `update.rollbackAfterFailedStarts`
(default `3`) consecutive rapid boots that fail to reach a fully-started daemon — the
startup path automatically restores the kept previous binary and restarts onto it,
with no operator action required. Setting `update.rollbackAfterFailedStarts` to `0`
leaves a bad update in place for a hand-run rollback instead.

The version that triggered an automatic rollback is remembered (`rejectedVersion` in
the local lifecycle marker — see below): the update loop will not attempt to install
that exact version again on its own. `goodvibes-daemon status` and
`goodvibes-daemon update` both surface it:

```
rejected: 1.29.0 crash looped and was rolled back — the update loop will not install that version again
rollback: an automatic rollback is in force; no fully-started boot has cleared it yet
```

## Receipts

The daemon writes a receipt for events worth telling an operator about — a completed
swap, a crash-loop rollback, a settings migration. These are read (never written) by
`status`/`update`, and are stored on the daemon's own host at
`<GOODVIBES_HOME>/.goodvibes/tui/control-plane/daemon-receipts.json`, alongside the
uptime/crash marker at `daemon-lifecycle.json` in the same directory. That is why the
uptime, receipt, and rollback lines are reported for a **local** daemon and stated as
unavailable for a **remote** one (`--host` naming another machine) — those files live
on the daemon's own filesystem, not behind a control-plane verb, and `status --host
other-box` has no access to that box's files.

## `update` / `update --check`

```sh
goodvibes-daemon update [--check] [--json] [--host <name>] [--port <n>] [--token <t>]
```

Reports the running version, the receipts written about swaps and restarts, any
rejected version, and whether a rollback is currently in force.

`--check` is honest about a real gap rather than inventing a verb: the daemon's
control plane, as of this release, publishes **no method to trigger an update check
early**. `--check` states that plainly and names what actually works:

```
update --check: this daemon publishes no verb to trigger an update check early.
  It checks once an hour on its own and swaps only at an idle moment.
  To make it check now, restart it — it checks on the way up:
    goodvibes-daemon restart-service
```

If a future release adds that verb, this behavior — and this document — update
alongside it. Until then, `restart-service` (which checks on the way up) or waiting
for the hourly check are the two working paths.

## Install-kind guard

The self-update loop only runs for a genuine **compiled binary** install. A `bun run
daemon` dev interpreter and a `bun add -g`/npm global package install are never
swapped by this mechanism — the daemon detects its own install kind from its exec
path before handing the update-artifact identity to the update loop at all, so a
developer's source checkout or a package-manager install is never at risk of having
its interpreter replaced out from under it. Those installs get their update path from
`bun`/`npm`/`git pull` instead.
