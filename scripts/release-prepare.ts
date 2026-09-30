#!/usr/bin/env bun
/**
 * release:prepare, the one command that makes a version bump complete.
 *
 * Files that carry the version are rewritten here, at the bump, instead of
 * being policed by a red CI run on every push. A stale stamp is fixed by
 * regenerating it; it is not a regression.
 *
 * Usage:
 *   bun run release:prepare --patch | --minor | --major
 *   bun run release:prepare --version 1.30.0     bump to an exact version
 *   bun run release:prepare --no-bump            regenerate at the current version
 *   bun run release:prepare --no-bump --no-changelog
 *                                                the toolchain release-cut sync
 *                                                command (release-cut bumps the
 *                                                manifest and writes the
 *                                                changelog section itself)
 *
 * Steps:
 *   1. package.json version (unless --no-bump)
 *   2. version stamps: the compiled-binary fallback in src/version.ts and the
 *      README badge (scripts/project-surfaces.ts, the same sync prebuild runs)
 *   3. a `## [X.Y.Z] - YYYY-MM-DD` CHANGELOG section scaffold, above the newest
 *      section, when none exists for the version (unless --no-changelog)
 *
 * It never commits, tags or pushes. Review `git diff` afterwards and write the
 * release notes into the scaffolded section.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { syncProjectSurfaces } from './project-surfaces.ts';

const ROOT = join(import.meta.dir, '..');

export type BumpKind = 'patch' | 'minor' | 'major';

/** The next semver for a bump kind. Pre-release suffixes are dropped. */
export function bumpVersion(current: string, kind: BumpKind): string {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(current);
  if (!match) throw new Error(`package.json version is not semver: ${current}`);
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (kind === 'major') return `${major + 1}.0.0`;
  if (kind === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/**
 * CHANGELOG text with a section for `version`, inserted above the newest
 * `## ` heading. Unchanged when a section for the version already exists.
 */
export function scaffoldChangelogText(changelog: string, version: string, date: string): string {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`^##\\s*\\[${escaped}\\]`, 'm').test(changelog)) return changelog;
  const section = `## [${version}] - ${date}\n\n### Changes\n\n- \n\n`;
  const first = changelog.search(/^## /m);
  if (first === -1) return `${changelog.trimEnd()}\n\n${section}`;
  return `${changelog.slice(0, first)}${section}${changelog.slice(first)}`;
}

interface PrepareArgs {
  readonly bump: BumpKind | { readonly exact: string } | null;
  readonly changelog: boolean;
}

function parseArgs(argv: readonly string[]): PrepareArgs {
  const kinds = (['patch', 'minor', 'major'] as const).filter((kind) => argv.includes(`--${kind}`));
  const versionIdx = argv.indexOf('--version');
  const exact = versionIdx >= 0 ? argv[versionIdx + 1] : undefined;
  const noBump = argv.includes('--no-bump');
  const chosen = kinds.length + (exact !== undefined ? 1 : 0) + (noBump ? 1 : 0);
  if (chosen !== 1 || (versionIdx >= 0 && (exact === undefined || !/^\d+\.\d+\.\d+$/.test(exact)))) {
    throw new Error('Usage: bun run release:prepare (--patch | --minor | --major | --version X.Y.Z | --no-bump) [--no-changelog]');
  }
  return {
    bump: noBump ? null : exact !== undefined ? { exact } : kinds[0]!,
    changelog: !argv.includes('--no-changelog'),
  };
}

function main(argv: readonly string[]): void {
  const args = parseArgs(argv);
  const pkgPath = join(ROOT, 'package.json');
  const pkgText = readFileSync(pkgPath, 'utf8');
  const current = (JSON.parse(pkgText) as { version: string }).version;

  let version = current;
  if (args.bump !== null) {
    version = typeof args.bump === 'string' ? bumpVersion(current, args.bump) : args.bump.exact;
    // A textual replace of the one version field keeps the manifest's own
    // formatting (key order, escapes) byte-identical apart from the number.
    const next = pkgText.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`);
    writeFileSync(pkgPath, next);
    console.log(`[release:prepare] package.json ${current} -> ${version}`);
  }

  syncProjectSurfaces(ROOT);

  if (args.changelog) {
    const changelogPath = join(ROOT, 'CHANGELOG.md');
    const before = readFileSync(changelogPath, 'utf8');
    const after = scaffoldChangelogText(before, version, new Date().toISOString().slice(0, 10));
    if (after !== before) {
      writeFileSync(changelogPath, after);
      console.log(`[release:prepare] CHANGELOG.md: scaffolded ## [${version}]; write the notes before pushing.`);
    } else {
      console.log(`[release:prepare] CHANGELOG.md already has a ## [${version}] section.`);
    }
  }
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`[release:prepare] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
