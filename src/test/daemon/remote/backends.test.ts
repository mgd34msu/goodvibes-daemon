import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'bun:test';
import { makeProjectTempDir } from '../../helpers/project-temp.ts';
import { runProcess } from '../../../daemon/handlers/remote/backends/process-runner.ts';
import {
  tokenizeCommand,
  createLocalProcessBackend,
} from '../../../daemon/handlers/remote/backends/local-process.ts';
import { createSshBackend } from '../../../daemon/handlers/remote/backends/ssh.ts';
import { createCloudTerminalBackend } from '../../../daemon/handlers/remote/backends/cloud-terminal.ts';
import {
  type BackendContext,
  BackendDispatchError,
  buildRemoteShellCommand,
} from '../../../daemon/handlers/remote/backends/types.ts';
import type { DaemonCredentialStore } from '../../../daemon/handlers/credentials.ts';
import type { HandlerLogger } from '../../../daemon/handlers/context.ts';
import type { PeerRecord } from '../../../daemon/handlers/remote/peer-registry.ts';

const noopLogger: HandlerLogger = { info: () => {}, warn: () => {}, error: () => {} };
const stubCredentials: DaemonCredentialStore = {
  resolveRef: async () => null,
  resolveConfigSecret: async () => null,
  put: async () => {},
  has: async () => false,
};
const ctx: BackendContext = { credentials: stubCredentials, logger: noopLogger, homeDirectory: '/tmp' };

function localPeer(allowedCommands?: string[]): PeerRecord {
  return {
    peerId: 'local',
    displayName: 'Local',
    backendKind: 'local-process',
    backendConfig: { kind: 'local-process', ...(allowedCommands ? { allowedCommands } : {}) },
  };
}

describe('tokenizeCommand', () => {
  it('splits plain words', () => {
    expect(tokenizeCommand('git status --short')).toEqual(['git', 'status', '--short']);
  });

  it('honors single and double quotes', () => {
    expect(tokenizeCommand('echo "hello world" \'a b\'')).toEqual(['echo', 'hello world', 'a b']);
  });

  it('honors backslash escapes outside single quotes', () => {
    expect(tokenizeCommand('echo a\\ b')).toEqual(['echo', 'a b']);
  });

  it('throws on an unterminated quote', () => {
    expect(() => tokenizeCommand('echo "open')).toThrow(BackendDispatchError);
  });
});

