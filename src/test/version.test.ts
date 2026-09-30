/**
 * src/version.ts reports this package's own version when run from source, and
 * falls back to the prebuild stamp only when the package.json beside it is not
 * this package's (a compiled binary's virtual root can land on a bundled
 * dependency's manifest).
 *
 * In this checkout the stamp and package.json usually agree, which would hide
 * the difference, so the real file is copied next to a package.json whose
 * version the stamp cannot match.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeProjectTempDir } from './helpers/project-temp.ts';

const VERSION_SOURCE = join(import.meta.dir, '..', 'version.ts');
const root = makeProjectTempDir('gv-version-source');
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** Lay out <dir>/package.json + <dir>/src/version.ts and import that copy. */
async function versionBeside(dir: string, manifest: Record<string, unknown>): Promise<string> {
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest));
  copyFileSync(VERSION_SOURCE, join(dir, 'src', 'version.ts'));
  const mod = await import(join(dir, 'src', 'version.ts')) as { VERSION: string };
  return mod.VERSION;
}

const stamped = /let _version = '([^']*)'/.exec(readFileSync(VERSION_SOURCE, 'utf8'))![1]!;

describe('the version a source run reports', () => {
  test('is the version in this package\'s package.json', async () => {
    const version = `${stamped}-source-run`;
    expect(await versionBeside(join(root, 'own'), { name: '@pellux/goodvibes-daemon', version })).toBe(version);
  });

  test('is the stamped fallback when the manifest beside it belongs to another package', async () => {
    expect(await versionBeside(join(root, 'stray'), { name: 'some-bundled-dependency', version: '0.0.0' })).toBe(stamped);
  });

  test('matches package.json in this checkout', async () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, '..', '..', 'package.json'), 'utf8')) as { version: string };
    const { VERSION } = await import('../version.ts');
    expect(VERSION).toBe(pkg.version);
  });
});
