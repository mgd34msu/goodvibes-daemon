/**
 * parser.ts — the argument engine.
 *
 * It knows about tokens, values, arity, `--`, and refusals. It knows nothing
 * about daemons: every command name, alias, flag and help string it works with
 * arrives from a catalog (`./command-catalog.ts`). That is the seam a
 * terminal-shell package is expected to take over — this file goes with it, the
 * catalog stays.
 *
 * THE TWO RULES THIS FILE EXISTS TO ENFORCE
 *
 * 1. Serving happens on a bare invocation or on `serve`, and on nothing else.
 *    Previously an unmatched word became a positional and the process fell
 *    through to "start a daemon in the foreground", so `goodvibes-daemon
 *    doctor`, `goodvibes-daemon sessions` and `goodvibes-daemon install-servce`
 *    all silently served.
 *
 * 2. Every refusal is a refusal. An unrecognized command, a flag that belongs
 *    to another surface, a flag this command does not take, a missing value —
 *    each produces an error line, and the caller exits 2 with the help. Nothing
 *    is accepted-and-ignored.
 */
import {
  ALL_FLAG_ARITY,
  DAEMON_COMMANDS,
  REJECTED_TERMINAL_FLAGS,
  daemonCommandSpec,
  flagsForCommand,
  resolveDaemonCommand,
  type DaemonCliFlagKind,
  type DaemonCommand,
  type DaemonCommandFlagSpec,
} from './command-catalog.ts';
import type { DaemonCliFlags, DaemonCliParseResult } from './types.ts';

function createDefaultFlags(): DaemonCliFlags {
  return {
    daemonHome: undefined,
    workingDir: undefined,
    help: false,
    version: false,
    json: false,
    yes: false,
    check: false,
    all: false,
    provider: undefined,
    model: undefined,
    hostname: undefined,
    port: undefined,
    host: undefined,
    token: undefined,
    configOverrides: [],
    enableFeatures: [],
    disableFeatures: [],
  };
}

/** `--name=value` split into its two halves; a bare `--name` yields no value. */
function splitOption(token: string): { readonly name: string; readonly value: string | undefined } {
  const index = token.indexOf('=');
  if (index < 0) return { name: token, value: undefined };
  return { name: token.slice(0, index), value: token.slice(index + 1) };
}

function isOptionToken(token: string): boolean {
  return token.startsWith('-') && token !== '-';
}

/**
 * The command word, and where it sits.
 *
 * This runs before the command is known, so it cannot use that command's flag
 * list to decide which tokens are option VALUES rather than the command word.
 * It uses the catalog's arity table instead — every token that appears in more
 * than one command's flags has the same arity in all of them, which a unit test
 * holds to.
 *
 * A `--flag=value` form consumes nothing extra. An unknown option consumes
 * nothing extra either: guessing that it took a value could swallow the command
 * word, and the parse pass will refuse the option by name in a moment anyway.
 */
function findCommandToken(argv: readonly string[]): { readonly token: string; readonly index: number } | null {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === '--') return null;
    if (!isOptionToken(token)) return { token, index };
    const { name, value } = splitOption(token);
    if (value !== undefined) continue;
    const kind = ALL_FLAG_ARITY.get(name);
    if (kind !== undefined && kind !== 'boolean') {
      index += 1;
      continue;
    }
    // A flag this binary refuses still has to have its VALUE skipped, or
    // `--prompt hello` reports "Unknown command: hello" and never names the
    // flag that is actually the problem.
    if (REJECTED_TERMINAL_FLAGS[name]?.takesValue === true) index += 1;
  }
  return null;
}

function parsePort(value: string, optionName: string, errors: string[]): number | undefined {
  if (!/^\d+$/.test(value)) {
    errors.push(`${optionName} must be a port number from 1 to 65535.`);
    return undefined;
  }
  const port = Number.parseInt(value, 10);
  if (port < 1 || port > 65535) {
    errors.push(`${optionName} must be a port number from 1 to 65535.`);
    return undefined;
  }
  return port;
}

