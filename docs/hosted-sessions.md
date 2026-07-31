# Daemon-Hosted Sessions

## What a hosted session is

A daemon-hosted session is a full conversation loop composed **inside this daemon
process** for one workspace — the same orchestrator, the same tool registry rooted at
the named workspace, and the same permission machinery a terminal client runs
locally. The difference is that it does not depend on any client staying open: once
created, it keeps running in the daemon, and any surface (terminal, agent, web UI) can
attach to watch and steer it, detach, and reattach later — including after the daemon
itself restarts, since a session's transcript is written to disk within the bound set
by `hostedSessions.maxMessagesPerSession`.

A hosted session registers on the same shared session spine every other kind of
session uses, so it shows up in general session listings alongside local ones — but it
is only listed and killable through the `sessions` verbs described below when you mean
specifically the daemon's own hosted sessions, not a terminal's local session running
on this machine.

## Workspace trust

Creating a hosted session names a `workspaceRoot` (an absolute path — a relative one
would resolve against the daemon's own directory, never what was meant). Where a
hosted run's tool-use permission questions are gated is scoped to **that session's
workspace**, not the daemon's own directory: an undecided workspace raises the trust
question as an approval record any attached surface can answer, a restricted workspace
refuses non-read tool categories without asking, and a daemon hosting three sessions in
three different directories can be asking three separate trust questions at once.

## The five verbs

| Verb | What it does |
| --- | --- |
| `sessions.hosted.create` | Compose a new hosted loop for a workspace. Refused with the live count and `hostedSessions.maxSessions` named when the cap is already reached |
| `sessions.hosted.attach` | Join a session and receive its transcript so far — what a client that was never connected, or one reconnecting after a restart, needs instead of an empty screen. A session restored from disk has its loop rebuilt on attach, with a system line noting its in-flight turn did not survive the restart |
| `sessions.hosted.detach` | Leave a session. If other clients are still attached, nothing else happens. If this was the *last* client, the effective detach policy decides what happens next (see below) |
| `sessions.hosted.kill` | End a session regardless of who is attached or what its detach policy says — its in-flight turn is interrupted, its loop taken apart, and its workspace floor released if it was the last session using it. Killing an already-terminated session returns that record unchanged rather than erroring |
| `sessions.hosted.list` | Every session this daemon hosts, most recently updated first. Terminated sessions are excluded unless `includeTerminated` is set |

These are declared **WebSocket-only** in the control-plane method catalog — there is no
REST binding for any of them. Driving one further (sending a message, cancelling a
tool call, queuing follow-ups) uses the same verbs a local session already exposes:
`sessions.steer`, `sessions.followUp`, `sessions.toolCalls.cancel`,
`sessions.queuedMessages.*`. Streamed output rides the `turn` and `tools` event
domains, stamped with the session id, so a client watches a hosted turn exactly as it
watches a local one.

## Detach vs kill

**Attaching is what keeps a `kill`-policy session alive** — the policy applies only
when the *last* attached client detaches, not on every detach. Two policies:

- **`kill`** (the default, and what closing a client has always done) — the session
  ends, with the reason recorded as `detached`.
- **`survive`** — the session stays alive and reattachable; work continues while
  nothing is watching, and any surface can pick it back up.

The governing setting is `hostedSessions.detachPolicy` (default `kill`), but a single
session can override it at creation time. Every hosted-session record carries both the
override (`detachPolicy`, possibly unset) and the policy that will actually apply next
(`effectiveDetachPolicy`), so a client can show what leaving will do *before* it
leaves, rather than guessing.

`kill` (the verb) is unconditional and never consults the detach policy at all — it
always ends the session, whoever is attached.

## From the CLI

```sh
goodvibes-daemon sessions list [--all] [--json] [--host <name>] [--port <n>] [--token <t>]
goodvibes-daemon sessions kill <id> [--json] [--host <name>] [--port <n>] [--token <t>]
```

`sessions list` shows every hosted session with its status, workspace, turn count,
attached-client count, its effective detach policy, and how long since it was last
updated. `--all` includes already-terminated sessions, kept (with their termination
reason) until `hostedSessions.terminatedRetentionMs` retires them. `sessions kill <id>`
calls `sessions.hosted.kill` with no id being a usage refusal (exit 2) rather than
"kill everything" — there is no shape of this command that ends more than the one
session named. Both subcommands use the same `--host`/`--port`/`--token` remote-target
convention as `status` (see [commands-reference.md](commands-reference.md)); because
these are ws-only verbs they are reached over the control-plane socket rather than a
REST call, but the target, the token, and the defaults are identical.

## Limits

| Setting | Default | Effect |
| --- | --- | --- |
| `hostedSessions.maxSessions` | `8` | Live sessions at once. A `create` past this is refused, naming the count and this setting. Terminated sessions do not count against it |
| `hostedSessions.maxMessagesPerSession` | `500` | How many of a session's most recent messages are persisted to disk — bounds what a restart can restore; the live in-memory transcript is unaffected |
| `hostedSessions.terminatedRetentionMs` | `86400000` (24h) | How long a terminated session's record stays listable (with `--all`) before it is retired |

See [configuration.md](configuration.md#daemon-hosted-sessions-hostedsessions) for how
to set these, and `hostedSessions.promoteInboundConversations` for handing inbound
channel conversations (Telegram, Slack, email, ...) to a hosted session instead of
answering them inside the process that received them.
