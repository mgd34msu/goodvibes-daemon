/**
 * Single SDK-contract import seam for the daemon handler layer.
 *
 * Every other module under `src/daemon/handlers/` imports SDK contract
 * identifiers from HERE and nowhere else. Concentrating the SDK imports in one
 * concrete-submodule module keeps the rest of the layer free of barrel cycles
 * and guarantees the host NEVER re-declares an SDK id, descriptor, or schema,
 * it only attaches handlers to the descriptors the SDK already registered.
 */

// Catalog + invocation contract types (concrete control-plane subpath, not a project barrel).
export type {
  GatewayMethodCatalog,
  GatewayMethodDescriptor,
  GatewayMethodInvocation,
  GatewayMethodInvocationContext,
  GatewayMethodHandler,
} from '@pellux/goodvibes-sdk/platform/control-plane';

// The SDK's own `payments.*` route module: the registrar and the service seam
// it dispatches to. Exported by the SDK barrel as of 2.0.18 (CHANGELOG). Three
// of the seven verbs attach through this unchanged; see
// daemon/handlers/payments/register.ts and checkout-handlers.ts for why the
// other four (`cards.create`, `purchases.list`, `checkout.begin`,
// `checkout.fillCard`) stay local wrappers instead.
export { registerPaymentsGatewayMethods } from '@pellux/goodvibes-sdk/platform/control-plane';
export type { PaymentsGatewayService, PaymentPurchaseView } from '@pellux/goodvibes-sdk/platform/control-plane';

// The browser-checkout seam a daemon composition receives through
// `onBrowserCheckout` (sdk 2.0.19, platform/control-plane's
// `composeDaemonBrowser`). See daemon/handlers/payments/register.ts for how
// the checkout pair reads it.
export type { BrowserCheckoutSeam } from '@pellux/goodvibes-sdk/platform/control-plane';

// Channel domain types reused in handler signatures (read-only SDK interfaces; never re-declared).
export type {
  ChannelIdentity,
  ChannelResolvedTarget,
  ChannelAccountRecord,
} from '@pellux/goodvibes-sdk/platform/channels';

/**
 * The two remote-route contracts a host has to name: the per-peer auth
 * envelope, and the distributed-runtime service the SDK facade injects into
 * `DaemonRemoteRouteContext.distributedRuntime` so the published
 * `remote.peers.*` HTTP routes can dispatch to it.
 *
 * Both were declared here, by hand, as a verbatim structural mirror of the
 * daemon-sdk's own declarations, seventeen methods copied signature for
 * signature, for one reason: neither carried the `export` keyword upstream,
 * so neither could be imported. Both do now, and a mirror that can drift out of
 * agreement with the interface it must satisfy is worse than no mirror at all.
 *
 * They are re-exported under the same names so every implementer in this
 * product keeps naming them the way it already does. The SDK ships no
 * docker/ssh/cloud backend, the host still owns the implementation.
 */
export type { DistributedRuntimeRouteService, RemotePeerAuth } from '@pellux/goodvibes-daemon-sdk/remote-routes';
