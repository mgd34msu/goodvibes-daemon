#!/usr/bin/env bun
/**
 * publish-github-mirror.ts — publishes a GitHub Packages mirror of this
 * package so the repository's Packages sidebar shows a published artifact.
 *
 * npmjs stays the canonical registry consumers pin against
 * (@pellux/goodvibes-daemon, unchanged). GitHub Packages has a hard rule the
 * npmjs name cannot satisfy here: a package's scope must equal the repository
 * owner's login, and `pellux` is a different GitHub account than this repo's
 * owner (mgd34msu) — so the mirror publishes under a different name,
 * @mgd34msu/goodvibes-daemon, to the registry npm.pkg.github.com. Nothing
 * about the npmjs publish changes; this is an additional, secondary artifact.
 *
 * What it does:
 *   1. Obtains a tarball of this package — either a prebuilt one passed via
 *      --tarball, or a fresh `npm pack` of the current tree.
 *   2. Extracts it to a scratch directory and rewrites its package.json:
 *      name -> @mgd34msu/goodvibes-daemon, publishConfig.registry -> the
 *      GitHub Packages registry (added if absent, overwritten if present).
 *   3. Repacks the rewritten package and publishes that tarball with
 *      `npm publish --registry=https://npm.pkg.github.com`.
 *
 * Idempotent: if the mirror registry already serves this exact version, the
 * script logs one line and exits 0 instead of re-publishing (this uses the
 * same @pellux/goodvibes-toolchain runPublishPackage/getPublishedVersion
 * primitives publish-check.ts and release.ts already lean on elsewhere in
 * this repo, rather than a bespoke duplicate of that check).
 *
 * Auth: a publish token via NODE_AUTH_TOKEN, falling back to GITHUB_TOKEN.
 * Neither set -> exit 1. The token is never written to disk: this script
 * writes a scratch .npmrc containing the literal reference
 * `${NODE_AUTH_TOKEN}` and points NPM_CONFIG_USERCONFIG at it, so npm
 * resolves the real value from the environment at invocation time — the same
 * mechanism actions/setup-node's `registry-url` option wires up in CI, kept
 * here too so this script is self-sufficient outside that CI step (e.g. a
 * local one-shot run).
 *
 * Usage:
 *   bun run scripts/publish-github-mirror.ts                    # packs fresh
 *   bun run scripts/publish-github-mirror.ts --tarball <path>    # publishes a given tarball
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { consoleLogger, realExec, runPublishPackage } from '@pellux/goodvibes-toolchain';

const root = process.cwd();
const REGISTRY = 'https://npm.pkg.github.com';
const MIRROR_NAME = '@mgd34msu/goodvibes-daemon';

function flagValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i < 0 ? undefined : process.argv[i + 1];
}

type NpmPackEntry = { filename: string };

/**
 * `npm pack --json`'s top-level shape has changed across npm versions — some
 * ship an array of entries, this repo's npm (12.x) ships an object keyed by
 * package id/name. Accept either rather than pinning to one.
 */
function firstPackEntry(parsed: unknown): NpmPackEntry | undefined {
  if (Array.isArray(parsed)) return parsed[0] as NpmPackEntry | undefined;
  if (parsed !== null && typeof parsed === 'object') {
    const values = Object.values(parsed as Record<string, unknown>);
    return values[0] as NpmPackEntry | undefined;
  }
  return undefined;
}

function runNpmPack(cwd: string, destDir: string): string {
  const out = execFileSync('npm', ['pack', '--json', '--pack-destination', destDir], {
    cwd,
    encoding: 'utf8',
  });
  const entry = firstPackEntry(JSON.parse(out));
  if (!entry || typeof entry.filename !== 'string') {
    throw new Error(`npm pack (cwd=${cwd}) produced an unexpected result: ${out}`);
  }
  return join(destDir, entry.filename);
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  name?: unknown;
  version?: unknown;
};
const version = pkg.version;
if (typeof version !== 'string' || version.trim().length === 0) {
  consoleLogger.error('publish-github-mirror: package.json has no version');
  process.exit(1);
}

