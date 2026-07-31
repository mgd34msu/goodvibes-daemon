import type { ConfigKey, ConfigManager, ConfigSetting, GoodVibesConfig } from '../config/index.ts';
import { CONFIG_SCHEMA, ConfigError } from '../config/index.ts';
import { featureEnablementWrite, getFeatureSetting } from '../runtime/feature-settings.ts';
import type { DaemonCliFlags } from './types.ts';
import { RUNTIME_ENDPOINT_CONFIG_KEYS, hostModeForHostname } from './endpoints.ts';
import type { RuntimeEndpointId } from './endpoints.ts';

const CONFIG_SCHEMA_BY_KEY = new Map<string, ConfigSetting>(
  CONFIG_SCHEMA.map((setting) => [setting.key, setting]),
);

/**
 * Turn a command-line settings value into the value the schema wants.
 *
 * JSON first, so `[1,2]`, `{"a":1}`, `"3"` and `null` all mean what they look
 * like; then the three bare literals a shell user actually types (`true`,
 * `false`, a number); then the raw string. Exported because `--config
 * key=value` and `config set key value` must read a typed value the same way —
 * two parsers would mean `--config x=false` and `config set x false` writing
 * different things.
 */
export function parseConfigValueText(value: string): unknown {
  return parseConfigOverrideValue(value);
}

function parseConfigOverrideValue(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed.length === 0) return '';
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    if (trimmed === 'true') return true;
    if (trimmed === 'false') return false;
    if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
    return value;
  }
}

function getRuntimeConfig(configManager: ConfigManager): GoodVibesConfig {
  const mutable = configManager as unknown as { config?: GoodVibesConfig };
  if (!mutable.config || typeof mutable.config !== 'object') {
    throw new ConfigError('ConfigManager runtime config is not available for CLI overrides.');
  }
  return mutable.config;
}

function validateConfigValue(setting: ConfigSetting, value: unknown): void {
  if (setting.type === 'boolean' && typeof value !== 'boolean') {
    throw new ConfigError(`Invalid value for ${setting.key}: expected boolean.`);
  }
  if (setting.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) {
    throw new ConfigError(`Invalid value for ${setting.key}: expected number.`);
  }
  if (setting.type === 'string' && typeof value !== 'string') {
    throw new ConfigError(`Invalid value for ${setting.key}: expected string.`);
  }
  if (setting.type === 'enum' && setting.enumValues && !setting.enumValues.includes(String(value))) {
    throw new ConfigError(`Invalid value for ${setting.key}: "${String(value)}". Allowed: ${setting.enumValues.join(', ')}`);
  }
  if (setting.validate && !setting.validate(value)) {
    throw new ConfigError(`Invalid value for ${setting.key}: ${String(value)}`);
  }
}

function setNestedConfigValue(config: GoodVibesConfig, key: ConfigKey, value: unknown): void {
  const parts = key.split('.');
  let cursor: unknown = config;
  for (const part of parts.slice(0, -1)) {
    if (cursor == null || typeof cursor !== 'object' || !(part in cursor)) {
      throw new ConfigError(`Invalid config path: section '${part}' does not exist`);
    }
    cursor = (cursor as Record<string, unknown>)[part];
  }
  if (cursor == null || typeof cursor !== 'object') {
    throw new ConfigError(`Invalid config path: section '${parts.slice(0, -1).join('.')}' does not exist`);
  }
  (cursor as Record<string, unknown>)[parts[parts.length - 1]!] = value;
}

export function applyRuntimeConfigValue(configManager: ConfigManager, key: ConfigKey, value: unknown): void {
  const setting = CONFIG_SCHEMA_BY_KEY.get(key);
  if (!setting) {
    throw new ConfigError(`Unknown config key: ${key}`);
  }
  validateConfigValue(setting, value);
  setNestedConfigValue(getRuntimeConfig(configManager), key, value);
}

export function applyRuntimeConfigOverrides(
  configManager: ConfigManager,
  overrides: readonly string[],
): readonly string[] {
  const errors: string[] = [];
  for (const override of overrides) {
    const index = override.indexOf('=');
    if (index <= 0) {
      errors.push(`Invalid --config override "${override}". Expected key=value.`);
      continue;
    }
    const key = override.slice(0, index) as ConfigKey;
    const rawValue = override.slice(index + 1);
    try {
      applyRuntimeConfigValue(configManager, key, parseConfigOverrideValue(rawValue));
    } catch (error) {
      errors.push(error instanceof Error ? `Invalid --config ${override}: ${error.message}` : `Invalid --config ${override}`);
    }
  }
  return errors;
}

/**
 * Session-only feature overrides (--enable-feature / --disable-feature).
 * Each feature is switched through its real domain settings key (e.g.
 * sandbox.enabled, behavior.compactionStrategy) in the runtime config layer;
 * features without an off position (constant capabilities on non-boolean
 * keys) and unknown ids are reported as errors rather than silently ignored.
 */
export function applyRuntimeFeatureFlagOverrides(
  configManager: ConfigManager,
  options: {
    readonly enableFeatures: readonly string[];
    readonly disableFeatures: readonly string[];
  },
): readonly string[] {
  if (options.enableFeatures.length === 0 && options.disableFeatures.length === 0) return [];
  const config = getRuntimeConfig(configManager);
  const errors: string[] = [];
  const apply = (feature: string, enabled: boolean, flagName: string): void => {
    const write = featureEnablementWrite(feature, enabled);
    if (!write) {
      errors.push(getFeatureSetting(feature)
        ? `${flagName} ${feature}: this capability has no ${enabled ? 'on' : 'off'} switch (its domain settings govern it directly).`
        : `${flagName} ${feature}: unknown feature id.`);
      return;
    }
    setNestedConfigValue(config, write.key, write.value);
  };
  for (const feature of options.enableFeatures) apply(feature, true, '--enable-feature');
  for (const feature of options.disableFeatures) apply(feature, false, '--disable-feature');
  return errors;
}

export function applyRuntimeEndpointFlagOverrides(
  configManager: ConfigManager,
  endpoint: RuntimeEndpointId,
  flags: Pick<DaemonCliFlags, 'hostname' | 'port'>,
): readonly string[] {
  const keys = RUNTIME_ENDPOINT_CONFIG_KEYS[endpoint];
  const errors: string[] = [];

  if (flags.hostname !== undefined) {
    try {
      applyRuntimeConfigValue(configManager, keys.hostMode, hostModeForHostname(flags.hostname));
      applyRuntimeConfigValue(configManager, keys.host, flags.hostname);
    } catch (error) {
      errors.push(error instanceof Error
        ? `Invalid --hostname ${flags.hostname}: ${error.message}`
        : `Invalid --hostname ${flags.hostname}`);
    }
  }

  if (flags.port !== undefined) {
    try {
      applyRuntimeConfigValue(configManager, keys.port, flags.port);
    } catch (error) {
      errors.push(error instanceof Error
        ? `Invalid --port ${flags.port}: ${error.message}`
        : `Invalid --port ${flags.port}`);
    }
  }

  return errors;
}
