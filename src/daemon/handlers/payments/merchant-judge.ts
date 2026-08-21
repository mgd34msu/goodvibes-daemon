/**
 * merchant-judge.ts, the merchant-recourse judgement, answered by this
 * daemon's own configured model.
 *
 * `createModelMerchantJudge` (platform/payments) wants a `MerchantJudgeModel`,
 * one method, `chat(task, prompt, options)`. This adapts the daemon's
 * `ProviderRegistry` to that shape, the same pattern
 * `createProviderBackedCheckinJudge` (platform/checkin) already uses for the
 * proactive check-in judge: resolve the currently configured model, ask its
 * provider, and treat any failure as "no judgement available" rather than as a
 * thrown error, because `createModelMerchantJudge` already reads a null/failed
 * chat as an honest "I could not judge this merchant" verdict (unqualified,
 * unconfident), never as a reason to fail the purchase in some OTHER way.
 */
import type { ProviderRegistry } from '@pellux/goodvibes-sdk/platform/providers';
import type { MerchantJudgeModel } from '@pellux/goodvibes-sdk/platform/payments';
import { logger } from '@pellux/goodvibes-sdk/platform/utils';

/** How long the merchant judge waits for the model before giving up. */
const MERCHANT_JUDGE_TIMEOUT_MS = 20_000;

export function createProviderBackedMerchantJudgeModel(
  providerRegistry: Pick<ProviderRegistry, 'getCurrentModel' | 'getForModel'>,
): MerchantJudgeModel {
  return {
    async chat(task, prompt, options) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), MERCHANT_JUDGE_TIMEOUT_MS);
      timer.unref?.();
      try {
        const current = providerRegistry.getCurrentModel();
        const provider = providerRegistry.getForModel(current.registryKey, current.provider);
        const response = await provider.chat({
          model: current.id,
          messages: [{ role: 'user', content: prompt }],
          ...(options.systemPrompt !== undefined ? { systemPrompt: options.systemPrompt } : {}),
          ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
          reasoningEffort: 'low',
          signal: controller.signal,
        });
        return response.content ?? null;
      } catch (error) {
        // `createModelMerchantJudge` treats a null answer as "I could not judge
        // this merchant", the safe direction (see merchant-judge-model.ts's
        // header: an unjudgeable domain must never make spending MORE
        // automatic). The task name rides along only for the operator log.
        logger.warn('Merchant judge model call failed; the purchase proceeds as unjudged', {
          task,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
