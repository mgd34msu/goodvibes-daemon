/**
 * daemon-fixture.ts — a real, running daemon, composed the way this product
 * composes one, for a test to drive.
 *
 * ── Why this is a shipped module and not a test helper ────────────────────
 *
 * Three consumer repositories test their client against the daemon's contract,
 * and each of them hand-builds a composition to test against: a stub session
 * broker here, a fake approval broker there, a catalog with the handlers
 * somebody remembered to attach. They are large (several hundred lines each),
 * they duplicate each other, and — the part that matters — they are each a
 * SECOND idea of what a daemon is. A client contract test passing against a
 * hand-rolled stand-in tells you the stand-in agrees with the client, which is
 * the one agreement that was never in doubt.
 *
 * This module is the alternative: the daemon's own `createRuntimeServices` and
 * its own `DaemonServer`, bound on an ephemeral port with a known token, over a
 * temp home. What a consumer's test talks to is the thing that ships.
 *
 * It deliberately lives under `src/testing/` rather than `src/test/`: the
 * package's `files` list ships `src` and excludes `src/test`, so this path is
 * published while the suites are not, and the main tsconfig typechecks it as
 * ordinary source. Nothing here imports `bun:test`, so a consumer on any runner
 * can use it.
 *
 * ── What it is not ───────────────────────────────────────────────────────
 *
 * Not a mock and not a fixture file. Nothing here fabricates a response. If a
 * verb is unwired in this composition it answers exactly as unwired as it would
 * in production, which is the property a contract test needs and a hand-built
 * stand-in cannot have.
 *
 * ── What a consumer needs, and what is still missing ─────────────────────
 *
 * WORKS TODAY, from inside this package, with no change anywhere else:
 *
 *   import { startDaemonFixture } from 'goodvibes-daemon/src/testing/daemon-fixture.ts';
 *
 *   The package declares no `exports` map, so a deep path resolves. It is the
 *   ugly form of the import, and it is a real one.
 *
 * STILL MISSING, and each is somebody's decision rather than a thing this file
 * can do for itself:
 *
 *   1. A NAMED ENTRY POINT. `goodvibes-daemon/testing` instead of the deep
 *      path. That means adding an `exports` map to package.json — and adding
 *      one is not additive: an `exports` map REPLACES path-based resolution, so
 *      every existing deep import into this package (its own `bin` shim
 *      included) stops resolving unless the map enumerates them. That is a
 *      packaging change with a blast radius, made once, deliberately, by
 *      whoever owns distribution — not a side effect of adding a test helper.
 *
 *   2. THE CONSUMER DEPENDENCY. A consumer repo has to depend on
 *      `goodvibes-daemon` to import this at all. Today the agent does (it is
 *      what makes its own install fail against an unpublished version); the
 *      terminal app and the webui do not. For the terminal app that is a
 *      devDependency and a version pin. For the webui, whose suites run in a
 *      browser context, the fixture cannot run in-process at all — it needs a
 *      launcher script that starts the fixture in a node process and hands the
 *      Playwright suite `baseUrl` and `token`. That launcher does not exist and
 *      should be written on the webui side, where its runner lives.
 *
 *   3. A RUNTIME FLOOR. This composes real stores, opens a real socket, and
 *      starts the runtime graph's pollers. A consumer suite that spins one up
 *      per test file pays about a second each and must `stop()` every one; the
 *      three hand-built stand-ins it replaces cost nothing and leak nothing.
 *      The honest guidance is one fixture per FILE (`beforeAll`/`afterAll`),
 *      which is how this repository's own suites use it — not one per test.
 *
 *   4. WHAT IT DOES NOT REPLACE. A stand-in is still the right tool for
 *      driving a client through a daemon state that is hard to reach for real:
 *      a wedged session, a specific 500, a torn connection. This fixture
 *      replaces the stand-ins that exist only to answer normally — which is
 *      most of the several hundred lines in each consumer, and all of the part
 *      that silently drifts. The refusal shapes it cannot easily produce live
 *      are exported separately and pinned against the real engine; see
 *      ./hosted-session-failures.ts for the pattern.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { DaemonServer } from '@pellux/goodvibes-sdk/platform/daemon';
import { createRuntimeStore } from '@pellux/goodvibes-sdk/platform/runtime/store';
import { UserAuthManager } from '@pellux/goodvibes-sdk/platform/security';
import { createFeatureFlagManager, deriveFeatureStates, RuntimeEventBus } from '@/runtime/index.ts';
import { createRuntimeServices, type RuntimeServices } from '../runtime/services.ts';
import { createHostedSessionOptions } from '../runtime/hosted-session-composition.ts';

/**
 * The capabilities a daemon serves once it is running. Seeded from a real
 * config first (so the registry stays complete), then forced on, because a
 * contract test asking "does this daemon serve X" must not be answered by a
 * feature flag that happens to be off in a fresh temp home.
 */
