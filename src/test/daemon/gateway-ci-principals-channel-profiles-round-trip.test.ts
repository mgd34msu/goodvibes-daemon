/**
 * ci.*, principals.* and channels.profiles.*, end to end, over this daemon's
 * own composition.
 *
 * Ported from
 * goodvibes-agent/src/test/daemon/ci-principals-channel-profiles-gateway.test.ts,
 * which drove a catalog a test helper rebuilt because that package serves no
 * gateway verb. The contract is the platform's; the owner is this process.
 *
 * The SDK registers these three groups unconditionally (unlike checkin.*, which
 * needs four optional deps), so what is proved here is that the stores behind
 * them are real and round-trip — a write is visible to the next read, and a
 * delete removes it — rather than that a descriptor exists.
 *
 * ci.status and ci.watches.run shell out to the `gh` CLI (createGhCliCiSource in
 * the SDK's ci-watch/gh-source.ts) to read real GitHub check-run data, which
 * this sandbox cannot depend on being authenticated or network-reachable. Those
 * two are asserted at the "a real handler answered, not the gateway's own
 * wiring refusal" level only.
 */
import { describe, expect, test } from 'bun:test';
import { getTestRuntimeServices, disposeTestRuntimeServicesAfterAll } from '../helpers/runtime-services.ts';

disposeTestRuntimeServicesAfterAll();

interface Principal {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly identities: readonly { readonly channel: string; readonly value: string }[];
}

interface ChannelProfileBinding {
  readonly id: string;
  readonly surfaceKind: string;
  readonly channelId?: string;
  readonly model?: string;
}

interface CiWatch {
  readonly id: string;
  readonly repo: string;
  readonly deliveryChannel: string;
}

async function invoke<T>(methodId: string, body: Record<string, unknown> = {}): Promise<T> {
  const services = getTestRuntimeServices();
  return services.gatewayMethods.invoke(methodId, { methodId, body } as never) as Promise<T>;
}

describe('ci / principals / channels.profiles on the composed daemon (live, not a 501 facade)', () => {
  test('descriptors are registered with real handlers, not just 501 facades', () => {
    const services = getTestRuntimeServices();
    for (const methodId of [
      'ci.status',
      'ci.watches.create',
      'ci.watches.list',
      'ci.watches.delete',
      'ci.watches.run',
      'principals.list',
      'principals.get',
      'principals.create',
      'principals.update',
      'principals.delete',
      'principals.resolve',
      'channels.profiles.list',
      'channels.profiles.get',
      'channels.profiles.set',
      'channels.profiles.delete',
    ]) {
      expect(services.gatewayMethods.get(methodId), `${methodId} descriptor missing from the catalog`).toBeTruthy();
      expect(services.gatewayMethods.hasHandler(methodId), `${methodId} has no handler`).toBe(true);
    }
  });

  test('principals.create then list/resolve round-trip for real', async () => {
    const { principal } = await invoke<{ principal: Principal }>('principals.create', {
      name: 'Mike Davis',
      kind: 'user',
      identities: [{ channel: 'slack', value: 'U-gateway-test' }],
    });
    expect(principal.id).toBeTruthy();
    expect(principal.name).toBe('Mike Davis');

    const { principals } = await invoke<{ principals: Principal[] }>('principals.list');
    expect(principals.some((entry) => entry.id === principal.id)).toBe(true);

    const known = await invoke<{ principal: Principal; known: boolean }>('principals.resolve', {
      channel: 'slack',
      value: 'U-gateway-test',
    });
    expect(known.known).toBe(true);
    expect(known.principal.id).toBe(principal.id);

    const unknown = await invoke<{ known: boolean }>('principals.resolve', {
      channel: 'slack',
      value: 'U-never-registered',
    });
    expect(unknown.known).toBe(false);

    const deleted = await invoke<{ deleted: boolean }>('principals.delete', { principalId: principal.id });
    expect(deleted.deleted).toBe(true);
  });

  test('channels.profiles.set then get/list round-trip for real', async () => {
    const { binding } = await invoke<{ binding: ChannelProfileBinding }>('channels.profiles.set', {
      surfaceKind: 'slack',
      model: 'openai:gpt-5.4',
      permissionMode: 'plan',
    });
    expect(binding.surfaceKind).toBe('slack');
    expect(binding.model).toBe('openai:gpt-5.4');

    const got = await invoke<{ binding: ChannelProfileBinding }>('channels.profiles.get', { surfaceKind: 'slack' });
    expect(got.binding.id).toBe(binding.id);

    const { bindings } = await invoke<{ bindings: ChannelProfileBinding[] }>('channels.profiles.list');
    expect(bindings.some((entry) => entry.id === binding.id)).toBe(true);

    const deleted = await invoke<{ deleted: boolean }>('channels.profiles.delete', { surfaceKind: 'slack' });
    expect(deleted.deleted).toBe(true);
  });

  test('ci.watches.create then list/delete round-trip for real (no gh CLI dependency)', async () => {
    const { watch } = await invoke<{ watch: CiWatch }>('ci.watches.create', {
      repo: 'my-org/my-repo',
      ref: 'main',
      deliveryChannel: 'slack:C123',
    });
    expect(watch.repo).toBe('my-org/my-repo');
    expect(watch.deliveryChannel).toBe('slack:C123');

    const { watches } = await invoke<{ watches: CiWatch[] }>('ci.watches.list');
    expect(watches.some((entry) => entry.id === watch.id)).toBe(true);

    const deleted = await invoke<{ deleted: boolean }>('ci.watches.delete', { watchId: watch.id });
    expect(deleted.deleted).toBe(true);
  });

  test('ci.status has a real handler attached (not a 501 wiring gap) even though this sandbox does not assert on gh CLI output', async () => {
    // A real handler surfaces a gh-CLI or domain error (bad repo, no auth, no
    // network) rather than the gateway's own "Gateway method is not invokable"
    // refusal. Whether gh succeeds, fails on lookup, or is missing here, it must
    // never be the wiring message.
    let wiringGapMessage: string | null = null;
    try {
      await invoke('ci.status', {
        repo: 'definitely-not-a-real-org/definitely-not-a-real-repo-goodvibes-daemon-test',
        ref: 'main',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/gateway method is not invokable/i.test(message)) wiringGapMessage = message;
    }
    expect(wiringGapMessage).toBeNull();
    // This drives the real `gh` CLI against a repository that does not exist, so
    // it costs a subprocess spawn and a network round trip before it can fail.
    // Whether that fits the default per-test budget depends on the host and the
    // network, not on the wiring this asserts — and a timeout here once reported
    // a 501 wiring gap that was not there. The budget is a hang detector; the
    // test returns as soon as gh answers.
  }, 60_000);
});