/**
 * `provider:model` and `provider/model` name the provider inside the model id.
 * A `--provider` the operator typed explicitly always wins.
 */
function inferProviderFromModel(model: string, currentProvider: string | undefined): string | undefined {
  if (currentProvider !== undefined) return currentProvider;
  if (model.includes(':')) return model.split(':')[0];
  if (model.includes('/')) return model.split('/')[0];
  return undefined;
}

type MutableFlags = {
  -readonly [K in keyof DaemonCliFlags]: DaemonCliFlags[K];
};

function applyFlagValue(
  flags: MutableFlags,
  spec: DaemonCommandFlagSpec,
  optionName: string,
  rawValue: string,
  errors: string[],
): void {
  switch (spec.kind) {
    case 'boolean':
      // Never reached: the caller only supplies a value for value-taking kinds.
      return;
    case 'port': {
      const port = parsePort(rawValue, optionName, errors);
      if (port !== undefined) flags.port = port;
      return;
    }
    case 'string-list': {
      const key = spec.field;
      if (key === 'configOverrides' || key === 'enableFeatures' || key === 'disableFeatures') {
        flags[key] = [...flags[key], rawValue];
      }
      return;
    }
    case 'string': {
      switch (spec.field) {
        case 'daemonHome': flags.daemonHome = rawValue; return;
        case 'workingDir': flags.workingDir = rawValue; return;
        case 'provider': flags.provider = rawValue; return;
        case 'model':
          flags.model = rawValue;
          flags.provider = inferProviderFromModel(rawValue, flags.provider);
          return;
        case 'hostname': flags.hostname = rawValue; return;
        case 'host': flags.host = rawValue; return;
        case 'token': flags.token = rawValue; return;
        default: return;
      }
    }
  }
}

function applyBooleanFlag(flags: MutableFlags, spec: DaemonCommandFlagSpec): void {
  switch (spec.field) {
    case 'help': flags.help = true; return;
    case 'version': flags.version = true; return;
    case 'json': flags.json = true; return;
    case 'yes': flags.yes = true; return;
    case 'check': flags.check = true; return;
    case 'all': flags.all = true; return;
    default: return;
  }
}

/** Which flag spec (if any) a token selects, among the ones this command takes. */
function findFlagSpec(
  accepted: readonly DaemonCommandFlagSpec[],
  name: string,
): DaemonCommandFlagSpec | undefined {
  return accepted.find((spec) => spec.tokens.includes(name));
}

/**
 * The refusal for a flag this binary understands but this command does not,
 * or one it does not understand at all. Both name what to do next, because
 * "Unknown option: --foo" on its own has never helped anyone.
 */
function unacceptedOptionError(name: string, command: DaemonCommand, binary: string): string {
  const rejected = REJECTED_TERMINAL_FLAGS[name];
  if (rejected !== undefined) {
    return `${name} is not a ${binary} flag — ${rejected.reason} belongs to the terminal app, not the daemon.`;
  }
  const spec = daemonCommandSpec(command);
  const known = ALL_FLAG_ARITY.has(name);
  const accepted = flagsForCommand(command)
    .flatMap((flag) => flag.tokens)
    .filter((token) => token.startsWith('--'))
    .join(', ');
  return known
    ? `${name} is not a flag \`${spec.name}\` takes. It accepts: ${accepted}`
    : `Unknown option: ${name}. \`${spec.name}\` accepts: ${accepted}`;
}

export interface ParseDaemonCliOptions {
  /** Name used in every message. Defaults to `goodvibes-daemon`. */
  readonly binary?: string | undefined;
}

/**
 * Parse a daemon command line.
 *
 * Never throws: every problem comes back as a line in `errors`, so the caller
 * decides how to report it (this binary writes them to the descriptor a service
 * journal is attached to, then exits 2).
 */
