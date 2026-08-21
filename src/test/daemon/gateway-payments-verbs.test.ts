/**
 * payments.* over this daemon's own composition, and over its real HTTP routes.
 *
 * ── The defect this file pins ─────────────────────────────────────────────
 *
 * All seven `payments.*` verbs were cataloged, advertised a real REST path, and
 * answered `501 NOT_INVOKABLE` to everyone. That is the exact
 * advertise-without-substance shape gateway-catalog-handler-or-route.test.ts
 * exists to catch, and it did not catch this one: those descriptors carry an
 * `http` binding and the daemon-sdk route table really serves those paths, so
 * the family sat in the sweep's "route-served" bucket while every request down
 * that route reached the handler-less branch and refused. A verb can be routed
 * and dead at the same time, and only an end-to-end call can tell.
 *
 * So this file makes the call. `GET /api/payments/cards` answered 501 before
 * runtime/payments-composition.ts existed and answers 200 after it, and the
 * assertion below is written against the live route rather than against the
 * catalog, because the catalog was never the thing that was wrong.
 *
 * ── The two verbs that still refuse ───────────────────────────────────────
 *
 * `payments.checkout.begin` and `payments.checkout.fillCard` are asserted to be
 * UNATTACHED, deliberately. They need a `CheckoutPageDriver` over an open
 * browser page and this composition cannot obtain one (see
 * payments-composition.ts). Pinning the refusal is what stops it from quietly
 * becoming either an accidental attachment that fails inside, or a forgotten
 * gap nobody remembers is a gap.
 *
 * ── What no assertion here does ───────────────────────────────────────────
 *
 * Nothing charges anything and nothing touches a real card. The number below is
 * a publicly-documented test value that no issuer routes, and every response
 * body is searched for it rather than being trusted to omit it.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  ATTACHED_PAYMENTS_METHOD_IDS,
  UNATTACHED_PAYMENTS_METHOD_IDS,
} from '../../daemon/handlers/payments/index.ts';
import { startDaemonFixture, type DaemonFixture } from '../../testing/daemon-fixture.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

/** A documented test number, and two values distinctive enough to grep a body for. */
const TEST_CARD_NUMBER = '4111111111111111';
const TEST_CARD_CVV = '907';
const TEST_CARDHOLDER = 'PAYMENTS ROUND TRIP';

let fixture: DaemonFixture;
let root = '';

beforeAll(async () => {
  root = makeProjectTempDir('gv-payments-verbs');
  fixture = await startDaemonFixture({
    root,
    configure: (configManager) => {
      // A configured daemon, because the read verbs report live settings and a
      // test against all-defaults cannot tell "read the config" from "returned
      // a zero".
      configManager.set('payments.enabled', true);
      configManager.set('payments.currency', 'USD');
      configManager.set('payments.budget.dailyItem', 150);
      configManager.set('payments.budget.dailyOverage', 25);
      configManager.set('daemon.timezone', 'America/New_York');
    },
  });
});

afterAll(async () => {
  await fixture?.stop();
});

/** Read a JSON response, keeping the raw text so a body can be searched for a sentinel. */
async function readJson(response: Response): Promise<{ status: number; text: string; body: Record<string, unknown> }> {
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = {};
  }
  return { status: response.status, text, body };
}

