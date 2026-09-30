/**
 * control-plane-store-location.test.ts
 *
 * The daemon must have ONE control-plane store, and it must be the
 * surface-scoped one.
 *
 * What was on an owner machine: a session store at
 * `~/.goodvibes/tui/control-plane/sessions.json` that the broker serves, and a
 * second at `~/.goodvibes/control-plane/sessions.json`, 274 KB against the
 * live 55 KB, holding sessions the live one did not, last written the second
 * the current daemon started, and read by nothing. It looked alive because the
 * SDK's boot-time legacy fold targeted it unconditionally on every start.
 *
 * The SDK now folds into the store the broker names and sweeps the pre-split
 * one aside with a receipt. That fix rests on a fact this repository owns: the
 * two paths are DIFFERENT here, because this daemon's stores are surface-scoped
 * and the unscoped helper adds no surface segment.
 */
import { describe, expect, test } from 'bun:test';
import { createShellPathService } from '@/runtime/index.ts';
import { controlPlaneStorePath } from '@pellux/goodvibes-sdk/platform/control-plane';
import { sharedWorkspaceRegisterPath } from '@pellux/goodvibes-sdk/platform/workspace';
import { sharedWorkspaceRegistrationStorePath } from '../../runtime/trust/checkpoint-eligibility.ts';
import { GOODVIBES_DAEMON_SURFACE_ROOT } from '../../config/surface.ts';

describe('the daemon serves exactly one, surface-scoped control-plane store', () => {
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

  test('the repointed control-plane stores resolve under the surface segment, not the pre-split orphan', () => {
    const shellPaths = createShellPathService({
      workingDirectory: '/nowhere/home',
      homeDirectory: '/nowhere/home',
    });
    const scopedPrefix = `/${GOODVIBES_DAEMON_SURFACE_ROOT}/control-plane/`;

    // The pairing-token store this daemon writes.
    const pairingTokens = controlPlaneStorePath(shellPaths, GOODVIBES_DAEMON_SURFACE_ROOT, 'pairing-tokens.json');
    expect(pairingTokens).toContain(scopedPrefix);

    // The workspace register is the ONE deliberate exception: its reader lives
    // in this repo, its writer in the SDK, and goodvibes-agent reads and writes
    // the same file. It lives in the shared tier so all three resolve one file;
    // scoping it here would move it out from under the agent and leave
    // checkpoint eligibility refusing workspaces the operator had registered.
    //
    // This reader FALLS BACK to the pre-split path while that is still the only
    // copy, so on a machine the daemon has not yet folded it reports the
    // operator's workspaces rather than none. With neither file present it
    // names the shared path, which is where writes go.
    const readerPath = sharedWorkspaceRegistrationStorePath(shellPaths);
    expect(readerPath).toBe(sharedWorkspaceRegisterPath(shellPaths));
    expect(readerPath).not.toContain(scopedPrefix);
    expect(readerPath).toContain('/shared/');
  });

  test('a blank surface root is refused rather than silently resolving to the orphan directory', () => {
    const shellPaths = createShellPathService({
      workingDirectory: '/nowhere/home',
      homeDirectory: '/nowhere/home',
    });
    expect(() => controlPlaneStorePath(shellPaths, '   ', 'pairing-tokens.json')).toThrow();
  });
});
