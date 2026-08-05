/**
 * control-plane-store-location.test.ts
 *
 * The daemon must have ONE control-plane store, and it must be the
 * surface-scoped one.
 *
 * What was on an owner machine: a session store at
 * `~/.goodvibes/tui/control-plane/sessions.json` that the broker serves, and a
 * second at `~/.goodvibes/control-plane/sessions.json` — 274 KB against the
 * live 55 KB, holding sessions the live one did not, last written the second
 * the current daemon started, and read by nothing. It looked alive because the
 * SDK's boot-time legacy fold targeted it unconditionally on every start.
 *
 * The SDK now folds into the store the broker names and sweeps the pre-split
 * one aside with a receipt. That fix rests on a fact this repository owns and
 * this file pins: the two paths are DIFFERENT here, because this daemon's
 * stores are surface-scoped and the unscoped helper adds no surface segment.
 *
 * A source pin rather than a live boot, for the same reason
 * composition-parity.test.ts uses one: the difference is a composition fact
 * with no return value to inspect, and booting a daemon to observe it would
 * write to a real home.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createShellPathService } from '@/runtime/index.ts';
import { GOODVIBES_DAEMON_SURFACE_ROOT } from '../../config/surface.ts';

const ROOT = resolve(import.meta.dir, '../../..');
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');

describe('the daemon serves exactly one, surface-scoped control-plane store', () => {
  test('the session broker is built on the surface-scoped path, not the unscoped one', () => {
    const services = read('src/runtime/services.ts');
    const idx = services.indexOf('new SharedSessionBroker({');
    expect(idx, 'SharedSessionBroker construction not found').toBeGreaterThan(-1);
    const construction = services.slice(idx, idx + 400);

    expect(construction).toContain(
      "resolveProjectPath(GOODVIBES_DAEMON_SURFACE_ROOT, 'control-plane', 'sessions.json')",
    );
    // The unscoped helper takes no surface segment of its own. A broker built on
    // it is the defect, restored.
    expect(construction).not.toContain("resolveUserPath('control-plane'");
  });

  test('the surface root is a non-empty segment, so the scoped and unscoped paths cannot collapse onto each other', () => {
    expect(GOODVIBES_DAEMON_SURFACE_ROOT.length).toBeGreaterThan(0);

    const shellPaths = createShellPathService({
      workingDirectory: '/nowhere/home',
      homeDirectory: '/nowhere/home',
    });
    const live = shellPaths.resolveProjectPath(GOODVIBES_DAEMON_SURFACE_ROOT, 'control-plane', 'sessions.json');
    const preSplit = shellPaths.resolveUserPath('control-plane', 'sessions.json');

    expect(live).not.toBe(preSplit);
    expect(live).toContain(`/${GOODVIBES_DAEMON_SURFACE_ROOT}/control-plane/`);
    expect(preSplit).not.toContain(`/${GOODVIBES_DAEMON_SURFACE_ROOT}/`);
  });

  test('the surface root still carries the reason it is what it is', () => {
    // Renaming this constant does not move a byte of state; it makes the daemon
    // stop finding state that has been accumulating for months. The header says
    // so, and that header is the only thing standing between a tidy-up and a
    // machine that comes up looking brand new.
    const surface = read('src/config/surface.ts');
    expect(surface).toContain('migration');
  });
});
