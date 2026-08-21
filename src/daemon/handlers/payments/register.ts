/**
 * register.ts, the `payments.*` handlers this daemon attaches.
 *
 * ── Why the handlers are written here and not imported ────────────────────
 *
 * The SDK has these handlers already: `registerPaymentsGatewayMethods` in
 * `platform/control-plane/routes/payments.ts`. It cannot be called from here.
 * That module is not re-exported by `platform/control-plane/index.ts`, and the
 * SDK package's `exports` map publishes only the barrel, so the symbol exists in
 * the installed `dist` and no import path reaches it. `registerGatewayVerbGroups`
 * (the SDK's own composition entry, which the terminal-shell wrapper calls from
 * runtime/services.ts) carries no payments dependency either, so there is no
 * argument this daemon can pass that would make the SDK attach them.
 *
 * So this follows the idiom this repository already uses for every other family
 * it serves, stated at the top of handlers/index.ts and implemented by
 * `registerCatalogHandler`: the SDK owns the id, the descriptor, the schemas,
 * the scopes and the access level, and only the BEHAVIOUR is ours. Nothing
 * below authors a descriptor.
 *
 * The right long-term fix is one line in the SDK's control-plane barrel. Until
 * that lands, the choice is these handlers or a 501 on every payments verb, and
 * a 501 is what the webui and the desktop app have been getting.
 *
 * ── What is attached, and what deliberately is not ────────────────────────
 *
 * Attached: budget.status, cards.list, cards.create, cards.delete,
 * purchases.list. Every one of them is answerable from stores this daemon owns.
 *
 * NOT attached: checkout.begin and checkout.fillCard. Both need a
 * `CheckoutPageDriver` bound to an open browser page, and this composition
 * cannot produce one: `createDaemonBrowserGatewayService` builds the engine
 * inside `registerGatewayVerbGroups` and returns only the `BrowserGatewayService`
 * slice, which exposes no page handle and no `fillSecret`; and that engine is
 * constructed with no `cardFieldGuard`, so its secret-fill path refuses by
 * design. Both verbs therefore keep answering 501 NOT_INVOKABLE, which is the
 * honest answer for a capability nothing here can perform, and a better one than
 * a handler that accepts the call and fails inside.
 *
 * ── Containment ───────────────────────────────────────────────────────────
 *
 * Every response below is BUILT from named fields rather than spread from a
 * store record, for the reason the SDK's own route module gives: an allowlist
 * silently drops a field a later change adds, a denylist silently ships it, and
 * for anything on a card's code path that is the correct direction to fail.
 * No handler here reads card material, and no failure path forwards a message
 * from a call that had material in its arguments.
 */
import type { BudgetLedger, PaymentsConfigReader } from '@pellux/goodvibes-sdk/platform/payments';
import {
  readDefaultCardId,
  readPaymentsEnabled,
  readPaymentsServiceConfig,
} from '@pellux/goodvibes-sdk/platform/payments';
import type { CardMetadata } from '@pellux/goodvibes-sdk/platform/payments';
import type { GatewayMethodCatalog } from '../contracts.ts';
import { HandlerError } from '../errors.ts';
import { registerCatalogHandlers, type TypedHandler, type Unregister } from '../register.ts';
import { CardStoreUnreadableError, type DaemonCardStore } from './card-store.ts';
import { MAX_PURCHASE_LIST_LIMIT, type DaemonPurchaseLedger, type StoredPurchase } from './purchase-ledger.ts';

/** The verbs this module attaches. Named so a test can assert the exact set. */
export const ATTACHED_PAYMENTS_METHOD_IDS: readonly string[] = [
  'payments.budget.status',
  'payments.cards.list',
  'payments.cards.create',
  'payments.cards.delete',
  'payments.purchases.list',
];

/**
 * The verbs this composition leaves unattached, and the reason each one is.
 *
 * Exported so the refusal is testable: a change that wires a page driver has to
 * delete the entry, and a change that attaches one of these without wiring a
 * driver fails the same assertion.
 */
