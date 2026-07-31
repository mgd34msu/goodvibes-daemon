/**
 * trust-gated-approvals.ts — how a headless daemon asks the workspace trust
 * question, and how the answer reaches the runs it hosts.
 *
 * The terminal app composes the trust gate at the permission machinery's final
 * ask layer and raises the question as a modal on its own screen
 * (bootstrap-core.ts). The daemon has the same gate — `trustGatedAsk` next
 * door, reading the same `<cwd>/.goodvibes/<surface>/trust.json` the terminal
 * writes — and no screen to raise anything on. Before this module it therefore
 * did neither: the gate was constructed, never loaded, never consulted, and no
 * hosted run passed through it.
 *
 * Two pieces close that:
 *
 *  1. `createWorkspaceTrustDecisionAsk` raises the trust question as an
 *     ordinary approval record. That is the whole point of the approval-raise
 *     path: a process with no screen states the question, publishes it on
 *     `approval-update`, and whichever surface is attached answers it. Approved
 *     means "trusted", denied means "restricted" — a real decision either way,
 *     persisted by the gate, and never asked again for this workspace.
 *
 *  2. `trustGatedApprovalRaiser` puts the gate in front of the raiser the
 *     permission manager asks through, and loads the persisted decision before
 *     consulting it. The load is here rather than in the composition root
 *     because `createRuntimeServices` is synchronous: a fire-and-forget load
 *     started at composition time can lose the race with the first hosted run,
 *     and losing it means re-asking a question the user already answered.
 *     `WorkspaceTrustManager.load()` is idempotent, so paying for it on every
 *     ask costs one already-resolved promise after the first.
 *
 * What the daemon does NOT do here is decide by default. An untrusted
 * workspace's hosted run neither runs as if trusted nor fails as if refused: it
 * asks. If the ask cannot be answered — nothing attached, or the broker itself
 * failed — the workspace stays undecided and this run is refused, with the
 * reason in the log rather than in a silence. A refusal that records nothing is
 * the failure mode this whole seam exists to remove.
 */
import { randomUUID } from 'node:crypto';
import { logger } from '@pellux/goodvibes-sdk/platform/utils';
import type { PermissionPromptDecision, PermissionPromptRequest } from '@pellux/goodvibes-sdk/platform/permissions';
import { operations } from '@pellux/goodvibes-sdk/platform/runtime';
const { trustGatedAsk } = operations;
type WorkspaceTrustLevel = operations.WorkspaceTrustLevel;
type WorkspaceTrustManager = operations.WorkspaceTrustManager;

/**
 * The extra fields a raise carries beside the request itself — the attribution
 * routing/metadata a background-agent ask is stamped with before it reaches the
 * broker. The gate only reads `request.category`, so these ride around it.
 */
export interface ApprovalRaiseExtras {
  readonly routeId?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
  /** Expiry for a raised ask; the trust question sets one, tool asks do not. */
  readonly timeoutMs?: number | undefined;
}

/** Raise an ask and wait for the answer. Matches the SDK's ApprovalRaiser seam. */
export type ApprovalRaise = (
  input: { readonly request: PermissionPromptRequest } & ApprovalRaiseExtras,
) => Promise<PermissionPromptDecision>;

/**
 * How long a raised trust question stays open before it expires.
 *
 * A hosted run blocked on a question nobody is there to answer is a run that
 * never finishes, and an unattended daemon is the normal case, not the edge
 * one. Ten minutes is long enough for someone who is at a surface to see the
 * ask and answer it, and short enough that an unattended run fails with a
 * reason instead of hanging until the process restarts.
 */
export const WORKSPACE_TRUST_ASK_TIMEOUT_MS = 10 * 60 * 1000;

export interface WorkspaceTrustDecisionAskDeps {
  readonly requestApproval: ApprovalRaise;
  /** The workspace the question is about — it names the directory being trusted. */
  readonly workingDirectory: string;
  readonly timeoutMs?: number | undefined;
}

/**
 * Build the `requestTrustDecision` callback `trustGatedAsk` calls when a
 * workspace has no decision yet.
 *
 * The question is raised as a `read`-category request on purpose: it is the
 * trust question itself, raised BY the gate, and routing it back through the
 * gate would ask the gate to decide whether it may ask.
 */
export function createWorkspaceTrustDecisionAsk(
  deps: WorkspaceTrustDecisionAskDeps,
): () => Promise<WorkspaceTrustLevel> {
  return async () => {
    const request: PermissionPromptRequest = {
      callId: `workspace-trust-${randomUUID().slice(0, 8)}`,
      tool: 'workspace-trust',
      args: { workspace: deps.workingDirectory },
      category: 'read',
      analysis: {
        classification: 'workspace-trust',
        riskLevel: 'high',
        summary: `Trust the workspace ${deps.workingDirectory}?`,
        reasons: [
          `A run hosted by this daemon wants to write, execute, or delegate in "${deps.workingDirectory}", which has no trust decision recorded.`,
          'Approving marks the workspace trusted and stops this question being asked for it again.',
          'Denying marks it restricted: reads keep working, and writes, commands and delegation are refused there.',
        ],
        target: deps.workingDirectory,
        targetKind: 'path',
        blastRadius: 'local',
      },
    };
    try {
      const decision = await deps.requestApproval({
        request,
        timeoutMs: deps.timeoutMs ?? WORKSPACE_TRUST_ASK_TIMEOUT_MS,
        metadata: { source: 'workspace-trust', workspace: deps.workingDirectory },
      });
      return decision.approved ? 'trusted' : 'restricted';
    } catch (error) {
      // Nothing attached, or the broker failed. Say so and leave the workspace
      // undecided — the next run asks again rather than inheriting a decision
      // nobody made.
      logger.warn('Workspace trust question could not be answered; this run is refused and the workspace stays undecided', {
        workspace: deps.workingDirectory,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };
}

/** The slice of the trust manager this seam uses. */
export type TrustGateManager =
  & Pick<WorkspaceTrustManager, 'isCategoryAllowed' | 'isDecided' | 'setLevel'>
  & { load(): Promise<void> };

/**
 * Wrap an approval raiser with the workspace trust gate.
 *
 * Layering matches the terminal app's: the gate is the outer ask, the broker
 * raise is the inner one, and the permission manager's own layers (mode,
 * policy, session cache, durable rules) still run before either. A trusted
 * workspace is exactly as permissive as it was; a restricted one refuses
 * non-read categories without asking, because that is what the user chose.
 *
 * `routeId`/`metadata` reach the inner raise unchanged. The gate's own
 * signature carries only the request, so the extras are held against the
 * request object for the duration of the call rather than in a shared slot a
 * concurrent ask could overwrite.
 */
export function trustGatedApprovalRaiser(
  manager: TrustGateManager,
  raise: ApprovalRaise,
  requestTrustDecision: () => Promise<WorkspaceTrustLevel>,
): ApprovalRaise {
  const extrasByRequest = new WeakMap<PermissionPromptRequest, ApprovalRaiseExtras>();
  const gated = trustGatedAsk(
    manager,
    (request) => raise({ request, ...(extrasByRequest.get(request) ?? {}) }),
    requestTrustDecision,
  );
  return async (input) => {
    extrasByRequest.set(input.request, { routeId: input.routeId, metadata: input.metadata });
    // Idempotent, and awaited on every ask rather than once at composition:
    // see the module header for why the composition root cannot await it.
    await manager.load();
    return gated(input.request);
  };
}
