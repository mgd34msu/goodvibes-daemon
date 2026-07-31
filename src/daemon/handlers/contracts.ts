/**
 * Single SDK-contract import seam for the daemon handler layer.
 *
 * Every other module under `src/daemon/handlers/` imports SDK contract
 * identifiers from HERE and nowhere else. Concentrating the SDK imports in one
 * concrete-submodule module keeps the rest of the layer free of barrel cycles
 * and guarantees the host NEVER re-declares an SDK id, descriptor, or schema —
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
 * daemon-sdk's own declarations — seventeen methods copied signature for
 * signature — for one reason: neither carried the `export` keyword upstream,
 * so neither could be imported. Both do now, and a mirror that can drift out of
 * agreement with the interface it must satisfy is worse than no mirror at all.
 *
 * They are re-exported under the same names so every implementer in this
 * product keeps naming them the way it already does. The SDK ships no
 * docker/ssh/cloud backend — the host still owns the implementation.
 */
export type { DistributedRuntimeRouteService, RemotePeerAuth } from '@pellux/goodvibes-daemon-sdk/remote-routes';