const DAEMON_CAPABILITY_FLAGS: readonly string[] = [
  'automation-domain',
  'control-plane-gateway',
  'delivery-engine',
  'hitl-ux-modes',
  'ntfy-surface',
  'permission-divergence-dashboard',
  'policy-as-code',
  'route-binding',
  'service-management',
  'slack-surface',
  'unified-runtime-task',
  'watcher-framework',
  'web-surface',
  'webhook-surface',
];

export interface DaemonFixtureOptions {
  /**
   * Root directory for this fixture's home and workspace. Omitted ⇒ a fresh
   * `mkdtemp` under the OS temp directory, removed by `stop()`. Pass one when
   * the caller has its own temp-tree bookkeeping (this repo's suites do).
   */
  readonly root?: string;
  /** Bearer token the daemon accepts. Omitted ⇒ a generated per-fixture token. */
  readonly token?: string;
  /** Last-chance hook to write config before the runtime graph is built. */
  readonly configure?: (configManager: ConfigManager) => void;
  /**
   * Feature flag ids to force on, replacing the default daemon capability set.
   * Rarely needed; stated so a caller testing a flag's OFF behaviour can.
   */
  readonly featureFlagIds?: readonly string[];
  /**
   * Whether this daemon hosts sessions of its own, the way the real entrypoint
   * states it (`src/daemon/cli.ts` passes `createHostedSessionOptions`).
   * Defaults to true: `sessions.hosted.*` is handler-less without it, and a
   * client with no terminal of its own has no other way to start a run.
   */
  readonly hostSessions?: boolean;
  /**
   * A mailbox address to watch. Omitted ⇒ none, and the inbound-mail
   * composition honestly registers no `email.expectation.*` /
   * `email.inbound.status` handler, exactly as it does on a daemon nobody has
   * configured a mailbox for. Pass one to exercise the provisioned shape.
   * Nothing connects: the composition reads the account name, and no source
   * starts until the supervisor does.
   */
  readonly watchedMailbox?: string;
}

export interface DaemonFixture {
  /** The composed runtime graph — the same object `DaemonServer` was handed. */
  readonly services: RuntimeServices;
  /** The running server. */
  readonly daemon: DaemonServer;
  /** `http://127.0.0.1:<bound port>`, valid after `start()` returned. */
  readonly baseUrl: string;
  /** The bearer token this daemon accepts. */
  readonly token: string;
  readonly homeDirectory: string;
  readonly workingDirectory: string;
  /** Fetch a path on this daemon with the bearer token attached. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /**
   * Fetch a path with NO credential. A route that exists answers 401; a path
   * nothing serves answers 404 — which is what makes this the side-effect-free
   * way to ask whether a route exists, even for a write verb.
   */
  fetchAnonymous(path: string, init?: RequestInit): Promise<Response>;
  /** Invoke a gateway verb in-process, the way the control plane dispatches it. */
  invoke<T = unknown>(methodId: string, body?: Record<string, unknown>): Promise<T>;
  /** Stop the server, dispose the graph, and remove a temp root this created. */
  stop(): Promise<void>;
}

/**
 * Compose and start a daemon. Always `await fixture.stop()` — the runtime graph
 * starts pollers while it builds, and abandoning it leaves every one of them
 * firing for the rest of the process.
 */
