/**
 * The provider-inbound aggregator, over the real inbox composition.
 *
 * `channels.inbox.list` spent a release cataloged with `invokable: false`
 * because no client could reach it — the SDK descriptor said "cataloged, not
 * callable" and the handler this repo already had sat behind that flag. The flag
 * is off now, so what a client actually GETS is what needs pinning, and the
 * properties below are the ones a caller would be misled by if they broke:
 *
 *   - Items from several providers merge into ONE timeline, newest first, each
 *     carrying its own provider so the merge does not cost attribution.
 *   - Paging walks the whole feed with no duplicate and no skipped item, using
 *     the opaque nextCursor rather than an offset.
 *   - A provider whose sync FAILED contributes nothing and SAYS SO, and the
 *     answer is flagged partial. The alternative — a short list with no
 *     explanation — is indistinguishable from a quiet week.
 *   - A daemon with nothing configured answers an EMPTY LIST, not an error, and
 *     names each unconfigured provider. The verb is callable in every state; a
 *     fresh install asking "what's in my inbox" gets "nothing yet, and here is
 *     what you have not set up", which is an answer.
 *
 * Everything here drives the composed catalog through `catalog.invoke`, the
 * same call the WebSocket frame and the REST path both land on.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { GatewayMethodCatalog } from '@pellux/goodvibes-sdk/platform/control-plane';
import type { HandlerContext } from '../../../daemon/handlers/context.ts';
import type { DaemonCredentialStore } from '../../../daemon/handlers/credentials.ts';
import {
  INBOX_LIST_METHOD_ID,
  registerInboxMethods,
  type ChannelInboxProviderStatus,
  type InboxListOutput,
} from '../../../daemon/handlers/inbox/index.ts';
import {
  clearAdapterRegistry,
  registerAdapterFactory,
  type InboundChannelItem,
  type ProviderPollResult,
} from '../../../daemon/handlers/inbox/provider-adapter.ts';
import { makeProjectTempDir } from '../../helpers/project-temp.ts';

const logger = { info() {}, warn() {}, error() {} };

function fakeCredentials(): DaemonCredentialStore {
  return {
    async resolveRef() { return null; },
    async resolveConfigSecret() { return null; },
    async put() {},
    async has() { return false; },
  };
}

function mkItem(provider: string, id: string, receivedAt: number): InboundChannelItem {
  return {
    id,
    provider,
    kind: 'dm',
    fromDigest: `${provider.padEnd(8, '0').slice(0, 8)}deadbeef`,
    subjectPreview: `${provider} subject`,
    bodyPreview: `${provider} body`,
    receivedAt,
    unread: true,
  };
}

/** A provider that syncs successfully and hands over the given items. */
function healthyProvider(id: string, items: readonly InboundChannelItem[]): void {
  registerAdapterFactory(id, () => ({
    id,
    pollIntervalMs: 30_000,
    poll: (): Promise<ProviderPollResult> =>
      Promise.resolve({ state: 'ready', items: [...items], configured: true }),
  }));
}

/** A provider that is wired up and whose sync failed — items exist, we cannot see them. */
function failingProvider(id: string, error: string): void {
  registerAdapterFactory(id, () => ({
    id,
    pollIntervalMs: 30_000,
    poll: (): Promise<ProviderPollResult> =>
      Promise.resolve({ state: 'unavailable', items: [], error, configured: true }),
  }));
}

/** A provider nobody has given a credential to. */
function unconfiguredProvider(id: string, missing: string): void {
  registerAdapterFactory(id, () => ({
    id,
    pollIntervalMs: 30_000,
    poll: (): Promise<ProviderPollResult> =>
      Promise.resolve({ state: 'unavailable', items: [], error: `missing ${missing}`, configured: false }),
  }));
}

let dir: string;
let catalog: GatewayMethodCatalog;
let ctx: HandlerContext;

