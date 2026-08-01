import type { ConfigKey } from '@pellux/goodvibes-sdk/platform/config';

/**
 * The channel surfaces the platform can speak on, with the settings keys each
 * one needs configured.
 *
 * The daemon reads this to answer "which channels are actually usable" — the
 * `send` subcommand lists them and refuses a channel whose keys are unset,
 * rather than accepting the message and dropping it. A surface added here
 * becomes visible to `send` with no further wiring.
 */
export const SURFACE_CONFIGS = [
  ['slack', 'Slack', ['surfaces.slack.signingSecret', 'surfaces.slack.botToken']],
  ['discord', 'Discord', ['surfaces.discord.publicKey', 'surfaces.discord.botToken', 'surfaces.discord.applicationId']],
  ['telegram', 'Telegram', ['surfaces.telegram.botToken']],
  ['webhook', 'Webhook', ['surfaces.webhook.secret']],
  ['ntfy', 'ntfy', ['surfaces.ntfy.baseUrl']],
  ['googleChat', 'Google Chat', ['surfaces.googleChat.webhookUrl']],
  ['signal', 'Signal', ['surfaces.signal.bridgeUrl', 'surfaces.signal.account']],
  ['whatsapp', 'WhatsApp', ['surfaces.whatsapp.accessToken', 'surfaces.whatsapp.phoneNumberId']],
  ['imessage', 'iMessage', ['surfaces.imessage.bridgeUrl', 'surfaces.imessage.account']],
  ['msteams', 'Microsoft Teams', ['surfaces.msteams.appId', 'surfaces.msteams.appPassword']],
  ['bluebubbles', 'BlueBubbles', ['surfaces.bluebubbles.serverUrl', 'surfaces.bluebubbles.password']],
  ['mattermost', 'Mattermost', ['surfaces.mattermost.baseUrl', 'surfaces.mattermost.botToken']],
  ['matrix', 'Matrix', ['surfaces.matrix.homeserverUrl', 'surfaces.matrix.accessToken', 'surfaces.matrix.userId']],
] as const;
