import { join } from 'node:path';
import { ServiceRegistry, SubscriptionManager, ToolLLM } from '@pellux/goodvibes-sdk/platform/config';
import { AutomationDeliveryManager, AutomationManager } from '@pellux/goodvibes-sdk/platform/automation';
import { ChannelDeliveryRouter, ChannelPolicyManager } from '@pellux/goodvibes-sdk/platform/channels';
import { ApprovalBroker, GatewayMethodCatalog, SharedSessionBroker, buildSharedSessionAgentSpawnRoutingInput } from '@pellux/goodvibes-sdk/platform/control-plane';
import { continuationChainOptions } from '@pellux/goodvibes-sdk/platform/agents';
import { wireIdlePowerAndLiveTurn } from './idle-power-services.ts';
import { resolvePairingWebOrigin } from '../core/pairing-origin.ts';
import { attachWsOnlyGatewayVerbHandlers } from '@pellux/goodvibes-terminal-shell';
import { composeMailDeps } from './mail-composition.ts';
import { composeCredentialServices } from './credential-composition.ts';
import { createDisposalScope, registerDaemonRuntimePollers } from './disposal-wiring.ts';
import { attachConfigEmitBridge } from '@pellux/goodvibes-sdk/platform/runtime/config';
import { WatcherRegistry } from '@pellux/goodvibes-sdk/platform/watchers';
import { ArtifactStore } from '@pellux/goodvibes-sdk/platform/artifacts';
import { createWebKnowledgeGapRepairer } from '@pellux/goodvibes-sdk/platform/knowledge';
import { createKnowledgeServices } from './knowledge-services.ts';
import { MediaProviderRegistry, ensureBuiltinMediaProviders } from '@pellux/goodvibes-sdk/platform/media';
import { MultimodalService } from '@pellux/goodvibes-sdk/platform/multimodal';
import { OverflowHandler, ProcessManager, cancelAllAgentRuns, createWorkflowServices } from '@pellux/goodvibes-sdk/platform/tools';
import { FileStateCache, FileUndoManager, MemoryEmbeddingProviderRegistry, MemoryRegistry, MemoryStore, ModeManager, ProjectIndex, resolveCanonicalMemoryDbPath } from '@pellux/goodvibes-sdk/platform/state';
import { buildExecPromptAnswerHandler } from '@pellux/goodvibes-sdk/platform/runtime/permissions/exec-prompt-wiring';
import { buildLocalhostFetchApproval } from '@pellux/goodvibes-sdk/platform/runtime/permissions/localhost-fetch-approval';
import { createBrokeredPermissionManager } from '@pellux/goodvibes-sdk/platform/runtime/client-services';
import { createNotificationDispatcher, wireRuntimeNotificationBridge, wireMemoryPressureNotice } from './notification-dispatch.ts';
import { createDurabilityServices } from './durability-services.ts';
import { MemorySpineClient, createLocalMemoryAccess } from '@pellux/goodvibes-sdk/platform/runtime/memory-spine';
import { createWorkspaceCheckpointing } from './workspace-checkpointing.ts';
import { createSessionConversationRewindPort } from './conversation-rewind-port.ts';
import { createDomainDispatch } from '@pellux/goodvibes-sdk/platform/runtime/store';
import { DistributedRuntimeManager, IntegrationHelperService, IdempotencyStore, ComponentHealthMonitor, WorktreeRegistry, createShellPathService, createFeatureFlagManager, createNoopPanelManager, createNoopKeybindingsManager, PolicyRuntimeState } from '@/runtime/index.ts';
import { createSessionStorageServices } from './session-storage-services.ts';
import { VoiceProviderRegistry, VoiceService, ensureBuiltinVoiceProviders } from '@pellux/goodvibes-sdk/platform/voice';
import { CacheRegistry, PauseController, wireDaemonMemoryGovernance } from '@pellux/goodvibes-sdk/platform/runtime/memory';
import { wireVoiceSetup } from './voice-setup-services.ts';
import { WebSearchProviderRegistry, WebSearchService } from '@pellux/goodvibes-sdk/platform/web-search';
import { HookActivityTracker } from '@pellux/goodvibes-sdk/platform/hooks';
import { HookDispatcher, createHookWorkbench } from '@pellux/goodvibes-sdk/platform/hooks';
import { PluginManager } from '@pellux/goodvibes-sdk/platform/plugins';
import { BookmarkManager } from '@pellux/goodvibes-sdk/platform/bookmarks';
import { ProfileManager } from '@pellux/goodvibes-sdk/platform/profiles';
import { CrossSessionTaskRegistry, SessionChangeTracker } from '@pellux/goodvibes-sdk/platform/sessions';
import { ApiTokenAuditor, UserAuthManager } from '@pellux/goodvibes-sdk/platform/security';
import { WebhookNotifier } from '@pellux/goodvibes-sdk/platform/integrations';
import { createRemoteExecutionServices } from './remote-execution-composition.ts';
import { createAgentGraph } from './agent-graph-composition.ts';
import { BenchmarkStore, CacheHitTracker, FavoritesStore, ModelLimitsService, ProviderCapabilityRegistry, ProviderOptimizer, createLaunchTolerantProviderRegistry, ensureConfiguredModelIsRoutable } from '@pellux/goodvibes-sdk/platform/providers';
import { AdaptivePlanner, DeterministicReplayEngine, ExecutionPlanManager, SessionLineageTracker, SessionMemoryStore } from '@pellux/goodvibes-sdk/platform/core';
import { deriveFeatureStates, bindFeatureSettingsBridge } from '@pellux/goodvibes-sdk/platform/runtime/state';
import { createChannelComposition } from './channel-composition.ts';
import { applyProviderOptimizerConfigMode, bindProviderOptimizerFeatureFlag } from './provider-optimizer-wiring.ts';
import { createFleetServices } from './fleet-services.ts';
import { createTriggerServices } from './trigger-services.ts';
import { createWorkstreamServices } from './workstream-services.ts';
import { wireFleetNeedsInputPush } from './fleet-needs-input-push.ts';
import { codeIndexDbPath, createCodeIndexServices, createStoreRerooter, isCodeInjectionSettingEnabled } from './code-index-services.ts';
import { createDaemonHandlerComposition } from './daemon-handler-composition.ts';
import { createDevicePostureServices } from './device-posture-composition.ts';
// Re-exported so the daemon entrypoint reaches the housekeeping sweep through
// the same module it already imports the runtime graph from. `installDevicePosture`
// is deliberately NOT re-exported: it registers the phone TOOL into a tool
// registry, and the daemon registers no tools — the sweep is the half it needs.
export { startDeviceHousekeeping } from './device-posture-composition.ts';
import { createClusterServices, startClusterServices } from './cluster-group-composition.ts';
import { WorkspaceTrustManager } from './trust/workspace-trust.ts';
import { createWorkspaceTrustDecisionAsk, trustGatedApprovalRaiser } from './trust/trust-gated-approvals.ts';
import { GOODVIBES_DAEMON_SURFACE_ROOT } from '../config/surface.ts';
import type { RuntimeServicesOptions, RuntimeServices } from './runtime-services-types.ts';
export type { RuntimeServicesOptions, RuntimeServices } from './runtime-services-types.ts';

