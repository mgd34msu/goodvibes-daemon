/**
 * Composition gate — pins the wiring facts the daemon's composition root must
 * keep in step with the SDK's own.
 *
 * These are source-level assertions on purpose: the wiring differences they
 * pin (observed foreign-agent detection, the startup retention sweep, live
 * config-file watching) are either host-nondeterministic to exercise
 * (observed detection scans the real process table / tmux) or lifecycle
 * side-effects with no return value to inspect, so a source pin is the honest,
 * deterministic way to catch a fork that silently drops one of them.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../../..');
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');

/** The argument object literal passed to the first createRuntimeServices call in a file. */
function createRuntimeServicesCallArgs(source: string): string {
  const idx = source.indexOf('createRuntimeServices({');
  expect(idx, 'createRuntimeServices({ ... }) call not found').toBeGreaterThan(-1);
  // Walk from the opening brace to its matching close so we inspect only this
  // call's options, not the rest of the file.
  const open = source.indexOf('{', idx);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error('unbalanced createRuntimeServices call braces');
}

describe('composition parity — observed foreign-agent detection is daemon-side only', () => {
  test('the standalone daemon composes observed agents (observeExternalAgents: true)', () => {
    const args = createRuntimeServicesCallArgs(read('src/daemon/cli.ts'));
    expect(args).toContain('observeExternalAgents: true');
  });

  test('there is exactly one composition root, and one entrypoint that opts in', () => {
    // Observed detection scans the real process table. Two processes doing it on
    // one machine is double-detection, which is why it is an opt-in the daemon
    // entrypoint alone takes — and why this repository must never grow a second
    // caller of it.
    const services = read('src/runtime/services.ts');
    expect(services).toContain('export function createRuntimeServices(');
    expect(read('src/daemon/cli.ts')).toContain('observeExternalAgents: true');
  });

  test('createRuntimeServices threads the daemon opt-in into the fleet services helper', () => {
    const services = read('src/runtime/services.ts');
    expect(services).toContain('observeExternalAgents: options.observeExternalAgents');
  });

  test('the fleet services helper constructs the observed source only under the opt-in flag', () => {
    const helper = read('src/runtime/fleet-services.ts');
    // Constructed only when opted in (never unconditionally)...
    expect(helper).toMatch(/observeExternalAgents\s*\?\s*new ObservedAgentSource\(\)\s*:\s*undefined/);
    // ...and threaded into the shared registry as the observedAgents dep.
    expect(helper).toContain('observedAgents,');
  });
});

describe('composition parity — retention janitor and live config apply run on TUI-composed runtimes', () => {
  const durability = read('src/runtime/durability-services.ts');

  test('the startup append-only sweep runs with the FULL roots set', () => {
    expect(durability).toContain('runStartupAppendOnlySweep');
    // Every root the SDK passes must be present — omitting any silently skips
    // that store class on every sweep.
    for (const root of ['workingDirectory', 'surfaceRoot', 'homeDirectory', 'logDir', 'telemetryDir']) {
      expect(durability, `sweep root ${root} missing`).toContain(`${root}:`);
    }
  });

  test('live config-file watching is composed (external edits apply without a restart)', () => {
    expect(durability).toContain('configManager.watchConfigFiles()');
  });

  test('services.ts feeds the durability helper the sweep roots', () => {
    const services = read('src/runtime/services.ts');
    expect(services).toContain('surfaceRoot:');
    expect(services).toContain('shellPaths,');
  });
});

describe('composition parity — keep-awake config live-apply is wired', () => {
  test('the power manager is wired with subscribeConfig so a config write applies live', () => {
    const idlePower = read('src/runtime/idle-power-services.ts');
    expect(idlePower).toContain('subscribeConfig:');
    expect(idlePower).toContain('configManager.subscribe');
  });
});

