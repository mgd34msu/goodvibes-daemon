/**
 * The daemon's `payments.*` surface: the card store, the purchase ledger, and
 * the handler registration that binds them to the SDK's descriptors.
 *
 * Composed from src/runtime/payments-composition.ts, which is the only module
 * that decides where the files live and which secret tier the material lands in.
 */
export {
  CARD_MATERIAL_FIELDS,
  CardStoreUnreadableError,
  DaemonCardStore,
  cardBrand,
  cardSecretKey,
  newCardId,
} from './card-store.ts';
export type {
  CardCreateInput,
  CardMaterialField,
  CvvHandling,
  DaemonCardStoreOptions,
  PaymentsSecretStore,
} from './card-store.ts';

export { DaemonPurchaseLedger, MAX_PURCHASE_LIST_LIMIT } from './purchase-ledger.ts';
export type { DaemonPurchaseLedgerOptions, PurchaseListQuery, StoredPurchase } from './purchase-ledger.ts';

export { DurableBudgetLedger } from './budget-store.ts';

export { DaemonApprovalStore } from './approval-store.ts';
export type { ApprovalTakeHit, ApprovalTakeMiss } from './approval-store.ts';

export { DurableCheckoutJournal } from './checkout-journal-store.ts';

export { CHECKOUT_APPROVAL_ACTION, checkoutApprovalContent } from './checkout-handlers.ts';

export { configBackedAddressStore } from './address-store.ts';
export { channelBackedPaymentNotifier } from './notifier.ts';
export { createProviderBackedMerchantJudgeModel } from './merchant-judge.ts';

export {
  ATTACHED_PAYMENTS_METHOD_IDS,
  UNATTACHED_PAYMENTS_METHOD_IDS,
  registerPaymentsMethods,
} from './register.ts';
export type { CheckoutComposition, PaymentsHandlerDeps } from './register.ts';