beforeEach(async () => {
  clearAdapterRegistry();
  dir = await makeProjectTempDir('inbox-aggregator');
  catalog = new GatewayMethodCatalog();
  ctx = {
    catalog,
    credentials: fakeCredentials(),
    configManager: {
      get: ((_key: string) => undefined) as unknown as HandlerContext['configManager']['get'],
      getCategory: ((_category: string) => ({})) as unknown as HandlerContext['configManager']['getCategory'],
    },
    workingDirectory: dir,
    homeDirectory: dir,
    logger,
  };
});

afterEach(async () => {
  clearAdapterRegistry();
  await rm(dir, { recursive: true, force: true });
});

/** Invoke exactly as the methodId transport does: a body, no query. */
async function invoke(body: Record<string, unknown> = {}): Promise<InboxListOutput> {
  return (await catalog.invoke(INBOX_LIST_METHOD_ID, {
    body,
    query: {},
    context: { authToken: 'fake-auth', scopes: ['read:channels'] },
  })) as InboxListOutput;
}

/** Invoke as the plain-REST GET does: params as query STRINGS, no body. */
async function invokeViaQuery(query: Record<string, string>): Promise<InboxListOutput> {
  return (await catalog.invoke(INBOX_LIST_METHOD_ID, {
    body: undefined,
    query,
    context: { authToken: 'fake-auth', scopes: ['read:channels'] },
  })) as InboxListOutput;
}

function statusFor(out: InboxListOutput, provider: string): ChannelInboxProviderStatus {
  const found = out.providers.find((entry) => entry.provider === provider);
  if (!found) throw new Error(`no status reported for ${provider}; reported: ${out.providers.map((p) => p.provider).join(', ')}`);
  return found;
}

// ── configured providers merge into one attributed timeline ────────────────

