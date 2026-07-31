/**
 * config-value.ts — reading a settings value off the command line.
 *
 * `config set <key> <value>` and `--config key=value` must read a typed value
 * the same way, or `--config x=false` and `config set x false` write different
 * things. The override path applies this rule inside
 * @pellux/goodvibes-terminal-shell's `applyRuntimeConfigOverrides`, which takes
 * whole `key=value` strings and keeps its coercion private; `config set`
 * already has the halves apart and needs the value alone, before it goes to
 * `ConfigManager.set` rather than to the runtime layer.
 *
 * JSON first, so `[1,2]`, `{"a":1}`, `"3"` and `null` all mean what they look
 * like; then the three bare literals a shell user actually types (`true`,
 * `false`, a number); then the raw string.
 */
export function parseConfigValueText(value: string): unknown {
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
