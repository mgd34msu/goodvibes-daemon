/**
 * payments-composition.ts, the payment capability inside THIS daemon.
 *
 * ── What was wrong ────────────────────────────────────────────────────────
 *
 * All seven `payments.*` verbs were cataloged, advertised with a real HTTP
 * route, and answered 501 NOT_INVOKABLE to every caller. The route existed, the
 * descriptor was honest about its shape, and nothing was attached, so the webui
 * and the desktop app could read the contract and never use it. The terminal app
 * did not paper over this: it has no payments handlers either; what it has is a
 * settings surface (`/payments card`) that writes four flat config keys, which
 * is a per-surface stopgap, not a served capability.
 *
 * ── What this composes ────────────────────────────────────────────────────
 *
 * The SDK owns the capability (`platform/payments`) and states, in
 * card-material.ts, that the store behind it "is implemented by the daemon
 * against its own secret store". It ships no such implementation. So this
 * composes the two stores that were missing, from paths the daemon already owns:
 *
 *   - card metadata at `<home>/.goodvibes/<surface>/control-plane/payments-cards.json`,
 *     through `controlPlaneStorePath`, the one resolver every control-plane
 *     store path goes through, so it lands beside pairing-tokens.json rather
 *     than in the unscoped orphan directory that resolver exists to prevent;
 *   - card MATERIAL one field per key in the DAEMON secret tier, written with an
 *     explicit `scope: 'daemon'`. Explicit because a payments card key is not in
 *     the SDK's daemon-needed registry, so an omitted scope would file the
 *     material in the surface tier while the daemon reads the daemon tier, the
 *     exact split secret-config.ts's `defaultSecretBackedScope` documents as the
 *     mailbox-password failure and names "the same shape of failure at purchase
 *     time" for a card;
 *   - the purchase audit ledger beside the card file.
 *
 * ── The budget ledger is durable ──────────────────────────────────────────
 *
 * `BudgetLedger` used to be constructed empty here and never persisted, correct
 * only while checkout stayed unattached (the sole writer of a spend record was
 * the checkout flow, so there was nothing to persist). Now that checkout is
 * wired below, `DurableBudgetLedger`
 * (daemon/handlers/payments/budget-store.ts) is used instead: it loads its
 * state from `payments-budget.json` beside the card and purchase files at
 * construction and writes back after every reservation, commit and release, so
 * a daemon restarted mid-day does not hand back a budget it already spent.
 *
 * ── The checkout pair, over the sdk 2.0.19 browser-checkout seam ──────────
 *
 * `payments.checkout.begin`/`.fillCard` need a `CardMaterialRedactor` bound to
 * the SAME browser engine the `browser.*` verbs drive, and this daemon does not
 * build that engine, `composeDaemonBrowser` does (control-plane/routes/
 * browser-composition.ts), inside `registerGatewayVerbGroups`, which THIS
 * composition runs before (see runtime/services.ts). `checkoutSeam` is
 * therefore a GETTER, not a value: services.ts passes `onBrowserCheckout` to
 * `attachWsOnlyGatewayVerbHandlers` wired to fill the SAME holder this getter
 * reads (runtime/browser-checkout-seam-holder.ts), and `register.ts`'s checkout
 * handlers read it fresh on every call rather than once at composition time.
 *
 * The rest of `PaymentsGatewayServiceImpl`'s dependencies this composition owns
 * outright: `configBackedAddressStore` reads the shipping/billing addresses the
 * owner profile already writes into `payments.*Address.*` config keys (see
 * that module's header for the exact defect this closes), and
 * `channelBackedPaymentNotifier`/`createProviderBackedMerchantJudgeModel` adapt
 * this daemon's channel router and provider registry to the ports the SDK
 * declares. The untrusted-content ledger is the SAME process-wide singleton the
 * browser composition binds its engine to (`getProcessUntrustedContentLedger`),
 * never a private one, for the reason browser-composition.ts's header gives:
 * a private ledger would make cross-capability derivation invisible.
 *
 * `channelBackedPaymentNotifier`'s own header names the one piece deliberately
 * left for a later pass: no live inbound-reply correlation, so every purchase
 * settles on the windows' own silence rules rather than an early answer. That
 * is a scoped, disclosed gap, not a silent one.
 */
