/**
 * command-catalog.ts — WHAT the daemon binary understands.
 *
 * This file is data. It holds no parsing logic, reads no argv and imports
 * nothing from the parser. `parser.ts` is the engine: it is handed a catalog
 * and an argument list and knows nothing about daemons. That seam is
 * deliberate — the terminal-shell package is expected to own the engine later,
 * at which point this file is the only part that stays behind, and it can be
 * moved under a different engine without editing a line of it.
 *
 * The seam in one sentence: `DaemonCommandSpec[]` in, `DaemonCliParseResult`
 * out, and nothing daemon-shaped in between.
 *
 * WHY THIS EXISTS AT ALL
 *
 * The binary shipped with the terminal app's alias table — `tui`, `run`,
 * `doctor`, `models`, `providers`, `auth`, `secrets`, `tasks`, `hooks`,
 * `plugin` and two dozen more — while the entry point dispatched on help,
 * version and four service subcommands. Everything else fell through to
 * "start a daemon in the foreground": `goodvibes-daemon doctor` served,
 * `goodvibes-daemon install-servce` (typo) served, and the unknown-command
 * error the parser carried was unreachable because no token could ever fail
 * to match. The vocabulary below is exactly the set of things this binary
 * actually does, and the engine refuses everything else.
 */

/** Every command this binary has. There is no other. */
export type DaemonCommand =
  | 'serve'
  | 'install-service'
  | 'uninstall-service'
  | 'service-status'
  | 'migrate-service'
  | 'start-service'
  | 'stop-service'
  | 'restart-service'
  | 'status'
  | 'pair'
  | 'sessions'
  | 'config'
  | 'update'
  | 'send'
  | 'cluster'
  | 'webui'
  | 'provision-wake-model'
  | 'completion'
  | 'help'
  | 'version';

/**
 * Where a flag's value lands in {@link DaemonCliFlags}.
 *
 * Named per flag rather than derived from the flag text because one token
 * legitimately means two things: `--host` names the BIND address for `serve`
 * and the TARGET daemon for `status`. The catalog says which, per command, so
 * neither has to be guessed at the point of use.
 */
export type DaemonCliFlagField =
  | 'daemonHome'
  | 'workingDir'
  | 'help'
  | 'version'
  | 'json'
  | 'yes'
  | 'check'
  | 'all'
  | 'provider'
  | 'model'
  | 'hostname'
  | 'port'
  | 'host'
  | 'token'
  | 'configOverrides'
  | 'enableFeatures'
  | 'disableFeatures';

/** How a flag consumes argv, and what shape its value has. */
export type DaemonCliFlagKind = 'boolean' | 'string' | 'port' | 'string-list';

export interface DaemonCommandFlagSpec {
  /** Every spelling that selects this flag, longest-lived first. `-C`, `--cd`, `--working-dir`. */
  readonly tokens: readonly string[];
  readonly field: DaemonCliFlagField;
  readonly kind: DaemonCliFlagKind;
  /** Placeholder shown in help for a value-taking flag. */
  readonly valueName?: string | undefined;
  readonly summary: string;
}

export interface DaemonCommandSpec {
  readonly name: DaemonCommand;
  /** Extra spellings that resolve to this command. The name itself is always accepted. */
  readonly aliases: readonly string[];
  /** One line, for the command list in `--help`. */
  readonly summary: string;
  /** Argument shape, shown as the first line of `help <command>`. */
  readonly usage: string;
  /** The body of `help <command>` — full sentences, no telegraphese. */
  readonly detail: readonly string[];
  /** Flags this command accepts, beyond the global ones. */
  readonly flags: readonly DaemonCommandFlagSpec[];
  /**
   * True when everything after the command word belongs to the command's own
   * parser rather than to this one. `send` carries arbitrary operator text — a
   * message starting with a dash, or one containing `--port`, has to reach the
   * channel intact rather than be eaten as a daemon flag.
   */
  readonly passthrough: boolean;
  /** Positional words the command takes, for completion. Empty for most. */
  readonly subcommands: readonly string[];
}

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

