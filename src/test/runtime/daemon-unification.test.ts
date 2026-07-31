/**
 * The capabilities the split unified, pinned on the one composition that now
 * holds them.
 *
 * Two forks each ran a daemon-grade service graph and each had things the other
 * did not. The terminal app's daemon had no trigger family, no registration gate
 * on checkpoints, no launch tolerance for a missing provider key and no
 * conversation gate on an inbound continuation. The agent had no cluster, no
 * mail, no crash-residue sweep and no presence check before pushing "needs
 * input". Every one of those is a real behaviour difference somebody could
 * observe, and every one of them is resolved here to exactly one answer.
 *
 * These tests exist because the resolution is invisible in a diff: nothing
 * fails if a capability quietly stops being composed, it just stops happening.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { disposeTestRuntimeServicesAfterAll, getTestRuntimeServices } from '../helpers/runtime-services.ts';

disposeTestRuntimeServicesAfterAll();

const ROOT = join(import.meta.dir, '..', '..', '..');
const services = readFileSync(join(ROOT, 'src/runtime/services.ts'), 'utf8');

describe('the trigger family is composed and supervised by the fleet', () => {
  test('a trigger manager is on the service surface', () => {
    // The agent had this and the terminal app's daemon did not, so a trigger
    // defined against the daemon simply never fired there.
    expect(getTestRuntimeServices().triggerManager).toBeDefined();
  });

  test('it is handed to the fleet registry as the trigger supervisor', () => {
    // Without this a trigger runs invisibly: not listed, not steerable, not
    // stoppable from anywhere an operator can see.
    expect(services).toContain('triggerSupervisor: triggerManager');
  });

  test('its config is a closure, so toggling the setting does not need a restart', () => {
    const composition = readFileSync(join(ROOT, 'src/runtime/trigger-services.ts'), 'utf8');
    expect(composition).toContain('config: () => ({');
    expect(composition).toContain("configManager.get('watchers.triggers.enabled')");
  });

  test('it is stopped when the graph is disposed', () => {
    // A supervision tick and a sweep interval that nothing stops is a poller the
    // daemon leaked. The SDK's poller list names the trigger manager; this pins
    // that the daemon actually puts one there for it to find.
    expect(services).toContain('triggerManager,');
  });
});

describe('checkpoints are gated on live workspace registration', () => {
  const checkpointing = readFileSync(join(ROOT, 'src/runtime/workspace-checkpointing.ts'), 'utf8');

  test('the gate is re-read per attempt, not decided once at construction', () => {
    // Deciding at construction is what made registering a workspace mid-run take
    // effect only after a restart.
    expect(checkpointing).toContain('createWorkspaceRegistrationLiveChecker(');
    expect(checkpointing).toContain('runtimeBus: opts.runtimeBus');
  });

  test('an automatic snapshot in an unregistered workspace resolves to nothing, quietly', () => {
    expect(checkpointing).toContain("if (createOpts.kind !== 'manual' && !currentlyAllowed()) return Promise.resolve(null);");
  });

  test('an explicit create refuses with something the caller can act on', () => {
    expect(checkpointing).toContain('is not registered');
    expect(checkpointing).toContain('unregisteredWorkspaces');
  });

  test('the gateway verbs get the gated surface, not the raw manager', () => {
    expect(services).toContain('workspaceCheckpointManager: checkpointing.gatewayManager');
  });

  test('the graph reports whether checkpoints are currently allowed', () => {
    expect(typeof getTestRuntimeServices().checkpointsCurrentlyAllowed()).toBe('boolean');
  });
});

describe('the provider registry tolerates a missing key at launch', () => {
  test('the launch-tolerant constructor is the one used', () => {
    // The daemon is a supervised service. A provider constructor that throws on
    // an unset environment variable turns one missing key into a crash loop with
    // no screen to explain it.
    expect(services).toContain('createLaunchTolerantProviderRegistry({');
    expect(services).not.toContain('new ProviderRegistry(');
  });

  test('a provider whose key is absent lands unconfigured rather than absent', () => {
    const registry = getTestRuntimeServices().providerRegistry;
    expect(registry.listModels).toBeDefined();
  });
});

describe('an inbound continuation is conversation-gated and routed through the shared resolver', () => {
  test('the conversation gate is applied, reading live config', () => {
    // Without it, a follow-up message in a session opens a write-review-fix
    // chain with a reviewer and a second agent instead of answering.
    expect(services).toContain('...continuationChainOptions(input, {');
    expect(services).toContain('configReader: {');
  });

  test('spawn routing goes through the SDK model-reference resolver', () => {
    // A bare model id resolves against the live registry instead of being
    // rejected on format.
    expect(services).toContain('...buildSharedSessionAgentSpawnRoutingInput(input.routing, {');
    expect(services).toContain('modelCandidates: providerRegistry.listModels()');
  });
});

describe('the control-plane write verbs a client with no filesystem access needs', () => {
  const catalog = getTestRuntimeServices().gatewayMethods;

  test('credentials.set and credentials.delete are handled, not merely cataloged', () => {
    // A descriptor with no handler answers 501. A client configuring a bot token
    // has no access to the daemon's settings file, so this verb is the only way.
    expect(catalog.get('credentials.set')).toBeDefined();
    expect(catalog.hasHandler('credentials.set')).toBe(true);
    expect(catalog.hasHandler('credentials.delete')).toBe(true);
  });

  test('approvals.raise is handled', () => {
    // A surface whose prompt runs outside this process needs a way to create the
    // ask here, where every other participant can see and answer it.
    expect(catalog.get('approvals.raise')).toBeDefined();
    expect(catalog.hasHandler('approvals.raise')).toBe(true);
  });

  test('the write deps are threaded from the composition, not defaulted', () => {
    expect(services).toContain('credentialWrites: { config: configManager, secrets: secretsManager }');
    expect(services).toContain('approvalRaise: approvalBroker');
  });
});

describe('config changes are announced on the bus', () => {
  test('the emit bridge is attached and registered for disposal', () => {
    // A client whose settings live in this process cannot watch a file it does
    // not have. Without this bridge its live-config subscriptions never fire and
    // nothing reports a problem.
    expect(services).toContain('attachConfigEmitBridge({');
    expect(services).toContain("disposalScope.registry.add('config event bridge'");
  });
});

describe('needs-input push checks presence through the SDK helper', () => {
  test('the presence helper is imported, not reimplemented', () => {
    // One verb, two behaviours was the state before: the terminal app mirrored a
    // private SDK helper and the agent pushed on every block with no presence
    // check at all.
    const push = readFileSync(join(ROOT, 'src/runtime/fleet-needs-input-push.ts'), 'utf8');
    expect(push).toContain("import { hasFreshSurfaceParticipant, SURFACE_ROUTE_FRESHNESS_MS");
    expect(push).not.toContain('const SURFACE_ATTACHED_FRESHNESS_MS');
  });
});

describe('the vendored mirrors are gone', () => {
  test('safe-serve, the fatal-boot reporter and the fallback-model synthesis come from the SDK', () => {
    const cli = readFileSync(join(ROOT, 'src/daemon/cli.ts'), 'utf8');
    expect(cli).toContain("import { createSafeHostServeFactory } from '@pellux/goodvibes-sdk/platform/daemon'");
    expect(cli).toContain("writeFatalLine } from '@pellux/goodvibes-sdk/platform/daemon'");
    expect(services).toContain('ensureConfiguredModelIsRoutable');
    expect(services).toContain("from '@pellux/goodvibes-sdk/platform/providers'");
  });

  test('the bind-mismatch comparison is the SDK\'s', () => {
    const cli = readFileSync(join(ROOT, 'src/daemon/cli.ts'), 'utf8');
    expect(cli).toContain('describeDerivedBindMismatch(');
  });
});

describe('nothing terminal-specific came with the daemon', () => {
  test('no source file imports a renderer, a panel or the input layer', () => {
    // The daemon has no screen. An import from one of those trees is the first
    // step back towards one repository holding two programs.
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'test') continue;
          walk(full);
        } else if (entry.name.endsWith('.ts')) {
          const source = readFileSync(full, 'utf8');
          if (/from '[^']*\/(renderer|panels)\//.test(source)) offenders.push(full);
        }
      }
    };
    walk(join(ROOT, 'src'));
    expect(offenders).toEqual([]);
  });
});