const token = process.env.NODE_AUTH_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim();
if (!token) {
  consoleLogger.error('publish-github-mirror: no publish token found — set NODE_AUTH_TOKEN or GITHUB_TOKEN');
  process.exit(1);
}
// Ensure the env var name the scratch .npmrc references below actually
// resolves, whichever of the two variables the caller supplied.
process.env.NODE_AUTH_TOKEN = token;

const scratchBase = join(root, '.test-tmp');
mkdirSync(scratchBase, { recursive: true });
const scratchRoot = mkdtempSync(join(scratchBase, 'github-mirror-'));

function cleanup(): void {
  rmSync(scratchRoot, { recursive: true, force: true });
}

function fail(message: string): never {
  consoleLogger.error(`publish-github-mirror: ${message}`);
  cleanup();
  process.exit(1);
}

try {
  // Scratch .npmrc: the literal string `${NODE_AUTH_TOKEN}` is written, never
  // the token value itself — npm substitutes it from the environment when it
  // reads the file at publish time.
  const npmrcPath = join(scratchRoot, '.npmrc');
  writeFileSync(npmrcPath, `//npm.pkg.github.com/:_authToken=\${NODE_AUTH_TOKEN}\n`);
  process.env.NPM_CONFIG_USERCONFIG = npmrcPath;

  // 1) Obtain the source tarball.
  const givenTarball = flagValue('--tarball');
  let sourceTarball: string;
  if (givenTarball !== undefined) {
    sourceTarball = resolve(givenTarball);
    if (!existsSync(sourceTarball)) fail(`--tarball path does not exist: ${sourceTarball}`);
  } else {
    sourceTarball = runNpmPack(root, scratchRoot);
  }
  consoleLogger.info(`publish-github-mirror: source tarball ${sourceTarball}`);

  // 2) Extract it and rewrite package.json.
  const extractDir = join(scratchRoot, 'extracted');
  mkdirSync(extractDir, { recursive: true });
  execFileSync('tar', ['-xzf', sourceTarball, '-C', extractDir], { encoding: 'utf8' });
  const packageDir = join(extractDir, 'package');
  if (!existsSync(packageDir)) fail(`tarball did not extract a package/ directory: ${sourceTarball}`);

  const pkgJsonPath = join(packageDir, 'package.json');
  const staged = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as Record<string, unknown>;
  if (staged.version !== version) {
    fail(
      `tarball version (${String(staged.version)}) does not match this tree's package.json version (${version}) — ` +
        'pass a --tarball that matches, or omit it to pack the current tree fresh',
    );
  }
  const originalName = staged.name;
  staged.name = MIRROR_NAME;
  const existingPublishConfig =
    typeof staged.publishConfig === 'object' && staged.publishConfig !== null
      ? (staged.publishConfig as Record<string, unknown>)
      : {};
  staged.publishConfig = { ...existingPublishConfig, registry: REGISTRY };
  writeFileSync(pkgJsonPath, `${JSON.stringify(staged, null, 2)}\n`);
  consoleLogger.info(`publish-github-mirror: staged ${String(originalName)}@${version} as ${MIRROR_NAME}@${version}`);

  // 3) Repack the rewritten package.
  const mirrorTarball = runNpmPack(packageDir, scratchRoot);
  consoleLogger.info(`publish-github-mirror: repacked ${mirrorTarball}`);

  // 4) Publish (idempotent — skips if the registry already serves this version).
  const result = runPublishPackage({
    cwd: root,
    name: MIRROR_NAME,
    version,
    registry: REGISTRY,
    tarballPath: mirrorTarball,
    exec: realExec,
    logger: consoleLogger,
  });
  consoleLogger.info(`publish-github-mirror: ${result.detail}`);
  cleanup();
  process.exit(result.ok ? 0 : 1);
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}