/** Accepted before or after any command, on every command. */
export const GLOBAL_FLAGS: readonly DaemonCommandFlagSpec[] = [
  {
    tokens: ['--daemon-home'],
    field: 'daemonHome',
    kind: 'string',
    valueName: 'dir',
    summary: "The daemon's own identity directory (operator tokens, auth users, daemon settings).",
  },
  {
    tokens: ['--working-dir', '--cd', '-C'],
    field: 'workingDir',
    kind: 'string',
    valueName: 'dir',
    summary: 'The directory the daemon treats as its workspace.',
  },
  { tokens: ['--help', '-h'], field: 'help', kind: 'boolean', summary: 'Print help and exit 0.' },
  { tokens: ['--version', '-v'], field: 'version', kind: 'boolean', summary: 'Print the version and exit 0.' },
];

const JSON_FLAG: DaemonCommandFlagSpec = {
  tokens: ['--json'],
  field: 'json',
  kind: 'boolean',
  summary: 'Print one JSON document instead of prose, for scripting.',
};

const YES_FLAG: DaemonCommandFlagSpec = {
  tokens: ['--yes', '-y', '--non-interactive'],
  field: 'yes',
  kind: 'boolean',
  summary: 'Answer the confirmation prompt with yes. Nothing destructive happens without it.',
};

/**
 * The target-daemon flags, spelled the same way everywhere.
 *
 * This is the convention `src/cluster/remote-daemon-target.ts` established and
 * asked later subcommands to follow: `--host`/`--port`/`--token`, each
 * defaulting to this machine's own daemon — the configured control-plane
 * binding and the operator token in `<daemon home>/operator-tokens.json`. A
 * headless box the operator has SSHed into must work with no flags at all.
 */
const REMOTE_TARGET_FLAGS: readonly DaemonCommandFlagSpec[] = [
  {
    tokens: ['--host'],
    field: 'host',
    kind: 'string',
    valueName: 'name',
    summary: 'The machine to ask. Defaults to this one.',
  },
  {
    tokens: ['--port'],
    field: 'port',
    kind: 'port',
    valueName: 'n',
    summary: "That daemon's control-plane port. Defaults to the configured one.",
  },
  {
    tokens: ['--token'],
    field: 'token',
    kind: 'string',
    valueName: 't',
    summary: 'Operator token for that daemon. Defaults to this machine\'s own.',
  },
];

const SERVE_FLAGS: readonly DaemonCommandFlagSpec[] = [
  {
    tokens: ['--hostname', '--host'],
    field: 'hostname',
    kind: 'string',
    valueName: 'host',
    summary: 'Bind address for the control plane. 0.0.0.0 means every interface.',
  },
  {
    tokens: ['--port'],
    field: 'port',
    kind: 'port',
    valueName: 'n',
    summary: 'Control-plane port to bind.',
  },
  {
    tokens: ['--provider'],
    field: 'provider',
    kind: 'string',
    valueName: 'id',
    summary: 'Run with this provider instead of the configured one. Not written to settings.',
  },
  {
    tokens: ['--model', '-m'],
    field: 'model',
    kind: 'string',
    valueName: 'registryKey',
    summary: 'Run with this model. A provider:model key also sets the provider.',
  },
  {
    tokens: ['--config', '-c'],
    field: 'configOverrides',
    kind: 'string-list',
    valueName: 'key=value',
    summary: 'Override one settings key for this run only. Repeatable. Never written to disk.',
  },
  {
    tokens: ['--enable'],
    field: 'enableFeatures',
    kind: 'string-list',
    valueName: 'feature',
    summary: 'Switch a capability on for this run through its real settings key. Repeatable.',
  },
  {
    tokens: ['--disable'],
    field: 'disableFeatures',
    kind: 'string-list',
    valueName: 'feature',
    summary: 'Switch a capability off for this run. Repeatable.',
  },
];

/**
 * Flags this binary once accepted in silence because it was carrying the
 * terminal app's parser.
 *
 * Every one of them means "start or resume a conversation", which this binary
 * does not do — and each was accepted, stored in a flag record nothing read,
 * and then ignored. `goodvibes-daemon --resume` started a fresh foreground
 * daemon and said nothing about the flag. They are refused by name so the
 * message names the surface that does own them.
 */