describe('several configured providers', () => {
  test('merge into one newest-first timeline, each item keeping its provider', async () => {
    healthyProvider('slack', [
      mkItem('slack', 'slack:1', 3_000),
      mkItem('slack', 'slack:2', 1_000),
    ]);
    healthyProvider('email', [
      mkItem('email', 'email:1', 4_000),
      mkItem('email', 'email:2', 2_000),
    ]);
    const unregister = registerInboxMethods(ctx, undefined, { registerBuiltins: false });
    try {
      const out = await invoke();

      // Interleaved by arrival, not grouped by provider: an inbox is a timeline.
      expect(out.items.map((item) => item.id)).toEqual(['email:1', 'slack:1', 'email:2', 'slack:2']);
      expect(out.items.map((item) => item.provider)).toEqual(['email', 'slack', 'email', 'slack']);
      expect(out.total).toBe(4);
      expect(out.hasMore).toBe(false);
      expect(out.truncated).toBe(out.hasMore);
      expect(out.nextCursor).toBeUndefined();
      expect(out.partial).toBe(false);

      // Both providers report, with the mirror's counts rather than the last
      // poll's, and neither claims an error.
      expect(statusFor(out, 'slack')).toMatchObject({ state: 'ready', storedCount: 2, itemCount: 2, configured: true });
      expect(statusFor(out, 'email')).toMatchObject({ state: 'ready', storedCount: 2, itemCount: 2, configured: true });
      for (const status of out.providers) expect(status.error).toBeUndefined();
    } finally {
      unregister();
    }
  });

  test('pagination walks the whole feed once — no duplicate, no gap', async () => {
    healthyProvider('slack', [1, 3, 5, 7, 9].map((n) => mkItem('slack', `slack:${n}`, n * 100)));
    healthyProvider('email', [2, 4, 6, 8].map((n) => mkItem('email', `email:${n}`, n * 100)));
    const unregister = registerInboxMethods(ctx, undefined, { registerBuiltins: false });
    try {
      const walked: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page: InboxListOutput = await invoke({ limit: 2, ...(cursor ? { cursor } : {}) });
        expect(page.items.length).toBeLessThanOrEqual(2);
        walked.push(...page.items.map((item) => item.id));
        cursor = page.nextCursor;
        // Every page reports the same total: it counts the feed, not the page.
        expect(page.total).toBe(9);
        pages += 1;
        expect(pages).toBeLessThan(10); // a cursor that never terminates is a defect
      } while (cursor !== undefined);

      expect(walked).toHaveLength(9);
      expect(new Set(walked).size).toBe(9);
      // And in the feed's order, so paging did not reshuffle anything.
      expect(walked).toEqual([
        'slack:9', 'email:8', 'slack:7', 'email:6', 'slack:5', 'email:4', 'slack:3', 'email:2', 'slack:1',
      ]);
    } finally {
      unregister();
    }
  });

  test('items sharing a timestamp are not lost at a page boundary', async () => {
    // Three items at the same receivedAt, paged two at a time. A cursor keyed
    // on the timestamp alone would skip the tie it landed inside.
    healthyProvider('slack', [
      mkItem('slack', 'slack:a', 500),
      mkItem('slack', 'slack:b', 500),
      mkItem('slack', 'slack:c', 500),
    ]);
    const unregister = registerInboxMethods(ctx, undefined, { registerBuiltins: false });
    try {
      const first = await invoke({ limit: 2 });
      expect(first.items.map((item) => item.id)).toEqual(['slack:a', 'slack:b']);
      expect(first.hasMore).toBe(true);
      const second = await invoke({ limit: 2, cursor: first.nextCursor });
      expect(second.items.map((item) => item.id)).toEqual(['slack:c']);
      expect(second.hasMore).toBe(false);
    } finally {
      unregister();
    }
  });

  test('the freshness watermark and the page cursor are different values, and both work', async () => {
    healthyProvider('slack', [
      mkItem('slack', 'slack:1', 1_000),
      mkItem('slack', 'slack:2', 2_000),
    ]);
    const unregister = registerInboxMethods(ctx, undefined, { registerBuiltins: false });
    try {
      const out = await invoke({ limit: 1 });
      // `cursor` is the newest arrival across the filtered feed...
      expect(out.cursor).toBe('2000');
      // ...and `nextCursor` is a position, so they are not interchangeable.
      expect(out.nextCursor).toBeDefined();
      expect(out.nextCursor).not.toBe(out.cursor);

      // Fed back as `since`, the watermark asks only for what is newer.
      const nothingNewer = await invoke({ since: Number(out.cursor) });
      expect(nothingNewer.items).toHaveLength(0);
      expect(nothingNewer.total).toBe(0);
      const fromTheStart = await invoke({ since: 0 });
      expect(fromTheStart.items).toHaveLength(2);
    } finally {
      unregister();
    }
  });

  test('a filter narrows the items, the total AND the reported statuses together', async () => {
    healthyProvider('slack', [mkItem('slack', 'slack:1', 100)]);
    healthyProvider('email', [mkItem('email', 'email:1', 200), mkItem('email', 'email:2', 300)]);
    const unregister = registerInboxMethods(ctx, undefined, { registerBuiltins: false });
    try {
      const out = await invoke({ provider: 'email' });
      expect(out.items.map((item) => item.id)).toEqual(['email:2', 'email:1']);
      expect(out.total).toBe(2);
      // Only the asked-about provider reports — a status list that still
      // included slack would be describing rows the answer excluded.
      expect(out.providers.map((entry) => entry.provider)).toEqual(['email']);
    } finally {
      unregister();
    }
  });

  test('a provider filter naming something this daemon has no adapter for says so', async () => {
    healthyProvider('slack', [mkItem('slack', 'slack:1', 100)]);
    const unregister = registerInboxMethods(ctx, undefined, { registerBuiltins: false });
    try {
      const out = await invoke({ provider: 'telegram' });
      expect(out.items).toHaveLength(0);
      // Not a bare empty list: an unreported provider would read as "nothing
      // there" when the truth is "nothing here reads that".
      expect(statusFor(out, 'telegram')).toMatchObject({
        state: 'unconfigured',
        configured: false,
        itemCount: 0,
        storedCount: 0,
      });
      expect(out.partial).toBe(false);
    } finally {
      unregister();
    }
  });
});

