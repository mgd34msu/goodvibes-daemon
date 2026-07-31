/**
 * A conversation this daemon dispatched to a SURFACE still gets its answer back
 * to the channel it came from.
 *
 * The daemon has always bound a reply for the executors it spawns itself: the
 * broker pairs the agent with the input it was started for, the pairing is
 * announced, and the completion poll delivers the answer. None of that could
 * happen for work the daemon handed to a client process — the client's
 * `sessions.inputs.deliver` dropped the id of the agent it started, so no
 * pairing existed, and the daemon's completion poll can only ever see agents
 * this process spawned, so no answer arrived either. A message from a channel
 * was received, answered, and the sender heard nothing.
 *
 * This is the oracle for both halves of the fix, over the real HTTP route, the
 * real shared-session broker and the real reply pipeline:
 *  - `deliver` carrying `agentId` binds the reply;
 *  - `deliver` carrying `answer` puts that answer in the session and on the
 *    channel.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DaemonServer } from '@pellux/goodvibes-sdk/platform/daemon';
import { UserAuthManager } from '@pellux/goodvibes-sdk/platform/security';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { createRuntimeStore } from '@pellux/goodvibes-sdk/platform/runtime/store';
import { RuntimeEventBus } from '@/runtime/index.ts';
import { createFeatureFlagManager, deriveFeatureStates } from '@/runtime/index.ts';
import { createRuntimeServices } from '../../runtime/services.ts';
import { resetTestRuntimeServices, disposeTestRuntimeServicesAfterAll } from '../helpers/runtime-services.ts';
import { trackDisposables } from '../helpers/disposables.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

disposeTestRuntimeServicesAfterAll();

const TEST_TOKEN = 'test-secret-token-dispatched-reply';

async function waitFor<T>(fn: () => T | undefined | null, timeoutMs = 5_000): Promise<T> {
  const startedAt = Date.now();
  for (;;) {
    const value = fn();
    if (value !== undefined && value !== null && value !== false) return value;
    if (Date.now() - startedAt >= timeoutMs) throw new Error('Timed out waiting for value');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const disposables = trackDisposables();

describe('a conversation dispatched to a surface', () => {
  let daemon: DaemonServer;
  let tempRoot: string;
  let workingDir: string;
  let homeDir: string;
  let configDir: string;
  let runtimeServices: ReturnType<typeof createRuntimeServices>;
  let boundPort = 0;
  /** What the channel was actually handed, in order. */
  let channelSends: { phase: string; text: string; agentId: string }[];

  const capturingServe = ((options) => {
    const server = Bun.serve(options);
    if (server.port !== undefined) boundPort = server.port;
    return server;
  }) as typeof Bun.serve;

  const makeConfig = (): ConfigManager => new ConfigManager({ surfaceRoot: 'tui', configDir, workingDir, homeDir });

  const makeFeatureFlags = (): ReturnType<typeof createFeatureFlagManager> => {
    const featureFlags = createFeatureFlagManager();
    const flags = deriveFeatureStates(makeConfig());
    for (const id of ['control-plane-gateway', 'delivery-engine', 'route-binding', 'webhook-surface', 'web-surface']) {
      flags[id] = 'enabled';
    }
    featureFlags.loadFromConfig({ flags });
    return featureFlags;
  };

  const authHeaders = {
    Authorization: `Bearer ${TEST_TOKEN}`,
    'Content-Type': 'application/json',
  };

  const deliverUrl = (sessionId: string, inputId: string): string =>
    `http://127.0.0.1:${boundPort}/api/sessions/${sessionId}/inputs/${inputId}/deliver`;

  /**
   * A channel-originated conversation with nothing running for it: exactly the
   * state a surface's dispatch poller collects a queued `submit` from.
   */
  const openChannelConversation = async (): Promise<{ sessionId: string; inputId: string; routeId: string }> => {
    const binding = await runtimeServices.routeBindings.upsertBinding({
      kind: 'channel',
      surfaceKind: 'webhook',
      surfaceId: 'surface:webhook',
      externalId: 'conversation-under-test',
      title: 'Webhook conversation',
      metadata: { callbackUrl: 'https://example.invalid/reply' },
    });
    const submission = await runtimeServices.sessionBroker.submitMessage({
      routeId: binding.id,
      surfaceKind: 'webhook',
      surfaceId: 'surface:webhook',
      externalId: 'conversation-under-test',
      title: 'Webhook conversation',
      body: 'Is the build green?',
      metadata: {},
    });
    // No daemon executor was started: the input is waiting for whoever hosts
    // the session, which is what the wire dispatch collects.
    expect(submission.mode).toBe('spawn');
    expect(submission.input.state).toBe('queued');
    return { sessionId: submission.session.id, inputId: submission.input.id, routeId: binding.id };
  };

  beforeEach(async () => {
    resetTestRuntimeServices();
    channelSends = [];
    tempRoot = makeProjectTempDir('gv-dispatched-reply');
    workingDir = join(tempRoot, 'workspace');
    homeDir = join(tempRoot, 'home');
    configDir = join(homeDir, '.goodvibes', 'tui');
    mkdirSync(workingDir, { recursive: true });
    mkdirSync(configDir, { recursive: true });
    const configManager = makeConfig();
    // The webhook surface is the deliverable channel in this test; without this
    // the daemon correctly refuses to create a delivery for it.
    configManager.set('surfaces.webhook.enabled', true);
    runtimeServices = disposables.add(createRuntimeServices({
      runtimeStore: createRuntimeStore(),
      runtimeBus: new RuntimeEventBus(),
      configManager,
      workingDir,
      homeDirectory: homeDir,
      featureFlags: makeFeatureFlags(),
      getConversationTitle: () => 'Dispatched reply test',
    }));
    daemon = new DaemonServer({
      port: 0,
      host: '127.0.0.1',
      userAuth: new UserAuthManager({
        bootstrapFilePath: join(homeDir, 'auth-users.json'),
        bootstrapCredentialPath: join(homeDir, 'auth-bootstrap.txt'),
        users: [{ username: 'admin', passwordHash: UserAuthManager.hashPassword('admin'), roles: ['admin'] }],
      }),
      runtimeServices,
      serveFactory: capturingServe,
    });
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();
    // Stand in for the channel itself, so "the answer reached the conversation"
    // is an assertion about what was handed to a channel rather than about a
    // network call. Registered AFTER start, because starting the daemon
    // registers its builtin channel plugins and registering by surface replaces
    // whatever holds that surface.
    runtimeServices.channelPlugins.register({
      id: 'test-recording-webhook',
      surface: 'webhook',
      displayName: 'Recording webhook',
      capabilities: ['egress'],
      renderEvent: async (request) => {
        channelSends.push({ phase: request.phase, text: request.text, agentId: request.agentId ?? '' });
        return { delivered: true, metadata: { surface: 'webhook', pluginId: 'test-recording-webhook' } };
      },
    });
  });

  afterEach(async () => {
    await daemon?.stop();
    resetTestRuntimeServices();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  test('naming the agent binds the session and the reply', async () => {
    const { sessionId, inputId } = await openChannelConversation();

    const response = await fetch(deliverUrl(sessionId, inputId), {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ agentId: 'agent-on-the-surface' }),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { input: { state: string; activeAgentId?: string } };

    // The input is collected, not finished, and it names its agent.
    expect(body.input.state).toBe('delivered');
    expect(body.input.activeAgentId).toBe('agent-on-the-surface');
    // The session's active agent is the one running on the surface, so anything
    // arriving next continues that conversation instead of starting another.
    expect(runtimeServices.sessionBroker.getSession(sessionId)?.activeAgentId).toBe('agent-on-the-surface');
  });

  test('reporting the answer puts it in the session and on the channel', async () => {
    const { sessionId, inputId } = await openChannelConversation();

    await fetch(deliverUrl(sessionId, inputId), {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ agentId: 'agent-on-the-surface' }),
    });
    const finish = await fetch(deliverUrl(sessionId, inputId), {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        consumed: true,
        agentId: 'agent-on-the-surface',
        answer: 'The build is green.',
        status: 'completed',
      }),
    });
    expect(finish.status).toBe(200);
    expect((await finish.json() as { input: { state: string } }).input.state).toBe('completed');

    // On the channel the message came from.
    const sent = await waitFor(() => channelSends.find((entry) => entry.phase === 'final') ?? null);
    expect(sent.agentId).toBe('agent-on-the-surface');
    expect(sent.text).toContain('The build is green.');

    // And in the shared session, so every surface listing the conversation sees
    // the answer rather than a question with no reply under it.
    const messages = runtimeServices.sessionBroker.getMessages(sessionId, 50) as Array<{
      role: string; body: string; agentId?: string;
    }>;
    expect(messages.some((message) => message.role === 'assistant'
      && message.body === 'The build is green.'
      && message.agentId === 'agent-on-the-surface')).toBe(true);
  });

  test('a surface that names no agent binds nothing', async () => {
    const { sessionId, inputId } = await openChannelConversation();

    const response = await fetch(deliverUrl(sessionId, inputId), {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ consumed: true }),
    });
    expect(response.status).toBe(200);

    // Nothing ran, so nothing is bound and nothing is sent — the honest outcome
    // for a runner that declined the work or handed it somewhere else.
    expect(runtimeServices.sessionBroker.getSession(sessionId)?.activeAgentId).toBeUndefined();
    expect(channelSends).toEqual([]);
  });
});