export interface RejectedFlagSpec {
  /** What the flag was for, named so the refusal points at the right surface. */
  readonly reason: string;
  /**
   * True when the flag took a value in the parser this binary inherited.
   *
   * It matters for the refusal, not for the behaviour: the engine has to skip a
   * refused flag's VALUE while hunting for the command word, or
   * `--prompt hello` reports "Unknown command: hello" instead of naming the
   * flag that is actually wrong. `--resume` and `--fork` took an OPTIONAL
   * value, so they are listed as taking none — over-skipping would swallow a
   * real command word.
   */
  readonly takesValue: boolean;
}

export const REJECTED_TERMINAL_FLAGS: Readonly<Record<string, RejectedFlagSpec>> = {
  '--resume': { reason: 'resuming a conversation', takesValue: false },
  '-r': { reason: 'resuming a conversation', takesValue: false },
  '--continue': { reason: 'continuing the last conversation', takesValue: false },
  '--fork': { reason: 'forking a conversation', takesValue: false },
  '--print': { reason: 'printing one conversation turn', takesValue: false },
  '--prompt': { reason: 'sending a prompt', takesValue: true },
  '-p': { reason: 'sending a prompt', takesValue: true },
  '--output': { reason: 'choosing a conversation output format', takesValue: true },
  '--output-format': { reason: 'choosing a conversation output format', takesValue: true },
  '-o': { reason: 'choosing a conversation output format', takesValue: true },
  '--open': { reason: 'opening a browser window', takesValue: false },
  '--no-alt-screen': { reason: 'terminal screen handling', takesValue: false },
  '--session': { reason: 'selecting a conversation', takesValue: true },
  '-s': { reason: 'selecting a conversation', takesValue: true },
  '--strict': { reason: "the doctor command's strict mode", takesValue: false },
};

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const SERVICE_DETAIL_TAIL: readonly string[] = [
  '',
  'The service is a systemd user unit on Linux, a launchd user agent on macOS,',
  'and a Scheduled Task on Windows. `service-status` names the one in use.',
];

