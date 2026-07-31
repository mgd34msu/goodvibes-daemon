import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

/**
 * Shell-level coverage for install_webui.
 *
 * The browser operator surface is the one product in the suite that is not a
 * binary: it is a bundle of static files the daemon serves on its own listener.
 * That makes three things worth pinning here, because each of them is a way to
 * end up with an install that reports success and serves nothing:
 *
 *   1. Verification and refusal. The bundle is checksum-verified against the web
 *      UI repository's own manifest, an archive with no index.html is refused
 *      rather than unpacked into place, and a missing manifest entry is the one
 *      non-fatal case (that release predates the asset).
 *   2. Versioned placement. Each version unpacks into its own directory, and a
 *      previous version is pruned only AFTER the daemon has been pointed at the
 *      new one — so a failed configure never leaves the machine with no bundle.
 *   3. Configuration by the binary, not by shell. The installer runs
 *      `goodvibes-daemon webui enable --bundle-dir <dir>` and reads its receipt;
 *      it never writes settings itself. A stub binary stands in here so the
 *      contract between the two is exercised without a real daemon.
 *
 * install.sh is sourced as a library (GOODVIBES_INSTALL_SH_LIB=1) with `fetch`
 * and `resolve_tag` replaced locally, so nothing touches the network, a real
 * install directory, or a running process.
 */

const INSTALL_SH = join(import.meta.dir, '../../../scripts/install.sh');
const WEBUI_TAG = 'v1.12.1';
const WEBUI_VERSION = '1.12.1';
const BUNDLE_ASSET = `goodvibes-webui-bundle-${WEBUI_VERSION}.tar.gz`;

const created: string[] = [];

function scratch(prefix: string): string {
  const dir = makeProjectTempDir(prefix);
  created.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of created) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

interface WebuiFixture {
  readonly root: string;
  readonly releaseDir: string;
  readonly workDir: string;
  readonly installDir: string;
  readonly webuiRoot: string;
  /** Where the stub daemon records the argv it was called with. */
  readonly callLog: string;
}

interface FixtureOptions {
  readonly omitIndexHtml?: boolean;
  readonly corruptChecksum?: boolean;
  readonly omitManifestEntry?: boolean;
  /** Makes the stub `goodvibes-daemon webui enable` exit non-zero. */
  readonly configureFails?: boolean;
  /** The URL the stub daemon reports in its receipt. */
  readonly reportedUrl?: string;
}

/**
 * Builds a fake web UI release: a real gzipped tar laid out the way the daemon
 * resolves it (`goodvibes-webui/index.html`), the repository's SHA256SUMS.txt,
 * and a stub `goodvibes-daemon` that answers `webui enable` with the receipt
 * shape the installer parses.
 */
