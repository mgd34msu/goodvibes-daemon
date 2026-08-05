/**
 * control-plane-store-writes.test.ts
 *
 * Companion to control-plane-store-location.test.ts, which pins the SOURCE
 * (the exact resolver calls this daemon makes). This file proves the other
 * half: a REAL write through the real store objects this daemon constructs
 * lands under the surface-scoped directory, on a hermetic temp home, and the
 * pre-split unscoped directory is never created by the act of writing.
 *
 * With ONE deliberate exception, pinned below: workspace-registrations.json is
 * cross-product state (goodvibes-agent reads and writes the same file), so it
 * lives in the platform's shared tier — no surface root — and every product
 * must resolve the identical path.
 *
 * Two stores are exercised end to end:
 *  - pairing-tokens.json — the daemon's own PairingTokenManager, built the
 *    same way services.ts:135 builds it (controlPlaneStorePath over
 *    GOODVIBES_DAEMON_SURFACE_ROOT).
 *  - workspace-registrations.json — written by the SDK's WorkspaceRegistration
 *    Store (as the gateway verb group constructs it) and read back by THIS
 *    repo's own reader (checkpoint-eligibility.ts), proving writer and reader
 *    actually agree on disk, not just in a source-string comparison.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PairingTokenManager } from '@pellux/goodvibes-sdk/platform/pairing';
import { WorkspaceRegistrationStore } from '@pellux/goodvibes-sdk/platform/workspace';
import { controlPlaneStorePath } from '@pellux/goodvibes-sdk/platform/control-plane';
import { sharedWorkspaceRegisterPath } from '@pellux/goodvibes-sdk/platform/workspace';
import { createShellPathService } from '@/runtime/index.ts';
import { GOODVIBES_DAEMON_SURFACE_ROOT } from '../../config/surface.ts';
import { sharedWorkspaceRegistrationStorePath } from '../../runtime/trust/checkpoint-eligibility.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

describe('a real pairing-token write lands under the surface-scoped control-plane directory', () => {
  test('mint() writes pairing-tokens.json scoped, and never creates the unscoped orphan directory', () => {
    const home = makeProjectTempDir('gv-cp-write-pairing');
    const shellPaths = createShellPathService({ workingDirectory: home, homeDirectory: home });

    // Built the same way services.ts:135 builds it.
    const pairingTokenPath = controlPlaneStorePath(shellPaths, GOODVIBES_DAEMON_SURFACE_ROOT, 'pairing-tokens.json');
    const manager = new PairingTokenManager(pairingTokenPath);
    manager.mint({ name: 'test device' });

    const expectedPath = join(home, '.goodvibes', GOODVIBES_DAEMON_SURFACE_ROOT, 'control-plane', 'pairing-tokens.json');
    const unscopedDir = join(home, '.goodvibes', 'control-plane');

    expect(pairingTokenPath).toBe(expectedPath);
    expect(existsSync(expectedPath)).toBe(true);
    expect(existsSync(unscopedDir)).toBe(false);
  });
});

describe("workspace-registrations.json: the SDK writer and this daemon's reader agree on disk", () => {
  test('the register writes to the SHARED tier, and this repo\'s reader resolves the identical file', async () => {
    // Not surface-scoped: goodvibes-agent reads and writes the same file, so
    // scoping it to this daemon's root would split the register — workspaces
    // registered from the agent vanishing from the daemon, and checkpoint
    // eligibility refusing workspaces the operator had registered. It lives in
    // the platform's shared tier instead, which takes no surface root.
    const home = makeProjectTempDir('gv-cp-write-workspace');
    const project = join(home, 'projects', 'app');
    mkdirSync(project, { recursive: true });
    const shellPaths = createShellPathService({ workingDirectory: project, homeDirectory: home });

    // The writer: same construction the SDK's gateway verb group uses
    // (register-gateway-verb-groups.ts), which resolves this one unscoped.
    const writerPath = sharedWorkspaceRegisterPath(shellPaths);
    const store = new WorkspaceRegistrationStore({
      path: writerPath,
      homeDir: home,
      daemonStateDir: shellPaths.resolveUserPath(),
    });
    await store.add(project);

    expect(writerPath).toBe(join(home, '.goodvibes', 'shared', 'workspace-registrations.json'));
    expect(existsSync(writerPath)).toBe(true);
    // Emphatically NOT under this daemon's surface root — that is the split —
    // and not at the pre-split address the boot fold is clearing out.
    expect(existsSync(join(home, '.goodvibes', GOODVIBES_DAEMON_SURFACE_ROOT, 'control-plane', 'workspace-registrations.json'))).toBe(false);
    expect(existsSync(join(home, '.goodvibes', 'control-plane', 'workspace-registrations.json'))).toBe(false);

    // The reader: this repo's own checkpoint-eligibility.ts resolver, pointed
    // at the identical shellPaths. A mismatch here is invisible at runtime —
    // it just reads an empty register and silently refuses every checkpoint.
    expect(sharedWorkspaceRegistrationStorePath(shellPaths)).toBe(writerPath);
    expect(readFileSync(writerPath, 'utf8')).toContain('app');
  });
});
