# Testing and validation

## What runs where

| When | What | Command |
|------|------|---------|
| While you work | the test files your change affects, and a typecheck | `bun run test:changed`, `bun test <file>`, `bun run typecheck:test` |
| Every push to `main` and every PR (`ci.yml`) | typecheck, import-cycle and layer check, workflow structure, the full test run, the linux-x64 build and banner smoke, the compiled-binary boot and hosted-session smokes, the SDK-pin and tarball check | CI |
| Version bump | version stamps and the CHANGELOG section scaffold | `bun run release:prepare` |
| Release (`release.yml`) | verifies the tagged commit's push CI was green job by job, then builds, smokes and publishes | CI |

Local work never needs the whole suite. CI runs it on every push.

## Local commands

```bash
bun run test:changed                       # test files affected by changes since origin/main
bun test src/test/daemon/daemon-wire.test.ts   # one file
bun run test daemon-wire                   # the runner, filtered by a path fragment
bun run typecheck:test                     # src/, scripts/ and the tests
bun run architecture:check                 # import cycles and layer boundaries
```

`test:changed` is `bun run scripts/run-tests.ts --changed=origin/main`. The
runner keeps its per-file processes and temp-directory containment and hands
each file Bun's own `--changed` selection: a file whose import graph touches
nothing changed since `origin/main` (committed or not) runs no tests and is
counted as "not affected by the change". Pass another base with
`bun run scripts/run-tests.ts --changed=<ref>`, or a bare `--changed` for
Bun's default base. `--changed` and a positional path filter combine.

`bun run test` runs every file under `src/`. It is what the CI `test` job runs;
you rarely need it locally.

## Test layers

- **Unit.** One module called directly with real inputs. Fakes stand in only
  for what is outside the unit: a provider, a clock, systemctl, the network.
- **Composed runtime.** `createRuntimeServices` over a temp home
  (`src/test/helpers/runtime-services.ts`), for what the composition wires:
  which verbs have handlers, which stores are real, what a floor is given.
- **Over the wire.** `startDaemonFixture` (`src/testing/daemon-fixture.ts`)
  starts the daemon's own `DaemonServer` on an ephemeral port.
  `src/test/daemon/daemon-wire.test.ts` is the model: WebSocket upgrade
  authentication, SSE replay after a reconnect with `Last-Event-ID`, and a
  hosted session created, run against a scripted OpenAI-compatible model,
  detached and reattached, all through HTTP, SSE and WebSocket.
- **Compiled binary.** `bun run smoke:boot` and `bun run smoke:hosted` boot
  `dist/goodvibes-daemon-linux-x64` against an isolated home and a high port.
  CI runs both on the bytes the `build` job produced.

Nothing in the suite calls a real external service or a host tool whose state
it cannot control (`gh`, the host's `systemctl`): tests address stubs by
absolute path and inject timeouts rather than measuring wall-clock time.

A test earns its place by failing when behavior breaks. Tests that read source,
docs or workflow files as text, pin wording or object shapes nothing parses,
assert a mock's own return value, or only check that something is defined do
not; they were removed in the 2026-09 overhaul and should not come back. Before
adding a test, break the behavior it covers and watch it fail.

## Per-push CI (`ci.yml`)

| Job | Command | Purpose |
|-----|---------|---------|
| `typecheck` | `bun run typecheck:test`, `bun run architecture:check`, `bun run workflows:check` | tsc over everything `tsconfig.json` covers plus the tests; no runtime import cycles and no forbidden layer edges; every workflow parses and no job hides behind `continue-on-error` |
| `test` | `bun run test` | The suite, one process per file |
| `build` | `bun run build:linux-x64`, `bun run smoke` | The binary and the toolchain banner smoke; uploaded for `boot-smoke` |
| `boot-smoke` | `bun run smoke:boot`, `bun run smoke:hosted` | The compiled binary serves HTTP, reports an honest banner, refuses a broken settings file, and hosts a session end to end |
| `publish-check` | `bun run publish:check` | SDK pin, installed version and lockfile agree; imports use npm specifiers; the npm tarball holds the files an install needs and nothing it must not |
| `auto-release` | tag + dispatch | Pushes to `main` only, after every job above; tags a version that has no tag yet and dispatches `release.yml` |

## Version bump: `bun run release:prepare`

Version stamps and the CHANGELOG heading are written at the bump, never
checked per push:

```bash
bun run release:prepare --minor         # or --patch, --major, --version X.Y.Z
bun run release:prepare --no-bump       # regenerate at the current version
```

It sets `package.json`'s version, stamps the compiled-binary fallback in
`src/version.ts` and the README badge, and scaffolds a `## [X.Y.Z] - date`
section above the newest CHANGELOG section when none exists. It never commits
or tags. `npm version` runs it through the `version` script, and the toolchain
`release-cut` (`bun run release`) runs it as its sync command with
`--no-bump --no-changelog`, since release-cut writes those two itself. The
reusable-workflow SHAs in `release.yml` are still updated by hand when the SDK
pin moves.
