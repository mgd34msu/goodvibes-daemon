/**
 * The daemon over its real wire: a running DaemonServer on an ephemeral port
 * (src/testing/daemon-fixture.ts), driven only through HTTP, SSE and
 * WebSocket, the way every client reaches it. Nothing here calls
 * gatewayMethods.invoke in process.
 *
 *   - a WebSocket upgrade with a bad token is refused before it is upgraded
 *   - an SSE client that reconnects with Last-Event-ID receives exactly the
 *     events it missed
 *   - a hosted session is created, runs a turn against a scripted model,
 *     detaches, and reattaches with its transcript
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { connect } from 'node:net';
import { startDaemonFixture, type DaemonFixture } from '../../testing/daemon-fixture.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

let fixture: DaemonFixture;

// ── the scripted model a hosted turn calls ────────────────────────────────────
const REPLY_MARKER = `wire-reply-${Math.random().toString(36).slice(2)}`;
const modelRequests: string[] = [];
let modelServer: ReturnType<typeof Bun.serve> | null = null;

function startScriptedModel(): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.endsWith('/models')) return Response.json({ data: [{ id: 'wire-model' }] });
      const body = await request.json().catch(() => ({})) as { messages?: unknown[]; stream?: boolean };
      modelRequests.push(JSON.stringify(body.messages ?? []));
      const content = `${REPLY_MARKER} answered`;
      if (body.stream === true) {
        const chunk = (delta: Record<string, unknown>, finish: string | null): string => `data: ${JSON.stringify({
          id: 'chatcmpl-wire',
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: 'wire-model',
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;
        return new Response(
          chunk({ role: 'assistant', content }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        );
      }
      return Response.json({
        id: 'chatcmpl-wire',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'wire-model',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
      });
    },
  });
}

beforeAll(async () => {
  fixture = await startDaemonFixture({ root: makeProjectTempDir('gv-daemon-wire') });
  modelServer = startScriptedModel();
  // The seam boot uses for the persisted discovery cache: the daemon's own
  // registry learns the server, and every hosted floor copies it from there.
  fixture.services.providerRegistry.registerDiscoveredProviders([{
    name: 'wire-stub',
    host: '127.0.0.1',
    port: modelServer.port!,
    baseURL: `http://127.0.0.1:${modelServer.port}/v1`,
    models: ['wire-model'],
    serverType: 'vllm',
  }]);
});

afterAll(async () => {
  modelServer?.stop(true);
  await fixture?.stop();
});

/** Invoke a gateway verb through the HTTP control plane. */
async function invokeOverHttp<T>(methodId: string, body: Record<string, unknown>): Promise<T> {
  const response = await fixture.fetch(`/api/control-plane/methods/${encodeURIComponent(methodId)}/invoke`, {
    method: 'POST',
    body: JSON.stringify({ body }),
  });
  const payload = await response.json() as unknown;
  if (!response.ok) throw new Error(`${methodId} -> ${response.status} ${JSON.stringify(payload)}`);
  return payload as T;
}