export function parseDaemonCli(
  argv: readonly string[],
  binary = 'goodvibes-daemon',
): DaemonCliParseResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const flags: MutableFlags = createDefaultFlags();
  const commandArgs: string[] = [];

  const found = findCommandToken(argv);
  let command: DaemonCommand = 'serve';
  let rawCommand: string | undefined;

  if (found) {
    const resolved = resolveDaemonCommand(found.token);
    if (resolved === undefined) {
      // The single most important refusal in this file. Every unmatched word
      // used to become a positional and the process served.
      errors.push(`Unknown command: ${found.token}`);
      return {
        binary,
        command: 'help',
        rawCommand: found.token,
        commandArgs: [],
        flags,
        errors,
        warnings,
      };
    }
    command = resolved;
    rawCommand = found.token;
  }

  const spec = daemonCommandSpec(command);
  const accepted = flagsForCommand(command);
  const stopAt = spec.passthrough && found ? found.index : argv.length;

  let passthrough = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;

    if (found && index === found.index) continue;

    if (found && spec.passthrough && index > stopAt) {
      // Everything after a passthrough command word is that command's, verbatim.
      commandArgs.push(token);
      continue;
    }

    if (passthrough) {
      commandArgs.push(token);
      continue;
    }
    if (token === '--') {
      passthrough = true;
      continue;
    }

    if (!isOptionToken(token)) {
      commandArgs.push(token);
      continue;
    }

    const { name, value: inlineValue } = splitOption(token);
    const flagSpec = findFlagSpec(accepted, name);
    if (!flagSpec) {
      errors.push(unacceptedOptionError(name, command, binary));
      // Consume a value only when the token is one this binary knows takes one
      // (accepted elsewhere, or refused but value-taking), so a typo does not
      // swallow the next argument as well.
      const kind: DaemonCliFlagKind | undefined = ALL_FLAG_ARITY.get(name);
      const consumesValue = (kind !== undefined && kind !== 'boolean')
        || REJECTED_TERMINAL_FLAGS[name]?.takesValue === true;
      if (inlineValue === undefined && consumesValue) index += 1;
      continue;
    }

    if (flagSpec.kind === 'boolean') {
      if (inlineValue !== undefined) {
        errors.push(`${name} takes no value.`);
        continue;
      }
      applyBooleanFlag(flags, flagSpec);
      continue;
    }

    if (inlineValue !== undefined) {
      applyFlagValue(flags, flagSpec, name, inlineValue, errors);
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined || isOptionToken(next)) {
      errors.push(`${name} requires a value.`);
      continue;
    }
    index += 1;
    applyFlagValue(flags, flagSpec, name, next, errors);
  }

  return { binary, command, rawCommand, commandArgs, flags, errors, warnings };
}

/**
 * The catalog's own consistency, checked rather than assumed.
 *
 * `findCommandToken` runs before the command is known and therefore reads
 * arity from one table shared across commands. That is only honest while no
 * token means "boolean" under one command and "takes a value" under another.
 * Exported so a unit test asserts it on the real catalog; a violation is
 * returned as a list of problems, never thrown, so the test can name them.
 */
export function findCatalogFlagArityConflicts(): readonly string[] {
  const seen = new Map<string, { kind: DaemonCliFlagKind; where: string }>();
  const problems: string[] = [];
  const check = (flagSpec: DaemonCommandFlagSpec, where: string): void => {
    for (const token of flagSpec.tokens) {
      const previous = seen.get(token);
      if (previous && previous.kind !== flagSpec.kind) {
        problems.push(`${token} is ${previous.kind} in ${previous.where} but ${flagSpec.kind} in ${where}`);
        continue;
      }
      if (!previous) seen.set(token, { kind: flagSpec.kind, where });
    }
  };
  for (const command of DAEMON_COMMANDS) {
    for (const flagSpec of flagsForCommand(command.name)) check(flagSpec, command.name);
  }
  return problems;
}
