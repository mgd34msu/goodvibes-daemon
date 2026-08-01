import { Notifier } from '@pellux/goodvibes-sdk/platform/integrations';
import { syncConfiguredServices } from '@/runtime/index.ts';
import { logger, summarizeError } from '@pellux/goodvibes-sdk/platform/utils';
import { operations } from '@pellux/goodvibes-sdk/platform/runtime';
const { runBootMemoryFold } = operations;
import { createDaemonPluginLoaderDeps } from './plugin-composition.ts';
import type { RuntimeServices } from './runtime-services-types.ts';

/**
 * The boot steps that belong to the graph rather than to the facade.
 *
 * The daemon facade starts the brokers, the automation manager and the memory
 * store; these are the ones it does not know about because they are this
 * product's own. A step that only runs in a client's bootstrap instead of
 * here is a step that never happens for this daemon.
 *
 * Every one of them is best-effort: none of them is a reason for the daemon not
 * to start, and each says so in the log if it fails.
 */
export async function runDaemonBootTasks(services: RuntimeServices): Promise<void> {
  // Fold a legacy per-project memory store into the canonical home-scoped one.
  // Runs after the facade's memoryStore.init(), is id-keyed and idempotent, and
  // never deletes the legacy file. The daemon is the only host of the canonical
  // store now, so if it does not fold, nothing does.
  await runBootMemoryFold(
    services.memoryStore,
    services.memoryEmbeddingRegistry,
    services.workingDirectory,
    logger,
  );

  // Provider health, rate limits and credential state become runtime events
  // rather than something a caller has to poll for.
  services.providerRegistry.startWatching(services.runtimeBus);

  // Attach the SAME WebhookNotifier the notification verbs keep live, rather
  // than a second boot-time-only instance. Attached unconditionally: `send()` is
  // already a safe no-op with zero URLs configured, and attaching only when URLs
  // exist at boot is how a URL added later reached some notifications and not
  // the bus listeners until the next restart.
  const webhookUrls = (services.configManager.getCategory('notifications') as { webhookUrls?: string[] }).webhookUrls ?? [];
  if (webhookUrls.length > 0) {
    services.webhookNotifier.setUrls(webhookUrls);
    services.runtimeDispatch.syncIntegration({
      id: 'webhooks',
      displayName: 'Webhooks',
      category: 'communication',
      status: 'healthy',
      enabled: true,
      successCount: 0,
      errorCount: 0,
      meta: { urlCount: webhookUrls.length },
    }, 'boot.webhooks');
  }
  services.webhookNotifier.attachToRuntimeBus(services.runtimeBus);

  // Outbound delivery queues: attach the notifier to the bus when any queue is
  // configured, and reflect each queue's health into the integrations read model
  // so a client can show per-channel delivery state without inventing its own.
  try {
    const notifier = await Notifier.fromConfig(services.serviceRegistry);
    const queueStatuses = notifier.getQueueStatus();
    if (queueStatuses.length > 0) {
      notifier.attachToRuntimeBus(services.runtimeBus);
      for (const queueStatus of queueStatuses) {
        services.runtimeDispatch.syncIntegration({
          id: queueStatus.channel,
          displayName: queueStatus.channel[0]!.toUpperCase() + queueStatus.channel.slice(1),
          category: 'communication',
          status: queueStatus.metrics.deadLettered > 0 ? 'degraded' : 'healthy',
          enabled: true,
          successCount: queueStatus.metrics.delivered,
          errorCount: queueStatus.metrics.deadLettered,
          ...(queueStatus.dlqEntries[0]?.deadAt ? { lastErrorAt: queueStatus.dlqEntries[0].deadAt } : {}),
          ...(queueStatus.dlqEntries[0]?.finalError ? { lastError: queueStatus.dlqEntries[0].finalError } : {}),
          meta: {
            attempts: queueStatus.metrics.totalAttempts,
            retrying: queueStatus.metrics.retrying,
            deadLetters: queueStatus.metrics.deadLettered,
            dlqSize: queueStatus.metrics.dlqSize,
            sloEnforced: queueStatus.sloEnforced,
          },
        }, 'boot.notifier');
      }
    }
  } catch (error) {
    logger.warn('daemon: notifier queue integration sync failed (non-fatal)', { error: summarizeError(error) });
  }

  // Configured external services become integration rows too, so "is my Linear
  // token set" is answerable from the daemon rather than from each client's own
  // idea of the same question.
  try {
    await syncConfiguredServices(services.runtimeDispatch.syncIntegration, services.serviceRegistry);
  } catch (error) {
    logger.warn('daemon: configured-service integration sync failed (non-fatal)', { error: summarizeError(error) });
  }

  // Load the plugins this host can serve. The manager was constructed by the
  // graph and never initialised, so it could list a plugin directory and never
  // load anything out of it — `enable` persisted a flag that turned nothing on.
  // Both hosts read the same directories; each takes the registrations it can
  // serve (plugin-composition.ts). Best-effort like everything else here: a
  // plugin that will not load is not a reason for the daemon not to start.
  try {
    await services.pluginManager.init(createDaemonPluginLoaderDeps(services));
  } catch (error) {
    logger.warn('daemon: plugin load failed (non-fatal)', { error: summarizeError(error) });
  }
}
