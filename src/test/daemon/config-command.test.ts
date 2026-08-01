import { describe, expect, test } from 'bun:test';
import { CONFIG_SCHEMA, ConfigError } from '@pellux/goodvibes-sdk/platform/config';
import { REDACTED_VALUE } from '@pellux/goodvibes-terminal-shell';
import { renderConfigValue, runConfigCommand } from '../../daemon/config-command.ts';

/**
 * A ConfigManager stand-in with the five methods this command uses. The real
 * one writes files and routes daemon-owned keys to a second tier; neither is
 * what these tests are about, and both are exercised where they live.
 */
function fakeManager(initial: Record<string, unknown> = {}) {
  const values = new Map<string, unknown>(Object.entries(initial));
  const writes: { key: string; value: unknown }[] = [];
  const resets: string[] = [];
  return {
    writes,
    resets,
    manager: {
      get: (key: string): never => values.get(key) as never,
      set: (key: string, value: unknown): void => {
        const setting = CONFIG_SCHEMA.find((entry) => entry.key === key);
        if (setting?.type === 'number' && typeof value !== 'number') {
          throw new ConfigError(`Invalid value for ${key}: expected number.`);
        }
        writes.push({ key, value });
        values.set(key, value);
      },
      reset: (key?: string): void => {
        if (key === undefined) return;
        resets.push(key);
        values.delete(key);
      },
      getSchema: () => CONFIG_SCHEMA,
      getRaw: () => Object.fromEntries(values) as never,
      getConfigPath: () => '/home/x/.goodvibes/settings.json',
    },
  };
}

function deps(manager: ReturnType<typeof fakeManager>['manager'], json = false) {
  return { configManager: manager, json, binary: 'goodvibes-daemon' };
}

/** A settings key whose last segment is a credential word, taken from the live schema. */
function aSecretKey(): string {
  const key = CONFIG_SCHEMA.map((setting) => setting.key)
    .find((candidate) => /(apiKey|password|token|secret)$/i.test(candidate));
  expect(key).toBeDefined();
  return key as string;
}

describe('config list', () => {
  test('reports every schema key with its value', () => {
    const { manager } = fakeManager({ 'controlPlane.port': 3421 });
    const result = runConfigCommand(['list'], deps(manager));
    expect(result.exitCode).toBe(0);
    const text = result.lines.join('\n');
    expect(text).toContain('controlPlane.port');
    expect(text).toContain('3421');
    expect(text).toContain('/home/x/.goodvibes/settings.json');
  });

  test('a credential-shaped key is printed as redacted, never in the clear', () => {
    const secret = aSecretKey();
    const { manager } = fakeManager({ [secret]: 'sk-live-abcdefghijklmnop' });
    const result = runConfigCommand(['list'], deps(manager));
    const text = result.lines.join('\n');
    expect(text).toContain(REDACTED_VALUE);
    expect(text).not.toContain('sk-live-abcdefghijklmnop');
  });

  test('--json redacts too, and names which keys it redacted', () => {
    const secret = aSecretKey();
    const { manager } = fakeManager({ [secret]: 'sk-live-abcdefghijklmnop' });
    const result = runConfigCommand(['list'], deps(manager, true));
    const text = result.lines.join('\n');
    expect(text).not.toContain('sk-live-abcdefghijklmnop');
    const parsed = JSON.parse(text) as { data: { redactedKeys: string[]; settings: Record<string, unknown> } };
    expect(parsed.data.redactedKeys).toContain(secret);
    expect(parsed.data.settings[secret]).toBe(REDACTED_VALUE);
  });

  test('a stray argument is refused', () => {
    const { manager } = fakeManager();
    expect(runConfigCommand(['list', 'extra'], deps(manager)).exitCode).toBe(2);
  });
});

describe('config get', () => {
  test('prints one value', () => {
    const { manager } = fakeManager({ 'controlPlane.port': 3421 });
    const result = runConfigCommand(['get', 'controlPlane.port'], deps(manager));
    expect(result.exitCode).toBe(0);
    expect(result.lines).toEqual(['3421']);
  });

  test('redacts a credential-shaped key', () => {
    const secret = aSecretKey();
    const { manager } = fakeManager({ [secret]: 'ghp_abcdefghijklmnopqrstuvwxyz' });
    const result = runConfigCommand(['get', secret], deps(manager));
    expect(result.lines).toEqual([REDACTED_VALUE]);
  });

  test('a goodvibes:// secrets reference stays visible — it is a pointer, not a secret', () => {
    const secret = aSecretKey();
    const { manager } = fakeManager({ [secret]: 'goodvibes://secrets/telegram-bot' });
    expect(runConfigCommand(['get', secret], deps(manager)).lines)
      .toEqual(['goodvibes://secrets/telegram-bot']);
  });

  test('an unknown key is refused with the command that lists them', () => {
    const { manager } = fakeManager();
    const result = runConfigCommand(['get', 'not.a.key'], deps(manager));
    expect(result.exitCode).toBe(1);
    expect(result.lines.join('\n')).toContain('config list');
  });

  test('a missing key is a usage refusal', () => {
    const { manager } = fakeManager();
    expect(runConfigCommand(['get'], deps(manager)).exitCode).toBe(2);
  });
});