describe('runProcess', () => {
  it('captures stdout and a zero exit code', async () => {
    const result = await runProcess({ args: ['printf', 'hi'], timeoutMs: 5_000 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hi');
    expect(result.timedOut).toBe(false);
  });

  it('reports a non-zero exit code without throwing', async () => {
    const result = await runProcess({ args: ['sh', '-c', 'exit 3'], timeoutMs: 5_000 });
    expect(result.exitCode).toBe(3);
    expect(result.timedOut).toBe(false);
  });

  it('SIGKILLs and reaps a process that exceeds the timeout', async () => {
    // The await resolves on child.exited (post-SIGKILL). A runner that only
    // flagged the timeout without killing would wait out the 60 s sleep, past
    // this test's 20 s ceiling, so the ceiling is what fails, not a clock
    // comparison that a loaded host can trip.
    const result = await runProcess({ args: ['sleep', '60'], timeoutMs: 200 });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
  }, 20_000);

  it('pipes stdin to the child', async () => {
    const result = await runProcess({ args: ['cat'], stdin: 'piped-input', timeoutMs: 5_000 });
    expect(result.stdout).toBe('piped-input');
  });
});

describe('buildRemoteShellCommand', () => {
  it('returns the bare command when there are no args', () => {
    expect(buildRemoteShellCommand('uptime')).toBe('uptime');
    expect(buildRemoteShellCommand('uptime', [])).toBe('uptime');
  });

  it('joins positional args onto the command with single spaces (remote-shell semantics)', () => {
    expect(buildRemoteShellCommand('ls', ['-l', '/tmp'])).toBe('ls -l /tmp');
  });

  it('does NOT shell-escape args: the joined string is handed verbatim to the remote shell', () => {
    // An arg containing a space stays unquoted on purpose, the remote shell
    // re-splits it. Callers needing a literal arg must pre-quote it themselves.
    expect(buildRemoteShellCommand('echo', ['a b'])).toBe('echo a b');
  });
});

describe('backend teardown sweeps ephemeral credential dirs', () => {
  it('ssh teardown removes the ssh-keys/ directory', async () => {
    const home = makeProjectTempDir('ssh-teardown-home');
    const keyDir = join(home, '.goodvibes', 'tui', 'operator', 'ssh-keys');
    mkdirSync(keyDir, { recursive: true });
    // A leftover key file from a prior invocation (word-style fake, not a ref).
    writeFileSync(join(keyDir, 'peer.cafef00d.key'), 'word-style-fake-private-key-not-a-ref');
    expect(existsSync(keyDir)).toBe(true);

    const backend = createSshBackend({ credentials: stubCredentials, logger: noopLogger, homeDirectory: home });
    await backend.teardown?.();
    expect(existsSync(keyDir)).toBe(false);
  });

  it('cloud-terminal teardown removes the cloud-creds/ directory', async () => {
    const home = makeProjectTempDir('cloud-teardown-home');
    const credDir = join(home, '.goodvibes', 'tui', 'operator', 'cloud-creds');
    mkdirSync(credDir, { recursive: true });
    writeFileSync(join(credDir, 'peer.deadbeef.cred'), 'wordfake-cloud-credential');
    expect(existsSync(credDir)).toBe(true);

    const backend = createCloudTerminalBackend({ credentials: stubCredentials, logger: noopLogger, homeDirectory: home });
    await backend.teardown?.();
    expect(existsSync(credDir)).toBe(false);
  });

  it('teardown is a safe no-op when nothing was written to disk', async () => {
    const home = makeProjectTempDir('noop-teardown-home');
    const backend = createSshBackend({ credentials: stubCredentials, logger: noopLogger, homeDirectory: home });
    await expect(backend.teardown?.()).resolves.toBeUndefined();
  });
});

describe('backend construction sweeps a crashed prior process\'s leftovers', () => {
  it('ssh: a stale ssh-keys/ file from before a SIGKILL is gone before the first write', async () => {
    const home = makeProjectTempDir('ssh-crash-sweep-home');
    const keyDir = join(home, '.goodvibes', 'tui', 'operator', 'ssh-keys');
    mkdirSync(keyDir, { recursive: true });
    writeFileSync(join(keyDir, 'stale-peer.abcd1234.key'), 'leftover-from-a-sigkilled-daemon');
    expect(existsSync(keyDir)).toBe(true);

    // No teardown() call between construction and dispatch: this is exactly the
    // crash case (only construction runs; a graceful unregister() never does).
    const backend = createSshBackend({ credentials: stubCredentials, logger: noopLogger, homeDirectory: home });
    const peer: PeerRecord = {
      peerId: 'p1',
      displayName: 'P1',
      backendKind: 'ssh',
      backendConfig: { kind: 'ssh', sshHost: 'h', sshUser: 'u', identityRef: 'goodvibes://secrets/x' },
    };
    // stubCredentials.resolveRef always returns null, so ensureIdentity throws
    // right after awaiting the construction-time sweep, never itself writing a
    // key file. Reaching this rejection proves the sweep already ran to
    // completion (a still-pending sweep would leave the `await` unresolved).
    await expect(backend.dispatch(peer, 'true'))
      .rejects.toMatchObject({ code: 'REMOTE_BACKEND_CREDENTIAL_MISSING' });
    expect(existsSync(keyDir)).toBe(false);
  });

  it('cloud-terminal: a stale cloud-creds/ file from before a SIGKILL is gone before the first write', async () => {
    const home = makeProjectTempDir('cloud-crash-sweep-home');
    const credDir = join(home, '.goodvibes', 'tui', 'operator', 'cloud-creds');
    mkdirSync(credDir, { recursive: true });
    const staleFile = join(credDir, 'stale-peer.deadbeef.cred');
    writeFileSync(staleFile, 'leftover-cloud-credential-from-a-sigkilled-daemon');
    expect(existsSync(staleFile)).toBe(true);

    const credentialingStub: DaemonCredentialStore = {
      ...stubCredentials,
      resolveRef: async () => 'fake-cloud-credential-word-not-a-ref',
    };
    const backend = createCloudTerminalBackend({ credentials: credentialingStub, logger: noopLogger, homeDirectory: home });
    const peer: PeerRecord = {
      peerId: 'p2',
      displayName: 'P2',
      backendKind: 'cloud-terminal',
      backendConfig: { kind: 'cloud-terminal', provider: 'gcp', instance: 'cloudshell', credentialRef: 'goodvibes://secrets/y' },
    };
    // The gcloud CLI is not installed in this test environment, so the actual
    // command spawn fails; that happens AFTER writeCredentialFile, which itself
    // waits on the construction-time sweep before touching credDir. Whatever
    // dispatch resolves or rejects with, the stale file must already be gone.
    await backend.dispatch(peer, 'true').catch(() => {});
    expect(existsSync(staleFile)).toBe(false);
  });
});

describe('createLocalProcessBackend', () => {
  it('runs a permitted command and returns captured stdout', async () => {
    const backend = createLocalProcessBackend(ctx);
    const result = await backend.dispatch(localPeer(['printf']), 'printf done');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('done');
  });

  it('denies a command outside the allowlist', async () => {
    const backend = createLocalProcessBackend(ctx);
    await expect(backend.dispatch(localPeer(['printf']), 'rm -rf /'))
      .rejects.toMatchObject({ code: 'REMOTE_BACKEND_COMMAND_DENIED' });
  });

  it('rejects a peer of the wrong backend kind', async () => {
    const backend = createLocalProcessBackend(ctx);
    const wrong: PeerRecord = {
      peerId: 'x', displayName: 'X', backendKind: 'docker',
      backendConfig: { kind: 'docker', containerName: 'c' },
    };
    await expect(backend.dispatch(wrong, 'ls'))
      .rejects.toMatchObject({ code: 'REMOTE_BACKEND_KIND_MISMATCH' });
  });

  it('maps a timeout to exit code 124 with a timeout note on stderr', async () => {
    const backend = createLocalProcessBackend(ctx);
    const result = await backend.dispatch(localPeer(['sleep']), 'sleep 10', { timeoutMs: 200 });
    expect(result.exitCode).toBe(124);
    expect(result.stderr).toContain('timed out');
  });
});