export const UNATTACHED_PAYMENTS_METHOD_IDS: readonly { readonly id: string; readonly reason: string }[] = [
  {
    id: 'payments.checkout.begin',
    reason:
      'Needs a CheckoutPageDriver for an open browser page. The SDK builds the browser engine inside '
      + 'registerGatewayVerbGroups and hands back only BrowserGatewayService, which exposes no page handle, '
      + 'and builds it with no cardFieldGuard, so its secret-fill path refuses by design.',
  },
  {
    id: 'payments.checkout.fillCard',
    reason: 'Same missing page driver; this is the verb that types the card into it.',
  },
];

const DEFAULT_PURCHASE_LIST_LIMIT = 100;

export interface PaymentsHandlerDeps {
  readonly cards: DaemonCardStore;
  readonly purchases: DaemonPurchaseLedger;
  /**
   * Today's pools. Read-only in this composition: the only writer of a spend
   * record is the checkout flow, which is not attached, so this ledger reports
   * limits from live config against an empty spend history. Wiring checkout must
   * also make this ledger DURABLE, a ledger rebuilt at every boot would hand
   * back a daily budget that was already spent.
   */
  readonly budget: BudgetLedger;
  readonly config: PaymentsConfigReader;
  /**
   * Whether this node is the one allowed to spend.
   *
   * Reported, never defaulted, see the SDK's gates.ts: on a clustered install a
   * wrong answer here is a double-spend. The composition root supplies the
   * coordinator's own answer.
   */
  readonly isPaymentsLeader: () => boolean;
  readonly now?: (() => number) | undefined;
}

// ---------------------------------------------------------------------------
// Input readers
//
// Each names the FIELD and never the value, the property the SDK's own route
// module enforces: an error string is a read path like any other.
// ---------------------------------------------------------------------------

function invalid(field: string, requirement: string): HandlerError {
  return new HandlerError(`${field} ${requirement}`, 'INVALID_ARGUMENT', 400);
}

/**
 * Run a card-store call and refuse in the caller's terms.
 *
 * Two outcomes, and the difference is what the caller is allowed to be told:
 *
 *  - `CardStoreUnreadableError` is a message this codebase WROTE, naming the
 *    file and what to do about it. It is forwarded verbatim because the operator
 *    cannot fix a damaged card file they are not told about, and 409 says the
 *    honest thing: nothing is wrong with the request, the store is not in a
 *    state that can serve it.
 *  - Anything else came out of the secret store, and its message can name the
 *    store path, the key, or the value it was handling. It is DISCARDED and
 *    replaced here. Without this, `registerCatalogHandler`'s generic wrapper
 *    forwards the original as a 500 body, which put a store path in front of any
 *    caller holding read:payments.
 */
async function overStore<T>(what: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof CardStoreUnreadableError) {
      throw new HandlerError(error.message, 'FAILED_PRECONDITION', 409);
    }
    void error;
    throw new HandlerError(`${what} failed.`, 'INTERNAL_ERROR', 500);
  }
}

function readString(source: Record<string, unknown>, field: string): string {
  const value = source[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw invalid(field, 'is required.');
  }
  return value.trim();
}

function readInteger(source: Record<string, unknown>, field: string, min: number, max: number): number {
  const value = source[field];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw invalid(field, `must be a whole number between ${String(min)} and ${String(max)}.`);
  }
  return value;
}

