#!/usr/bin/env bun
/**
 * postinstall — place the compiled daemon binary AND the sqlite-vec native
 * addon for this platform.
 *
 * The npm package carries source and the launcher; the daemon itself is a
 * compiled binary published as a GitHub release asset of THIS repository. This
 * downloads the one matching binary asset, verifies it against the release's
 * SHA256SUMS.txt, and caches it in vendor/ where bin/goodvibes-daemon finds it.
 *
 * The sqlite-vec addon gets the identical treatment for the identical reason:
 * `resolveSqliteVecPath()` (platform/state/sqlite-vec-loader.ts, reached from a
 * compiled binary) looks for it at `<execDir>/lib/sqlite-vec-<platform>-<arch>/
 * vec0.<suffix>` — `<execDir>` being vendor/ once bin/goodvibes-daemon has
 * placed the binary there — and nothing else stages it for an npm install. Skip
 * this and the addon is silently absent forever: the launcher's self-heal
 * (bin/launcher-support.js) only ever re-fetches the BINARY, and the daemon's
 * own auto-updater only refreshes the addon if a copy already exists on disk
 * (there is never a first one to refresh). The daemon degrades to lexical
 * search plus a log warning rather than failing loudly, so the loss is easy to
 * miss — this download is what gives every npm install the same vector search
 * a curl/install.sh install gets.
 *
 * What it deliberately does NOT do: deploy skills, deploy agents, or fetch the
 * wake-word model. Skills and agents are surface artifacts that ship with the
 * terminal app's own package, not this one. The wake-word model is fetched by
 * the daemon itself — the installer
 * runs `goodvibes-daemon provision-wake-model` on the placed binary, and every
 * daemon start retries whatever is still missing — so pulling it here as well
 * would be a second copy of a pin that already has one owner.
 *
 * A source checkout is skipped: a repository clone is a development tree, not an
 * installation.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CHECKSUM_MANIFEST_NAME,
  parseChecksumFile,
  resolveArtifactNames,
  resolveSqliteVecAsset,
  sha256,
  verifyChecksum,
} from '@pellux/goodvibes-sdk/platform/runtime/self-update';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');
const pkg = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'));
const noDownload = process.argv.includes('--no-download') || process.env.GOODVIBES_SKIP_BINARY_DOWNLOAD === '1';

function isSourceCheckout() {
  return existsSync(join(projectRoot, '.git')) || existsSync(join(projectRoot, 'bun.lock'));
}

function prepareBinary(path) {
  if (process.platform !== 'win32') {
    chmodSync(path, 0o755);
  }
}

function resolveRepositoryBaseUrl() {
  const repositoryUrl = typeof pkg.repository?.url === 'string' ? pkg.repository.url : '';
  const normalized = repositoryUrl
    .replace(/^git\+/, '')
    .replace(/\.git$/, '')
    .replace(/^git@github\.com:/, 'https://github.com/');
  if (!normalized.startsWith('https://github.com/')) {
    throw new Error(`unsupported repository URL for binary downloads: ${repositoryUrl || '(missing)'}`);
  }
  return normalized;
}

async function downloadFile(url, destination) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`download failed (${response.status}) for ${url}`);
  }
  writeFileSync(destination, Buffer.from(await response.arrayBuffer()));
}

async function downloadText(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`download failed (${response.status}) for ${url}`);
  }
  return await response.text();
}

async function installPlatformBinary() {
  const artifacts = resolveArtifactNames(process.platform, process.arch);
  if (!artifacts) {
    console.log(`postinstall: no prebuilt binary for ${process.platform}-${process.arch}; skipping binary install`);
    return;
  }

  if (noDownload) {
    console.log('postinstall: skipping binary install (--no-download)');
    return;
  }

  if (isSourceCheckout()) {
    console.log('postinstall: source checkout detected; skipping release-binary install');
    return;
  }

  const vendorDir = join(projectRoot, 'vendor');
  mkdirSync(vendorDir, { recursive: true });

  const localSourceDir = process.env.GOODVIBES_ASSET_SOURCE_DIR?.trim();
  if (localSourceDir) {
    const sourcePath = join(localSourceDir, artifacts.daemon);
    if (!existsSync(sourcePath)) {
      throw new Error(`missing local release artifact for postinstall smoke: ${sourcePath}`);
    }
    const destination = join(vendorDir, artifacts.daemon);
    copyFileSync(sourcePath, destination);
    prepareBinary(destination);
    console.log(`postinstall: installed local smoke-test binary for ${process.platform}-${process.arch}`);
    return;
  }

  const releaseBaseUrl =
    process.env.GOODVIBES_RELEASE_BASE_URL?.trim() ||
    `${resolveRepositoryBaseUrl()}/releases/download/v${pkg.version}`;

  const checksumText = await downloadText(`${releaseBaseUrl}/${CHECKSUM_MANIFEST_NAME}`);
  writeFileSync(join(vendorDir, CHECKSUM_MANIFEST_NAME), checksumText);
  const checksums = parseChecksumFile(checksumText);

  const destination = join(vendorDir, artifacts.daemon);
  const tempDestination = `${destination}.download`;
  rmSync(tempDestination, { force: true });
  await downloadFile(`${releaseBaseUrl}/${artifacts.daemon}`, tempDestination);
  const actual = sha256(readFileSync(tempDestination));
  const expected = checksums.get(artifacts.daemon);
  try {
    // A missing manifest entry is as fatal as a mismatch: an unverifiable
    // download is not a verified one.
    verifyChecksum(artifacts.daemon, actual, expected);
  } catch (error) {
    rmSync(tempDestination, { force: true });
    throw error;
  }
  rmSync(destination, { force: true });
  copyFileSync(tempDestination, destination);
  rmSync(tempDestination, { force: true });
  prepareBinary(destination);

  console.log(`postinstall: installed the release daemon binary for ${process.platform}-${process.arch}`);
}

/**
 * Places the sqlite-vec native addon at `vendor/lib/sqlite-vec-<platform>-
 * <arch>/vec0.<suffix>` — see the file banner for why this is a separate,
 * equally load-bearing step from `installPlatformBinary`, not an optional
 * extra. Mirrors that function's gating and verification exactly (skip on an
 * unsupported target, `--no-download`, or a source checkout; the smoke-test
 * local-source-dir seam; checksum-verify-then-place with no partial state on
 * failure) so the two artifacts never drift in how they are trusted.
 */