describe('composition parity — memory governance is composed (governor default ON, real caches, pausable jobs)', () => {
  const services = read('src/runtime/services.ts');

  test('the CacheRegistry, PauseController and the deferrable job ids are built EARLY (before the schedulers that consult them)', () => {
    expect(services).toContain('new CacheRegistry()');
    expect(services).toContain('new PauseController()');
    expect(services).toContain("MEMORY_BACKGROUND_JOB_IDS = ['knowledge-self-improvement', 'memory-consolidation', 'code-index-reindex']");
    // The seams are built before the knowledge services (which consult them via the passed-in gate).
    expect(services.indexOf('new CacheRegistry()')).toBeLessThan(services.indexOf('createKnowledgeServices('));
  });

  test('createRuntimeServices constructs + starts the governor through the SDK path and late-binds the admission gate', () => {
    // The SDK's wiring, called directly. The terminal app wrapped it in a local
    // helper the agent did not have, so one process's footprint defence was a
    // fork's copy of the other's.
    expect(services).toContain('wireDaemonMemoryGovernance({');
    expect(services).toContain('admitExpensiveWorkRef.current = (label) => memoryGovernor.admitExpensiveWork(label)');
  });

  test('the governor is threaded into the gateway verb handlers so ops.memory.get is invokable (not a 501)', () => {
    // memoryGovernor lands in the attachWsOnlyGatewayVerbHandlers deps object.
    const attachIdx = services.indexOf('attachWsOnlyGatewayVerbHandlers(gatewayMethods,');
    expect(attachIdx).toBeGreaterThan(-1);
    expect(services.slice(attachIdx)).toContain('memoryGovernor,');
  });

  test('the three deferrable jobs honor governor backpressure at their scheduler gates', () => {
    // code-index reindex (threaded into createCodeIndexServices)...
    expect(services).toContain("isReindexPaused: () => pauseController.isPaused('code-index-reindex')");
    // memory consolidation (ANDed into the idle gate)...
    expect(services).toContain("!pauseController.isPaused('memory-consolidation')");
    // knowledge self-improvement (isBackgroundPaused on the semantic services).
    expect(services).toContain('isBackgroundPaused: isKnowledgeBackgroundPaused');
  });

  test('the governor gets the REAL cache adapters and starts by default (never start:false)', () => {
    // Caches with no reachable real adapter are not registered at all: a no-op
    // registration would make the shed tiers theatre.
    expect(services).toContain('knowledgeStores: [knowledgeStore, agentKnowledgeStore, homeGraphKnowledgeStore]');
    const wireIdx = services.indexOf('wireDaemonMemoryGovernance({');
    expect(services.slice(wireIdx)).toContain('sessionBroker,');
    expect(services).not.toContain('start: false');
  });

  test('managed voice provisioning is composed so voice.local.status/install are invokable', () => {
    expect(services).toContain('wireVoiceSetup({');
    const helper = read('src/runtime/voice-setup-services.ts');
    // The composer is now the SDK's exported createVoiceSetupService (SDK 1.10.1
    // added ./platform/runtime/voice-setup); the fork's wiring delegates to it.
    expect(helper).toContain('createVoiceSetupService({');
    const attachIdx = services.indexOf('attachWsOnlyGatewayVerbHandlers(gatewayMethods,');
    expect(services.slice(attachIdx)).toContain('voiceSetup,');
  });

  test('the daemon serves LIVE install progress: the fork consumes the SDK composer that carries it', () => {
    // The single-flight install, the progress tracker folded onto status(), the
    // ownership-aware preconfigure and the admission gate all live in the SDK's
    // createVoiceSetupService now — the fork consumes it through the exported
    // subpath rather than rebuilding it from the voice primitives.
    const helper = read('src/runtime/voice-setup-services.ts');
    expect(helper).toContain("from '@pellux/goodvibes-sdk/platform/runtime/voice-setup'");
    expect(helper).toContain('createVoiceSetupService');
  });
});

