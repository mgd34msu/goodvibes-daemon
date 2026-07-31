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
 *
 * The sqlite-vec native addon gets the same self-heal: `resolveSqliteVecPath()`
 * (platform/state/sqlite-vec-loader.ts, reached from a compiled binary) expects
 * it at `<execDir>/lib/sqlite-vec-<platform>-<arch>/vec0.<suffix>` —
 * `vendor/lib/...` once the binary above is placed there — and a blocked
 * postinstall never staged it either. Without this, a self-healed install
 * would get the daemon binary back but stay on lexical-only search forever.
 */
import { accessSync, chmodSync, constants, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const SUPPORTED_TARGETS = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64'];

/** Names the sqlite-vec addon for a platform/arch — mirrors resolveSqliteVecAsset
 * in src/runtime/release-artifacts.ts. Reimplemented (rather than imported) so
 * this launcher never depends on a TypeScript source file: it must keep
 * working from the packaged bin/ directory alone, with no bundler step and no
 * node_modules resolution of repo-relative .ts paths. */
export function resolveSqliteVecAddonName(platform, arch) {
  if ((platform !== 'linux' && platform !== 'darwin') || (arch !== 'x64' && arch !== 'arm64')) {
    return null;
  }
  const suffix = platform === 'darwin' ? 'dylib' : 'so';
  const dirName = `sqlite-vec-${platform}-${arch}`;
  return { assetName: `${dirName}.${suffix}`, dirName, fileName: `vec0.${suffix}` };
}

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

/**
 * Self-heal counterpart to `ensureVendoredBinary` for the sqlite-vec native
 * addon. Same shape, same verification posture (a missing manifest entry does
 * not block the install, matching `ensureVendoredBinary` above), same
 * vendor/ destination — placed at `vendor/lib/sqlite-vec-<platform>-<arch>/
 * vec0.<suffix>`, which is exactly where `resolveSqliteVecPath()` looks
 * relative to the vendored binary this module also places. A platform/arch
 * with no addon (`resolveSqliteVecAddonName` returns null) is a no-op, not an
 * error — same as an unsupported binary target.
 */
export async function ensureVendoredSqliteVecAddon({ packageRoot, platform, arch }) {
  const asset = resolveSqliteVecAddonName(platform, arch);
  if (!asset) return null;

  const addonDir = join(packageRoot, 'vendor', 'lib', asset.dirName);
  const destination = join(addonDir, asset.fileName);
  if (fileExists(destination)) {
    return destination;
  }

  const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  const releaseBaseUrl =
    process.env.GOODVIBES_RELEASE_BASE_URL?.trim() ||
    `${resolveRepositoryBaseUrl(pkg)}/releases/download/v${pkg.version}`;

  mkdirSync(addonDir, { recursive: true });

  const checksumText = await downloadText(`${releaseBaseUrl}/SHA256SUMS.txt`);
  const checksums = parseChecksumFile(checksumText);

  const tempDestination = `${destination}.download`;
  rmSync(tempDestination, { force: true });

  try {
    const addon = await downloadBuffer(`${releaseBaseUrl}/${asset.assetName}`);
    const actual = sha256(addon);
    const expected = checksums.get(asset.assetName);
    if (expected && expected !== actual) {
      throw new Error(`checksum mismatch for ${asset.assetName}: expected ${expected}, got ${actual}`);
    }
    writeFileSync(tempDestination, addon);
    rmSync(destination, { force: true });
    writeFileSync(destination, readFileSync(tempDestination));
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
