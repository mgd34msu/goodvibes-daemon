/**
 * CLI barrel for the daemon product.
 *
 * The daemon's command surface is the flag parser, the help and banner
 * renderers, the runtime config/feature/endpoint overrides, and the endpoint
 * resolution the banner and the service unit both read. Everything else the
 * terminal app's CLI barrel carried (interactive status, completion, doctor,
 * plugin and bundle commands) belongs to that surface, not here.
 */
export * from './types.ts';
export * from './parser.ts';
export * from './help.ts';
export * from './config-overrides.ts';
export * from './endpoints.ts';
