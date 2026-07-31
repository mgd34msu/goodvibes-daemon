/**
 * pair-command.ts — `goodvibes-daemon pair`.
 *
 * Print the pairing block again. The daemon prints it once as it starts; a
 * service-managed daemon prints it where nothing reads, and a person who
 * scrolled past it had no way back to the link.
 *
 * WHY THIS IS A LOCAL COMMAND
 *
 * The link is assembled from the machine's OWN token store: the shared
 * companion token in `<daemon home>/operator-tokens.json`, plus the web origin
 * that machine's settings resolve to. Nothing is asked of a running daemon, and
 * nothing needs to be — which is the useful property, because the pairing link
 * is most wanted on a box where the daemon is not currently up.
 *
 * It still takes the --host/--port/--token flags of the remote convention, and
 * it uses them the only honest way it can: a --host naming a DIFFERENT machine
 * is refused with the reason, because this process cannot read that machine's
 * token store and a link built from this machine's token would be rejected by
 * that machine's daemon. Answering with a link that cannot work would be worse
 * than declining to answer.
 */
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { availablePairingOffers, resolvePairingWebOrigin } from '@pellux/goodvibes-sdk/platform/pairing';
import { renderPairingBanner } from '../core/pairing-banner.ts';
import { extractOperatorToken } from '@pellux/goodvibes-terminal-shell';
import type { DaemonCommandResult, RemoteCommandFlags } from './status-command.ts';

export interface PairCommandDeps {
  readonly configManager: Pick<ConfigManager, 'get'>;
  readonly daemonHomeDir: string;
  readonly version: string;
  /** Injected in tests so nothing reads a real token file. */
  readonly readToken: (daemonHomeDir: string) => string | undefined;
}

export interface RunPairCommandInput extends PairCommandDeps {
  readonly flags: RemoteCommandFlags;
}

/** The hosts that mean "this machine", matching the remote-target convention. */
function namesThisMachine(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === ''
    || normalized === '127.0.0.1'
    || normalized === 'localhost'
    || normalized === '::1'
    || normalized === '0.0.0.0';
}

function failure(error: string, fix: string, json: boolean): DaemonCommandResult {
  return {
    exitCode: 1,
    lines: json ? [JSON.stringify({ ok: false, error, fix }, null, 2)] : [error, `  ${fix}`],
  };
}

export function runPairCommand(input: RunPairCommandInput): DaemonCommandResult {
  const { flags } = input;

  if (flags.host !== undefined && !namesThisMachine(flags.host)) {
    return failure(
      `the pairing link for ${flags.host} is minted from that machine's own token store, which this one cannot read`,
      `run \`goodvibes-daemon pair\` on ${flags.host} itself, or open its web UI and pair from there`,
      flags.json,
    );
  }

  const token = extractOperatorToken(input.readToken(input.daemonHomeDir));
  if (token === undefined) {
    return failure(
      'no operator token was found for this machine, so there is no link to print',
      'start the daemon once — it creates the token as it starts: goodvibes-daemon serve',
      flags.json,
    );
  }

  // The non-writing read: `ensurePublicBaseUrl` (which the boot path uses)
  // freezes a resolved origin into settings, and a command that only PRINTS a
  // link has no business writing configuration as a side effect.
  const origin = resolvePairingWebOrigin(input.configManager);
  const offers = availablePairingOffers({
    relayEnabled: input.configManager.get('relay.enabled') === true,
    stepUpAvailable: true,
  });

  const banner = renderPairingBanner({
    version: input.version,
    origin: origin.origin,
    token,
    offers,
    includeQr: !flags.json,
  });

  if (flags.json) {
    return {
      exitCode: 0,
      lines: [JSON.stringify({
        ok: true,
        data: {
          origin: origin.origin,
          deepLink: banner.deepLink,
          offers,
          capabilities: banner.capabilities,
          ...(banner.notice === undefined ? {} : { notice: banner.notice }),
          originFromPublicBaseUrl: origin.fromPublicBaseUrl,
        },
      }, null, 2)],
    };
  }

  return { exitCode: 0, lines: banner.lines };
}