describe('composition parity — host power seam is opt-in (non-spawning default)', () => {
  // SDK 1.9.0's wireRuntimePower defaults an ABSENT seam to the real host seam
  // (createHostPowerSeam — spawns systemd-inhibit + a dbus-monitor sleep-edge
  // watcher). That host-level spawn must never fire on a test-constructed
  // runtime, so the fork mirrors the SDK's own createRuntimeServices: default to
  // the non-spawning unavailable seam, and only the real long-lived compositions
  // opt in. These source pins catch a fork that regresses either half.

  test('the idle-power helper defaults to the NON-spawning unavailable seam when no seam is passed', () => {
    const idlePower = read('src/runtime/idle-power-services.ts');
    // The seam falls back to createUnavailablePowerSeam(...) rather than passing
    // undefined through to wireRuntimePower (which would spawn the host seam).
    expect(idlePower).toMatch(/seam:\s*deps\.powerSeam\s*\?\?\s*createUnavailablePowerSeam\(/);
    expect(idlePower).toContain("import { PowerManager, wireRuntimePower, createUnavailablePowerSeam }");
  });

  test('createRuntimeServices threads the power-seam opt-in into the idle-power helper', () => {
    const services = read('src/runtime/services.ts');
    expect(services).toContain('powerSeam: options.powerSeam');
  });

  test('the standalone daemon opts into the real host power seam (live keep-awake/idle-inhibit)', () => {
    const args = createRuntimeServicesCallArgs(read('src/daemon/cli.ts'));
    expect(args).toContain('powerSeam: createHostPowerSeam()');
  });

});

describe('composition parity — wake-model boot provisioning is opt-in, like the power seam', () => {
  // The wake-word model arrives with the installation, and the daemon retries at
  // boot for whatever the install could not get. That retry does network I/O and
  // starts an hourly recovery sweep, so it must be an explicit opt-in — the same
  // treatment the host power seam gets, for the same reason: a test composing this
  // graph, and a one-shot CLI command, must fetch nothing and start no timer.
  test('the standalone daemon opts in', () => {
    expect(createRuntimeServicesCallArgs(read('src/daemon/cli.ts'))).toContain('provisionWakeModelsAtBoot: true');
  });

  test('the one-shot subcommands compose no runtime at all', () => {
    // `send`, `cluster` and `provision-wake-model` answer one thing and exit.
    // They are intercepted before the runtime is composed, so there is nothing
    // to opt in or out of: no hourly sweep, no download, and — the reason it
    // matters most — no second copy of the pollers, the leader election and the
    // LAN scan a running daemon on this machine already owns.
    const cli = read('src/daemon/cli.ts');
    const composeIndex = cli.indexOf('createRuntimeServices({');
    for (const subcommand of ['cluster', 'send', 'provision-wake-model']) {
      const interceptIndex = cli.indexOf(`if (rawArgs[0] === '${subcommand}') {`);
      expect(interceptIndex, `${subcommand} is not intercepted`).toBeGreaterThan(0);
      expect(interceptIndex).toBeLessThan(composeIndex);
    }
    expect(read('src/daemon/send/composition.ts')).not.toContain('createRuntimeServices(');
    expect(read('src/daemon/provision-wake-model.ts')).not.toContain('createRuntimeServices(');
  });

  test('the sweep and the pending attempt are on the disposal list, opted in or not', () => {
    // An hourly timer nothing stops is a poller this surface leaked. It is
    // registered unconditionally, because "the graph did not start it this time"
    // is not a reason for teardown to have no way to stop it.
    const disposal = read('src/runtime/disposal-wiring.ts');
    expect(disposal).toContain("registry.add('wake-word housekeeping', services.stopWakeHousekeeping)");
    expect(read('src/runtime/services.ts')).toContain('stopWakeHousekeeping');
  });

  test('the boot attempt joins the setup service single flight and names the terminal recovery command', () => {
    const helper = read('src/runtime/voice-setup-services.ts');
    // Through the service, not the provisioner directly: a boot attempt racing a
    // user typing /voice wake setup would otherwise be two downloads of the same
    // 6 MB. And the SDK would name the control-plane verb, which is right
    // everywhere and useless to someone sitting in a terminal.
    expect(helper).toContain('voiceSetup.wakeEnsureProvisioned({ recoveryHint: WAKE_RECOVERY_COMMAND })');
    expect(helper).toContain("export const WAKE_RECOVERY_COMMAND = '/voice wake setup'");
  });
});