export const DAEMON_COMMANDS: readonly DaemonCommandSpec[] = [
  {
    name: 'serve',
    aliases: [],
    summary: 'Run the daemon in the foreground. This is what a bare invocation does.',
    usage: 'goodvibes-daemon [serve] [OPTIONS]',
    detail: [
      'Start the control plane, the channel pollers, the cluster membership and',
      'every verb family a GoodVibes client calls, and keep running until stopped.',
      '',
      'Serving happens on a bare invocation or on the word `serve`, and on nothing',
      'else. Any other first word is a command; an unrecognized one is refused',
      'rather than quietly treated as "start serving".',
      '',
      'To have it survive reboots instead, install it as a service:',
      '  goodvibes-daemon install-service',
    ],
    flags: SERVE_FLAGS,
    passthrough: false,
    subcommands: [],
  },
  {
    name: 'install-service',
    aliases: [],
    summary: 'Install the daemon as a host service and start it.',
    usage: 'goodvibes-daemon install-service',
    detail: [
      'Write the service definition for this platform, then start it, so the daemon',
      'comes back after a reboot without anyone logging in.',
      '',
      'Refused when a unit from the older install script is still present, because',
      'installing beside it would leave two daemons competing for one port. Take',
      'that one over with `migrate-service` first.',
      ...SERVICE_DETAIL_TAIL,
    ],
    flags: [],
    passthrough: false,
    subcommands: [],
  },
  {
    name: 'uninstall-service',
    aliases: [],
    summary: 'Stop the daemon service and remove its definition.',
    usage: 'goodvibes-daemon uninstall-service',
    detail: [
      'Stop the service and delete its definition file. On systemd this does not run',
      '`disable`, so a stale enablement symlink can remain until',
      '`systemctl --user daemon-reload`; the receipt says so when it applies.',
      ...SERVICE_DETAIL_TAIL,
    ],
    flags: [],
    passthrough: false,
    subcommands: [],
  },
  {
    name: 'service-status',
    aliases: [],
    summary: 'Report whether the daemon service is installed and running.',
    usage: 'goodvibes-daemon service-status [--json]',
    detail: [
      'Report the platform, the service name, the definition path, and whether the',
      'service is installed and currently running. systemd and launchd are queried',
      'live rather than inferred from a pid file.',
      '',
      'Exit codes, so a script never has to read the prose:',
      '  0  installed and running',
      '  3  installed but not running',
      '  4  not installed',
      '  1  the platform refused the query (the error is printed)',
      ...SERVICE_DETAIL_TAIL,
    ],
    flags: [JSON_FLAG],
    passthrough: false,
    subcommands: [],
  },
  {
    name: 'migrate-service',
    aliases: [],
    summary: 'Take over a service unit left by the older install script.',
    usage: 'goodvibes-daemon migrate-service [-y]',
    detail: [
      'Move from the install script\'s `goodvibes-daemon.service` unit to the one this',
      'binary manages. Without -y it prints the exact plan and changes nothing.',
      '',
      'The new service is installed, started and verified healthy BEFORE the old one',
      'is stopped or removed; a new service that does not come up rolls itself back',
      'and leaves the working one alone. A process listening on the port with no unit',
      'behind it is reported, never killed.',
      ...SERVICE_DETAIL_TAIL,
    ],
    flags: [YES_FLAG],
    passthrough: false,
    subcommands: [],
  },
  {
    name: 'start-service',
    aliases: [],
    summary: 'Start the installed daemon service.',
    usage: 'goodvibes-daemon start-service',
    detail: [
      'Start the service this binary manages, and report what the platform did.',
      'An absent service is reported as absent rather than silently installed.',
      ...SERVICE_DETAIL_TAIL,
    ],
    flags: [],
    passthrough: false,
    subcommands: [],
  },
  {
    name: 'stop-service',
    aliases: [],
    summary: 'Stop the daemon service without removing it.',
    usage: 'goodvibes-daemon stop-service',
    detail: [
      'Stop the service this binary manages. The definition stays in place, so',
      '`start-service` brings it back and a reboot still starts it.',
      ...SERVICE_DETAIL_TAIL,
    ],
    flags: [],
    passthrough: false,
    subcommands: [],
  },
  {
    name: 'restart-service',
    aliases: [],
    summary: 'Restart the daemon service.',
    usage: 'goodvibes-daemon restart-service',
    detail: [
      'Restart the service this binary manages — the usual way to pick up a settings',
      'change that only applies at boot.',
      ...SERVICE_DETAIL_TAIL,
    ],
    flags: [],
    passthrough: false,
    subcommands: [],
  },
  {
    name: 'status',
    aliases: [],
    summary: 'Ask a running daemon what it is doing.',
    usage: 'goodvibes-daemon status [--json] [--host <name>] [--port <n>] [--token <t>]',
    detail: [
      'Talk to a daemon that is already running and report: its version, how long it',
      'has been up, the address it actually bound, what its last update did, whether',
      'its channels and inbox are healthy, its place in the cluster, and how many',
      'sessions it is hosting.',
      '',
      'With no flags it asks the daemon on this machine. --host/--port/--token ask',
      'another one; the token defaults to this machine\'s operator token, which is not',
      'the right credential for a different machine.',
      '',
      'The update, uptime and rollback lines come from files this daemon writes on its',
      'own host, so they are reported for a local daemon and named as unavailable for',
      'a remote one rather than guessed at.',
      '',
      'Exit 0 when the daemon answered, 1 when it could not be reached.',
    ],
    flags: [JSON_FLAG, ...REMOTE_TARGET_FLAGS],
    passthrough: false,
    subcommands: [],
  },
  {
    name: 'pair',
    aliases: ['qr', 'qrcode'],
    summary: 'Print the pairing link and QR code again.',
    usage: 'goodvibes-daemon pair [--json] [--host <name>] [--port <n>] [--token <t>]',
    detail: [
      'Print the same pairing block a daemon prints once at startup: the web origin,',
      'the offers a new device can accept, what it will be able to do, and a QR code',
      'encoding the deep link that opens the web app already signed in.',
      '',
      'It reprints the EXISTING shared token rather than minting a new one, so a link',
      'printed here and one printed at boot are the same link. Scrolling the startup',
      'banner off the screen therefore costs nothing.',
      '',
      'The link is assembled from this machine\'s own token store, so it is a local',
      'command: a --host naming another machine is refused with the reason rather',
      'than answered with a link that machine would reject.',
    ],
    flags: [
      JSON_FLAG,
      ...REMOTE_TARGET_FLAGS,
    ],
    passthrough: false,
    subcommands: [],
  },
  {
    name: 'sessions',
    aliases: ['session'],
    summary: 'List or end the sessions a running daemon is hosting.',
    usage: 'goodvibes-daemon sessions list|kill <id> [--json] [--all] [--host <name>] [--port <n>] [--token <t>]',
    detail: [
      'sessions list          every session this daemon hosts, most recently used first.',
      'sessions kill <id>     end one: its in-flight turn is interrupted and its loop',
      '                       taken apart, whoever is attached and whatever its detach',
      '                       policy says.',
      '',
      '--all includes sessions that have already ended; they are kept, with the reason',
      'they ended, until the retention window retires them.',
      '',
      'These are the daemon\'s own hosted sessions — conversations running INSIDE it,',
      'which outlive the client that started them. Sessions a terminal runs on this',
      'machine are that terminal\'s, and are not listed here.',
    ],
    flags: [
      JSON_FLAG,
      { tokens: ['--all'], field: 'all', kind: 'boolean', summary: 'Include sessions that have already ended.' },
      ...REMOTE_TARGET_FLAGS,
    ],
    passthrough: false,
    subcommands: ['list', 'kill'],
  },
  {
    name: 'config',
    aliases: [],
    summary: 'Read and write this daemon\'s settings.',
    usage: 'goodvibes-daemon config list|get <key>|set <key> <value>|unset <key> [--json]',
    detail: [
      'config list            every setting with a value, and where the value came from.',
      'config get <key>       one setting.',
      'config set <key> <v>   write one setting to disk. The value is checked against the',
      '                       schema first, and a daemon-owned key lands in the daemon\'s',
      '                       own settings file rather than the shared one.',
      'config unset <key>     put one setting back to its shipped default.',
      '',
      'Values are read and written on this machine\'s settings files directly, so this',
      'works whether or not a daemon is running. A running daemon picks up most',
      'changes live; the ones that only apply at bind time say so.',
      '',
      'Anything that reads like a credential — a token, a password, an API key — is',
      'printed as <redacted>. `config set` still writes the real value; it is the',
      'OUTPUT that is redacted, so a settings dump pasted into an issue carries none.',
    ],
    flags: [JSON_FLAG],
    passthrough: false,
    subcommands: ['list', 'get', 'set', 'unset'],
  },
  {
    name: 'update',
    aliases: [],
    summary: 'Report what this daemon knows about its own updates.',
    usage: 'goodvibes-daemon update [--check] [--json] [--host <name>] [--port <n>] [--token <t>]',
    detail: [
      'Report the running version, the receipts the daemon has written about its own',
      'updates and restarts, the version an automatic rollback rejected (if any), and',
      'whether a rollback is currently in force.',
      '',
      '--check asks the daemon to look for a new release now. The daemon checks hourly',
      'on its own and swaps only at an idle moment; this command exists for the case',
      'where you do not want to wait for the next hour.',
      '',
      'The rollback and receipt lines are read from files the daemon writes on its own',
      'host, so they are reported for a local daemon and named as unavailable for a',
      'remote one.',
    ],
    flags: [
      { tokens: ['--check'], field: 'check', kind: 'boolean', summary: 'Ask for an update check now instead of waiting for the hourly one.' },
      JSON_FLAG,
      ...REMOTE_TARGET_FLAGS,
    ],
    passthrough: false,
    subcommands: [],
  },
  {
    name: 'send',
    aliases: [],
    summary: 'Send a message to one of your configured channels.',
    usage: 'goodvibes-daemon send [message] [--channel <id>] [--to <address>] [--title <text>] [--list]',
    detail: [
      'Send a message through Telegram, ntfy, Discord, Slack, Google Chat, Signal,',
      'WhatsApp, iMessage, Teams, BlueBubbles, Mattermost, Matrix or a webhook. The',
      'message is an argument or stdin, so it composes with other tooling.',
      '',
      '--channel <id> picks the channel; with none named it uses your one configured',
      'channel and says which. --to <address> targets a topic, chat or room inside it,',
      '--title <text> sets a title, and --list shows every channel with where it would',
      'send.',
      '',
      'A channel that is switched off is refused rather than redirected to the default,',
      'and a failed send exits non-zero carrying the provider\'s own error. It works',
      'with no daemon running, which is much of the point: the reason to message',
      'yourself is usually that something stopped.',
    ],
    flags: [],
    passthrough: true,
    subcommands: [],
  },
  {
    name: 'cluster',
    aliases: [],
    summary: 'Share inbound channel work with your other machines.',
    usage: 'goodvibes-daemon cluster status|create|join|key|nodes|forget|rotate|leave|rename|groups',
    detail: [
      'Manage the group of machines on this network that share inbound channel work.',
      '',
      '  status            what this machine is doing in its group',
      '  create            start a group here',
      '  join              join one (interactively, or with --group and --key)',
      '  key               print the join key for another machine to use',
      '  nodes             every machine in the group',
      '  groups            groups advertising themselves on this network',
      '  forget <machine>  drop a machine from the group',
      '  rotate [--now]    change the shared key',
      '  rename <name>     rename the group',
      '  leave             leave the group',
      '',
      'Talks to a running daemon over the same --host/--port/--token convention',
      '`status` uses; --json gives a scriptable answer.',
    ],
    flags: [],
    passthrough: true,
    subcommands: ['status', 'create', 'join', 'key', 'nodes', 'forget', 'rotate', 'leave', 'rename', 'groups'],
  },
  {
    name: 'webui',
    aliases: [],
    summary: 'Serve the browser operator surface from this daemon.',
    usage: 'goodvibes-daemon webui enable|disable|status [--bundle-dir <dir>] [--lan|--loopback]',
    detail: [
      'The web UI is a built bundle of static files served by the daemon\'s own',
      'control-plane listener, on the same origin as the API — so the URL to open is',
      'the control-plane one, not the declared web port.',
      '',
      '  enable [--bundle-dir <dir>]  serve the bundle at that directory',
      '  disable                      stop serving it; the bundle stays on disk',
      '  status                       what is served, from where, and who can reach it',
      '',
      '`enable` changes no network exposure on its own: a daemon bound to loopback',
      'keeps serving to this machine only. --lan binds every interface, --loopback',
      'takes it back, and both are stated in the receipt.',
    ],
    flags: [],
    passthrough: true,
    subcommands: ['enable', 'disable', 'status'],
  },
  {
    name: 'provision-wake-model',
    aliases: [],
    summary: 'Fetch any missing wake-word model files.',
    usage: 'goodvibes-daemon provision-wake-model',
    detail: [
      'Fetch the wake-word model files that are missing from the managed voice tree.',
      '',
      'The installer runs this on a binary it has just placed, and a daemon start',
      'retries it, so an install that happened offline heals on its own. A download',
      'that fails is reported and exits 0 — a machine with no wake word still has a',
      'perfectly good daemon.',
    ],
    flags: [],
    passthrough: true,
    subcommands: [],
  },
  {
    name: 'completion',
    aliases: ['completions'],
    summary: 'Print a shell completion script.',
    usage: 'goodvibes-daemon completion bash|zsh|fish',
    detail: [
      'Print a completion script for the named shell on stdout. It completes this',
      'binary\'s commands, their sub-words and their flags, generated from the same',
      'catalog the parser and the help text use — so it cannot drift from what the',
      'binary accepts.',
      '',
      'Install it by writing it somewhere the shell reads, for example:',
      '  goodvibes-daemon completion bash > ~/.local/share/bash-completion/completions/goodvibes-daemon',
      '  goodvibes-daemon completion zsh  > ~/.zfunc/_goodvibes-daemon',
      '  goodvibes-daemon completion fish > ~/.config/fish/completions/goodvibes-daemon.fish',
    ],
    flags: [],
    passthrough: false,
    subcommands: ['bash', 'zsh', 'fish'],
  },
  {
    name: 'help',
    aliases: [],
    summary: 'Print help for the binary, or for one command.',
    usage: 'goodvibes-daemon help [command]',
    detail: [
      'With no argument, print the command list and the global options.',
      'With a command name, print that command\'s arguments, flags and behaviour.',
    ],
    flags: [],
    passthrough: false,
    subcommands: [],
  },
  {
    name: 'version',
    aliases: [],
    summary: 'Print the version.',
    usage: 'goodvibes-daemon version',
    detail: ['Print the binary name and its version, and exit 0.'],
    flags: [],
    passthrough: false,
    subcommands: [],
  },
];