import { controlPlaneStorePath } from '@pellux/goodvibes-sdk/platform/control-plane';
import type { GatewayMethodCatalog } from '@pellux/goodvibes-sdk/platform/control-plane';
import { createModelMerchantJudge, readCvvHandling } from '@pellux/goodvibes-sdk/platform/payments';
import type { BudgetLedger, PaymentsConfigReader } from '@pellux/goodvibes-sdk/platform/payments';
import { getProcessUntrustedContentLedger } from '@pellux/goodvibes-sdk/platform/security';
import type { ConfigManager, SecretsManager } from '@pellux/goodvibes-sdk/platform/config';
import type { ChannelDeliveryRouter } from '@pellux/goodvibes-sdk/platform/channels';
import type { ProviderRegistry } from '@pellux/goodvibes-sdk/platform/providers';
import type { ShellPathService } from '@/runtime/index.ts';
import {
  DaemonCardStore,
  DaemonPurchaseLedger,
  DurableBudgetLedger,
  channelBackedPaymentNotifier,
  configBackedAddressStore,
  createProviderBackedMerchantJudgeModel,
  registerPaymentsMethods,
  type CheckoutComposition,
  type PaymentsSecretStore,
} from '../daemon/handlers/payments/index.ts';
import { GOODVIBES_DAEMON_SURFACE_ROOT } from '../config/surface.ts';
import type { BrowserCheckoutSeamHolder } from './browser-checkout-seam-holder.ts';

export interface PaymentsCompositionOptions {
  readonly configManager: ConfigManager;
  readonly shellPaths: ShellPathService;
  readonly secretsManager: SecretsManager;
  /** Binding the catalog is what turns the family from a 501 facade into handlers. */
  readonly gatewayMethods: GatewayMethodCatalog;
  /**
   * Whether this node is the one currently allowed to spend.
   *
   * Reported by `payments.budget.status` and never defaulted, see the SDK's
   * gates.ts: on a clustered install the wrong answer is a double-spend.
   */
  readonly isPaymentsLeader: () => boolean;
  /** Where the checkout pair reads the browser-checkout seam; see this file's header. */
  readonly checkoutSeam: BrowserCheckoutSeamHolder['get'];
  /** Delivers a purchase notice; the SAME router every other channel send in this daemon uses. */
  readonly channelDeliveryRouter: Pick<ChannelDeliveryRouter, 'deliver'>;
  /** Judges an unfamiliar merchant's recourse through the currently configured model. */
  readonly providerRegistry: Pick<ProviderRegistry, 'getCurrentModel' | 'getForModel'>;
}

export interface PaymentsServices {
  readonly cards: DaemonCardStore;
  readonly purchases: DaemonPurchaseLedger;
  readonly budget: BudgetLedger;
  /** Detaches the handlers. Held by the runtime disposal scope. */
  readonly unregister: () => void;
}

/**
 * The narrow secret port the card store gets: three operations over the daemon
 * tier, and no way to reach any other credential in the process. The same
 * treatment cluster-group-composition.ts gives the group key.
 */
function daemonScopedSecrets(secretsManager: SecretsManager): PaymentsSecretStore {
  return {
    get: (key) => secretsManager.get(key),
    set: async (key, value) => {
      await secretsManager.set(key, value, { scope: 'daemon', medium: 'secure' });
    },
    delete: async (key) => {
      await secretsManager.delete(key, { scope: 'daemon' });
    },
  };
}

/** Read live, per call: a budget raised five minutes ago applies to the next read. */
function livePaymentsConfig(configManager: ConfigManager): PaymentsConfigReader {
  return { get: (key: string) => configManager.get(key as Parameters<ConfigManager['get']>[0]) };
}

/**
 * Build the payment stores and bind the answerable verbs to them.
 *
 * The card and purchase stores read lazily and write only when a verb asks
 * them to, so composing either by itself creates no file activity. The budget
 * ledger is different: `DurableBudgetLedger`'s constructor reads
 * `payments-budget.json` synchronously to load today's pools
 * (daemon/handlers/payments/budget-store.ts), so constructing the result of
 * THIS function does touch disk, once, for that one file, before any verb is
 * ever called.
 */
export function createPaymentsServices(options: PaymentsCompositionOptions): PaymentsServices {
  const config = livePaymentsConfig(options.configManager);
  const cards = new DaemonCardStore({
    filePath: controlPlaneStorePath(options.shellPaths, GOODVIBES_DAEMON_SURFACE_ROOT, 'payments-cards.json'),
    secrets: daemonScopedSecrets(options.secretsManager),
    cvvHandling: () => readCvvHandling(config),
  });
  const purchases = new DaemonPurchaseLedger({
    filePath: controlPlaneStorePath(options.shellPaths, GOODVIBES_DAEMON_SURFACE_ROOT, 'payments-purchases.json'),
  });
  const budget = new DurableBudgetLedger(
    controlPlaneStorePath(options.shellPaths, GOODVIBES_DAEMON_SURFACE_ROOT, 'payments-budget.json'),
  );
  const checkout: CheckoutComposition = {
    seam: options.checkoutSeam,
    addresses: configBackedAddressStore(config),
    notifier: channelBackedPaymentNotifier(config, options.channelDeliveryRouter),
    merchantJudge: createModelMerchantJudge(createProviderBackedMerchantJudgeModel(options.providerRegistry)),
    untrusted: getProcessUntrustedContentLedger(),
  };
  const unregister = registerPaymentsMethods(options.gatewayMethods, {
    cards,
    purchases,
    budget,
    config,
    isPaymentsLeader: options.isPaymentsLeader,
    checkout,
  });
  return { cards, purchases, budget, unregister };
}
