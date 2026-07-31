/**
 * boot-smoke — proves the COMPILED daemon binary boots, serves, and fails loudly.
 *
 * The version smoke (`bun run smoke`) proves the binary starts and prints its
 * banner. This one proves the three things that only a real boot can show, and
 * that a source-level test provably cannot:
 *
 *   1. It serves. An isolated home, a fixed port, and `/status` answering 200
 *      with `status: running`.
 *   2. It says who it is. The startup banner carries the resolved version and
 *      the host and port it actually bound — never a placeholder, and never a
 *      value from a different resolver than the bind path uses.
 *   3. It fails LOUDLY. Given a `.goodvibes/daemon/settings.json` that cannot be
 *      parsed, it exits non-zero with the reason on the error stream. This is
 *      not hypothetical: a released daemon binary died on exactly this path with
 *      zero bytes on stdout, zero bytes on stderr and an empty activity log, and
 *      crash-looped 77 times overnight with nothing anywhere saying why. The
 *      identical source run under `bun` printed the reason, which is why this
 *      check has to run the compiled artifact.
 *
 * Every run is isolated: its own home, its own daemon home, its own working
 * directory, its own token and a high fixed port. It never touches the machine's
 * real GoodVibes tree, never claims a service unit, and never talks to a daemon
 * it did not start.
 *
 * Usage:
 *   bun run scripts/boot-smoke.ts
 *   bun run scripts/boot-smoke.ts --binary dist/goodvibes-daemon-linux-x64
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = process.cwd();
const args = process.argv.slice(2);

function defaultBinary(): string {
  const key = `${process.platform}-${process.arch}`;
  const names: Record<string, string> = {
    'linux-x64': 'goodvibes-daemon-linux-x64',
    'linux-arm64': 'goodvibes-daemon-linux-arm64',
    'darwin-x64': 'goodvibes-daemon-macos-x64',
    'darwin-arm64': 'goodvibes-daemon-macos-arm64',
  };
  return join(root, 'dist', names[key] ?? 'goodvibes-daemon-linux-x64');
}

const binaryIndex = args.indexOf('--binary');
const BINARY = binaryIndex !== -1 && args[binaryIndex + 1] ? args[binaryIndex + 1]! : defaultBinary();

/** High enough to stay clear of the daemon's own default, so a live daemon on this machine is untouched. */
const SMOKE_PORT = 47931;
const SMOKE_TOKEN = 'boot-smoke-token-local';
const STARTUP_TIMEOUT_MS = 45_000;
const POLL_INTERVAL_MS = 400;
const FATAL_TIMEOUT_MS = 30_000;

const failures: string[] = [];

function pass(message: string): void {
  console.log(`[boot-smoke] OK   ${message}`);
}

function fail(message: string): void {
  console.error(`[boot-smoke] FAIL ${message}`);
  failures.push(message);
}

/** A throwaway home tree: the daemon's whole world for one run. */
function makeIsolatedHome(): { readonly home: string; readonly daemonHome: string; readonly workingDir: string } {
  const home = mkdtempSync(join(tmpdir(), 'gv-boot-smoke-'));
  const daemonHome = join(home, '.goodvibes', 'daemon');
  const workingDir = join(home, 'work');
  mkdirSync(daemonHome, { recursive: true });
  mkdirSync(workingDir, { recursive: true });
  return { home, daemonHome, workingDir };
}

function isolatedEnv(paths: ReturnType<typeof makeIsolatedHome>): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GOODVIBES_HOME: paths.home,
    GOODVIBES_DAEMON_HOME: paths.daemonHome,
    GOODVIBES_WORKING_DIR: paths.workingDir,
    GOODVIBES_DAEMON_TOKEN: SMOKE_TOKEN,
  };
}

async function waitForStatus(port: number, deadlineMs: number): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/status`, {
        headers: { Authorization: `Bearer ${SMOKE_TOKEN}` },
      });
      if (response.ok) return await response.json() as Record<string, unknown>;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  return null;
}

// ---------------------------------------------------------------------------
// 1 + 2: it serves, and its banner is honest
// ---------------------------------------------------------------------------

async function checkServes(): Promise<void> {
  const paths = makeIsolatedHome();
  let stdout = '';
  let stderr = '';
  const child = spawn(BINARY, ['--port', String(SMOKE_PORT), '--hostname', '127.0.0.1'], {
    env: isolatedEnv(paths),
    cwd: paths.workingDir,
  });
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

  try {
    const status = await waitForStatus(SMOKE_PORT, STARTUP_TIMEOUT_MS);
    if (!status) {
      fail(`the daemon did not answer /status within ${STARTUP_TIMEOUT_MS}ms\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`);
      return;
    }
    pass('/status answered 200 on an isolated home');

    if (status.status === 'running') pass("/status reports status: 'running'");
    else fail(`/status reported status: ${JSON.stringify(status.status)}`);

    const banner = stdout.split('\n')[0] ?? '';
    if (!banner.startsWith('goodvibes-daemon ')) {
      fail(`the startup banner does not identify the daemon: ${banner.slice(0, 160)}`);
    } else if (banner.includes('0.0.0')) {
      fail(`the startup banner reports a placeholder version: ${banner.slice(0, 160)}`);
    } else if (!banner.includes(`port=${SMOKE_PORT}`) || !banner.includes('host=127.0.0.1')) {
      fail(`the startup banner does not state the binding it actually took: ${banner.slice(0, 200)}`);
    } else {
      pass(`the startup banner states the real version and binding: ${banner.trim().slice(0, 120)}`);
    }

    if (stderr.includes('disagrees with the real bind')) {
      fail('the daemon warned that clients are handed an origin it does not answer on');
    } else {
      pass('the advertised control-plane origin agrees with the real bind');
    }
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    if (child.exitCode === null) child.kill('SIGKILL');
    rmSync(paths.home, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 3: it fails loudly
// ---------------------------------------------------------------------------

function checkFailsLoudly(): void {
  const paths = makeIsolatedHome();
  writeFileSync(join(paths.daemonHome, 'settings.json'), '{ not json', 'utf8');
  try {
    const result = spawnSync(BINARY, ['--port', String(SMOKE_PORT + 1), '--hostname', '127.0.0.1'], {
      env: isolatedEnv(paths),
      cwd: paths.workingDir,
      encoding: 'utf-8',
      timeout: FATAL_TIMEOUT_MS,
    });
    const stderr = result.stderr ?? '';
    if (result.status === 0) {
      fail('the daemon exited 0 with an unparseable settings file — a broken config must not read as a clean start');
      return;
    }
    if (stderr.trim().length === 0) {
      fail('the daemon died with zero bytes on the error stream — this is the silence that crash-looped 77 times');
      return;
    }
    if (!stderr.includes('settings.json')) {
      fail(`the failure reason does not name the file that could not be read: ${stderr.trim().slice(0, 300)}`);
      return;
    }
    pass(`a broken settings file exits non-zero with the reason on the error stream (${stderr.trim().length} bytes)`);
  } finally {
    rmSync(paths.home, { recursive: true, force: true });
  }
}

const bootProbe = spawnSync(BINARY, ['--version'], { encoding: 'utf-8' });
if (bootProbe.error) {
  console.error(`[boot-smoke] FAIL cannot run ${BINARY}: ${bootProbe.error.message}`);
  console.error('[boot-smoke] build one first: bun run build');
  process.exit(1);
}

await checkServes();
checkFailsLoudly();

if (failures.length > 0) {
  console.error(`[boot-smoke] ${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('[boot-smoke] all checks passed');
