#!/usr/bin/env bun
/**
 * postinstall — place the compiled daemon binary for this platform.
 *
 * The npm package carries source and the launcher; the daemon itself is a
 * compiled binary published as a GitHub release asset of THIS repository. This
 * downloads the one matching asset, verifies it against the release's
 * SHA256SUMS.txt, and caches it in vendor/ where bin/goodvibes-daemon finds it.
 *
 * What it deliberately does NOT do, unlike the terminal app's postinstall it is
 * modelled on: deploy skills, deploy agents, or fetch the wake-word model. The
 * skills and agents are surface artifacts and stay with the terminal app's
 * package. The wake-word model is fetched by the daemon itself — the installer
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
import { CHECKSUM_MANIFEST_NAME, parseChecksumFile, resolveArtifactNames, sha256, verifyChecksum } from '../src/runtime/release-artifacts.ts';

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

async function main() {
  await installPlatformBinary();
}

// Guarded so this module can be imported by tests (to exercise verifyChecksum,
// parseChecksumFile and friends) without triggering a real network install as a
// side effect of the import.
if (import.meta.main) {
  await main();
}

export { verifyChecksum, parseChecksumFile, sha256, resolveArtifactNames, CHECKSUM_MANIFEST_NAME, installPlatformBinary };
