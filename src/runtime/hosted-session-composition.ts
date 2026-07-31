/**
 * hosted-session-composition.ts — what this daemon states so it may host
 * conversation loops.
 *
 * The engine is the SDK's (`@pellux/goodvibes-sdk/platform/hosted-sessions`):
 * lifecycle, the detach policy, the bounded disk state, the verbs, the
 * lifecycle channel. It is off until a product says how a workspace FLOOR is
 * built, and that is deliberate — the floor's `requestApproval` seam is where a
 * product's trust posture lives, and no default can stand in for a decision
 * about who may write files and run commands in a directory a client named over
 * the wire.
 *
 * This daemon's answer is the gate it already had. Phase A put the workspace
 * trust question in front of every ask a hosted run makes (trust/trust-gated-
 * approvals.ts): an undecided workspace raises the question as an ordinary
 * approval record for whichever surface is attached to answer, a trusted one is
 * exactly as permissive as before, and a restricted one refuses non-read
 * categories without asking. What this file adds is PER-WORKSPACE scope: the
 * daemon's own gate reads `<its cwd>/.goodvibes/<surface>/trust.json`, and a
 * session hosted in another directory has to be gated by that directory's
 * decision, not by the daemon's.
 *
 * Everything else in a floor comes from `createClientRuntimeServices` — the
 * same composition a terminal runs — so a hosted turn's tools, hooks, plugins
 * and model stack are the ones the platform already has, not a second set.
 */
import { createShellPathService } from '@/runtime/index.ts';
import { createClientRuntimeServices } from '@pellux/goodvibes-sdk/platform/runtime/client-services';
import { createRuntimeStore } from '@pellux/goodvibes-sdk/platform/runtime/store';
import { createLaunchTolerantProviderRegistry } from '@pellux/goodvibes-sdk/platform/providers';
import type { DaemonHostedSessionsOptions } from '@pellux/goodvibes-sdk/platform/daemon';
import type { HostedWorkspaceFloor } from '@pellux/goodvibes-sdk/platform/hosted-sessions';
import { operations } from '@pellux/goodvibes-sdk/platform/runtime';
const { WorkspaceTrustManager } = operations;
import { createWorkspaceTrustDecisionAsk, trustGatedApprovalRaiser, type ApprovalRaise } from './trust/trust-gated-approvals.ts';
import { GOODVIBES_DAEMON_SURFACE_ROOT } from '../config/surface.ts';
import type { RuntimeServices } from './runtime-services-types.ts';

/** The operator policy a session hosted by THIS daemon runs under. */
function hostedSystemPrompt(input: { readonly workspaceRoot: string }): string {
  return [
    'You are a GoodVibes session hosted by the daemon rather than by a terminal.',
    `Your working directory is ${input.workspaceRoot}.`,
    'Someone may be attached and watching this turn, or may have detached and read it later —',
    'write for both. Say what you did and why; never report work you did not do.',
    'Tool permissions are decided by whoever is attached: an ask you raise may take a while to be',
    'answered, and an unanswered one is a refusal, not a reason to find another way round.',
  ].join(' ');
}

/**
 * Build the hosted-session options this daemon passes to `DaemonServer`.
 *
 * `services` is the daemon's own graph: its config manager, event bus, secrets
 * home and approval broker are shared with every floor, so a hosted session
 * reads the same settings, publishes on the same bus and raises asks into the
 * same broker every other surface is watching.
 */
export function createHostedSessionOptions(services: RuntimeServices): DaemonHostedSessionsOptions {
  /**
   * One trust manager per workspace, cached: `load()` is idempotent but a
   * manager per floor keeps the decision file and the in-memory answer for a
   * workspace in one place, so two sessions in one directory cannot end up
   * having been asked the trust question twice.
   */
  const trustByWorkspace = new Map<string, operations.WorkspaceTrustManager>();

  const gateFor = (workspaceRoot: string): ApprovalRaise => {
    const shellPaths = createShellPathService({
      workingDirectory: workspaceRoot,
      homeDirectory: services.homeDirectory,
    });
    let trust = trustByWorkspace.get(workspaceRoot);
    if (!trust) {
      trust = new WorkspaceTrustManager({ shellPaths, surfaceRoot: GOODVIBES_DAEMON_SURFACE_ROOT });
      trustByWorkspace.set(workspaceRoot, trust);
    }
    const raise: ApprovalRaise = (input) => services.approvalBroker.requestApproval(input);
    return trustGatedApprovalRaiser(
      trust,
      raise,
      // The question names the workspace it is about, which is the whole point
      // of scoping it here: a daemon hosting three sessions in three
      // directories asks three separate questions, each answerable on its own.
      createWorkspaceTrustDecisionAsk({ requestApproval: raise, workingDirectory: workspaceRoot }),
    );
  };

  return {
    floorFactory: ({ workspaceRoot }): HostedWorkspaceFloor => {
      const floor = createClientRuntimeServices({
        configManager: services.configManager,
        // The daemon's own bus: a hosted turn's stream events reach the
        // control-plane SSE subscribers through the same path every other
        // runtime event takes, stamped with the hosted session's id.
        runtimeBus: services.runtimeBus,
        // A store of its own. The daemon's runtime store describes the daemon's
        // single local runtime, and a hosted session is not that runtime.
        runtimeStore: createRuntimeStore(),
        featureFlags: services.featureFlags,
        surfaceRoot: GOODVIBES_DAEMON_SURFACE_ROOT,
        workingDir: workspaceRoot,
        homeDirectory: services.homeDirectory,
        requestApproval: gateFor(workspaceRoot),
        // A workspace with broken or absent provider credentials must degrade,
        // not take the daemon down on a create call.
        providerRegistryFactory: createLaunchTolerantProviderRegistry,
      });
      // The machine's own local models. The daemon's registry learned them at
      // boot (the persisted discovery cache) and from the LAN scan; a floor
      // builds its own registry and would otherwise be the only place on this
      // box where they are not routable. Servers found by a scan that finishes
      // AFTER a floor is built reach the next floor, not this one — stated
      // rather than hidden, because a wrong claim here would look like a model
      // that exists everywhere except in hosted sessions.
      const discovered = services.providerRegistry.listDiscoveredServers();
      if (discovered.length > 0) floor.providerRegistry.registerDiscoveredProviders([...discovered]);
      return {
        services: floor,
        // The daemon has a real review-chain controller; a hosted session's
        // orchestrator lists through it rather than reporting none.
        wrfcController: services.wrfcController,
        dispose: (): void => floor.dispose(),
      };
    },
    systemPrompt: hostedSystemPrompt,
  };
}
