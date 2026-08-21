/**
 * notifier.ts, sending a purchase notice over this daemon's channels.
 *
 * `createChannelPaymentNotifier` (platform/payments/notice-delivery.ts) wants
 * a router, a target per configured channel, and a `PaymentReplySource`. The
 * first two are real: `payments.notifyChannels` names which
 * `CommandAuthorityChannel`s to notify, and delivery goes out over this
 * daemon's own `ChannelDeliveryRouter`, the SAME router every other channel
 * send in this daemon uses (see services.ts's comment on why there is exactly
 * one).
 *
 * ── What is deliberately NOT wired in this pass ───────────────────────────
 *
 * `PaymentReplySource.waitForAnswer` always resolves `null`. That is not a
 * stub standing in for something broken, it is the documented meaning of
 * SILENCE (platform/payments/windows.ts): an approval window's silence DENIES
 * and a veto window's silence PROCEEDS, both already correct, tested behaviors
 * the decision layer exercises with no reply source at all. What is missing is
 * the OTHER path, an inbound reply on a channel resolving the window before its
 * deadline, "approve"/"yes"/"stop" arriving back from wherever the notice went.
 * Building that needs an inbound-message correlation path this daemon does not
 * have yet (there is no `payments.*` counterpart to
 * `tryResolveApprovalReplyFromChannel`/`tryResolveWorkProposalReplyFromChannel`
 * in `platform/daemon/surface-actions.ts`, which resolve DIFFERENT kinds of
 * reply against a DIFFERENT store). Wiring it is a distinct, sizeable piece of
 * work and is left for a later pass, exactly like `describeSubmission` above
 * it; every purchase in the meantime is decided by budget and by the windows'
 * own silence rules, with the notice actually reaching the owner's configured
 * channels.
 */
import type { ChannelDeliveryRouter, ChannelDeliveryTarget } from '@pellux/goodvibes-sdk/platform/channels';
import {
  createChannelPaymentNotifier,
  parseCommandAuthorityChannel,
  readNotifyChannels,
} from '@pellux/goodvibes-sdk/platform/payments';
import type {
  PaymentNotifier,
  PaymentNoticeRouter,
  PaymentNoticeTarget,
  PaymentReplySource,
  PaymentsConfigReader,
} from '@pellux/goodvibes-sdk/platform/payments';
import { logger } from '@pellux/goodvibes-sdk/platform/utils';

const PAYMENTS_NOTICE_JOB_ID = 'payments-notice';

/**
 * The channel name (`payments.notifyChannels` entry) turned into the router's
 * own addressing shape. `parseChannelDeliveryTarget` (platform/channels'
 * internal delivery/types.ts) is not on the published subpath, so this mirrors
 * its `surface` construction for the plain channel names `readNotifyChannels`
 * produces (no `kind:address` suffix, `CommandAuthorityChannel` carries none).
 */
function surfaceTarget(surfaceKind: string): ChannelDeliveryTarget {
  return { kind: 'surface', surfaceKind: surfaceKind as ChannelDeliveryTarget['surfaceKind'] };
}

/** Adapts this daemon's router to the notifier's narrow, opaque-`request` shape. */
function daemonNoticeRouter(router: Pick<ChannelDeliveryRouter, 'deliver'>): PaymentNoticeRouter {
  return {
    deliver: async (request) => {
      const merged = request as unknown as Record<string, unknown> & { readonly content: string };
      return router.deliver({
        target: merged['target'] as ChannelDeliveryTarget,
        body: merged.content,
        title: 'Purchase',
        jobId: PAYMENTS_NOTICE_JOB_ID,
        runId: `${PAYMENTS_NOTICE_JOB_ID}-${String(Date.now())}`,
        includeLinks: false,
      });
    },
  };
}

/** No live reply integration yet; see this module's header for why silence is still correct. */
const NO_REPLIES: PaymentReplySource = {
  async waitForAnswer() {
    return null;
  },
};

export function channelBackedPaymentNotifier(
  config: PaymentsConfigReader,
  router: Pick<ChannelDeliveryRouter, 'deliver'>,
): PaymentNotifier {
  const targets: PaymentNoticeTarget[] = [];
  for (const name of readNotifyChannels(config)) {
    const channel = parseCommandAuthorityChannel(name);
    if (channel === null) {
      logger.warn('payments.notifyChannels names a channel this daemon does not recognise; it will not be notified', { channel: name });
      continue;
    }
    targets.push({
      channel,
      request: { target: surfaceTarget(name) },
      // No backfill path is wired (see this module's header): a notice missed
      // while the daemon was down cannot be recovered by re-reading history it
      // never asked this router to keep.
      backfillable: false,
    });
  }

  return createChannelPaymentNotifier({
    router: daemonNoticeRouter(router),
    targets,
    replies: NO_REPLIES,
    onDeliveryFailure: ({ channel, reason }) => {
      logger.warn('A payments notice could not be delivered on a configured channel', { channel, reason });
    },
  });
}
