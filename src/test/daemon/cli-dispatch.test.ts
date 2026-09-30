/**
 * The daemon entry point, run as a process: `bun src/daemon/cli.ts <args>`
 * against an isolated home, asserting what each invocation prints and how it
 * exits.
 *
 * The defect this guards: an unmatched word used to become a positional
 * nothing read, and the process fell through to serving in the foreground.
 * A process that starts serving does not exit, so each run here has a ceiling
 * and a run that hits it is reported as `timedOut`.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const CLI_ENTRY = join(REPO_ROOT, 'src', 'daemon', 'cli.ts');
const PACKAGE_VERSION = (JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string }).version;

const home = makeProjectTempDir('gv-cli-dispatch');
afterAll(() => rmSync(home, { recursive: true, force: true }));

// If a regression ever makes one of these invocations serve, it serves on a
// loopback port nobody uses, never the machine's own control-plane port.
const spare = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response() });
const sparePort = spare.port;
spare.stop(true);
mkdirSync(join(home, '.goodvibes', 'daemon'), { recursive: true });
writeFileSync(
  join(home, '.goodvibes', 'daemon', 'settings.json'),
  JSON.stringify({ controlPlane: { port: sparePort, host: '127.0.0.1' } }),
);

interface CliRun {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

async function runCli(args: readonly string[], ceilingMs = 20_000): Promise<CliRun> {
  const child = Bun.spawn(['bun', CLI_ENTRY, ...args], {
    cwd: home,
    env: {
      ...process.env,
      HOME: home,
      GOODVIBES_HOME: home,
      GOODVIBES_DAEMON_HOME: join(home, '.goodvibes', 'daemon'),
      GOODVIBES_WORKING_DIR: home,
      // Nothing here may reach a daemon the machine is running.
      GOODVIBES_DAEMON_TOKEN: 'cli-dispatch-test-token',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, ceilingMs);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  clearTimeout(timer);
  return { exitCode, stdout, stderr, timedOut };
}

describe('the daemon entry point dispatches every command and serves on none of the others', () => {
  test('--version prints the package version and exits 0', async () => {
    const run = await runCli(['--version']);
    expect(run.timedOut).toBe(false);
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain(PACKAGE_VERSION);
  }, 30_000);

  test('a misspelled command is refused with exit 2 and the help, and never starts serving', async () => {
    const run = await runCli(['install-servce']);
    expect(run.timedOut).toBe(false);
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain('install-servce');
    expect(run.stderr).toContain('goodvibes-daemon');
  }, 30_000);

  test('`help <command>` prints that command\'s page; `help <unknown>` is refused with exit 2', async () => {
    const page = await runCli(['help', 'sessions']);
    expect(page.exitCode).toBe(0);
    expect(page.stdout).toContain('sessions');
    expect(page.stdout).not.toBe(''); // a real page, not an empty success

    const unknown = await runCli(['help', 'doctor']);
    expect(unknown.timedOut).toBe(false);
    expect(unknown.exitCode).toBe(2);
    expect(unknown.stderr).toContain('Unknown command: doctor');
  }, 30_000);

  test('a first-word-only command behind a global flag is refused with exit 2, not served', async () => {
    const run = await runCli(['--daemon-home', join(home, '.goodvibes', 'daemon'), 'send', 'hello']);
    expect(run.timedOut).toBe(false);
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain('has to be the first argument');
  }, 30_000);
});
