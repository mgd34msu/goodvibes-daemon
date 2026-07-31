/**
 * Runtime barrel for the daemon product.
 *
 * The SDK groups its runtime seams into namespace exports (`bootstrap`,
 * `observability`, `operations`, `security`, `shell`, `state`, `transport`,
 * `ui`). This file names the ones the daemon composition actually uses so the
 * composition modules import them as plain symbols, and so there is exactly one
 * place to look when the SDK moves one.
 *
 * It re-exports and nothing else: no local runtime entry points, no wrappers, no
 * behavior. Anything that needs behavior belongs in its own module or in the
 * SDK.
 */

import {
  observability,
  operations,
  security,
  shell,
  transport,
  ui,
} from '@pellux/goodvibes-sdk/platform/runtime';

// State, the event bus and the read-model store.
export * from '@pellux/goodvibes-sdk/platform/runtime/state';
export * from '@pellux/goodvibes-sdk/platform/runtime/store';
export * from '@pellux/goodvibes-sdk/platform/runtime/feature-flags';
export * from '@pellux/goodvibes-sdk/platform/runtime/settings';
export * from '@pellux/goodvibes-sdk/platform/runtime/sandbox';

// Shell paths + the surface-scoped storage handle.
export const createShellPathService = shell.createShellPathService;
export type ShellPathService = shell.ShellPathService;
export const createSessionSurface = operations.createSessionSurface;
export type SessionSurface = operations.SessionSurface;
export const WorktreeRegistry = shell.WorktreeRegistry;
export type WorktreeRegistry = shell.WorktreeRegistry;

// Remote execution + the distributed runtime.
export const DistributedRuntimeManager = operations.DistributedRuntimeManager;
export type DistributedRuntimeManager = operations.DistributedRuntimeManager;
export const RemoteRunnerRegistry = operations.RemoteRunnerRegistry;
export type RemoteRunnerRegistry = operations.RemoteRunnerRegistry;
export const RemoteSupervisor = operations.RemoteSupervisor;
export type RemoteSupervisor = operations.RemoteSupervisor;

// Observability.
export const TelemetryApiService = observability.TelemetryApiService;
export type TelemetryApiService = observability.TelemetryApiService;
export const ComponentHealthMonitor = observability.ComponentHealthMonitor;
export type ComponentHealthMonitor = observability.ComponentHealthMonitor;
export const IdempotencyStore = observability.IdempotencyStore;
export type IdempotencyStore = observability.IdempotencyStore;

// Security.
export const PolicyRuntimeState = security.PolicyRuntimeState;
export type PolicyRuntimeState = security.PolicyRuntimeState;

// Integration helpers (surface-scoped continuity reads) and the no-op screen
// stand-ins. The daemon facade's service-graph contract names a panel manager
// and a keybindings manager because a surface that has a screen supplies real
// ones; the daemon has no screen, and the SDK ships the honest no-ops for
// exactly this case rather than leaving a hole a fake would fill.
export const IntegrationHelperService = ui.IntegrationHelperService;
export type IntegrationHelperService = ui.IntegrationHelperService;
export const createNoopPanelManager = ui.createNoopPanelManager;
export const createNoopKeybindingsManager = ui.createNoopKeybindingsManager;
export type PanelManagerLike = ui.PanelManagerLike;
export type KeybindingsManagerLike = ui.KeybindingsManagerLike;

// Notification routing types (the router itself is imported from its own subpath).
export type Notification = ui.Notification;
export type RoutingDecision = ui.RoutingDecision;

// Outbound network transport installation (proxy/TLS policy from settings).
export const GlobalNetworkTransportInstaller = transport.GlobalNetworkTransportInstaller;
export type GlobalNetworkTransportInstaller = transport.GlobalNetworkTransportInstaller;


// Runtime event payload unions, re-exported so a consumer names one import path
// for the bus and the shapes that travel on it.
export type {
  AgentEvent,
  CommunicationEvent,
  OpsEvent,
  OrchestrationEvent,
  PermissionEvent,
  ProviderEvent,
  RouteEvent,
  SessionEvent,
  TaskEvent,
  ToolEvent,
  TransportEvent,
  TurnEvent,
  WorkflowEvent,
} from '@pellux/goodvibes-sdk/events';