describe('config set', () => {
  test('writes through the manager and reports where it landed', () => {
    const { manager, writes } = fakeManager();
    const result = runConfigCommand(['set', 'controlPlane.port', '3999'], deps(manager));
    expect(result.exitCode).toBe(0);
    expect(writes).toEqual([{ key: 'controlPlane.port', value: 3999 }]);
    expect(result.lines.join('\n')).toContain('written to disk');
  });

  test('a value is typed the same way --config key=value types it', () => {
    const { manager, writes } = fakeManager();
    runConfigCommand(['set', 'controlPlane.webui.serve', 'true'], deps(manager));
    expect(writes[0]?.value).toBe(true);
  });

  test('a value the schema refuses comes back as the schema\'s own message', () => {
    const { manager, writes } = fakeManager();
    const result = runConfigCommand(['set', 'controlPlane.port', 'not-a-port'], deps(manager));
    expect(result.exitCode).toBe(1);
    expect(result.lines.join('\n')).toContain('expected number');
    expect(writes).toEqual([]);
  });

  test('the written value is real, and only the ECHO is redacted', () => {
    const secret = aSecretKey();
    const { manager, writes } = fakeManager();
    const result = runConfigCommand(['set', secret, 'sk-live-abcdefghijklmnop'], deps(manager));
    expect(writes).toEqual([{ key: secret, value: 'sk-live-abcdefghijklmnop' }]);
    expect(result.lines.join('\n')).toContain(REDACTED_VALUE);
    expect(result.lines.join('\n')).not.toContain('sk-live-abcdefghijklmnop');
  });

  test('a missing value is a usage refusal, never a write of empty', () => {
    const { manager, writes } = fakeManager();
    expect(runConfigCommand(['set', 'controlPlane.port'], deps(manager)).exitCode).toBe(2);
    expect(writes).toEqual([]);
  });
});

describe('config unset', () => {
  test('resets one key through the manager', () => {
    const { manager, resets } = fakeManager({ 'controlPlane.port': 3999 });
    const result = runConfigCommand(['unset', 'controlPlane.port'], deps(manager));
    expect(result.exitCode).toBe(0);
    expect(resets).toEqual(['controlPlane.port']);
    expect(result.lines.join('\n')).toContain('shipped default');
  });

  test('an unknown key is refused rather than reset', () => {
    const { manager, resets } = fakeManager();
    expect(runConfigCommand(['unset', 'not.a.key'], deps(manager)).exitCode).toBe(1);
    expect(resets).toEqual([]);
  });
});

describe('config with no or a wrong subcommand', () => {
  test('names the four verbs', () => {
    const { manager } = fakeManager();
    expect(runConfigCommand([], deps(manager)).lines.join('\n')).toContain('config list');
    const wrong = runConfigCommand(['delete', 'x'], deps(manager));
    expect(wrong.exitCode).toBe(2);
    expect(wrong.lines.join('\n')).toContain('list, get, set, unset');
  });
});

describe('renderConfigValue — the redaction rule, stated directly', () => {
  test('a non-credential key prints its value', () => {
    expect(renderConfigValue('controlPlane.port', 3421)).toBe('3421');
    expect(renderConfigValue('controlPlane.host', '127.0.0.1')).toBe('127.0.0.1');
    expect(renderConfigValue('controlPlane.webui.serve', false)).toBe('false');
  });

  test('a credential key with a real value prints redacted', () => {
    expect(renderConfigValue('cluster.secret', 'hunter2')).toBe(REDACTED_VALUE);
    expect(renderConfigValue('surfaces.calendar.caldavPassword', 'p')).toBe(REDACTED_VALUE);
  });

  test('an unset or empty credential is reported as unset, not as a secret', () => {
    expect(renderConfigValue('cluster.secret', undefined)).toBe('unset');
    expect(renderConfigValue('cluster.secret', null)).toBe('unset');
    expect(renderConfigValue('cluster.secret', '')).toBe('""');
  });
});
