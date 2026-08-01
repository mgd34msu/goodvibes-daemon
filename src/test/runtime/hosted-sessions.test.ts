/**
 * Daemon-hosted sessions — this is the process that hosts them.
 *
 * The engine is the SDK's and has its own unit suites there. What this daemon
 * owns — and what these tests are the oracle for — is the composition: that the
 * verbs are actually invokable on this daemon's catalog, that a hosted session's
 * asks are gated by the trust decision of the SESSION's workspace rather than
 * the daemon's own directory, that the detach toggle reads this daemon's
 * setting, and that a restart reconciles from disk instead of losing sessions.
 *
 * Turn execution is not re-tested here; the SDK proves that against a stub
 * provider. What is proved here is that a turn CAN be driven — the live-turn
 * controls for a hosted session are bound where `sessions.toolCalls.cancel`
 * looks for them, which is the wiring that goes missing silently.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GatewayMethodCatalog } from '@pellux/goodvibes-sdk/platform/control-plane';
import { SessionLiveTurnControlsHolder, createSessionRuntimeControls } from '@pellux/goodvibes-sdk/platform/control-plane';
import { composeHostedSessions } from '@pellux/goodvibes-sdk/platform/daemon';
import type { HostedSessionManager } from '@pellux/goodvibes-sdk/platform/hosted-sessions';
import type { PermissionPromptRequest } from '@pellux/goodvibes-sdk/platform/permissions';
import { createShellPathService } from '@/runtime/index.ts';
import { createHostedSessionOptions } from '../../runtime/hosted-session-composition.ts';
import { GOODVIBES_DAEMON_SURFACE_ROOT } from '../../config/surface.ts';
import { disposeTestRuntimeServicesAfterAll, getTestRuntimeServices } from '../helpers/runtime-services.ts';

disposeTestRuntimeServicesAfterAll();

let root: string;
let workspaceA: string;
let workspaceB: string;
let stateDir: string;
let published: { event: string; payload: unknown }[];
let liveTurns: SessionLiveTurnControlsHolder;
let managers: HostedSessionManager[];

/** A write-category ask — the kind an undecided workspace gates. */
function writeRequest(callId = 'call-1'): PermissionPromptRequest {
  return {
    callId,
    tool: 'edit',
    args: { path: 'src/main.ts' },
    category: 'write',
    analysis: {
      classification: 'file-write',
      riskLevel: 'medium',
      summary: 'Edit src/main.ts',
      reasons: ['A hosted run wants to edit a file.'],
    },
  };
}

function build(options?: { readonly detachPolicy?: 'kill' | 'survive' }): {
  manager: HostedSessionManager;
  catalog: GatewayMethodCatalog;
} {
  const services = getTestRuntimeServices();
  if (options?.detachPolicy) {
    services.configManager.set('hostedSessions.detachPolicy', options.detachPolicy);
  }
  const catalog = new GatewayMethodCatalog();
  const manager = composeHostedSessions({
    options: createHostedSessionOptions(services),
    configManager: services.configManager,
    runtimeBus: services.runtimeBus,
    shellPaths: createShellPathService({ workingDirectory: root, homeDirectory: root }),
    gatewayMethods: catalog,
    liveTurns,
    eventPublisher: { publishEvent: (event, payload) => { published.push({ event, payload }); } },
  });
  managers.push(manager);
  return { manager, catalog };
}

/** Invoke a verb the way the control plane does: params in the body. */
async function invoke(catalog: GatewayMethodCatalog, id: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await catalog.invoke(id, { methodId: id, body, context: {} } as never);
  return result as Record<string, unknown>;
}