async function waitFor(what: string, check: () => boolean | Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

// ── (a) WebSocket authentication ─────────────────────────────────────────────

/** Send a raw WebSocket upgrade request and return the HTTP status line the server answers. */
function rawUpgradeStatusLine(authorization: string | null): Promise<string> {
  const { hostname, port } = new URL(fixture.baseUrl);
  return new Promise((resolve, reject) => {
    const socket = connect(Number(port), hostname, () => {
      socket.write([
        'GET /api/control-plane/ws?clientKind=web HTTP/1.1',
        `Host: ${hostname}:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        ...(authorization ? [`Authorization: ${authorization}`] : []),
        '',
        '',
      ].join('\r\n'));
    });
    let received = '';
    socket.on('data', (chunk) => {
      received += chunk.toString('utf8');
      const end = received.indexOf('\r\n');
      if (end >= 0) {
        socket.destroy();
        resolve(received.slice(0, end));
      }
    });
    socket.on('error', reject);
    socket.setTimeout(10_000, () => { socket.destroy(); reject(new Error('no answer to the upgrade request')); });
  });
}

/** Open a WebSocket with the given bearer token; report whether it opened and its first message. */
function openSocket(token: string): Promise<{ opened: boolean; firstMessage: string | null }> {
  const url = `${fixture.baseUrl.replace(/^http/, 'ws')}/api/control-plane/ws?clientKind=web`;
  const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } } as unknown as string[]);
  return new Promise((resolve) => {
    let opened = false;
    let settled = false;
    const finish = (firstMessage: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ opened, firstMessage });
      // close() can dispatch onclose synchronously; the result is already settled.
      socket.close();
    };
    const timer = setTimeout(() => finish(null), 10_000);
    socket.onopen = () => { opened = true; };
    socket.onmessage = (message) => finish(String(message.data));
    socket.onerror = () => finish(null);
    socket.onclose = () => finish(null);
  });
}

describe('WebSocket upgrade authentication', () => {
  test('an upgrade carrying a wrong bearer token is refused with 401 and never opens', async () => {
    expect(await rawUpgradeStatusLine('Bearer not-the-daemon-token')).toMatch(/^HTTP\/1\.1 401\b/);
    const attempt = await openSocket('not-the-daemon-token');
    expect(attempt.opened).toBe(false);
    expect(attempt.firstMessage).toBeNull();
  });

  test('an upgrade with no credential at all is refused with 401', async () => {
    expect(await rawUpgradeStatusLine(null)).toMatch(/^HTTP\/1\.1 401\b/);
  });

  test('the daemon token upgrades, and the socket is served the ready frame', async () => {
    const attempt = await openSocket(fixture.token);
    expect(attempt.opened).toBe(true);
    expect(JSON.parse(attempt.firstMessage ?? '{}')).toMatchObject({ type: 'event', event: 'ready' });
    expect(await rawUpgradeStatusLine(`Bearer ${fixture.token}`)).toMatch(/^HTTP\/1\.1 101\b/);
  });
});

// ── (b) SSE replay after reconnect ───────────────────────────────────────────

interface SseFrame {
  readonly id: string | null;
  readonly event: string;
  readonly data: Record<string, unknown>;
}

/** An open control-plane SSE stream, parsed frame by frame as it arrives. */
interface SseStream {
  readonly frames: SseFrame[];
  close(): void;
}

async function openEventStream(lastEventId?: string): Promise<SseStream> {
  const abort = new AbortController();
  const response = await fixture.fetch('/api/control-plane/events', {
    signal: abort.signal,
    headers: { Accept: 'text/event-stream', ...(lastEventId ? { 'Last-Event-ID': lastEventId } : {}) },
  });
  expect(response.status).toBe(200);
  const frames: SseFrame[] = [];
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf('\n\n');
        while (boundary >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf('\n\n');
          let id: string | null = null;
          let event = 'message';
          const data: string[] = [];
          for (const line of block.split('\n')) {
            if (line.startsWith('id: ')) id = line.slice(4);
            else if (line.startsWith('event: ')) event = line.slice(7);
            else if (line.startsWith('data: ')) data.push(line.slice(6));
          }
          frames.push({ id, event, data: JSON.parse(data.join('\n') || '{}') as Record<string, unknown> });
        }
      }
    } catch {
      // aborted by close()
    }
  })();
  return { frames, close: () => abort.abort() };
}

function hostedSessionCreatedIn(frames: readonly SseFrame[], sessionId: string): SseFrame | undefined {
  return frames.find((frame) => frame.event === 'hosted-session-update'
    && frame.data['event'] === 'hosted-session-created'
    && (frame.data['session'] as { id?: string } | undefined)?.id === sessionId);
}

interface HostedSession {
  readonly id: string;
  readonly status: string;
  readonly attachedClients: readonly string[];
  readonly messageCount: number;
  readonly terminatedReason?: string;
}

describe('SSE replay after a reconnect with Last-Event-ID', () => {
  test('the reconnecting client receives the events it missed, and nothing it already had', async () => {
    const first = await openEventStream();
    const before = await invokeOverHttp<{ session: HostedSession }>('sessions.hosted.create', {
      workspaceRoot: fixture.workingDirectory, clientId: 'sse-before', detachPolicy: 'survive',
    });
    await waitFor('the first stream to carry the first session', () => hostedSessionCreatedIn(first.frames, before.session.id) !== undefined);
    first.close();
    const seenIds = new Set(first.frames.map((frame) => frame.id).filter((id): id is string => id !== null));
    const checkpoint = [...first.frames].reverse().find((frame) => frame.id !== null)!.id!;

    // Happens while no stream is open.
    const missed = await invokeOverHttp<{ session: HostedSession }>('sessions.hosted.create', {
      workspaceRoot: fixture.workingDirectory, clientId: 'sse-missed', detachPolicy: 'survive',
    });

    const second = await openEventStream(checkpoint);
    try {
      await waitFor('the missed session to be replayed', () => hostedSessionCreatedIn(second.frames, missed.session.id) !== undefined, 10_000);
      const ready = second.frames.find((frame) => frame.event === 'ready');
      expect(ready?.data['resume']).toMatchObject({ resume: 'resumed', sinceId: checkpoint });
      const redelivered = second.frames.filter((frame) => frame.id !== null && seenIds.has(frame.id));
      expect(redelivered.map((frame) => `${frame.event} ${frame.id}`)).toEqual([]);
    } finally {
      second.close();
      await invokeOverHttp('sessions.hosted.kill', { sessionId: before.session.id });
      await invokeOverHttp('sessions.hosted.kill', { sessionId: missed.session.id });
    }
  });
});

// ── (c) a hosted session end to end ──────────────────────────────────────────

describe('a hosted session over the HTTP control plane', () => {
  test('create, one turn on the scripted model, detach, reattach with the transcript', async () => {
    const created = await invokeOverHttp<{ session: HostedSession }>('sessions.hosted.create', {
      workspaceRoot: fixture.workingDirectory,
      clientId: 'wire-client',
      modelId: 'wire-stub:wire-model',
      detachPolicy: 'survive',
      title: 'daemon wire test',
    });
    const sessionId = created.session.id;
    expect(created.session.status).toBe('idle');

    await invokeOverHttp('sessions.steer', { sessionId, body: 'say hello from the wire test' });
    await waitFor('the scripted model to be called', () => modelRequests.some((messages) => messages.includes('say hello from the wire test')));
    await waitFor('the reply to land in the session', async () => {
      const { sessions } = await invokeOverHttp<{ sessions: HostedSession[] }>('sessions.hosted.list', {});
      return (sessions.find((session) => session.id === sessionId)?.messageCount ?? 0) >= 2;
    });

    const detached = await invokeOverHttp<{ session: HostedSession }>('sessions.hosted.detach', { sessionId, clientId: 'wire-client' });
    expect(detached.session.status).toBe('idle');
    expect(detached.session.attachedClients).toEqual([]);

    const reattached = await invokeOverHttp<{ session: HostedSession; history: { role: string; content: string }[] }>(
      'sessions.hosted.attach', { sessionId, clientId: 'wire-client-2' },
    );
    expect(reattached.session.id).toBe(sessionId);
    expect(reattached.session.status).not.toBe('terminated');
    expect(reattached.session.attachedClients).toContain('wire-client-2');
    expect(reattached.history.some((message) => message.role === 'user' && message.content.includes('say hello from the wire test'))).toBe(true);
    expect(reattached.history.some((message) => message.role === 'assistant' && message.content.includes(REPLY_MARKER))).toBe(true);

    const killed = await invokeOverHttp<{ session: HostedSession }>('sessions.hosted.kill', { sessionId });
    expect(killed.session.terminatedReason).toBe('killed');
  });
});
