#!/usr/bin/env bun
/**
 * Changelog gate: verifies that CHANGELOG.md contains a section header
 * matching the current package.json version before release.
 *
 * The section-matching logic (both the "## [1.2.3]" and "## 1.2.3" heading
 * conventions) is owned by @pellux/goodvibes-toolchain's changelog gate, driven
 * by this repo's toolchain.config.json (releaseCut.changelogHeading: "bracket").
 *
 * Usage:
 *   bun scripts/check-changelog.ts
 *
 * Exit 0 when the section is present. Exit 1 with a clear error when missing.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadToolchainConfig, runChangelogGate, type ChangelogHeading } from '@pellux/goodvibes-toolchain';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const pkgPath = join(root, 'package.json');
const changelogPath = join(root, 'CHANGELOG.md');

if (!existsSync(pkgPath)) {
  console.error(`[changelog-check] ERROR: package.json not found at ${pkgPath}`);
  process.exit(1);
}

if (!existsSync(changelogPath)) {
  console.error(
    `[changelog-check] ERROR: CHANGELOG.md not found at ${changelogPath}\n` +
      '  Create it with a "## [X.Y.Z] - YYYY-MM-DD" section before releasing.',
  );
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: unknown };
const version = pkg.version;
if (typeof version !== 'string' || version.length === 0) {
  console.error('[changelog-check] ERROR: could not read version from package.json');
  process.exit(1);
}

const config = loadToolchainConfig(root);
const heading: ChangelogHeading = config.releaseCut?.changelogHeading ?? 'bracket';
const changelog = readFileSync(changelogPath, 'utf8');
const result = runChangelogGate(changelog, version, heading);

if (!result.ok) {
  console.error(`[changelog-check] ${result.detail}`);
  process.exit(1);
}

console.log(`[changelog-check] OK — ${result.detail}`);