/**
 * createRuntimeServices — the daemon's service graph.
 *
 * This is the one composition root the daemon has. It used to exist twice, once
 * in the terminal app's repository and once in the agent's, and the two drifted:
 * each had capabilities the other lacked and each had its own wiring for things
 * both did. Where they differed, exactly one implementation survives here — the
 * SDK-public path where the agent had it (memory governance, disposal, the
 * continuation runner's conversation gating and spawn routing, the
 * launch-tolerant provider registry, the trigger family, registration-gated
 * checkpoints), and the terminal app's where the agent had nothing (cluster,
 * mail, crash-residue housekeeping, device housekeeping, presence-aware
 * needs-input push).
 */
export function createRuntimeServices(options: RuntimeServicesOptions): RuntimeServices {
  // The SDK's disposal scope and its all-required poller list, plus the four
  // pollers only the daemon has — see disposal-wiring.ts.
  const disposalScope = createDisposalScope('RuntimeServices');
  const workingDirectory = options.workingDir;
  const homeDirectory = options.homeDirectory;
  const shellPaths = createShellPathService({
    workingDirectory,
    homeDirectory,
  });
  // Built before anything that touches session state — see session-storage-services.ts.
  const { surface, sessionManager } = createSessionStorageServices({ workingDirectory, homeDirectory });
  const workspaceTrustManager = new WorkspaceTrustManager({ shellPaths });
  const configManager = options.configManager;
  const featureFlags = options.featureFlags ?? createFeatureFlagManager();
  if (options.featureFlags === undefined) {
    // Owned manager: gate states derive from domain settings keys + live bridge
    // (mirrors the SDK composition root; a passed manager is the caller's to wire).
    featureFlags.loadFromConfig({ flags: deriveFeatureStates(configManager) });
    bindFeatureSettingsBridge(configManager, featureFlags);
  }
  const runtimeDispatch = createDomainDispatch(options.runtimeStore);
  // Memory governance seams built EARLY (mirrors the SDK's own createRuntimeServices)
  // so the scheduler gates and the knowledge background jobs can consult the pause
  // controller before the MemoryGovernor (constructed at the composition tail)
  // drives it. The admission gate is late-bound: expensive entry points capture
  // this closure now and the governor binds into it at the tail — until then
  // everything is admitted (the daemon is still booting).
  const cacheRegistry = new CacheRegistry();
  const pauseController = new PauseController();
  const MEMORY_BACKGROUND_JOB_IDS = ['knowledge-self-improvement', 'memory-consolidation', 'code-index-reindex'];
  const admitExpensiveWorkRef: { current: ((label: string) => { allowed: boolean; reason?: string | undefined }) | null } = { current: null };
  const admitExpensiveWork = (label: string): { allowed: boolean; reason?: string | undefined } =>
    admitExpensiveWorkRef.current?.(label) ?? { allowed: true };
  const isKnowledgeBackgroundPaused = (): boolean => pauseController.isPaused('knowledge-self-improvement');
  const gatewayMethods = new GatewayMethodCatalog();
  // The daemon has no screen. The facade's service-graph contract names a panel
  // manager and a keybindings manager because a surface that HAS a screen
  // supplies real ones; the SDK ships no-ops for a host that does not, which is
  // the honest answer rather than a stub that pretends to open panels.
  const panelManager = createNoopPanelManager();
  const keybindingsManager = createNoopKeybindingsManager();
  // Channel/surface wiring: see channel-composition.ts (incl. the recorded surface-gating divergence note).
  const { routeBindings, surfaceRegistry, channelPlugins } = createChannelComposition({
    configManager,
    runtimeStore: options.runtimeStore,
    runtimeBus: options.runtimeBus,
    featureFlags,
  });
  // The credential/identity seam (credential-composition.ts).
  const { secretsManager, stepUpService, pairingTokens } = composeCredentialServices({
    workingDirectory, homeDirectory, configManager,
    daemonHomeDirectory: options.daemonHomeDirectory,
    pairingTokenPath: shellPaths.resolveUserPath('control-plane', 'pairing-tokens.json'),
  });
  const subscriptionManager = new SubscriptionManager(shellPaths.resolveUserPath(GOODVIBES_DAEMON_SURFACE_ROOT, 'subscriptions.json'));
  const serviceRegistry = new ServiceRegistry(shellPaths.resolveProjectPath(GOODVIBES_DAEMON_SURFACE_ROOT, 'services.json'), {
    secretsManager,
    subscriptionManager,
  });
  const providerCapabilityRegistry = new ProviderCapabilityRegistry();
  const cacheHitTracker = new CacheHitTracker();
  const favoritesStore = new FavoritesStore({ dir: shellPaths.resolveUserPath(GOODVIBES_DAEMON_SURFACE_ROOT) });
  const benchmarkStore = new BenchmarkStore({ dir: shellPaths.resolveUserPath(GOODVIBES_DAEMON_SURFACE_ROOT) });
  const modelLimitsService = new ModelLimitsService({
    cachePath: shellPaths.resolveUserPath(GOODVIBES_DAEMON_SURFACE_ROOT, 'model-limits.json'),
  });
  // Launch-tolerant: a provider whose API key is absent from the environment is
  // constructed with a placeholder that is stripped immediately afterwards, so
  // it lands unconfigured instead of throwing during construction. The daemon
  // has the same must-boot property the agent has — it is a supervised service,
  // and a constructor that throws on a missing key turns one unset variable into
  // a crash loop with no screen to explain it.
  const providerRegistry = createLaunchTolerantProviderRegistry({
    configManager,
    subscriptionManager,
    secretsManager,
    serviceRegistry,
    capabilityRegistry: providerCapabilityRegistry,
    cacheHitTracker,
    favoritesStore,
    benchmarkStore,
    modelLimitsService,
    featureFlags,
    runtimeBus: options.runtimeBus,
  });
  ensureConfiguredModelIsRoutable(providerRegistry, configManager);
  providerRegistry.initCustomProviders();
  // Background, TTL-respecting live model discovery so provider model lists
  // refresh from their own listing APIs.
  providerRegistry.initProviderModelDiscovery();
  const toolLLM = new ToolLLM({
    configManager,
    providerRegistry,
    // The bus the agent's composition passed and the terminal app's did not, so
    // tool-LLM activity was observable in one process and invisible in the other.
    runtimeBus: options.runtimeBus,
  });
  const localUserAuthManager = options.localUserAuthManager ?? new UserAuthManager({
    bootstrapFilePath: shellPaths.resolveUserPath(GOODVIBES_DAEMON_SURFACE_ROOT, 'auth-users.json'),
    bootstrapCredentialPath: shellPaths.resolveUserPath(GOODVIBES_DAEMON_SURFACE_ROOT, 'auth-bootstrap.txt'),
  });
  const profileManager = new ProfileManager(shellPaths.resolveUserPath(GOODVIBES_DAEMON_SURFACE_ROOT, 'profiles'));
  const bookmarkManager = new BookmarkManager(shellPaths.resolveUserPath(GOODVIBES_DAEMON_SURFACE_ROOT, 'bookmarks'));
  const sessionOrchestration = new CrossSessionTaskRegistry(
    join(surface.sessionsDir, 'task-graph.json'),
  );
  const hookActivityTracker = new HookActivityTracker();
  // featureFlags is REQUIRED here in practice, even though the SDK types it
  // optional. isFeatureGateEnabled(null, ...) is permissive by design — a narrow
  // embed with no manager wired gets the capability rather than a silent off —
  // so omitting it did not disable the watcher framework when watchers.enabled
  // is turned off; it made the setting configure nothing.
  const watcherRegistry = new WatcherRegistry({
    storePath: shellPaths.resolveProjectPath(GOODVIBES_DAEMON_SURFACE_ROOT, 'watchers.json'),
    featureFlags,
  });
  watcherRegistry.attachRuntime({
    runtimeStore: options.runtimeStore,
    runtimeBus: options.runtimeBus,
  });
  // The agent-execution graph, wired in both directions; see
  // agent-graph-composition.ts for why the six are built as one.
  const {
    agentMessageBus, archetypeLoader, agentOrchestrator,
    agentManager, contextAccountingHolder, wrfcController,
  } = createAgentGraph({
    runtimeBus: options.runtimeBus, workingDirectory, configManager, providerRegistry,
  });
  const hookDispatcher = new HookDispatcher({ agentManager, toolLLM, projectRoot: workingDirectory }, hookActivityTracker);
  configManager.attachHookDispatcher(hookDispatcher);
  const hookWorkbench = createHookWorkbench({
    hookDispatcher,
    configManager,
  });
  const approvalBroker = new ApprovalBroker({
    storePath: shellPaths.resolveProjectPath(GOODVIBES_DAEMON_SURFACE_ROOT, 'control-plane', 'approvals.json'),
  });
  const sessionBroker = new SharedSessionBroker({
    storePath: shellPaths.resolveProjectPath(GOODVIBES_DAEMON_SURFACE_ROOT, 'control-plane', 'sessions.json'),
    routeBindings,
    agentStatusProvider: agentManager,
    messageSender: agentMessageBus,
    conversationGateConfig: configManager, // without this the gate runs on DEFAULTS: an inbound message landing in a live session takes the handover and starts work whatever conversationGate.mode/gatedSurfaces say
  });
  sessionBroker.setContinuationRunner(async ({ task, input }) => {
    const record = agentManager.spawn({
      mode: 'spawn',
      task,
      // Conversation first: a follow-up message in a session gets an answer, not
      // a write-review-fix-confirm chain with a reviewer, quality gates and a
      // second agent. A chain opens only for an explicit authorization marker —
      // the channel confirmation the owner gave, or the schedule/trigger that
      // was confirmed when it was created — or for a follow-up typed on a local
      // surface. Both `conversationGate.mode` and the gated-surfaces list are
      // read live. The terminal app's daemon had none of this and opened a chain
      // for every inbound message.
      ...continuationChainOptions(input, {
        configReader: {
          get: (key: string) => configManager.get(key as never),
          getCategory: (name: string) => configManager.getCategory(name as never),
        },
      }),
      // Spawn routing through the SDK's shared model-reference resolver
      // (unique-across-registry auto-qualifies; ambiguous and unknown ids throw
      // errors naming real candidates), against the live registry's models. The
      // terminal app's daemon passed routing fields through raw, so a bare model
      // id on an inbound continuation was a format-only rejection.
      ...buildSharedSessionAgentSpawnRoutingInput(input.routing, { restrictTools: true, modelCandidates: providerRegistry.listModels() }),
      context: `shared-session:${input.sessionId}`,
    });
    return { agentId: record.id };
  });
  const artifactStore = new ArtifactStore({ configManager });
  const memoryEmbeddingRegistry = new MemoryEmbeddingProviderRegistry({ configManager });
  // Open the ONE home-scoped canonical store; legacy per-project memory folds in at boot.
  const memoryDbPath = resolveCanonicalMemoryDbPath(homeDirectory);
  const memoryStore = new MemoryStore(memoryDbPath, {
    embeddingRegistry: memoryEmbeddingRegistry,
  });
  const memoryRegistry = new MemoryRegistry(memoryStore);
  // The daemon is the memory spine's HOST: it always serves the local store.
  // Clients construct the same facade in wire mode against this process.
  const memorySpine = new MemorySpineClient({ local: createLocalMemoryAccess(memoryRegistry) });
  // featureFlags is REQUIRED here in practice, even though the SDK types it
  // optional (same reasoning as the watcher registry above): without it,
  // integrations.deliveryTracking configured nothing.
  const deliveryManager = new AutomationDeliveryManager({
    configManager,
    // This manager builds the delivery router the daemon actually replies
    // through. Without the secrets manager it cannot resolve a
    // goodvibes://secrets/... credential, so Telegram accepted every inbound
    // message and dropped every reply with "Missing Telegram bot token" while
    // ntfy — which needs no secret — worked.
    secretsManager,
    serviceRegistry,
    runtimeBus: options.runtimeBus,
    runtimeStore: options.runtimeStore,
    routeBindings,
    artifactStore,
    featureFlags,
  });
  const automationManager = new AutomationManager({
    configManager,
    // The daemon is a service, not a terminal: a job it creates is attributed to
    // the service surface.
    defaultSurfaceKind: 'service',
    routeBindings,
    sessionBroker,
    runtimeStore: options.runtimeStore,
    runtimeBus: options.runtimeBus,
    deliveryManager,
    // Same live registry: a bare model id on an automation job resolves through
    // the shared resolver instead of a format-only rejection.
    providerRegistry,
    featureFlags,
    spawnTask: (input) => {
      const record = agentManager.spawn({
        mode: 'spawn',
        task: input.prompt,
        ...(input.modelId ? { model: input.modelId } : {}),
        ...(input.modelProvider ? { provider: input.modelProvider } : {}),
        ...(input.fallbackModels !== undefined ? { fallbackModels: [...input.fallbackModels] } : {}),
        ...(input.routing ? { routing: input.routing } : {}),
        ...(input.executionIntent ? { executionIntent: input.executionIntent } : {}),
        ...(input.template ? { template: input.template } : {}),
        ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
        ...(input.toolAllowlist?.length ? { tools: [...input.toolAllowlist], restrictTools: true } : {}),
        ...(input.context ? { context: input.context } : {}),
      });
      return record.id;
    },
  });
  // Knowledge/wiki + home-graph stack (governor backpressure wired in) — see knowledge-services.ts.
  const {
    knowledgeStore, agentKnowledgeStore, homeGraphKnowledgeStore,
    knowledgeSemanticService, homeGraphSemanticService, agentKnowledgeSemanticService,
    knowledgeService, agentKnowledgeService, homeGraphService,
    projectPlanningService, projectPlanningProjectId, workPlanStore,
  } = createKnowledgeServices({ configManager, providerRegistry, artifactStore, memoryRegistry, runtimeBus: options.runtimeBus, workingDirectory, homeDirectory, isBackgroundPaused: isKnowledgeBackgroundPaused, admitExpensiveWork });
  const voiceProviders = new VoiceProviderRegistry();
  ensureBuiltinVoiceProviders(voiceProviders, { readConfig: (key) => configManager.get(key as Parameters<typeof configManager.get>[0]) });
  const voiceService = new VoiceService(voiceProviders);
  const webSearchProviders = new WebSearchProviderRegistry({
    env: process.env,
    serviceRegistry,
  });
  const webSearchService = new WebSearchService(webSearchProviders, {
    serviceRegistry,
    featureFlags,
  });
  for (const [semantic, ingest] of [[knowledgeSemanticService, knowledgeService], [agentKnowledgeSemanticService, agentKnowledgeService], [homeGraphSemanticService, homeGraphService]] as const) {
    semantic.setGapRepairer(createWebKnowledgeGapRepairer({ searchService: webSearchService, ingestService: ingest }));
  }
  const mediaProviders = new MediaProviderRegistry();
  ensureBuiltinMediaProviders(mediaProviders, artifactStore, providerRegistry);
  const multimodalService = new MultimodalService(artifactStore, mediaProviders, voiceService, knowledgeService);
  const pluginManager = new PluginManager({
    pathOptions: {
      cwd: shellPaths.workingDirectory,
      homeDir: shellPaths.homeDirectory,
    },
    stateFilePath: shellPaths.resolveUserPath(GOODVIBES_DAEMON_SURFACE_ROOT, 'plugins.json'),
  });
  const workflow = createWorkflowServices();
  hookDispatcher.setTriggerManager(workflow.triggerManager);
  const channelPolicy = new ChannelPolicyManager({
    storePath: shellPaths.resolveProjectPath(GOODVIBES_DAEMON_SURFACE_ROOT, 'channels', 'policies.json'),
  });
  const distributedRuntime = new DistributedRuntimeManager(
    shellPaths.resolveProjectPath(GOODVIBES_DAEMON_SURFACE_ROOT, 'remote', 'distributed-runtime.json'),
  );
  distributedRuntime.attachRuntime({
    sessionBridge: sessionBroker,
    approvalBridge: approvalBroker,
    automationBridge: automationManager,
  });
  // The paired-phone feature for this host, on the SAME runtime phones pair onto
  // and the SAME approval broker every other confirmation rides. Every `device.*`
  // setting is read live through this; see device-posture-composition.ts.
  const { devicePosture } = createDevicePostureServices({
    configManager,
    distributedRuntime,
    approvals: approvalBroker,
    stateDirectory: shellPaths.resolveProjectPath(GOODVIBES_DAEMON_SURFACE_ROOT, 'devices'),
    gatewayMethods,
  });

  // Which machines on this network are "us", and which of them reads the shared
  // inbox. Both inert until startCluster() — no socket, no key material read;
  // see cluster-group-composition.ts for why they are built together.
  const { clusterGroup, clusterCoordinator } = createClusterServices({
    configManager, shellPaths, secretsManager,
  });
  // Daemon handler surfaces (see daemon-handler-composition.ts); the inbox
  // poller registers itself with the coordinator rather than starting eagerly.
  const daemonHandlers = createDaemonHandlerComposition({
    gatewayMethods,
    secretsManager,
    configManager,
    workingDirectory,
    homeDirectory,
    distributedRuntime,
    clusterCoordinator,
  });

  // Remote runners and the sandboxes tool calls are confined to; see
  // remote-execution-composition.ts for why the four are built as one.
  const { remoteRunnerRegistry, remoteSupervisor, sandboxSessionRegistry, mcpRegistry }
    = createRemoteExecutionServices({
      agentManager, workingDirectory, hookDispatcher, configManager, runtimeBus: options.runtimeBus,
    });
  // Advisory reporting only: `managed` is hardcoded false here, so excess-scope
  // and overdue tokens are reported and never blocked.
  const tokenAuditor = new ApiTokenAuditor({ managed: false, featureFlags });
  const componentHealthMonitor = new ComponentHealthMonitor();
  const worktreeRegistry = new WorktreeRegistry(workingDirectory);
  const webhookNotifier = new WebhookNotifier();
  const replayEngine = new DeterministicReplayEngine(workingDirectory);
  const providerOptimizer = new ProviderOptimizer(providerRegistry, providerCapabilityRegistry, false); // dark until its gate flips it (see provider-optimizer-wiring.ts)
  bindProviderOptimizerFeatureFlag(featureFlags, providerOptimizer);
  applyProviderOptimizerConfigMode(configManager, providerOptimizer);
  const sessionMemoryStore = new SessionMemoryStore();
  const sessionLineageTracker = new SessionLineageTracker(); const sessionChangeTracker = new SessionChangeTracker();
  const planManager = new ExecutionPlanManager(workingDirectory);
  const adaptivePlanner = new AdaptivePlanner();
  const idempotencyStore = new IdempotencyStore();
  const overflowHandler = new OverflowHandler({ baseDir: workingDirectory });
  const policyRuntimeState = new PolicyRuntimeState();
  const fileCache = new FileStateCache();
  const projectIndex = new ProjectIndex(workingDirectory);
  const channelDeliveryRouter = new ChannelDeliveryRouter({
    configManager,
    secretsManager,
    serviceRegistry,
    artifactStore,
  });
  const processManager = new ProcessManager();
  // The phase/work-item orchestration engine, constructed before the process
  // registry so its fleet nodes (workstream/phase/work-item) can be folded in
  // below via the registry's optional orchestrationEngine dep.
  const { orchestrationEngine, workstreamCommands } = createWorkstreamServices({
    agentManager, configManager, adaptivePlanner, runtimeBus: options.runtimeBus, projectRoot: workingDirectory,
  });
  // Repo source-tree code index, sharing memoryEmbeddingRegistry with MemoryStore
  // above. Auto-build is config-gated (default off) — see code-index-services.ts.
  const { codeIndexStore, codeIndexReindexScheduler } = createCodeIndexServices({ workingDirectory, configManager, memoryEmbeddingRegistry, isReindexPaused: () => pauseController.isPaused('code-index-reindex'), admitExpensiveWork });
  // Store snapshots, the periodic append-only sweep, durable remembered-approval rules + the live credential chain — see durability-services.ts.
  const { storeSnapshotScheduler, appendOnlyRetentionScheduler, userPermissionRuleStore, stopDurabilityHousekeeping, stopConfigWatch } = createDurabilityServices({
    configManager, secretsManager, providerRegistry, memoryDbPath, codeIndexDbPath: codeIndexDbPath(workingDirectory), surface, shellPaths, // + retention-sweep roots & live config watch (mirrors the SDK)
    ...(options.currentSessionId ? { currentSessionId: options.currentSessionId } : {}), // exempts the running session from crash-residue reaping
  });
  const codeInjectionOrchestratorDeps = { codeIndex: codeIndexStore, isCodeInjectionSettingEnabled: () => isCodeInjectionSettingEnabled(configManager), codeIndexReindexScheduler };
  // The trigger family the agent composed and the terminal app's daemon never
  // had: stream watchers, on-exit process triggers, condition checks — fed to
  // the fleet below as its trigger supervisor, so a trigger is visible and
  // steerable like every other running thing.
  const triggerManager = createTriggerServices({
    configManager, shellPaths, surfaceRoot: GOODVIBES_DAEMON_SURFACE_ROOT,
    agentManager, processManager, sessionBroker,
  });
  const { processRegistry } = createFleetServices({ // Shared archive-aware fleet registry (+ daemon observed rows) — see fleet-services.ts
    agentManager, wrfcController,
    orchestrationEngine, // Folds workstream/phase/work-item nodes into the fleet
    codeIndexService: codeIndexStore, // Folds a single 'code-index' node into the fleet
    processManager, watcherRegistry, workflow, approvalBroker, sessionBroker,
    triggerSupervisor: triggerManager,
    messageBus: agentMessageBus, // Backs steer()/`steerable` (the Fleet steer composer builds on top)
    automationManager, // Folds scheduled AutomationJobs into the fleet as 'schedule' nodes
    runtimeBus: options.runtimeBus,
    observeExternalAgents: options.observeExternalAgents, providerRegistry, // observeExternalAgents is daemon-side only
  });
  const modeManager = new ModeManager({ featureFlags }); const fileUndoManager = new FileUndoManager();
  // Checkpoints, gated on live workspace registration — see workspace-checkpointing.ts.
  const checkpointing = createWorkspaceCheckpointing({
    workspaceRoot: workingDirectory, surface, runtimeBus: options.runtimeBus, configManager, shellPaths,
  });
  const workspaceCheckpointManager = checkpointing.manager;
  // memory-consolidation honors governor backpressure: it ticks only when idle
  // AND the 'memory-consolidation' job is not paused AND expensive work is
  // admitted (mirrors the SDK's own createRuntimeServices idle gate).
  const { memoryConsolidationScheduler, powerManager, sessionLiveTurnControls } = wireIdlePowerAndLiveTurn({ configManager, memoryRegistry, runtimeBus: options.runtimeBus, isIdle: () => sessionBroker.countBusySessions() === 0 && !pauseController.isPaused('memory-consolidation') && admitExpensiveWork('memory consolidation').allowed, snapshotTick: () => storeSnapshotScheduler.tick(), heartbeat: async () => { await automationManager.triggerHeartbeat({ source: 'wake-catchup' }); }, powerSeam: options.powerSeam });

  // Construct + start the MemoryGovernor (default ON — a safety feature) with the
  // standard KNOWN cache adapters (knowledge stores + shared session broker),
  // then late-bind the admission gate the expensive entry points captured
  // earlier. The SDK owns this wiring; the terminal app had a fork wrapper around
  // it that the agent did not, so the two processes defended their footprint
  // slightly differently.
  const { memoryGovernor } = wireDaemonMemoryGovernance({
    config: {
      budgetMb: configManager.get('memory.budgetMb'),
      elevatedPct: configManager.get('memory.tier.elevatedPct'),
      highPct: configManager.get('memory.tier.highPct'),
      criticalPct: configManager.get('memory.tier.criticalPct'),
      tripwireRateMbPerSec: configManager.get('memory.tripwire.rateMbPerSec'),
      tripwireSustainSec: configManager.get('memory.tripwire.sustainSec'),
      hardLimitPct: configManager.get('memory.hardLimitPct'),
    },
    runtimeBus: options.runtimeBus,
    cacheRegistry,
    pauseController,
    jobIds: MEMORY_BACKGROUND_JOB_IDS,
    receiptPath: shellPaths.resolveProjectPath(GOODVIBES_DAEMON_SURFACE_ROOT, 'memory', 'tripwire-receipt.json'),
    knowledgeStores: [knowledgeStore, agentKnowledgeStore, homeGraphKnowledgeStore],
    sessionBroker,
    // Graceful tripwire shutdown flushes in-flight state via ASYNC store
    // snapshots so the governor's 10s shutdown ceiling stays enforceable.
    onTripwireShutdown: async () => { await storeSnapshotScheduler.snapshotAllAsync('tripwire'); },
  });
  admitExpensiveWorkRef.current = (label) => memoryGovernor.admitExpensiveWork(label);

  // Managed local-voice provisioning (voice.local.status/install) — single-flight
  // one-act install + no-network status; see voice-setup-services.ts.
  const { voiceSetup, stopWakeHousekeeping } = wireVoiceSetup({ configManager, shellPaths, voiceProviders, admitExpensiveWork,
    // Boot provisioning of the wake-word model + its recovery sweep, opted into
    // by the real entrypoint only (same treatment as powerSeam) so a one-shot CLI
    // command and a test composing this graph fetch nothing and start no timer.
    provisionWakeModelsAtBoot: options.provisionWakeModelsAtBoot === true });

  // Terminal-shell wrapper over the SDK registerGatewayVerbGroups (gateway-verbs.ts); checkin.*/fleet-needs-input/pairing.* register only when their deps are present. memoryGovernor lights up ops.memory.get; voiceSetup lights up voice.local.status/install.
  // calendar.*/email.* are platform-served; these two let it register (mail-composition.ts).
  const { emailServiceDeps, describeEmailConfigProblem } = composeMailDeps({ configManager, secretsManager });
  attachWsOnlyGatewayVerbHandlers(gatewayMethods, {
    homeDirectory, emailServiceDeps, describeEmailConfigProblem, processRegistry,
    // The registration-gated surface, not the raw manager: an explicit create in
    // an unregistered workspace refuses with something actionable.
    workspaceCheckpointManager: checkpointing.gatewayManager,
    conversationRewindPort: createSessionConversationRewindPort(), sessionBroker, secretsManager, stepUpService,
    approvalBroker, requestApproval: (input) => approvalBroker.requestApproval(input),
    // approvals.raise — a surface CREATING an ask in this broker. Without it the
    // verb is cataloged and unhandled, and a client whose prompt runs outside
    // this process has no way to raise one.
    approvalRaise: approvalBroker,
    // credentials.set / credentials.delete — a credential written THROUGH the
    // control plane, so a client with no access to the daemon's settings file can
    // configure one. The value lands in the daemon's secret tier and the verb
    // never echoes it back.
    credentialWrites: { config: configManager, secrets: secretsManager },
    watcherRegistry, userPermissionRuleStore, shellPaths, configManager, runtimeStore: options.runtimeStore,
    channelDeliveryRouter, providerRegistry, automationManager, sessionLister: sessionBroker, sessionIntake: sessionBroker,
    workingDirectory, memoryRegistry, pairingTokens, sessionLiveTurnControls, powerManager, memoryGovernor, voiceSetup,
    attemptsController: orchestrationEngine,
    relayAvailable: () => configManager.get('relay.enabled') === true,
    pairingWebOrigin: () => resolvePairingWebOrigin(configManager).origin,
    disposal: disposalScope.registry,
    ...wireFleetNeedsInputPush({ registry: processRegistry, runtimeBus: options.runtimeBus, sessionBroker }),
  });
  // A loopback fetch that isn't allow-listed asks once through the approval
  // broker; "allow for this project" persists and later fetches never ask. Built
  // once and shared with the tool registry so both ask alike.
  const localhostFetchApproval = buildLocalhostFetchApproval({ requestApproval: (input) => approvalBroker.requestApproval(input), configManager });
  // Exec stuck on a terminal prompt rides the approval broker; the typed answer
  // feeds the continuing run. Built once and shared (like localhostFetchApproval)
  // so every setDependencies site installs the SAME handler; otherwise a
  // wholesale replace drops it and prompts hang.
  const execPromptAnswerHandler = buildExecPromptAnswerHandler({ requestApproval: (input) => approvalBroker.requestApproval(input) });
  // Tool asks from the runs this daemon HOSTS. Without a manager here, the
  // background permission gate short-circuits to approved and every hosted
  // write, command and delegation ran ungated — the workspace trust decision
  // written by the terminal app was read by nobody in this process.
  //
  // The ask seam is the trust gate wrapping the approval broker, which is the
  // terminal app's layering with its modal replaced by the raise: a workspace
  // with no decision yet has the question raised as an approval record and
  // answered by whichever surface is attached (trust-gated-approvals.ts). The
  // manager's own layers — permission mode, policy, session cache, durable
  // user rules — still run first and are unchanged.
  const permissionManager = createBrokeredPermissionManager({
    requestApproval: trustGatedApprovalRaiser(
      workspaceTrustManager,
      (input) => approvalBroker.requestApproval(input),
      createWorkspaceTrustDecisionAsk({
        requestApproval: (input) => approvalBroker.requestApproval(input),
        workingDirectory,
      }),
    ),
    configManager,
    policyRuntimeState,
    hookDispatcher,
    featureFlags,
    userRuleStore: userPermissionRuleStore,
  });
  agentOrchestrator.setDependencies({
    surfaceRoot: surface.surfaceRoot,
    permissionManager,
    execPromptAnswerHandler,
    localhostFetchApproval,
    fileCache,
    projectIndex,
    workingDirectory,
    fileUndoManager,
    modeManager,
    processManager,
    agentMessageBus,
    webSearchService,
    channelRegistry: channelPlugins,
    remoteRunnerRegistry,
    knowledgeService,
    memoryRegistry,
    ...codeInjectionOrchestratorDeps, // Agent-run code injection + tool-site reindex
    archetypeLoader,
    configManager,
    providerRegistry,
    providerOptimizer,
    toolLLM,
    serviceRegistry,
    sessionOrchestration,
    featureFlags,
    overflowHandler,
    sandboxSessionRegistry,
    workflowServices: workflow,
    contextAccountingHolder,
  });

  // Continuity reads (recovery-file presence, last-session pointer) scoped to
  // the same surface the daemon writes with, so a reader never checks the
  // unscoped legacy pair. Part of the facade's service-graph contract.
  const integrationHelpers = new IntegrationHelperService({
    surface, configManager, automationManager, approvalBroker, sessionBroker, distributedRuntime,
    remoteRunnerRegistry, remoteSupervisor, panelManager, localUserAuthManager, providerRegistry,
    serviceRegistry, subscriptionManager, secretsManager,
    runtimeStore: options.runtimeStore, runtimeBus: options.runtimeBus,
    getConversationTitle: options.getConversationTitle,
  });

  // Curated runtime-domain events become routed notifications. See
  // notification-dispatch.ts for what the daemon does with a panel_only
  // decision, which is a surface target it has no screen for.
  const notificationDispatcher = createNotificationDispatcher(configManager);
  wireRuntimeNotificationBridge(options.runtimeBus, notificationDispatcher);
  // OPS_MEMORY_PRESSURE is lifted onto its own targeted bridge (the high-churn
  // 'ops' domain stays out of the wholesale allowlist).
  wireMemoryPressureNotice(options.runtimeBus, notificationDispatcher);

  // In-process config changes become key-level events on the `config` domain, so
  // a client whose settings live HERE gets live change notices instead of
  // polling. Secret-bearing keys are named and never valued.
  disposalScope.registry.add('config event bridge', attachConfigEmitBridge({
    config: { subscribe: (key, cb) => configManager.subscribe(key as never, cb as never) },
    bus: options.runtimeBus,
  }));

  const services: RuntimeServices = {
    workingDirectory,
    homeDirectory,
    surface,
    shellPaths,
    workspaceTrustManager,
    permissionManager,
    configManager,
    featureFlags,
    runtimeBus: options.runtimeBus,
    runtimeStore: options.runtimeStore,
    runtimeDispatch,
    panelManager,
    keybindingsManager,
    routeBindings,
    surfaceRegistry,
    channelPlugins,
    channelDeliveryRouter,
    watcherRegistry,
    approvalBroker,
    localhostFetchApproval,
    execPromptAnswerHandler,
    notificationDispatcher,
    userPermissionRuleStore,
    sessionBroker,
    deliveryManager,
    automationManager,
    gatewayMethods,
    artifactStore,
    knowledgeService,
    agentKnowledgeService,
    homeGraphService,
    projectPlanningService,
    projectPlanningProjectId,
    workPlanStore,
    memoryStore,
    memoryRegistry,
    memorySpine,
    serviceRegistry,
    secretsManager,
    stepUpService,
    pairingTokens,
    subscriptionManager,
    localUserAuthManager,
    profileManager,
    bookmarkManager,
    sessionManager,
    sessionOrchestration,
    hookDispatcher,
    hookActivityTracker,
    hookWorkbench,
    pluginManager,
    workflow,
    triggerManager,
    voiceProviders,
    voiceService,
    webSearchProviders,
    webSearchService,
    mediaProviders,
    multimodalService,
    memoryEmbeddingRegistry,
    channelPolicy,
    mcpRegistry,
    tokenAuditor,
    componentHealthMonitor,
    worktreeRegistry,
    sandboxSessionRegistry,
    webhookNotifier,
    replayEngine,
    providerOptimizer,
    providerCapabilityRegistry,
    cacheHitTracker,
    favoritesStore,
    benchmarkStore,
    modelLimitsService,
    providerRegistry,
    toolLLM,
    distributedRuntime,
    devicePosture,
    daemonHandlers,
    clusterCoordinator,
    clusterGroup,
    startCluster: () => startClusterServices({ clusterGroup, clusterCoordinator }),
    remoteRunnerRegistry,
    remoteSupervisor,
    sessionMemoryStore,
    sessionLineageTracker,
    sessionChangeTracker,
    planManager,
    adaptivePlanner,
    idempotencyStore,
    overflowHandler,
    policyRuntimeState,
    archetypeLoader,
    agentManager,
    agentMessageBus,
    agentOrchestrator,
    contextAccountingHolder,
    wrfcController,
    processManager,
    orchestrationEngine,
    workstreamCommands,
    codeIndexStore,
    codeIndexReindexScheduler,
    storeSnapshotScheduler, appendOnlyRetentionScheduler, stopDurabilityHousekeeping, stopWakeHousekeeping,
    memoryConsolidationScheduler,
    powerManager,
    memoryGovernor,
    cacheRegistry,
    pauseController,
    sessionLiveTurnControls,
    processRegistry,
    modeManager,
    fileUndoManager,
    workspaceCheckpointManager,
    checkpointsCurrentlyAllowed: checkpointing.currentlyAllowed,
    integrationHelpers,
    rerootStores: createStoreRerooter({ codeIndexStore, projectIndex }),
    // Cancels the agent runs this graph was hosting. By dispose() time the fleet
    // registry, orchestration engine, process registry and bus these runs report
    // through are already down, so a run still described as "running" is orphaned
    // rather than preserved — and this is the only shutdown-reachable way to
    // abort its in-flight provider call instead of letting it sleep out a retry
    // backoff nobody is waiting on.
    cancelHostedAgentRuns: () => cancelAllAgentRuns(agentManager),
    dispose: (): void => disposalScope.dispose(),
  };
  registerDaemonRuntimePollers(disposalScope.registry, services, { stopConfigWatch });
  return services;
}
