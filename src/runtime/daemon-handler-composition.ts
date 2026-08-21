/**
 * daemon-handler-composition.ts, the daemon's HOST-side handler surfaces.
 *
 * Attaches this repository's handlers to the SDK-auto-registered builtin
 * gateway descriptors (channels.* / email.* / calendar.*) via
 * catalog.register(descriptor, handler, { replace: true }), the SDK owns
 * every id, descriptor and schema; only the behaviour is ours. The remote
 * surface reuses the SAME DistributedRuntimeManager the SDK facade injects.
 *
 * Split out of services.ts for the 800-line file cap, the same reason
 * the SDK's channel composition exists.
 *
 * The one behavioural decision that lives here: the inbox poller is handed to
 * the cluster coordinator instead of being started eagerly. It is this
 * product's own inbound consumer, the SDK facade does not know it exists,
 * so if it is not gated here it is not gated anywhere, and two goodvibes nodes
 * on one network each read the shared inbox and answer the same message twice.
 */
import type { ConfigManager } from '@pellux/goodvibes-sdk/platform/config';
import type { ClusterCoordinator } from '@pellux/goodvibes-sdk/platform/cluster';
import type { GatewayMethodCatalog } from '@pellux/goodvibes-sdk/platform/control-plane';
import type { SecretsManager } from '@pellux/goodvibes-sdk/platform/config';
import type { ChannelDeliveryRouter } from '@pellux/goodvibes-sdk/platform/channels';
import type { ProviderRegistry } from '@pellux/goodvibes-sdk/platform/providers';
import { registerDaemonHandlers, type DaemonHandlerSurfaces } from '../daemon/handlers/index.ts';
import type { HandlerContext, HandlerLogger } from '../daemon/handlers/context.ts';
import { createDaemonCredentialStore } from '../daemon/handlers/credentials.ts';
import { registerRouting } from '../daemon/handlers/routing/index.ts';
import { registerInboxMethods } from '../daemon/handlers/inbox/index.ts';
import { registerTriagedInbox } from '../daemon/handlers/triage/index.ts';
import { registerDraftMethods } from '../daemon/handlers/drafts/index.ts';
import { registerRemoteSurface } from '../daemon/handlers/remote/index.ts';
import { createPaymentsServices } from './payments-composition.ts';
import { inboxPollerGate } from './cluster-composition.ts';
import type { ShellPathService } from '@/runtime/index.ts';
import type { BrowserCheckoutSeamHolder } from './browser-checkout-seam-holder.ts';

export interface DaemonHandlerCompositionOptions {
  readonly gatewayMethods: GatewayMethodCatalog;
  readonly secretsManager: SecretsManager;
  readonly configManager: ConfigManager;
  readonly workingDirectory: string;
  readonly homeDirectory: string;
  /** Resolves the surface-scoped control-plane paths the payment stores live at. */
  readonly shellPaths: ShellPathService;
  readonly distributedRuntime: NonNullable<Parameters<typeof registerRemoteSurface>[1]>['manager'];
  /**
   * Decides whether THIS node polls the shared inbox. Always supplied by the
   * composition root; the poller is never started outside it.
   */
  readonly clusterCoordinator: ClusterCoordinator;
  /**
   * Where `payments.checkout.*` reads the browser-checkout seam, filled later
   * by services.ts's own `onBrowserCheckout`. See
   * runtime/browser-checkout-seam-holder.ts and payments-composition.ts's
   * header for why this has to be a getter rather than the seam itself.
   */
  readonly checkoutSeam: BrowserCheckoutSeamHolder['get'];
  readonly channelDeliveryRouter: Pick<ChannelDeliveryRouter, 'deliver'>;
  readonly providerRegistry: Pick<ProviderRegistry, 'getCurrentModel' | 'getForModel'>;
}

export function createDaemonHandlerComposition(
  options: DaemonHandlerCompositionOptions,
): DaemonHandlerSurfaces {
  const handlerLogger: HandlerLogger = {
    info: (message, meta) => console.info(message, meta ?? ''),
    warn: (message, meta) => console.warn(message, meta ?? ''),
    error: (message, meta) => console.error(message, meta ?? ''),
  };
  const handlerContext: HandlerContext = {
    catalog: options.gatewayMethods,
    credentials: createDaemonCredentialStore(options.secretsManager),
    configManager: options.configManager,
    workingDirectory: options.workingDirectory,
    homeDirectory: options.homeDirectory,
    logger: handlerLogger,
  };
  return registerDaemonHandlers(handlerContext, {
    registerRouting,
    registerInbox: (ctx, routing) =>
      registerTriagedInbox(ctx, (inboxCtx) => registerInboxMethods(inboxCtx, routing, {
        // Hands polling to leadership. The `channels.inbox.list` read stays
        // available on every node, a standby still SERVES the persisted feed,
        // it just does not FETCH into it.
        gatePolling: (providerId, control) =>
          options.clusterCoordinator.register(inboxPollerGate(providerId, control)),
      })).unregister,
    registerDrafts: (ctx) => registerDraftMethods(ctx),
    // The payment stores need a path resolver and a daemon-scoped secret writer,
    // neither of which is on HandlerContext, so they are built here and the
    // provider only carries the teardown. See payments-composition.ts for the
    // full checkout composition (address store, notifier, merchant judge,
    // browser-checkout seam).
    registerPayments: () => createPaymentsServices({
      gatewayMethods: options.gatewayMethods,
      configManager: options.configManager,
      secretsManager: options.secretsManager,
      shellPaths: options.shellPaths,
      // True only on a machine that is not clustered at all, and false on every
      // node of a cluster.
      //
      // `isMaster` was the obvious answer and it is the wrong one: it means
      // "this node holds at least one inbound surface", which two nodes sharing
      // a mailbox and a Slack workspace both satisfy, so a two-node cluster
      // would have answered true twice. The SDK's gates.ts is explicit that
      // exactly one node may act and that the wrong answer here is a
      // double-spend.
      //
      // The alternative was to register a payments surface with the coordinator
      // and read holdsSurface(), which is this repo's per-surface idiom
      // (inboxPollerGate). It is the right answer once there is something to
      // elect over, and today there is not: ClusterConsumerGate.start() is
      // specified to not resolve until consumption has actually begun, and this
      // composition has no payments consumer to start it. Checkout is now
      // wired (payments.checkout.begin/.fillCard), but registering a gate whose
      // start() does nothing would STILL put a fake consumer in the election and
      // in `cluster status`; a real election is a separate piece of work, left
      // for a later pass, not something wiring the checkout pair itself needed.
      //
      // So the honest reading of the topology stays what it was: clustering off
      // means this is the only node, and it is trivially the one that would
      // spend; clustering on means no payments election has been held and this
      // node cannot claim to have won it. False on every node is also the safe
      // direction, checkPaymentGates refuses on false.
      isPaymentsLeader: () => !options.clusterCoordinator.enabled,
      checkoutSeam: options.checkoutSeam,
      channelDeliveryRouter: options.channelDeliveryRouter,
      providerRegistry: options.providerRegistry,
    }).unregister,
    registerRemote: (ctx) => registerRemoteSurface(ctx, { manager: options.distributedRuntime }),
  });
}
