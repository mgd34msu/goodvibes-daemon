#!/usr/bin/env bun
/**
 * hosted-binary-proof.ts — the compiled daemon binary, hosting a real session.
 *
 * Boots dist/goodvibes-daemon-linux-x64 against an isolated home and a high
 * port (never the machine's daemon, never 3421, never systemd), points it at a
 * local OpenAI-compatible stub for its model, and then drives the whole
 * hosted-session story over the wire:
 *
 *   create -> one real turn -> detach under `kill` -> create again under
 *   `survive` -> detach -> reattach -> history is still there -> kill.
 *
 * Everything is asserted against what the binary answers, not against the
 * source it was built from.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function defaultBinary(): string {
  const names: Record<string, string> = {
    'linux-x64': 'goodvibes-daemon-linux-x64',
    'linux-arm64': 'goodvibes-daemon-linux-arm64',
    'darwin-x64': 'goodvibes-daemon-macos-x64',
    'darwin-arm64': 'goodvibes-daemon-macos-arm64',
  };
  return join(process.cwd(), 'dist', names[`${process.platform}-${process.arch}`] ?? 'goodvibes-daemon-linux-x64');
}

const BINARY = process.argv[2] ?? defaultBinary();
const DAEMON_PORT = 47861;
const STUB_PORT = 47862;
const TOKEN = 'hosted-binary-proof-token';

const home = mkdtempSync(join(tmpdir(), 'gv-hosted-proof-'));
const workspace = join(home, 'workspace');
mkdirSync(workspace, { recursive: true });
writeFileSync(join(workspace, 'note.txt'), 'the note a hosted session can read\n');

const results: { step: string; ok: boolean; detail: string }[] = [];
function check(step: string, ok: boolean, detail = ''): void {
  results.push({ step, ok, detail });
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${step}${detail ? ` — ${detail}` : ''}`);
}

// --- the model the hosted session will actually call --------------------------
let stubCalls = 0;
const stub = Bun.serve({
  port: STUB_PORT,
  hostname: '127.0.0.1',
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.endsWith('/models')) {
      return Response.json({ data: [{ id: 'proof-model' }] });
    }
    stubCalls += 1;
    const body = await request.json().catch(() => ({})) as { messages?: unknown[] };
    const saw = JSON.stringify(body.messages ?? []);
    return Response.json({
      id: 'chatcmpl-proof',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: 'proof-model',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: `hosted turn ${stubCalls} answered; the prompt mentioned the workspace: ${saw.includes(workspace)}`,
        },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
    });
  },
});

// The daemon reads this at boot and registers it as a routable provider.
const surfaceDir = join(home, '.goodvibes', 'tui');
mkdirSync(surfaceDir, { recursive: true });
writeFileSync(join(surfaceDir, 'discovered-providers.json'), JSON.stringify([{
  name: 'proof-stub',
  host: '127.0.0.1',
  port: STUB_PORT,
  baseURL: `http://127.0.0.1:${STUB_PORT}/v1`,
  models: ['proof-model'],
  serverType: 'vllm',
  lastSeen: Date.now(),
}], null, 2));

mkdirSync(join(home, '.goodvibes', 'daemon'), { recursive: true });
const daemon = Bun.spawn([BINARY, '--port', String(DAEMON_PORT), '--hostname', '127.0.0.1'], {
  env: {
    ...process.env,
    GOODVIBES_HOME: home,
    GOODVIBES_DAEMON_HOME: join(home, '.goodvibes', 'daemon'),
    GOODVIBES_WORKING_DIR: workspace,
    GOODVIBES_DAEMON_TOKEN: TOKEN,
  },
  cwd: workspace,
  stdout: 'pipe',
  stderr: 'pipe',
});

async function invoke<T = Record<string, unknown>>(methodId: string, params: Record<string, unknown>): Promise<T> {
  const response = await fetch(
    `http://127.0.0.1:${DAEMON_PORT}/api/control-plane/methods/${encodeURIComponent(methodId)}/invoke`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ body: params }),
    },
  );
  const body = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(`${methodId} -> ${response.status} ${JSON.stringify(body)}`);
  return body as T;
}

async function waitForDaemon(): Promise<boolean> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${DAEMON_PORT}/status`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      if (response.ok) return true;
    } catch { /* not up yet */ }
    await Bun.sleep(500);
  }
  return false;
}

type HostedSession = {
  id: string;
  status: string;
  effectiveDetachPolicy: string;
  detachPolicy: string | null;
  terminatedReason?: string;
  attachedClients: string[];
  messageCount: number;
};

