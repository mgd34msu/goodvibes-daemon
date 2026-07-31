/**
 * Launcher support for the daemon package.
 *
 * The npm package carries source and this launcher; the daemon itself is a
 * compiled binary published as a GitHub release asset. The postinstall places
 * it, and this module is the self-heal path for an install whose lifecycle
 * script was blocked (which is the default for an untrusted global package under
 * bun): the first run downloads the release asset, verifies it against the
 * release's SHA256SUMS.txt, and caches it in vendor/.
 *
 * Asset names are the ones the daemon has always published
 * (`goodvibes-daemon-<os>-<arch>`), so the curl installer, the release manifest
 * and the daemon's own updater all keep resolving the same files.
 */
import { accessSync, chmodSync, constants, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const SUPPORTED_TARGETS = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64'];

export function isExecutable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function run(command, args) {
  const child = spawnSync(command, args, { stdio: 'inherit' });
  if (child.error) {
    throw child.error;
  }
  process.exit(child.status ?? 1);
}

export function isSourceCheckout(packageRoot) {
  return isExecutable(join(packageRoot, 'node_modules', '.bin', 'bun')) ||
    isExecutable(join(packageRoot, 'node_modules', '.bin', 'tsc')) ||
    fileExists(join(packageRoot, 'tsconfig.json'));
}

export function supportedTargetsText() {
  return SUPPORTED_TARGETS.join(', ');
}

/** The published asset name for a platform, unchanged from what the daemon has always released. */
export function resolveArtifactName(platform, arch) {
  if (platform === 'linux' && arch === 'x64') return 'goodvibes-daemon-linux-x64';
  if (platform === 'linux' && arch === 'arm64') return 'goodvibes-daemon-linux-arm64';
  if (platform === 'darwin' && arch === 'x64') return 'goodvibes-daemon-macos-x64';
  if (platform === 'darwin' && arch === 'arm64') return 'goodvibes-daemon-macos-arm64';
  return null;
}

export async function ensureVendoredBinary({ packageRoot, artifactName }) {
  const vendorDir = join(packageRoot, 'vendor');
  const destination = join(vendorDir, artifactName);
  if (isExecutable(destination)) {
    return destination;
  }

  const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  const releaseBaseUrl =
    process.env.GOODVIBES_RELEASE_BASE_URL?.trim() ||
    `${resolveRepositoryBaseUrl(pkg)}/releases/download/v${pkg.version}`;

  mkdirSync(vendorDir, { recursive: true });

  const checksumText = await downloadText(`${releaseBaseUrl}/SHA256SUMS.txt`);
  writeFileSync(join(vendorDir, 'SHA256SUMS.txt'), checksumText);
  const checksums = parseChecksumFile(checksumText);

  const tempDestination = `${destination}.download`;
  rmSync(tempDestination, { force: true });

  try {
    const binary = await downloadBuffer(`${releaseBaseUrl}/${artifactName}`);
    const actual = sha256(binary);
    const expected = checksums.get(artifactName);
    if (expected && expected !== actual) {
      throw new Error(`checksum mismatch for ${artifactName}: expected ${expected}, got ${actual}`);
    }
    writeFileSync(tempDestination, binary);
    prepareBinary(tempDestination);
    rmSync(destination, { force: true });
    writeFileSync(destination, readFileSync(tempDestination));
    prepareBinary(destination);
  } finally {
    rmSync(tempDestination, { force: true });
  }

  return destination;
}

function fileExists(path) {
  try {
    accessSync(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function prepareBinary(path) {
  if (process.platform !== 'win32') {
    chmodSync(path, 0o755);
  }
}

function resolveRepositoryBaseUrl(pkg) {
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

async function downloadText(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`download failed (${response.status}) for ${url}`);
  }
  return await response.text();
}

async function downloadBuffer(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`download failed (${response.status}) for ${url}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function parseChecksumFile(contents) {
  const checksums = new Map();
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
    if (!match) continue;
    checksums.set(match[2], match[1].toLowerCase());
  }
  return checksums;
}
