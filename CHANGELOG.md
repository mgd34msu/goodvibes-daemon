# Changelog

All notable changes to the GoodVibes daemon.

---

## [1.28.0] - 2026-07-30

### Changes

- The daemon is its own product. It was built and shipped out of the terminal app's repository,
  which meant one repository held two programs with very different jobs and every daemon change
  rode a terminal-app release. It now has its own repository, its own release line and its own
  binary, and the terminal app and the agent become clients of it.