describe('payments.* is attached to this daemon, not a cataloged 501 facade', () => {
  test('the five answerable verbs carry a handler', () => {
    for (const id of ATTACHED_PAYMENTS_METHOD_IDS) {
      expect(fixture.services.gatewayMethods.get(id), `${id} is not cataloged`).toBeTruthy();
      expect(
        fixture.services.gatewayMethods.hasHandler(id),
        `${id} is cataloged with no handler, so it answers 501 to every client`,
      ).toBe(true);
    }
  });

  test('the checkout pair carries no handler', () => {
    for (const { id, reason } of UNATTACHED_PAYMENTS_METHOD_IDS) {
      expect(fixture.services.gatewayMethods.get(id), `${id} is not cataloged`).toBeTruthy();
      expect(
        fixture.services.gatewayMethods.hasHandler(id),
        `${id} gained a handler. If a CheckoutPageDriver is now reachable, move it into `
        + `ATTACHED_PAYMENTS_METHOD_IDS and delete this entry. Reason it was unattached: ${reason}`,
      ).toBe(false);
    }
  });

  test('the checkout pair refuses with 501 NOT_INVOKABLE, not with a schema 400', async () => {
    // Both bodies below satisfy their published input schemas in full, which is
    // the point: the input-validation gate runs BEFORE the handler lookup, so a
    // body that failed validation would prove nothing about whether the verb is
    // wired. These get past it and land on the honest "not wired here" refusal.
    const probes: readonly { readonly path: string; readonly body: Record<string, unknown> }[] = [
      {
        path: '/api/payments/checkout/fill-card',
        body: {
          sessionId: 'session-that-does-not-exist',
          pageId: 'page-that-does-not-exist',
          targets: [{ field: 'number', ref: 'e1' }],
        },
      },
      {
        path: '/api/payments/checkout/begin',
        body: {
          sessionId: 'session-that-does-not-exist',
          pageId: 'page-that-does-not-exist',
          merchantDomain: 'example.invalid',
          checkoutUrl: 'https://example.invalid/checkout',
          item: 'nothing at all',
          cardId: 'card-that-does-not-exist',
          requestedLines: [{ label: 'nothing at all', quantity: 1 }],
          lines: [{ label: 'nothing at all', quantity: '1', unitPrice: '1.00' }],
          shippingOptions: [{ label: 'standard', cost: '0.00' }],
          cardFields: [{ field: 'number', ref: 'e1' }],
          placeOrderTarget: 'e9',
        },
      },
    ];
    for (const probe of probes) {
      const response = await readJson(await fixture.fetch(probe.path, {
        method: 'POST',
        body: JSON.stringify(probe.body),
      }));
      // Nothing was attempted: the refusal happens before any handler body, so
      // the non-existent session and page above are never looked up.
      expect(response.status, `${probe.path} answered ${String(response.status)}: ${response.text}`).toBe(501);
      expect(response.body['code']).toBe('NOT_INVOKABLE');
    }
  });
});