function buildFixture(options: FixtureOptions = {}): WebuiFixture {
  const root = scratch('gv-webui');
  const releaseDir = join(root, 'release');
  const workDir = join(root, 'work');
  const installDir = join(root, 'bin');
  const stage = join(root, 'stage', 'goodvibes-webui');
  mkdirSync(releaseDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });
  mkdirSync(installDir, { recursive: true });
  mkdirSync(join(stage, 'assets'), { recursive: true });

  if (options.omitIndexHtml !== true) {
    writeFileSync(join(stage, 'index.html'), '<!doctype html><title>GoodVibes</title>\n');
  }
  writeFileSync(join(stage, 'assets', 'app.js'), 'console.log("app");\n');

  const archivePath = join(releaseDir, BUNDLE_ASSET);
  const tar = Bun.spawnSync(['tar', '-czf', archivePath, '-C', join(root, 'stage'), 'goodvibes-webui']);
  if (tar.exitCode !== 0) throw new Error(`fixture tar failed: ${tar.stderr.toString()}`);

  const digest = Bun.spawnSync(['sha256sum', archivePath]).stdout.toString().split(/\s+/)[0] ?? '';
  const recorded = options.corruptChecksum === true ? 'f'.repeat(64) : digest;
  writeFileSync(
    join(releaseDir, 'SHA256SUMS.txt'),
    options.omitManifestEntry === true ? 'deadbeef  something-else.txt\n' : `${recorded}  ${BUNDLE_ASSET}\n`,
  );

  const callLog = join(root, 'daemon-calls.txt');
  const url = options.reportedUrl ?? 'http://127.0.0.1:3421';
  const daemonStub = [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> "${callLog}"`,
    'echo "web UI: served by the daemon from $3"',
    `echo "  ${url}"`,
    'echo "  reachable from this machine only (the control-plane listener is bound to loopback)."',
    options.configureFails === true ? 'exit 1' : 'exit 0',
  ].join('\n');
  const daemonPath = join(installDir, 'goodvibes-daemon');
  writeFileSync(daemonPath, `${daemonStub}\n`);
  chmodSync(daemonPath, 0o755);

  return { root, releaseDir, workDir, installDir, webuiRoot: join(installDir, 'webui'), callLog };
}

/**
 * Sources install.sh as a library with `fetch` copying from a local release
 * fixture and `resolve_tag` answering a fixed tag, then runs install_webui.
 */
function runInstallWebui(
  fixture: WebuiFixture,
  env: Record<string, string> = {},
): { stdout: string; stderr: string; code: number } {
  const script = [
    `. "${INSTALL_SH}"`,
    'resolve_platform',
    // Stand in for the network: the "release" is a directory of files, resolved
    // by asset name — install_webui builds a real github.com URL, and the name
    // at the end of it is the only part a fixture can answer.
    `fetch() { cp "${fixture.releaseDir}/$(basename "$1")" "$2"; }`,
    // Stand in for the tag redirect.
    `resolve_tag() { printf '%s' "${WEBUI_TAG}"; }`,
    `WORKDIR="${fixture.workDir}"`,
    `INSTALL_DIR="${fixture.installDir}"`,
    `WEBUI_ROOT="${fixture.webuiRoot}"`,
    'install_webui',
    'echo "WEBUI_INSTALLED=$WEBUI_INSTALLED"',
    'echo "WEBUI_URL=$WEBUI_URL"',
  ].join('\n');
  const result = Bun.spawnSync(['sh', '-c', script], {
    env: {
      ...process.env,
      GOODVIBES_INSTALL_SH_LIB: '1',
      HOME: fixture.root,
      GOODVIBES_INSTALL_DIR: fixture.installDir,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    code: result.exitCode ?? -1,
  };
}

describe('install_webui — placement', () => {
  test('unpacks the bundle into a versioned directory under the install tree', () => {
    const fixture = buildFixture();
    const run = runInstallWebui(fixture);
    expect(run.code).toBe(0);
    const target = join(fixture.webuiRoot, WEBUI_VERSION);
    expect(existsSync(join(target, 'index.html'))).toBe(true);
    expect(existsSync(join(target, 'assets', 'app.js'))).toBe(true);
  });

  test('leaves no staging directory behind at the target path', () => {
    const fixture = buildFixture();
    runInstallWebui(fixture);
    expect(existsSync(`${join(fixture.webuiRoot, WEBUI_VERSION)}.incoming`)).toBe(false);
  });

  test('prunes a superseded version once the new one is configured', () => {
    const fixture = buildFixture();
    const stale = join(fixture.webuiRoot, '1.0.0');
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, 'index.html'), 'old\n');
    const run = runInstallWebui(fixture);
    expect(run.code).toBe(0);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(join(fixture.webuiRoot, WEBUI_VERSION, 'index.html'))).toBe(true);
  });
});

describe('install_webui — verification and refusal', () => {
  test('a checksum mismatch is fatal and installs nothing', () => {
    const fixture = buildFixture({ corruptChecksum: true });
    const run = runInstallWebui(fixture);
    expect(run.code).not.toBe(0);
    expect(`${run.stdout}${run.stderr}`).toContain('checksum mismatch');
    expect(existsSync(join(fixture.webuiRoot, WEBUI_VERSION))).toBe(false);
  });

  test('an archive with no index.html is refused rather than unpacked into place', () => {
    const fixture = buildFixture({ omitIndexHtml: true });
    const run = runInstallWebui(fixture);
    expect(run.code).not.toBe(0);
    expect(`${run.stdout}${run.stderr}`).toContain('index.html');
    expect(existsSync(join(fixture.webuiRoot, WEBUI_VERSION))).toBe(false);
  });

  test('a release with no manifest entry is a note, not a failure', () => {
    const fixture = buildFixture({ omitManifestEntry: true });
    const run = runInstallWebui(fixture);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('does not ship');
    expect(existsSync(join(fixture.webuiRoot, WEBUI_VERSION))).toBe(false);
    expect(run.stdout).toContain('WEBUI_INSTALLED=0');
  });

  test('GOODVIBES_WEBUI=0 skips the whole step and says so', () => {
    const fixture = buildFixture();
    const run = runInstallWebui(fixture, { GOODVIBES_WEBUI: '0' });
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('skipping the web UI');
    expect(existsSync(fixture.webuiRoot)).toBe(false);
  });
});

describe('install_webui — configuring the daemon', () => {
  test('configures by running the daemon binary, never by writing settings itself', () => {
    const fixture = buildFixture();
    runInstallWebui(fixture);
    const calls = readFileSync(fixture.callLog, 'utf8');
    expect(calls).toContain('webui enable --bundle-dir');
    expect(calls).toContain(join(fixture.webuiRoot, WEBUI_VERSION));
  });

  test("reports the URL from the daemon's own receipt", () => {
    const fixture = buildFixture({ reportedUrl: 'http://127.0.0.1:3421' });
    const run = runInstallWebui(fixture);
    expect(run.stdout).toContain('WEBUI_URL=http://127.0.0.1:3421');
    expect(run.stdout).toContain('WEBUI_INSTALLED=1');
  });

  test('a LAN-bound daemon reports its LAN origin rather than a loopback guess', () => {
    const fixture = buildFixture({ reportedUrl: 'http://desk.local:3421' });
    const run = runInstallWebui(fixture);
    expect(run.stdout).toContain('WEBUI_URL=http://desk.local:3421');
  });

  test('a failed configure keeps the bundle, says what to run, and does not claim success', () => {
    const fixture = buildFixture({ configureFails: true });
    const stale = join(fixture.webuiRoot, '1.0.0');
    mkdirSync(stale, { recursive: true });
    const run = runInstallWebui(fixture);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('goodvibes-daemon webui enable --bundle-dir');
    expect(existsSync(join(fixture.webuiRoot, WEBUI_VERSION, 'index.html'))).toBe(true);
    expect(run.stdout).toContain('WEBUI_INSTALLED=0');
    // The prune runs only after a successful configure, so the old directory
    // survives: a host is never left with no bundle at all.
    expect(existsSync(stale)).toBe(true);
  });
});