beforeEach(() => {
  root = join(tmpdir(), `gv-hosted-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  workspaceA = join(root, 'workspace-a');
  workspaceB = join(root, 'workspace-b');
  stateDir = join(root, '.goodvibes', 'hosted-sessions');
  mkdirSync(workspaceA, { recursive: true });
  mkdirSync(workspaceB, { recursive: true });
  published = [];
  liveTurns = new SessionLiveTurnControlsHolder();
  managers = [];
});

afterEach(async () => {
  for (const manager of managers.splice(0)) {
    await manager.dispose().catch(() => undefined);
  }
  rmSync(root, { recursive: true, force: true });
});

describe('the composition states a trust posture, and it is the session\'s workspace', () => {
  it('gates a hosted run\'s ask on the SESSION\'s workspace, not the daemon\'s directory', async () => {
    const services = getTestRuntimeServices();
    const answers: PermissionPromptRequest[] = [];
    // Answer the trust question "trusted" and let the tool ask through, so the
    // decision is actually persisted where it should be.
    const original = services.approvalBroker.requestApproval.bind(services.approvalBroker);
    (services.approvalBroker as { requestApproval: unknown }).requestApproval = async (
      input: { request: PermissionPromptRequest },
    ) => {
      answers.push(input.request);
      return { approved: true };
    };
    try {
      const options = createHostedSessionOptions(services);
      const floor = await options.floorFactory({ workspaceRoot: workspaceA });
      const decision = await floor.services.requestApproval({ request: writeRequest() });
      expect(decision.approved).toBe(true);
      // The question that was asked names THIS workspace.
      const trustAsk = answers.find((request) => request.tool === 'workspace-trust');
      expect(trustAsk?.args).toEqual({ workspace: workspaceA });
      // And the answer landed under this workspace, not under the daemon's cwd.
      const trustFile = join(workspaceA, '.goodvibes', GOODVIBES_DAEMON_SURFACE_ROOT, 'trust.json');
      expect(existsSync(trustFile)).toBe(true);
      expect(JSON.parse(readFileSync(trustFile, 'utf-8')).level).toBe('trusted');
      floor.dispose();
    } finally {
      (services.approvalBroker as { requestApproval: unknown }).requestApproval = original;
    }
  });

  it('composes the floor rooted at the session\'s workspace', async () => {
    const services = getTestRuntimeServices();
    const options = createHostedSessionOptions(services);
    const floor = await options.floorFactory({ workspaceRoot: workspaceB });
    expect(floor.services.workingDirectory).toBe(workspaceB);
    expect(floor.services.surfaceRoot).toBe(GOODVIBES_DAEMON_SURFACE_ROOT);
    // The daemon has a real review-chain controller and hands it over rather
    // than letting the session report none.
    expect(floor.wrfcController).toBeDefined();
    floor.dispose();
  });

  it('states an operator policy naming the workspace the session runs in', () => {
    const options = createHostedSessionOptions(getTestRuntimeServices());
    const prompt = options.systemPrompt?.({ sessionId: 'hosted-x', workspaceRoot: workspaceA }) ?? '';
    expect(prompt).toContain(workspaceA);
    expect(prompt).toContain('hosted by the daemon');
  });
});

describe('the verbs are invokable on this daemon\'s catalog', () => {
  it('creates, lists, attaches and kills over the wire shape', async () => {
    const { catalog } = build({ detachPolicy: 'survive' });

    const created = await invoke(catalog, 'sessions.hosted.create', {
      workspaceRoot: workspaceA,
      clientId: 'terminal-1',
      title: 'a hosted session',
    });
    const session = created['session'] as { id: string; status: string; effectiveDetachPolicy: string };
    expect(session.status).toBe('idle');
    expect(session.effectiveDetachPolicy).toBe('survive');

    const listed = await invoke(catalog, 'sessions.hosted.list', {});
    expect((listed['sessions'] as unknown[]).length).toBe(1);

    const attached = await invoke(catalog, 'sessions.hosted.attach', {
      sessionId: session.id,
      clientId: 'terminal-2',
    });
    expect((attached['session'] as { attachedClients: string[] }).attachedClients.sort())
      .toEqual(['terminal-1', 'terminal-2']);
    expect(Array.isArray(attached['history'])).toBe(true);

    const killed = await invoke(catalog, 'sessions.hosted.kill', { sessionId: session.id });
    expect((killed['session'] as { terminatedReason: string }).terminatedReason).toBe('killed');

    // Kept, with its reason, until retention retires it.
    const withTerminated = await invoke(catalog, 'sessions.hosted.list', { includeTerminated: true });
    expect((withTerminated['sessions'] as unknown[]).length).toBe(1);
    expect((await invoke(catalog, 'sessions.hosted.list', {}))['sessions']).toEqual([]);
  });

  it('refuses a workspace this daemon cannot host a session in', async () => {
    const { catalog } = build();
    await expect(invoke(catalog, 'sessions.hosted.create', { workspaceRoot: join(root, 'not-a-directory') }))
      .rejects.toThrow(/not a directory/);
  });

  it('publishes lifecycle notices on the hosted-session channel', async () => {
    const { catalog } = build({ detachPolicy: 'kill' });
    const created = await invoke(catalog, 'sessions.hosted.create', { workspaceRoot: workspaceA, clientId: 'a' });
    const session = created['session'] as { id: string };
    await invoke(catalog, 'sessions.hosted.detach', { sessionId: session.id, clientId: 'a' });

    expect(published.map((entry) => entry.event)).toEqual([
      'hosted-session-update',
      'hosted-session-update',
      'hosted-session-update',
    ]);
    const events = published.map((entry) => (entry.payload as { event: string }).event);
    expect(events).toEqual(['hosted-session-created', 'hosted-session-detached', 'hosted-session-terminated']);
  });
});

describe('the detach toggle reads this daemon\'s setting', () => {
  it('kill (the shipped default) ends the session on the last detach', async () => {
    const { manager } = build({ detachPolicy: 'kill' });
    const created = await manager.create({ workspaceRoot: workspaceA, clientId: 'a' });
    const after = await manager.detach(created.id, 'a');
    expect(after.status).toBe('terminated');
    expect(after.terminatedReason).toBe('detached');
  });

  it('survive leaves it reattachable', async () => {
    const { manager } = build({ detachPolicy: 'survive' });
    const created = await manager.create({ workspaceRoot: workspaceA, clientId: 'a' });
    expect((await manager.detach(created.id, 'a')).status).toBe('idle');
    expect((await manager.attach(created.id, 'b')).session.attachedClients).toEqual(['b']);
  });

  it('a per-session override beats the setting', async () => {
    const { manager } = build({ detachPolicy: 'kill' });
    const created = await manager.create({ workspaceRoot: workspaceA, clientId: 'a', detachPolicy: 'survive' });
    expect((await manager.detach(created.id, 'a')).status).toBe('idle');
  });
});

describe('a hosted turn is reachable by the session verbs', () => {
  it('binds live-turn controls under the hosted session id', async () => {
    const { manager } = build();
    const created = await manager.create({ workspaceRoot: workspaceA, clientId: 'a' });

    // The wiring that goes missing silently: without the per-session binding,
    // sessions.toolCalls.cancel answers SESSION_NOT_LOCAL for a loop running in
    // this very process.
    expect(liveTurns.hasSession(created.id)).toBe(true);
    const controls = createSessionRuntimeControls({
      config: {
        get: () => 'prompt' as never,
        set: () => {},
      },
      store: {
        getState: () => ({
          session: { id: 'the-daemons-own-runtime' },
          conversation: { estimatedContextTokens: 0 },
          model: { tokenLimits: { contextWindow: 1000 } },
        }),
      },
      liveTurnHolder: liveTurns,
    });
    expect(controls.isLocalSession(created.id)).toBe(true);
    expect(controls.getLiveTurnControls(created.id)).not.toBeNull();
    expect(controls.getLiveTurnControls(created.id)!.listQueuedMessages()).toEqual([]);

    await manager.kill(created.id);
    expect(liveTurns.hasSession(created.id)).toBe(false);
  });
});

describe('a restart reconciles from disk rather than losing sessions', () => {
  it('brings a survive-policy session back and terminates a kill-policy one with a reason', async () => {
    const services = getTestRuntimeServices();
    services.configManager.set('hostedSessions.detachPolicy', 'survive');
    const first = build().manager;
    const survivor = await first.create({ workspaceRoot: workspaceA, clientId: 'a' });
    await first.dispose();
    // Written under the shellPaths user root this composition was given, which
    // is what makes the next start able to find it.
    expect(existsSync(join(stateDir, `${survivor.id}.json`))).toBe(true);

    const second = build().manager;
    const report = await second.init();
    expect(report.rejected).toEqual([]);
    expect(second.get(survivor.id)?.status).toBe('idle');
    expect(second.get(survivor.id)?.restoredFromDisk).toBe(true);

    services.configManager.set('hostedSessions.detachPolicy', 'kill');
    const third = build().manager;
    await third.init();
    // Same record, read under a kill policy this time: it is terminated with
    // the reason that applies, not silently dropped.
    expect(third.get(survivor.id)?.status).toBe('terminated');
    expect(third.get(survivor.id)?.terminatedReason).toBe('daemon-shutdown');
  });
});
