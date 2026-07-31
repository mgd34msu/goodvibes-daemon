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
