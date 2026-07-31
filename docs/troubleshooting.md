# Troubleshooting

## The daemon won't start

The daemon writes the reason a boot failed **synchronously to the file descriptor the
service journal is attached to**, before anything else, specifically so a crash during
startup is never silent even if the activity logger has no destination configured yet.
Check the platform's own service log first:

```sh
# systemd (Linux)
journalctl --user -u goodvibes.service -n 100 --no-pager

# launchd (macOS) — the unit's stdout/stderr redirection path, printed by:
goodvibes-daemon service-status
```

If the daemon was started directly (not through the service manager), the same fatal
line is on its own stderr — nothing is buffered or lost even if the process exits
immediately after printing it.

A parse refusal (an unrecognized command, a malformed flag) is reported the same way,
with exit code 2 — check for that before assuming a deeper startup failure. Run
`goodvibes-daemon service-status` to confirm the service is even installed before
digging further; see [service-and-deployment.md](service-and-deployment.md).

## Where logs live

The daemon's own activity log is at:

```
<working directory>/.goodvibes/logs/activity.md
```

where "working directory" is wherever the daemon was started from (or the directory
named by `--working-dir`/`GOODVIBES_WORKING_DIR`) — for a service-managed daemon that
is your login home, so in practice `~/.goodvibes/logs/activity.md`. It rotates to
`activity.md.1` (one backup, overwritten each rotation) once the live file reaches
10 MB. Each entry is timestamped and leveled (`INFO`/`WARN`/`ERROR`), with structured
data attached as a fenced JSON block where relevant.

Separately, the daemon's own lifecycle history — its uptime marker, update/rollback
receipts, and any rejected version — lives under
`<GOODVIBES_HOME>/.goodvibes/tui/control-plane/` as `daemon-lifecycle.json` and
`daemon-receipts.json`. These are what `goodvibes-daemon status` and
`goodvibes-daemon update` read for a **local** daemon; a remote target (`--host`
naming another machine) cannot see them and says so rather than guessing.

## `/status` and `/health` over HTTP

Both routes require the bearer operator token. Read it out of the daemon's identity
directory (default `~/.goodvibes/daemon/operator-tokens.json`, relocatable with
`GOODVIBES_DAEMON_HOME`/`--daemon-home`):

```sh
TOKEN=$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.env.HOME+'/.goodvibes/daemon/operator-tokens.json')).token)")

curl -sS -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3421/status
curl -sS -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3421/api/health
```

A `401`/`403` means the token is stale or wrong for that daemon — restart the daemon
(which re-derives its shared token if missing) or re-read the file; a connection
refused means nothing is listening on that host/port yet — check
`goodvibes-daemon service-status` and `controlPlane.port` in
[configuration.md](configuration.md). `goodvibes-daemon status --json` wraps the same
information (plus channels, cluster membership, and local-only history) in one call
without needing to construct the curl by hand.

## Pairing link lost / need it again

```sh
goodvibes-daemon pair
```

Reprints the exact block the daemon prints once at startup — the web origin, the QR
code, and the deep link — reusing the same shared token rather than minting a new one,
so nothing that has already paired is invalidated. It only works for **this** machine;
`--host` naming another one is refused, because the link has to be built from that
machine's own token store.

## Port conflicts

When the TUI or another instance already owns the configured control-plane port, the
daemon logs a startup warning rather than crashing silently, and a stale
`controlPlane.publicBaseUrl` that disagrees with the real bind is flagged the same way
(`[goodvibes-daemon] warning: ...`) in both stdout and the activity log. To change
which port this daemon binds:

```sh
goodvibes-daemon config set controlPlane.port 3431
goodvibes-daemon restart-service
```

(`--port` on `serve`/`install-service`/`migrate-service` is a runtime-only override for
that one invocation and is refused on the service-lifecycle commands precisely because
it would not survive a restart — see
[service-and-deployment.md](service-and-deployment.md).)

## `service-status` says `installed: false` but something is answering

`installed` and `running` are two independent checks: `installed` is a file-exists
check on the exact unit path this tool resolves (`~/.config/systemd/user/goodvibes.service`
on Linux); `running` is a live query of that service **name** against systemd/launchd,
or (on `manual`) a pid-file check. They can disagree — most commonly when a unit file
was deleted or moved by hand without stopping the unit first, so systemd is still
serving a unit it has already loaded into memory even though the file at the expected
path is gone. Verify directly before acting on either field alone:

```sh
systemctl --user status goodvibes.service    # Linux
launchctl list | grep goodvibes              # macOS
```

If a daemon is genuinely running with no tracked unit behind it at all (a manually
`nohup`'d process, or one started with `bun run daemon` directly), `service-status`
reports it honestly as not installed — this tool never assumes ownership of, or kills,
a process it did not install. `install-service` in that situation writes and starts a
proper unit alongside whatever is already running, which is exactly the state
`migrate-service`'s "adopt-or-warn, never kill" rule exists to handle carefully — see
[service-and-deployment.md](service-and-deployment.md#what-migrate-service-does).