// ── query-string params, because the advertised path is a GET ──────────────

describe('the REST path\'s query strings', () => {
  test('limit / provider / cursor arriving as strings are honored, not ignored', async () => {
    healthyProvider('slack', [
      mkItem('slack', 'slack:1', 100),
      mkItem('slack', 'slack:2', 200),
      mkItem('slack', 'slack:3', 300),
    ]);
    healthyProvider('email', [mkItem('email', 'email:1', 400)]);
    const unregister = registerInboxMethods(ctx, undefined, { registerBuiltins: false });
    try {
      const first = await invokeViaQuery({ provider: 'slack', limit: '2' });
      expect(first.items.map((item) => item.id)).toEqual(['slack:3', 'slack:2']);
      expect(first.total).toBe(3);
      expect(first.hasMore).toBe(true);

      const second = await invokeViaQuery({ provider: 'slack', limit: '2', cursor: first.nextCursor! });
      expect(second.items.map((item) => item.id)).toEqual(['slack:1']);
      expect(second.hasMore).toBe(false);
    } finally {
      unregister();
    }
  });

  test('a cursor this method never issued is refused, naming the field', async () => {
    healthyProvider('slack', [mkItem('slack', 'slack:1', 100)]);
    const unregister = registerInboxMethods(ctx, undefined, { registerBuiltins: false });
    try {
      let caught: unknown;
      try {
        await invokeViaQuery({ cursor: 'not-a-cursor-this-issued' });
      } catch (error) {
        caught = error;
      }
      // Refused rather than silently restarting from the top: a paging caller
      // handed page one forever would look like data loss further down.
      const refusal = caught as { code?: string; status?: number; message?: string };
      expect(refusal.code).toBe('INVALID_ARGUMENT');
      expect(refusal.status).toBe(400);
      expect(refusal.message).toContain('cursor');
    } finally {
      unregister();
    }
  });

  test('an absurd limit is clamped rather than refused', async () => {
    healthyProvider('slack', [mkItem('slack', 'slack:1', 100)]);
    const unregister = registerInboxMethods(ctx, undefined, { registerBuiltins: false });
    try {
      expect((await invokeViaQuery({ limit: '100000' })).items).toHaveLength(1);
      expect((await invokeViaQuery({ limit: '0' })).items).toHaveLength(1);
      expect((await invokeViaQuery({ limit: 'banana' })).items).toHaveLength(1);
    } finally {
      unregister();
    }
  });
});

// ── one provider down: partial, and honest about it ────────────────────────

