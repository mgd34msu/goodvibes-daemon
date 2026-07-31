import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DAEMON_COMMANDS } from '../../cli/command-catalog.ts';

/**
 * The entry point's dispatch, asserted against its source.
 *
 * `src/daemon/cli.ts` composes a whole daemon on its serving path — it cannot
 * be imported into a test process and driven. What CAN be held is the shape of
 * the dispatch: that the vocabulary is the parser's, that every command in the
 * catalog is reached by something, and that no path other than `serve` falls
 * through into the boot sequence. That fall-through is the defect this work
 * exists to close, so it is the thing worth pinning.
 */
const SOURCE = readFileSync(join(import.meta.dir, '../../daemon/cli.ts'), 'utf-8');

describe('the daemon entry point dispatches on the command catalog', () => {
  test('it parses with the catalog-driven parser', () => {
    expect(SOURCE).toContain("import {\n  parseDaemonCli,");
    expect(SOURCE).toContain("const cli = parseDaemonCli(process.argv.slice(2), 'goodvibes-daemon');");
  });

  test('a parse error exits 2 with the help, before anything is composed', () => {
    const parseAt = SOURCE.indexOf('const cli = parseDaemonCli(');
    const refuseAt = SOURCE.indexOf('if (cli.errors.length > 0) {');
    const composeAt = SOURCE.indexOf('createRuntimeServices({');
    expect(parseAt).toBeGreaterThan(0);
    expect(refuseAt).toBeGreaterThan(parseAt);
    expect(refuseAt).toBeLessThan(composeAt);
    expect(SOURCE.slice(refuseAt, refuseAt + 400)).toContain('process.exit(2)');
  });

  test('every command in the catalog is dispatched somewhere before the boot sequence', () => {
    const composeAt = SOURCE.indexOf('createRuntimeServices({');
    const beforeBoot = SOURCE.slice(0, composeAt);
    for (const spec of DAEMON_COMMANDS) {
      if (spec.name === 'serve') continue; // serve IS the boot sequence
      const dispatched = beforeBoot.includes(`cli.command === '${spec.name}'`)
        || beforeBoot.includes(`rawArgs[0] === '${spec.name}'`)
        || beforeBoot.includes('isDaemonServiceSubcommand(serviceSubcommand)')
        || beforeBoot.includes('isRawInterceptCommand(cli.command)');
      expect(dispatched).toBe(true);
    }
  });

  test('the service verbs are dispatched off the parsed command, not a loose positional', () => {
    // They used to be read from `cli.positionals[0]`, which is exactly why a
    // mistyped one became a positional nothing matched and the daemon served.
    expect(SOURCE).not.toContain('cli.positionals');
    expect(SOURCE).toContain('const serviceSubcommand = cli.command;');
    expect(SOURCE).toContain('isDaemonServiceSubcommand(serviceSubcommand)');
  });

  test('status, update, sessions, pair and config all run before any runtime is composed', () => {
    const composeAt = SOURCE.indexOf('createRuntimeServices({');
    for (const command of ['status', 'update', 'sessions', 'pair', 'config']) {
      const at = SOURCE.indexOf(`cli.command === '${command}'`);
      expect(at).toBeGreaterThan(0);
      expect(at).toBeLessThan(composeAt);
    }
  });

  test('a passthrough command reached through the parser is refused, never served', () => {
    const guardAt = SOURCE.indexOf('isRawInterceptCommand(cli.command)');
    const composeAt = SOURCE.indexOf('createRuntimeServices({');
    expect(guardAt).toBeGreaterThan(0);
    expect(guardAt).toBeLessThan(composeAt);
    expect(SOURCE.slice(guardAt, guardAt + 600)).toContain('process.exit(2)');
  });

  test('--hostname/--port are written into config only on the serving path', () => {
    // On `status` the same --port names the daemon to CALL. Writing it into
    // this process's control-plane config would answer a different question.
    const guardAt = SOURCE.indexOf("if (cli.command === 'serve') {");
    const applyAt = SOURCE.indexOf('applyRuntimeEndpointFlagOverrides(config,');
    expect(guardAt).toBeGreaterThan(0);
    expect(applyAt).toBeGreaterThan(guardAt);
  });

  test('`help <command>` prints that command\'s page, and an unknown word is refused', () => {
    expect(SOURCE).toContain('renderDaemonCommandHelp(topic');
    const helpAt = SOURCE.indexOf('const page = renderDaemonCommandHelp(topic');
    expect(SOURCE.slice(helpAt, helpAt + 400)).toContain('Unknown command: ${topic}');
  });

  test('the startup pairing block and `pair` render from the one module', () => {
    expect(SOURCE).toContain("import { renderPairingBanner } from '../core/pairing-banner.ts';");
    expect(SOURCE).toContain('const banner = renderPairingBanner({');
    expect(SOURCE).toContain('goodvibes-daemon pair');
  });
});
