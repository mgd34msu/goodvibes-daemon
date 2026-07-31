# Changelog

All notable changes to the GoodVibes daemon.

---

## [1.28.0] - 2026-07-30

### Changes

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
