/**
 * A plugin dropped into the plugin directory, loaded by the daemon.
 *
 * The graph constructed a PluginManager and never called init on it, so this
 * host could list a plugin directory and load nothing out of it: `enable`
 * persisted a flag that turned nothing on, and a plugin's channel adapter,
 * delivery strategy or gateway verb — the three kinds only this process can
 * serve — reached nothing no matter where it was installed.
 *
 * This drives the real loader against a real fixture on disk, because until now
 * no test in any repository had executed the init path at all: every plugin
 * test in the platform exercised the branch where deps are unset.
 *
 * The fixture registers all four kinds deliberately. The SDK's loader has no
 * per-kind degrade — a missing registry throws inside the plugin's own init and
 * the whole plugin is dropped, halves this host could serve included — so the
 * test that matters is that a plugin declaring BOTH halves still lands its
 * daemon half here.
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import { ChannelDeliveryRouter, ChannelPluginRegistry } from '@pellux/goodvibes-sdk/platform/channels';
import { GatewayMethodCatalog } from '@pellux/goodvibes-sdk/platform/control-plane';
import { MediaProviderRegistry } from '@pellux/goodvibes-sdk/platform/media';
import { MemoryEmbeddingProviderRegistry } from '@pellux/goodvibes-sdk/platform/state';
import { VoiceProviderRegistry } from '@pellux/goodvibes-sdk/platform/voice';
import { WebSearchProviderRegistry } from '@pellux/goodvibes-sdk/platform/web-search';
import { PluginManager, type PluginLoaderDeps } from '@pellux/goodvibes-sdk/platform/plugins';
import { RuntimeEventBus } from '@/runtime/index.ts';
import {
  createDaemonPluginLoaderDeps,
  createUnservedCommandRegistry,
  UnservedToolRegistry,
} from '../../runtime/plugin-composition.ts';
import { disposeTestRuntimeServicesAfterAll, getTestRuntimeServices } from '../helpers/runtime-services.ts';

disposeTestRuntimeServicesAfterAll();

let root: string;

/** A plugin that declares both halves — the daemon's three and a surface's two. */
const BOTH_HALVES_PLUGIN = `
export function init(api) {
  api.registerDeliveryStrategy({
    id: 'fixture-delivery',
    canHandle: () => false,
    deliver: async () => ({ responseId: 'never' }),
  });
  api.registerGatewayMethod(
    { id: 'fixture.ping', category: 'system', scopes: [], transport: ['ws'] },
    async () => ({ ok: true }),
  );
  api.registerCommand({
    name: 'fixture',
    description: 'a slash command this host has no prompt for',
    handler: () => {},
  });
}
`;

function writePlugin(name: string, source: string): void {
  const dir = join(root, '.goodvibes', 'plugins', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
    name,
    version: '1.0.0',
    description: 'fixture',
    main: 'index.js',
  }));
  writeFileSync(join(dir, 'index.js'), source);
}

/** The daemon's dependency shape, with real registries a test can inspect. */
function daemonShapedDeps(): PluginLoaderDeps & {
  readonly router: ChannelDeliveryRouter;
  readonly catalog: GatewayMethodCatalog;
} {
  const configManager = new ConfigManager({
    surfaceRoot: 'tui',
    workingDir: root,
    configDir: join(root, '.goodvibes', 'tui'),
  });
  const router = new ChannelDeliveryRouter({ strategies: [] });
  const catalog = new GatewayMethodCatalog({ includeBuiltins: false });
  return {
    router,
    catalog,
    runtimeBus: new RuntimeEventBus(),
    gatewayMethods: catalog,
    channelRegistry: new ChannelPluginRegistry(),
    channelDeliveryRouter: router,
    providerRegistry: { register: () => {}, registerInstance: () => {} } as unknown as PluginLoaderDeps['providerRegistry'],
    memoryEmbeddingRegistry: new MemoryEmbeddingProviderRegistry({ configManager }),
    voiceProviderRegistry: new VoiceProviderRegistry(),
    mediaProviderRegistry: new MediaProviderRegistry(),
    webSearchProviderRegistry: new WebSearchProviderRegistry({ env: {}, serviceRegistry: { get: () => null } }),
    // The two the daemon cannot serve, exactly as the composition supplies them.
    commandRegistry: createUnservedCommandRegistry(),
    toolRegistry: new UnservedToolRegistry(),
    getPluginConfig: () => ({}),
    isEnabled: () => true,
  };
}

beforeEach(() => {
  root = join(tmpdir(), `gv-daemon-plugins-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(root, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('a plugin in the daemon\'s plugin directory actually loads', () => {
  test('its delivery strategy and gateway verb land, and its slash command does not sink the load', async () => {
    writePlugin('both-halves', BOTH_HALVES_PLUGIN);
    const deps = daemonShapedDeps();
    // The state a previous `enable` left behind — which is exactly what init is
    // for, and exactly what did nothing while init was never called.
    writeFileSync(join(root, 'plugins.json'), JSON.stringify({ enabled: { 'both-halves': true } }));
    const manager = new PluginManager({
      pathOptions: { cwd: root, homeDir: join(root, 'home') },
      stateFilePath: join(root, 'plugins.json'),
    });

    await manager.init(deps);

    const listed = manager.list();
    expect(listed.map((entry) => entry.name)).toContain('both-halves');
    // Enabled in the persisted state, so init loaded it outright.
    expect(listed.find((entry) => entry.name === 'both-halves')?.active).toBe(true);

    // The daemon half is live on the real objects.
    expect(deps.router.listStrategies().map((entry) => entry.id)).toContain('fixture-delivery');
    expect(deps.catalog.get('fixture.ping')).toBeDefined();
  });

  test('an unserved slash command is accepted rather than throwing the plugin away', () => {
    const registry = createUnservedCommandRegistry();
    expect(() => registry.register({
      name: 'fixture',
      description: 'x',
      handler: () => {},
    })).not.toThrow();
    expect(() => registry.unregister('fixture')).not.toThrow();
  });
});

describe('the composition wires the registries this host can serve', () => {
  test('the delivery router handed to a plugin is the one replies leave through', () => {
    const services = getTestRuntimeServices();
    const deps = createDaemonPluginLoaderDeps(services);
    // Not a second router built from the same arguments: the same object.
    expect(deps.channelDeliveryRouter).toBe(services.deliveryManager.getDeliveryRouter());
  });

  test('the gateway catalog and channel registry are the served ones', () => {
    const services = getTestRuntimeServices();
    const deps = createDaemonPluginLoaderDeps(services);
    expect(deps.gatewayMethods).toBe(services.gatewayMethods);
    expect(deps.channelRegistry).toBe(services.channelPlugins);
  });

  test('boot calls init — a manager that is never initialised loads nothing', () => {
    const bootTasks = readFileSync(join(import.meta.dir, '..', '..', 'runtime', 'boot-tasks.ts'), 'utf8');
    expect(bootTasks).toContain('services.pluginManager.init(createDaemonPluginLoaderDeps(services))');
  });
});