describe('payments.* over the live HTTP routes', () => {
  test('GET /api/payments/cards answers 200, the flip this composition exists for', async () => {
    const response = await readJson(await fixture.fetch('/api/payments/cards'));
    expect(
      response.status,
      'This route answered 501 NOT_INVOKABLE on every build before the payments handlers were '
      + 'composed. A 501 here means the composition regressed, not that the test is stale.',
    ).toBe(200);
    expect(Array.isArray(response.body['cards'])).toBe(true);
    expect(typeof response.body['defaultCardId']).toBe('string');
  });

  test('GET /api/payments/budget reports the live configuration', async () => {
    const response = await readJson(await fixture.fetch('/api/payments/budget'));
    expect(response.status).toBe(200);
    expect(response.body['enabled']).toBe(true);
    expect(response.body['currency']).toBe('USD');
    // The configured zone, not UTC: the day boundary this daemon resets on.
    expect(response.body['timezone']).toBe('America/New_York');
    // 150 dollars, in the currency's minor units, multiplied here once.
    expect(response.body['item']).toEqual({ limit: 15000, spent: 0, reserved: 0, remaining: 15000 });
    expect(response.body['overage']).toEqual({ limit: 2500, spent: 0, reserved: 0, remaining: 2500 });
    expect(response.body['reservationCount']).toBe(0);
    // Clustering is off on this fixture, so this machine is the only one there
    // is and is trivially the one that would spend.
    expect(response.body['isPaymentsLeader']).toBe(true);
  });

  test('a clustered node never claims payments leadership, because no election awarded it', async () => {
    // `isMaster` was the tempting answer and it means "this node holds at least
    // one inbound surface", which every node of a two-node cluster sharing a
    // mailbox and a Slack workspace satisfies. It would have answered true on
    // both, and the SDK's gates.ts is explicit that exactly one node may act:
    // today's spend does not replicate, so a second spender starts from a clean
    // daily budget. False everywhere is the safe direction and the honest one,
    // no payments election has been held.
    const clustered = await startDaemonFixture({
      root: makeProjectTempDir('gv-payments-clustered'),
      configure: (configManager) => {
        configManager.set('cluster.enabled', true);
      },
    });
    try {
      const response = await readJson(await clustered.fetch('/api/payments/budget'));
      expect(response.status).toBe(200);
      expect(response.body['isPaymentsLeader']).toBe(false);
    } finally {
      await clustered.stop();
    }
  });

  test('GET /api/payments/purchases answers an empty audit ledger', async () => {
    const response = await readJson(await fixture.fetch('/api/payments/purchases'));
    expect(response.status).toBe(200);
    expect(response.body['purchases']).toEqual([]);
    expect(response.body['total']).toBe(0);
  });

  test('a card round trip: create, list, delete, all over the real routes', async () => {
    const created = await readJson(await fixture.fetch('/api/payments/cards', {
      method: 'POST',
      body: JSON.stringify({
        label: 'round trip',
        kind: 'virtual',
        number: TEST_CARD_NUMBER,
        expiryMonth: 7,
        expiryYear: 2029,
        cvv: TEST_CARD_CVV,
        cardholderName: TEST_CARDHOLDER,
        issuerCapMinorUnits: 5000,
      }),
    }));
    expect(created.status).toBe(200);
    const card = created.body['card'] as Record<string, unknown>;
    expect(card['brand']).toBe('visa');
    expect(card['last4']).toBe('1111');
    expect(card['kind']).toBe('virtual');
    expect(card['issuerCapMinorUnits']).toBe(5000);
    expect(card['materialComplete']).toBe(true);
    // The response never echoes what was submitted. Checked against the raw
    // body, not against the parsed fields, so a field nobody thought to look at
    // still fails this.
    expect(created.text).not.toContain(TEST_CARD_NUMBER);
    expect(created.text).not.toContain(TEST_CARD_CVV);
    expect(created.text).not.toContain(TEST_CARDHOLDER);

    const id = String(card['id']);
    const listed = await readJson(await fixture.fetch('/api/payments/cards'));
    expect(listed.status).toBe(200);
    const cards = listed.body['cards'] as Record<string, unknown>[];
    expect(cards.map((entry) => entry['id'])).toContain(id);
    expect(listed.text).not.toContain(TEST_CARD_NUMBER);
    expect(listed.text).not.toContain(TEST_CARD_CVV);
    expect(listed.text).not.toContain(TEST_CARDHOLDER);

    const removed = await readJson(await fixture.fetch(`/api/payments/cards/${id}`, { method: 'DELETE' }));
    expect(removed.status).toBe(200);
    expect(removed.body).toEqual({ id, deleted: true, secretsCleared: 5 });

    const after = await readJson(await fixture.fetch('/api/payments/cards'));
    expect((after.body['cards'] as unknown[]).length).toBe(0);
  });

  test('a malformed card is refused by field name, with nothing submitted echoed back', async () => {
    const response = await readJson(await fixture.fetch('/api/payments/cards', {
      method: 'POST',
      body: JSON.stringify({
        label: 'bad',
        kind: 'virtual',
        number: TEST_CARD_NUMBER,
        expiryMonth: 13,
        expiryYear: 2029,
        cvv: TEST_CARD_CVV,
        cardholderName: TEST_CARDHOLDER,
      }),
    }));
    expect(response.status).toBe(400);
    expect(response.text).toContain('expiryMonth');
    expect(response.text).not.toContain(TEST_CARD_NUMBER);
    expect(response.text).not.toContain(TEST_CARD_CVV);
  });

  test('deleting a card that is not there reports it rather than pretending', async () => {
    const response = await readJson(await fixture.fetch('/api/payments/cards/card-not-here', { method: 'DELETE' }));
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ id: 'card-not-here', deleted: false, secretsCleared: 0 });
  });
});