async function installSqliteVecAddon() {
  const asset = resolveSqliteVecAsset(process.platform, process.arch);
  if (!asset) {
    console.log(`postinstall: no sqlite-vec addon for ${process.platform}-${process.arch}; skipping addon install`);
    return;
  }

  if (noDownload) {
    console.log('postinstall: skipping sqlite-vec addon install (--no-download)');
    return;
  }

  if (isSourceCheckout()) {
    console.log('postinstall: source checkout detected; skipping release sqlite-vec addon install');
    return;
  }

  const addonDir = join(projectRoot, 'vendor', 'lib', asset.dirName);
  mkdirSync(addonDir, { recursive: true });
  const destination = join(addonDir, asset.fileName);

  const localSourceDir = process.env.GOODVIBES_ASSET_SOURCE_DIR?.trim();
  if (localSourceDir) {
    const sourcePath = join(localSourceDir, 'lib', asset.dirName, asset.fileName);
    if (!existsSync(sourcePath)) {
      throw new Error(`missing local sqlite-vec addon for postinstall smoke: ${sourcePath}`);
    }
    copyFileSync(sourcePath, destination);
    console.log(`postinstall: installed local smoke-test sqlite-vec addon for ${process.platform}-${process.arch}`);
    return;
  }

  const releaseBaseUrl =
    process.env.GOODVIBES_RELEASE_BASE_URL?.trim() ||
    `${resolveRepositoryBaseUrl()}/releases/download/v${pkg.version}`;

  // A fresh manifest fetch (rather than sharing the one `installPlatformBinary`
  // already wrote to vendor/) keeps this function independently correct and
  // testable — the extra request is a one-time postinstall cost, not a
  // per-boot one.
  const checksumText = await downloadText(`${releaseBaseUrl}/${CHECKSUM_MANIFEST_NAME}`);
  const checksums = parseChecksumFile(checksumText);

  const tempDestination = `${destination}.download`;
  rmSync(tempDestination, { force: true });
  await downloadFile(`${releaseBaseUrl}/${asset.assetName}`, tempDestination);
  const actual = sha256(readFileSync(tempDestination));
  const expected = checksums.get(asset.assetName);
  try {
    verifyChecksum(asset.assetName, actual, expected);
  } catch (error) {
    rmSync(tempDestination, { force: true });
    throw error;
  }
  rmSync(destination, { force: true });
  copyFileSync(tempDestination, destination);
  rmSync(tempDestination, { force: true });

  console.log(`postinstall: installed the sqlite-vec addon for ${process.platform}-${process.arch}`);
}

async function main() {
  await installPlatformBinary();
  await installSqliteVecAddon();
}

// Guarded so this module can be imported by tests (to exercise verifyChecksum,
// parseChecksumFile and friends) without triggering a real network install as a
// side effect of the import.
if (import.meta.main) {
  await main();
}

export {
  verifyChecksum,
  parseChecksumFile,
  sha256,
  resolveArtifactNames,
  resolveSqliteVecAsset,
  CHECKSUM_MANIFEST_NAME,
  installPlatformBinary,
  installSqliteVecAddon,
};
