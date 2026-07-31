import { describe, expect, test } from 'bun:test';
import { renderPairingBanner } from '../../core/pairing-banner.ts';
import { runPairCommand } from '../../daemon/pair-command.ts';

function config(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    'controlPlane.hostMode': 'local',
    'controlPlane.host': '127.0.0.1',
    'controlPlane.port': 3421,
    'web.hostMode': 'local',
    'web.host': '127.0.0.1',
    'web.port': 3423,
    'web.publicBaseUrl': 'http://127.0.0.1:3423',
    'relay.enabled': false,
    ...overrides,
  };
  return { get: (key: string): never => values[key] as never };
}

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    configManager: config(),
    daemonHomeDir: '/home/x/.goodvibes/daemon',
    version: '9.9.9-test',
    readToken: () => JSON.stringify({ token: 'companion-token' }),
    flags: { host: undefined, port: undefined, token: undefined, json: false },
    ...overrides,
  };
}

describe('pair reprints the block the daemon prints at startup', () => {
  test('the lines are the shared banner, byte for byte', () => {
    const result = runPairCommand(baseInput());
    expect(result.exitCode).toBe(0);
    const expected = renderPairingBanner({
      version: '9.9.9-test',
      origin: 'http://127.0.0.1:3423',
      token: 'companion-token',
      offers: ['notifications', 'passkey'],
    });
    expect(result.lines).toEqual(expected.lines);
  });

  test('the deep link carries the EXISTING token, not a fresh one', () => {
    const result = runPairCommand(baseInput({
      flags: { host: undefined, port: undefined, token: undefined, json: true },
    }));
    const parsed = JSON.parse(result.lines[0] as string) as { data: { deepLink: string } };
    expect(parsed.data.deepLink).toContain('companion-token');
    expect(parsed.data.deepLink.startsWith('http://127.0.0.1:3423')).toBe(true);
  });

  test('a bare token file (not a JSON record) is read as the token', () => {
    const result = runPairCommand(baseInput({
      readToken: () => '  raw-token  ',
      flags: { host: undefined, port: undefined, token: undefined, json: true },
    }));
    const parsed = JSON.parse(result.lines[0] as string) as { data: { deepLink: string } };
    expect(parsed.data.deepLink).toContain('raw-token');
  });

  test('a relay-enabled daemon offers relay too', () => {
    const result = runPairCommand(baseInput({
      configManager: config({ 'relay.enabled': true }),
      flags: { host: undefined, port: undefined, token: undefined, json: true },
    }));
    const parsed = JSON.parse(result.lines[0] as string) as { data: { offers: string[] } };
    expect(parsed.data.offers).toEqual(['notifications', 'relay', 'passkey']);
  });

  test('--json prints the link with no QR block', () => {
    const result = runPairCommand(baseInput({
      flags: { host: undefined, port: undefined, token: undefined, json: true },
    }));
    expect(result.lines.length).toBe(1);
    expect(result.lines[0]).not.toContain('█');
  });

  test('the prose form carries the QR', () => {
    const result = runPairCommand(baseInput());
    expect(result.lines.join('\n')).toContain('scan to pair a device');
  });
});

describe('pair refuses what it cannot honestly answer', () => {
  test('a --host naming another machine is refused with the reason', () => {
    const result = runPairCommand(baseInput({
      flags: { host: '10.0.0.7', port: undefined, token: undefined, json: false },
    }));
    expect(result.exitCode).toBe(1);
    expect(result.lines.join('\n')).toContain("minted from that machine's own token store");
    expect(result.lines.join('\n')).toContain('run `goodvibes-daemon pair` on 10.0.0.7');
  });

  test.each([['127.0.0.1'], ['localhost'], ['::1'], ['0.0.0.0']])(
    '--host %s still means this machine',
    (host) => {
      const result = runPairCommand(baseInput({
        flags: { host, port: undefined, token: undefined, json: false },
      }));
      expect(result.exitCode).toBe(0);
    },
  );

  test('no operator token means no link, and says how to make one', () => {
    const result = runPairCommand(baseInput({ readToken: () => undefined }));
    expect(result.exitCode).toBe(1);
    expect(result.lines.join('\n')).toContain('no operator token');
    expect(result.lines.join('\n')).toContain('goodvibes-daemon serve');
  });

  test('a refusal in --json mode is one JSON document', () => {
    const result = runPairCommand(baseInput({
      readToken: () => undefined,
      flags: { host: undefined, port: undefined, token: undefined, json: true },
    }));
    expect(JSON.parse(result.lines[0] as string)).toMatchObject({ ok: false });
  });
});

describe('pair writes nothing', () => {
  test('it reads the web origin without freezing it into settings', () => {
    // The boot path calls ensurePublicBaseUrl, which PERSISTS a resolved
    // origin. A command that only prints a link must not do that, so this
    // config double has no write method at all: reaching for one would throw.
    const readOnly = {
      get: (key: string): never => ({
        'web.publicBaseUrl': '',
        'web.hostMode': 'local',
        'web.host': '127.0.0.1',
        'web.port': 3423,
        'relay.enabled': false,
      } as Record<string, unknown>)[key] as never,
    };
    const result = runPairCommand(baseInput({ configManager: readOnly }));
    expect(result.exitCode).toBe(0);
  });
});