describe('a provider whose sync failed', () => {
  test('contributes no items, reports the failure, and flags the answer partial', async () => {
    healthyProvider('slack', [mkItem('slack', 'slack:1', 100), mkItem('slack', 'slack:2', 200)]);
    failingProvider('email', 'IMAP LOGIN refused: AUTHENTICATIONFAILED');
    const unregister = registerInboxMethods(ctx, undefined, { registerBuiltins: false });
    try {
      const out = await invoke();

      // The healthy provider still answers — one bad provider does not take the
      // feed down with it.
      expect(out.items.map((item) => item.id)).toEqual(['slack:2', 'slack:1']);
      expect(out.items.some((item) => item.provider === 'email')).toBe(false);

      const email = statusFor(out, 'email');
      expect(email.state).toBe('error');
      expect(email.error).toBe('IMAP LOGIN refused: AUTHENTICATIONFAILED');
      expect(email.configured).toBe(true);
      expect(email.itemCount).toBe(0);
      expect(typeof email.lastSyncAt).toBe('number');

      // The hole is named at the top level too, so a caller does not have to
      // scan the status list to learn the list is short.
      expect(out.partial).toBe(true);
      expect(statusFor(out, 'slack').state).toBe('ready');
    } finally {
      unregister();
    }
  });

  test('a provider that THREW is reported the same way, not as unconfigured', async () => {
    healthyProvider('slack', [mkItem('slack', 'slack:1', 100)]);
    registerAdapterFactory('discord', () => ({
      id: 'discord',
      pollIntervalMs: 30_000,
      poll: () => Promise.reject(new Error('socket hang up')),
    }));
    const unregister = registerInboxMethods(ctx, undefined, { registerBuiltins: false });
    try {
      const out = await invoke();
      const discord = statusFor(out, 'discord');
      // It got far enough to run, so the credentials are not what failed.
      expect(discord.state).toBe('error');
      expect(discord.error).toContain('socket hang up');
      expect(out.partial).toBe(true);
      expect(out.items).toHaveLength(1);
    } finally {
      unregister();
    }
  });
});

// ── nothing configured is an answer, not a failure ─────────────────────────

describe('a daemon with nothing configured', () => {
  test('answers an empty list with an unconfigured status per provider — not an error', async () => {
    unconfiguredProvider('slack', 'surfaces.slack.botToken');
    unconfiguredProvider('discord', 'surfaces.discord.botToken');
    unconfiguredProvider('email', 'email IMAP credentials');
    const unregister = registerInboxMethods(ctx, undefined, { registerBuiltins: false });
    try {
      const out = await invoke();

      expect(out.items).toEqual([]);
      expect(out.total).toBe(0);
      expect(out.hasMore).toBe(false);
      // Nothing is MISSING from a provider nobody wired up, so this is not a
      // partial answer — it is a complete answer about an empty inbox.
      expect(out.partial).toBe(false);

      expect(out.providers.map((entry) => entry.provider).sort()).toEqual(['discord', 'email', 'slack']);
      for (const status of out.providers) {
        expect(status.state).toBe('unconfigured');
        expect(status.configured).toBe(false);
        expect(status.storedCount).toBe(0);
        // The "missing credential" text is not surfaced as an error: it is not
        // a fault, and rendering it as one sends someone to fix a working box.
        expect(status.error).toBeUndefined();
      }
    } finally {
      unregister();
    }
  });

  test('the verb is callable with no providers registered at all', async () => {
    const unregister = registerInboxMethods(ctx, undefined, { registerBuiltins: false });
    try {
      const out = await invoke();
      expect(out.items).toEqual([]);
      expect(out.providers).toEqual([]);
      expect(out.total).toBe(0);
      expect(out.partial).toBe(false);
      // Availability does not depend on configuration: the answer is "nothing",
      // which is what a caller asked for.
      expect(catalog.hasHandler(INBOX_LIST_METHOD_ID)).toBe(true);
    } finally {
      unregister();
    }
  });
});

// ── a standby node has not looked, and says so ─────────────────────────────

describe('a node that is not the elected fetcher', () => {
  test('reports its providers as pending rather than as empty', async () => {
    healthyProvider('slack', [mkItem('slack', 'slack:1', 100)]);
    // gatePolling hands fetching to the cluster and starts nothing here, which
    // is the standby's real state.
    const unregister = registerInboxMethods(ctx, undefined, {
      registerBuiltins: false,
      gatePolling: () => {},
    });
    try {
      const out = await invoke();
      const slack = statusFor(out, 'slack');
      // "We have not looked" and "there is nothing" are different claims, and
      // only one of them is true here.
      expect(slack.state).toBe('pending');
      expect(slack.syncing).toBe(false);
      expect(slack.lastSyncAt).toBeUndefined();
      // The READ still serves — a standby answers about what has arrived.
      expect(out.items).toEqual([]);
    } finally {
      unregister();
    }
  });
});