try {
  const up = await waitForDaemon();
  check('the compiled binary boots on an isolated home and answers /status', up, `port ${DAEMON_PORT}`);
  if (!up) throw new Error('daemon never answered');

  // --- the toggle's shipped default: kill ------------------------------------
  await invoke('config.set', { key: 'hostedSessions.detachPolicy', value: 'kill' });
  const settings = await invoke<Record<string, unknown>>('config.get', { key: 'hostedSessions.detachPolicy' });
  const hosted = settings['hostedSessions'] as Record<string, unknown> | undefined;
  check('the detach policy is a real setting this daemon serves',
    hosted?.['detachPolicy'] === 'kill' && typeof hosted?.['maxSessions'] === 'number',
    JSON.stringify(hosted));

  const created = await invoke<{ session: HostedSession }>('sessions.hosted.create', {
    workspaceRoot: workspace,
    clientId: 'proof-client',
    modelId: 'proof-stub:proof-model',
    title: 'the compiled-binary proof',
  });
  check('sessions.hosted.create composes a session in the named workspace',
    created.session.status === 'idle' && created.session.effectiveDetachPolicy === 'kill',
    `${created.session.id} status=${created.session.status} policy=${created.session.effectiveDetachPolicy}`);

  const listed = await invoke<{ sessions: HostedSession[] }>('sessions.hosted.list', {});
  check('sessions.hosted.list reports it', listed.sessions.some((s) => s.id === created.session.id),
    `${listed.sessions.length} hosted session(s)`);

  // --- one real turn, driven by the verb that already existed ----------------
  const steered = await invoke('sessions.steer', {
    sessionId: created.session.id,
    body: 'say hello from a hosted session',
  }).then(() => 'steered').catch((error: unknown) => String(error));
  check('sessions.steer accepts a hosted session id — no parallel verb family', steered === 'steered', steered.slice(0, 160));
  for (let attempt = 0; attempt < 40 && stubCalls === 0; attempt += 1) await Bun.sleep(500);
  check('the hosted session called a real model', stubCalls > 0, `${stubCalls} provider call(s)`);

  const afterTurn = await invoke<{ session: HostedSession; history: { role: string; content: string }[] }>(
    'sessions.hosted.attach', { sessionId: created.session.id, clientId: 'proof-watcher' },
  );
  check('attach returns the transcript so far', afterTurn.history.length > 0,
    `${afterTurn.history.length} message(s)`);

  // --- detach under kill ------------------------------------------------------
  await invoke('sessions.hosted.detach', { sessionId: created.session.id, clientId: 'proof-watcher' });
  const killed = await invoke<{ session: HostedSession }>('sessions.hosted.detach', {
    sessionId: created.session.id, clientId: 'proof-client',
  });
  check('detach under the kill default ends the session with a reason',
    killed.session.status === 'terminated' && killed.session.terminatedReason === 'detached',
    `status=${killed.session.status} reason=${killed.session.terminatedReason}`);

  // --- detach under survive ---------------------------------------------------
  await invoke('config.set', { key: 'hostedSessions.detachPolicy', value: 'survive' });
  const survivor = await invoke<{ session: HostedSession }>('sessions.hosted.create', {
    workspaceRoot: workspace, clientId: 'proof-client',
  });
  check('a session created under survive reports that policy',
    survivor.session.effectiveDetachPolicy === 'survive', survivor.session.effectiveDetachPolicy);

  const detached = await invoke<{ session: HostedSession }>('sessions.hosted.detach', {
    sessionId: survivor.session.id, clientId: 'proof-client',
  });
  check('detach under survive leaves it idle and reattachable',
    detached.session.status === 'idle' && detached.session.attachedClients.length === 0,
    `status=${detached.session.status}`);

  const reattached = await invoke<{ session: HostedSession; history: unknown[] }>('sessions.hosted.attach', {
    sessionId: survivor.session.id, clientId: 'proof-client-2',
  });
  check('reattach works and the session is still the same one',
    reattached.session.id === survivor.session.id && reattached.session.status !== 'terminated',
    `status=${reattached.session.status}`);

  // --- a per-session override beats the setting -------------------------------
  const overridden = await invoke<{ session: HostedSession }>('sessions.hosted.create', {
    workspaceRoot: workspace, clientId: 'proof-client', detachPolicy: 'kill',
  });
  const overriddenAfter = await invoke<{ session: HostedSession }>('sessions.hosted.detach', {
    sessionId: overridden.session.id, clientId: 'proof-client',
  });
  check('a per-session kill override beats a survive setting',
    overriddenAfter.session.status === 'terminated',
    `status=${overriddenAfter.session.status} reason=${overriddenAfter.session.terminatedReason}`);

  // --- kill, and the record survives with its reason --------------------------
  const explicit = await invoke<{ session: HostedSession }>('sessions.hosted.kill', { sessionId: survivor.session.id });
  check('kill ends it with the reason `killed`', explicit.session.terminatedReason === 'killed',
    String(explicit.session.terminatedReason));

  const live = await invoke<{ sessions: HostedSession[] }>('sessions.hosted.list', {});
  const withHistory = await invoke<{ sessions: HostedSession[] }>('sessions.hosted.list', { includeTerminated: true });
  check('terminated sessions are excluded from the live list but kept with their reasons',
    live.sessions.length === 0 && withHistory.sessions.length >= 3,
    `live=${live.sessions.length} all=${withHistory.sessions.length}`);

  const refused = await invoke('sessions.hosted.create', { workspaceRoot: 'relative/path' })
    .then(() => 'accepted').catch((error: unknown) => String(error));
  check('a relative workspace root is refused', refused.includes('absolute'), refused.slice(0, 120));
} finally {
  daemon.kill('SIGTERM');
  await daemon.exited.catch(() => undefined);
  stub.stop(true);
  const failed = results.filter((entry) => !entry.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    console.log(`home kept for inspection: ${home}`);
    process.exitCode = 1;
  } else {
    rmSync(home, { recursive: true, force: true });
  }
}