function asRecord(body: unknown): Record<string, unknown> {
  return typeof body === 'object' && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

/** A number that arrived as a query string (a GET) or as JSON (an invoke). */
function optionalCount(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) return raw;
  if (typeof raw === 'string' && /^[0-9]+$/.test(raw.trim())) {
    const parsed = Number.parseInt(raw.trim(), 10);
    if (parsed > 0) return parsed;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Response builders (allowlists, never spreads)
// ---------------------------------------------------------------------------

interface CardView {
  readonly id: string;
  readonly label: string;
  readonly brand: string;
  readonly last4: string;
  readonly kind: 'virtual' | 'real';
  readonly expiryMonth: number;
  readonly expiryYear: number;
  readonly issuerCapMinorUnits: number | null;
  readonly addedAt: string;
  readonly materialComplete: boolean;
}

function cardView(card: CardMetadata, materialComplete: boolean): CardView {
  return {
    id: card.id,
    label: card.label,
    brand: card.brand,
    last4: card.last4,
    kind: card.kind,
    expiryMonth: card.expiryMonth,
    expiryYear: card.expiryYear,
    issuerCapMinorUnits: card.issuerCapMinorUnits,
    addedAt: card.addedAt,
    materialComplete,
  };
}

function purchaseView(row: StoredPurchase): Record<string, unknown> {
  return {
    purchaseId: row.purchaseId,
    atUtc: row.atUtc,
    dayKey: row.dayKey,
    timezone: row.timezone,
    merchantDomain: row.merchantDomain,
    item: String(row.item),
    currency: String(row.currency),
    itemMinorUnits: row.itemMinorUnits,
    taxMinorUnits: row.taxMinorUnits,
    feesMinorUnits: row.feesMinorUnits,
    shippingMinorUnits: row.shippingMinorUnits,
    totalMinorUnits: row.totalMinorUnits,
    shippingTierRequested: row.shippingTierRequested,
    shippingTierUsed: row.shippingTierUsed,
    steppedDown: row.steppedDown === true,
    itemPoolDraw: row.itemPoolDraw,
    overagePoolDraw: row.overagePoolDraw,
    tolerancePoolDraw: row.tolerancePoolDraw,
    cardLast4: row.cardLast4,
    windowKind: row.windowKind,
    windowOutcome: row.windowOutcome,
    answeredBy: row.answeredBy ?? null,
    outcome: row.outcome,
    refusalReason: row.refusalReason ?? null,
    merchantOrderId: row.merchantOrderId ?? null,
    refundedAt: row.refundedAt ?? null,
    merchantRecognised: row.merchantRecognised === true,
    merchantQualifier: row.merchantQualifier ?? null,
    merchantDiscovered: row.merchantDiscovered === true,
  };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Attach the five answerable `payments.*` handlers to the descriptors the SDK
 * catalog already holds. Returns the teardown, reverse order, like every other
 * surface in this layer.
 *
 * NOT gated on `payments.enabled`. That key defaults to false, and
 * `payments.cards.*` is how a surface CONFIGURES the capability, so gating
 * registration on it would leave the configuration surface unreachable until the
 * capability was already configured, which is the shape of the defect this
 * module exists to fix. The setting is reported live by `budget.status` instead,
 * and it is `checkPaymentGates` at purchase time that stops a disabled daemon
 * from spending.
 */
export function registerPaymentsMethods(
  catalog: GatewayMethodCatalog,
  deps: PaymentsHandlerDeps,
): Unregister {
  const now = deps.now ?? Date.now;

  const budgetStatus: TypedHandler<unknown, Record<string, unknown>> = async () => {
    const config = readPaymentsServiceConfig(deps.config);
    const nowMs = now();
    const pools = deps.budget.snapshot(config.limits, nowMs, config.timezone);
    const live = deps.budget.state().reservations.filter((entry) => entry.expiresAtMs > nowMs);
    return {
      enabled: readPaymentsEnabled(deps.config),
      dayKey: String(pools.dayKey),
      timezone: pools.timezone,
      currency: String(config.budgetCurrency),
      item: { ...pools.item },
      overage: { ...pools.overage },
      tolerance: { ...pools.tolerance },
      reservationCount: live.length,
      isPaymentsLeader: deps.isPaymentsLeader(),
    };
  };

  const cardsList: TypedHandler<unknown, Record<string, unknown>> = async () => {
    const views = await overStore('Listing the stored cards', async () => {
      const built: CardView[] = [];
      for (const card of deps.cards.list()) {
        built.push(cardView(card, await deps.cards.materialComplete(card.id)));
      }
      return built;
    });
    return { cards: views, defaultCardId: readDefaultCardId(deps.config) };
  };

  const cardsCreate: TypedHandler<unknown, Record<string, unknown>> = async ({ body }) => {
    const params = asRecord(body);
    const kind = readString(params, 'kind');
    if (kind !== 'virtual' && kind !== 'real') {
      throw invalid('kind', "must be 'virtual' or 'real'.");
    }
    const label = readString(params, 'label');
    const number = readString(params, 'number');
    // Narrower than the published input schema, which types these as a plain
    // string and a plain number. Each check below is a property of BEING a card
    // rather than a policy about one: a value that fails it could not be
    // charged, and storing it would produce a card the surface offers and the
    // checkout can never fill. None of them names anything but the field.
    if (number.replace(/\D/g, '').length < 12) {
      throw invalid('number', 'does not contain enough digits to be a card number.');
    }
    const expiryMonth = readInteger(params, 'expiryMonth', 1, 12);
    // A full four-digit year: `cardFieldValue` derives the two-digit form by
    // slicing this one, so a year stored as 29 would type as "29" in a
    // four-digit field and as "29" in a two-digit one, and only one of those is
    // right.
    const expiryYear = readInteger(params, 'expiryYear', 1000, 9999);
    const cvv = readString(params, 'cvv');
    if (!/^[0-9]{3,4}$/.test(cvv)) {
      throw invalid('cvv', 'must be the three or four digit code printed on the card.');
    }
    const cardholderName = readString(params, 'cardholderName');
    const rawCap = params['issuerCapMinorUnits'];

    let card: CardMetadata;
    try {
      card = await deps.cards.create({
        label,
        kind,
        number,
        expiryMonth,
        expiryYear,
        cvv,
        cardholderName,
        issuerCapMinorUnits: typeof rawCap === 'number' && Number.isInteger(rawCap) ? rawCap : null,
      });
    } catch (error) {
      // A damaged card file is the operator's to fix and its message says how,
      // so it is forwarded; see overStore. Everything else is discarded, because
      // the failing call had the card in its arguments.
      if (error instanceof CardStoreUnreadableError) {
        throw new HandlerError(error.message, 'FAILED_PRECONDITION', 409);
      }
      void error;
      throw new HandlerError('Storing the card failed. Nothing was saved.', 'INTERNAL_ERROR', 500);
    }
    return {
      card: cardView(card, await overStore('Reading the card back', () => deps.cards.materialComplete(card.id))),
    };
  };

  const cardsDelete: TypedHandler<unknown, Record<string, unknown>> = async ({ body, query }) => {
    // The REST path is `/api/payments/cards/{id}`, whose path parameter the
    // dispatcher folds into BOTH query and body; the methodId-invoke endpoint
    // carries it in the body only. Reading both is what makes the two paths the
    // same verb rather than two.
    const id = readString({ ...query, ...asRecord(body) }, 'id');
    const result = await overStore('Deleting the card', () => deps.cards.remove(id));
    return { id, deleted: result.deleted, secretsCleared: result.secretsCleared };
  };

  const purchasesList: TypedHandler<unknown, Record<string, unknown>> = async ({ body, query }) => {
    const params = { ...query, ...asRecord(body) };
    const requested = optionalCount(params['limit']);
    const rawDay = params['dayKey'];
    const dayKey = typeof rawDay === 'string' && rawDay.trim().length > 0 ? rawDay.trim() : undefined;
    const result = deps.purchases.list({
      limit: Math.min(requested ?? DEFAULT_PURCHASE_LIST_LIMIT, MAX_PURCHASE_LIST_LIMIT),
      dayKey,
    });
    return { purchases: result.purchases.map(purchaseView), total: result.total };
  };

  return registerCatalogHandlers(catalog, [
    { id: 'payments.budget.status', handler: budgetStatus as TypedHandler<unknown, unknown> },
    { id: 'payments.cards.list', handler: cardsList as TypedHandler<unknown, unknown> },
    { id: 'payments.cards.create', handler: cardsCreate as TypedHandler<unknown, unknown> },
    { id: 'payments.cards.delete', handler: cardsDelete as TypedHandler<unknown, unknown> },
    { id: 'payments.purchases.list', handler: purchasesList as TypedHandler<unknown, unknown> },
  ]);
}
