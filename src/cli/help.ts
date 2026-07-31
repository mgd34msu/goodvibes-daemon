import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../version.ts';

function readJsonVersion(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { name?: unknown; version?: unknown };
    // Only trust OUR package.json — a compiled single-file binary can resolve
    // this path to a different package.json (a bundled dependency's) that
    // reports a placeholder like "0.0.0". Fall through to the baked VERSION in
    // that case rather than rendering a stray version in `--version`/banners.
    if (parsed.name !== 'goodvibes-daemon') return null;
    return typeof parsed.version === 'string' && parsed.version.length > 0 ? parsed.version : null;
  } catch {
    return null;
  }
}

export function getPackageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return readJsonVersion(join(here, '..', '..', 'package.json'))
    ?? VERSION;
}

export function renderGoodVibesVersion(binary = 'goodvibes-daemon'): string {
  return `${binary} ${getPackageVersion()}`;
}

/**
 * Honest one-line startup identity for the daemon binary, emitted right as it
 * begins serving — including on a bare (no-arg) systemd launch. It states the
 * RESOLVED version (never a placeholder), the home/host/port it actually bound,
 * and points at the real service-setup command. This replaces the field
 * behavior where a bare launch showed a wrong "v0.0.0" banner and gave an
 * operator nothing to act on. `version` is passed in (never read from the live
 * build here) so callers/tests can pin a sentinel and never compare the live
 * VERSION.
 */
export function renderDaemonStartupBanner(
  version: string,
  binding: { readonly homeDir: string; readonly host: string; readonly port: number },
  binary = 'goodvibes-daemon',
): string {
  return (
    `${binary} ${version} starting — ` +
    `home=${binding.homeDir} host=${binding.host} port=${binding.port} ` +
    `(manage as a service: ${binary} install-service)`
  );
}

export function renderGoodVibesDaemonHelp(binary = 'goodvibes-daemon'): string {
  return [
    `Usage: ${binary} [COMMAND] [OPTIONS]`,
    '',
    'Starts the headless GoodVibes daemon/API host.',
    '',
    'Commands:',
    '  install-service                Install + enable the daemon as a systemd user service (survives reboots)',
    '  uninstall-service              Disable + remove the daemon systemd user service',
    '  service-status                 Show whether the daemon service is installed / enabled / active',
    '  migrate-service                Guided migration from an install-script goodvibes-daemon.service unit; prints a plan',
    '                                 unless run with -y/--yes (never auto-migrates)',
    '  send [message]                 Send a message to one of your configured channels — Telegram, ntfy,',
    '                                 Discord, Slack, Google Chat, Signal, WhatsApp, iMessage, Teams,',
    '                                 BlueBubbles, Mattermost, Matrix or a webhook. Takes the message as',
    '                                 an argument or on stdin, so it composes with other tooling.',
    '                                 --channel <id> picks the channel; with none named it uses your one',
    '                                 configured channel and says which. --to <address> targets a specific',
    '                                 topic / chat / room within it, --title <text> sets a title, and',
    '                                 --list shows every channel with where it would send. A channel that',
    '                                 is off is refused rather than redirected to the default, and a',
    '                                 failed send exits non-zero with the provider\'s own error.',
    '  provision-wake-model           Fetch any missing wake-word model files into the managed voice tree.',
    '                                 The installer runs this on a freshly placed binary; a daemon start',
    '                                 also retries it, so an offline install heals on its own.',
    '  webui <command>                Serve the browser operator surface from this daemon.',
    '                                 enable [--bundle-dir <dir>] | disable | status',
    '                                 The bundle is served on the same origin as the API, so the URL to open',
    '                                 is the control-plane one. `enable` alone changes no network exposure:',
    '                                 a daemon bound to loopback keeps serving to this machine only. Add',
    '                                 --lan to bind all interfaces, --loopback to take it back.',
    '  cluster <command>              Share inbound channel work with your other machines on this network.',
    '                                 status | create | join | key | nodes | forget <machine> | rotate [--now]',
    '                                 | leave | rename | groups',
    '                                 Talks to a running daemon: add --host/--port/--token for one on another',
    '                                 machine, or --json for a scriptable answer.',
    '',
    'Options:',
    '      --daemon-home <dir>        Override daemon home',
    '      --working-dir <dir>        Override working directory',
    '  -C, --cd <dir>                 Alias for --working-dir',
    '      --provider <id>            Override provider',
    '  -m, --model <registryKey>      Override model. provider:model infers --provider',
    '      --hostname <host>          Hostname hint for printed connection info',
    '      --port <port>              Control-plane port override when supported',
    '  -h, --help                     Print help',
    '  -v, --version                  Print version',
  ].join('\n');
}