describe('a damaged card store refuses over the wire instead of reporting the cards as gone', () => {
  test('a corrupt file answers 409 with the repair, and the cards are intact afterwards', async () => {
    const created = await readJson(await fixture.fetch('/api/payments/cards', {
      method: 'POST',
      body: JSON.stringify({
        label: 'survivor', kind: 'virtual', number: TEST_CARD_NUMBER,
        expiryMonth: 7, expiryYear: 2029, cvv: TEST_CARD_CVV, cardholderName: TEST_CARDHOLDER,
        issuerCapMinorUnits: null,
      }),
    }));
    expect(created.status).toBe(200);
    const id = String((created.body['card'] as Record<string, unknown>)['id']);

    const storePath = join(fixture.homeDirectory, '.goodvibes', 'tui', 'control-plane', 'payments-cards.json');
    const intact = readFileSync(storePath, 'utf-8');
    writeFileSync(storePath, '{"version":1,"cards":[{"id":');
    try {
      // Not 200-with-an-empty-list, which is what reading a damaged file as
      // empty produces and is a straight untruth, and not 500, which tells an
      // operator to retry something that will never work.
      const listed = await readJson(await fixture.fetch('/api/payments/cards'));
      expect(listed.status).toBe(409);
      expect(listed.body['code']).toBe('FAILED_PRECONDITION');
      expect(String(listed.body['error'])).toContain('payments-cards.json');

      // And a write is refused, which is the half that used to destroy data: a
      // create here rewrote the file with only the new card and stranded the
      // material of everything it had silently dropped.
      const attempted = await readJson(await fixture.fetch('/api/payments/cards', {
        method: 'POST',
        body: JSON.stringify({
          label: 'would strand the others', kind: 'virtual', number: '5500005555555559',
          expiryMonth: 3, expiryYear: 2031, cvv: '456', cardholderName: 'B Person',
        }),
      }));
      expect(attempted.status).toBe(409);
      expect(readFileSync(storePath, 'utf-8')).toBe('{"version":1,"cards":[{"id":');
    } finally {
      writeFileSync(storePath, intact);
    }

    // Repaired, and the card is exactly what it was, material included.
    const after = await readJson(await fixture.fetch('/api/payments/cards'));
    expect(after.status).toBe(200);
    const card = (after.body['cards'] as Record<string, unknown>[]).find((entry) => entry['id'] === id);
    expect(card).toBeTruthy();
    expect(card!['materialComplete']).toBe(true);
    await fixture.fetch(`/api/payments/cards/${id}`, { method: 'DELETE' });
  });
});

describe('the card survives the daemon that stored it', () => {
  test('a second daemon over the same home lists the card the first one wrote', async () => {
    const first = await readJson(await fixture.fetch('/api/payments/cards', {
      method: 'POST',
      body: JSON.stringify({
        label: 'persisted',
        kind: 'real',
        number: '5500005555555559',
        expiryMonth: 3,
        expiryYear: 2031,
        cvv: '456',
        cardholderName: 'A Person',
        issuerCapMinorUnits: null,
      }),
    }));
    expect(first.status).toBe(200);
    const id = String((first.body['card'] as Record<string, unknown>)['id']);

    // The whole point of the daemon holding the card: every surface closed, and
    // it is still there. A second composition over the same home reads the same
    // control-plane store and the same daemon secret tier.
    const restarted = await startDaemonFixture({ root });
    try {
      const listed = await readJson(await restarted.fetch('/api/payments/cards'));
      expect(listed.status).toBe(200);
      const cards = listed.body['cards'] as Record<string, unknown>[];
      const found = cards.find((entry) => entry['id'] === id);
      expect(found, 'the card written by the first daemon was not visible to the second').toBeTruthy();
      expect(found!['brand']).toBe('mastercard');
      expect(found!['last4']).toBe('5559');
      // Material too, not just the row: the secret tier is the daemon's, not the
      // process's, so a restart does not strand the card as unusable.
      expect(found!['materialComplete']).toBe(true);
    } finally {
      await restarted.stop();
      await fixture.fetch(`/api/payments/cards/${id}`, { method: 'DELETE' });
    }
  });
});