/**
 * The commands whose arguments are read straight off `process.argv` before the
 * parser runs at all, because they must be reachable with no runtime composed
 * and with their own flag vocabulary intact. Kept here so the vocabulary and
 * the dispatch order agree in one place.
 */
export const RAW_INTERCEPT_COMMANDS: readonly DaemonCommand[] = DAEMON_COMMANDS
  .filter((spec) => spec.passthrough)
  .map((spec) => spec.name);

const SPECS_BY_NAME: ReadonlyMap<DaemonCommand, DaemonCommandSpec> = new Map(
  DAEMON_COMMANDS.map((spec) => [spec.name, spec]),
);

/** Every accepted spelling, lowercased, mapped to the command it names. */
export const DAEMON_COMMAND_ALIASES: Readonly<Record<string, DaemonCommand>> = Object.freeze(
  DAEMON_COMMANDS.reduce<Record<string, DaemonCommand>>((table, spec) => {
    table[spec.name] = spec.name;
    for (const alias of spec.aliases) table[alias] = spec.name;
    return table;
  }, {}),
);

export function daemonCommandSpec(command: DaemonCommand): DaemonCommandSpec {
  const spec = SPECS_BY_NAME.get(command);
  // Unreachable through the union, but a thrown error beats an undefined that
  // travels three frames before failing.
  if (!spec) throw new Error(`No catalog entry for command '${command}'`);
  return spec;
}

