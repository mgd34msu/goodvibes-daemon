/**
 * CLI barrel for the daemon product.
 *
 * Two halves, deliberately separable:
 *   - `command-catalog.ts` is WHAT this binary understands — every command,
 *     alias, flag and help string, as data.
 *   - `parser.ts`, `help.ts` and `completion.ts` are the ENGINE that reads a
 *     catalog and produces a parse, a help page or a completion script. None of
 *     them names a daemon command.
 *
 * The engine half is what a terminal-shell package is expected to own later;
 * the catalog stays here. Everything the terminal app's CLI barrel carried that
 * described a conversation surface (interactive status, doctor, plugin and
 * bundle commands) belongs to that surface, not here.
 */
export * from './types.ts';
export * from './command-catalog.ts';
export * from './parser.ts';
export * from './help.ts';
export * from './completion.ts';
export * from './config-overrides.ts';
export * from './endpoints.ts';
export * from './redaction.ts';
