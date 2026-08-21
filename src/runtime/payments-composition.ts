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
 * ── The budget ledger is in-process, and that is a statement ──────────────
 *
 * `BudgetLedger` is constructed empty here and never persisted. That is correct
 * ONLY while checkout is unattached: the sole writer of a spend record is the
 * checkout flow, so there is nothing to persist, and a state file nothing writes
 * would be decoration. It stops being correct the moment `payments.checkout.begin`
 * is wired, and the failure would be silent and expensive, a daemon restarted at
 * noon would hand back a daily budget it had already spent. Making this ledger
 * durable is part of wiring checkout.
 *
 * ── What is NOT composed ──────────────────────────────────────────────────
 *
 * `payments.checkout.begin` and `payments.checkout.fillCard` stay unattached and
 * keep answering 501. They need a `CheckoutPageDriver` over an open browser
 * page, and this composition has no way to obtain one: the SDK builds its
 * browser engine inside `registerGatewayVerbGroups`
 * (control-plane/routes/browser-composition.ts), hands back only the
 * `BrowserGatewayService` slice, which exposes no page handle and no
 * `fillSecret`, and constructs it with no `cardFieldGuard`, which its own
 * secret-fill path refuses without. There is also no adapter anywhere from a
 * browser session to a `CheckoutPageDriver`. Writing one here would put the
 * card-into-page seam in this repository, and card-material.ts is explicit that
 * exactly one module in the platform may produce card material. So the two verbs
 * refuse honestly instead.
 */
import { controlPlaneStorePath } from '@pellux/goodvibes-sdk/platform/control-plane';
import type { GatewayMethodCatalog } from '@pellux/goodvibes-sdk/platform/control-plane';
import { BudgetLedger, readCvvHandling } from '@pellux/goodvibes-sdk/platform/payments';
import type { PaymentsConfigReader } from '@pellux/goodvibes-sdk/platform/payments';
import type { ConfigManager, SecretsManager } from '@pellux/goodvibes-sdk/platform/config';
import type { ShellPathService } from '@/runtime/index.ts';
import {
  DaemonCardStore,
  DaemonPurchaseLedger,
  registerPaymentsMethods,
  type PaymentsSecretStore,
} from '../daemon/handlers/payments/index.ts';
import { GOODVIBES_DAEMON_SURFACE_ROOT } from '../config/surface.ts';

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
 * Constructing this touches no disk: both stores read lazily and write only when
 * a verb asks them to, so composing a runtime in a test creates no files.
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
  const budget = new BudgetLedger();
  const unregister = registerPaymentsMethods(options.gatewayMethods, {
    cards,
    purchases,
    budget,
    config,
    isPaymentsLeader: options.isPaymentsLeader,
  });
  return { cards, purchases, budget, unregister };
}