/** Resolve a raw argv word to a command, or undefined when it names none. */
export function resolveDaemonCommand(token: string): DaemonCommand | undefined {
  return DAEMON_COMMAND_ALIASES[token.toLowerCase()];
}

export function isRawInterceptCommand(command: DaemonCommand): boolean {
  return daemonCommandSpec(command).passthrough;
}

/**
 * Every flag token in the catalog, with its arity.
 *
 * The engine needs this BEFORE it knows which command it is parsing: to find
 * the command word it has to skip over option values, and whether a token
 * takes a value is a property of the token. Every token that appears in more
 * than one command's flag list has the same kind in all of them — asserted by
 * a unit test rather than left as an assumption — so one table is honest.
 */
export const ALL_FLAG_ARITY: ReadonlyMap<string, DaemonCliFlagKind> = (() => {
  const table = new Map<string, DaemonCliFlagKind>();
  const record = (spec: DaemonCommandFlagSpec): void => {
    for (const token of spec.tokens) table.set(token, spec.kind);
  };
  for (const spec of GLOBAL_FLAGS) record(spec);
  for (const command of DAEMON_COMMANDS) for (const spec of command.flags) record(spec);
  return table;
})();

/** Flag specs a given command accepts: the global ones plus its own. */
export function flagsForCommand(command: DaemonCommand): readonly DaemonCommandFlagSpec[] {
  return [...GLOBAL_FLAGS, ...daemonCommandSpec(command).flags];
}