export async function startDaemonFixture(options: DaemonFixtureOptions = {}): Promise<DaemonFixture> {
  const ownsRoot = options.root === undefined;
  const root = options.root ?? mkdtempSync(join(tmpdir(), 'goodvibes-daemon-fixture-'));
  const workingDirectory = join(root, 'workspace');
  const homeDirectory = join(root, 'home');
  const configDir = join(homeDirectory, '.goodvibes', 'daemon');
  mkdirSync(workingDirectory, { recursive: true });
  mkdirSync(configDir, { recursive: true });

  const token = options.token ?? `daemon-fixture-${Math.random().toString(36).slice(2)}`;

  const configManager = new ConfigManager({
    surfaceRoot: 'tui',
    configDir,
    workingDir: workingDirectory,
    homeDir: homeDirectory,
  });
  if (options.watchedMailbox !== undefined) {
    configManager.set('surfaces.email.inbound.accounts', JSON.stringify([options.watchedMailbox]));
  }
  options.configure?.(configManager);

  const featureFlags = createFeatureFlagManager();
  const flags = deriveFeatureStates(configManager);
  for (const id of options.featureFlagIds ?? DAEMON_CAPABILITY_FLAGS) flags[id] = 'enabled';
  featureFlags.loadFromConfig({ flags });

  const services = createRuntimeServices({
    runtimeStore: createRuntimeStore(),
    runtimeBus: new RuntimeEventBus(),
    configManager,
    workingDir: workingDirectory,
    homeDirectory,
    featureFlags,
    getConversationTitle: () => 'daemon fixture',
  });

  // Ephemeral port: two concurrent test processes must never collide, and
  // injecting a serveFactory also makes DaemonServer skip its pre-bind OS port
  // probe (the facade only probes when serveFactory === Bun.serve).
  let boundPort = 0;
  const capturingServe = ((serveOptions) => {
    const server = Bun.serve(serveOptions);
    if (server.port !== undefined) boundPort = server.port;
    return server;
  }) as typeof Bun.serve;

  const daemon = new DaemonServer({
    port: 0,
    host: '127.0.0.1',
    userAuth: new UserAuthManager({
      bootstrapFilePath: join(homeDirectory, 'auth-users.json'),
      bootstrapCredentialPath: join(homeDirectory, 'auth-bootstrap.txt'),
      users: [{ username: 'admin', passwordHash: UserAuthManager.hashPassword('admin'), roles: ['admin'] }],
    }),
    runtimeServices: services,
    serveFactory: capturingServe,
    // What the real entrypoint states, for the same reason it states it: the
    // hosted-session verbs are registered by this composition and by nothing
    // else, so a fixture that leaves it out is a daemon a client cannot start a
    // session on — and every contract test written against it would agree.
    ...(options.hostSessions === false ? {} : { hostedSessions: createHostedSessionOptions(services) }),
  });

  daemon.enable({ daemon: true }, token);
  await daemon.start();
  if (!daemon.isRunning) {
    services.dispose();
    if (ownsRoot) rmSync(root, { recursive: true, force: true });
    throw new Error('daemon fixture: the server refused to start');
  }

  const baseUrl = `http://127.0.0.1:${boundPort}`;

  return {
    services,
    daemon,
    baseUrl,
    token,
    homeDirectory,
    workingDirectory,
    fetch(path, init) {
      const headers = new Headers(init?.headers);
      headers.set('Authorization', `Bearer ${token}`);
      if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
      return fetch(`${baseUrl}${path}`, { ...init, headers });
    },
    fetchAnonymous(path, init) {
      return fetch(`${baseUrl}${path}`, init);
    },
    invoke<T>(methodId: string, body: Record<string, unknown> = {}): Promise<T> {
      return services.gatewayMethods.invoke(methodId, { methodId, body } as never) as Promise<T>;
    },
    async stop(): Promise<void> {
      await daemon.stop();
      services.dispose();
      if (ownsRoot) rmSync(root, { recursive: true, force: true });
    },
  };
}
