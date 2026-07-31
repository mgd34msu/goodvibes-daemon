/**
 * Gate: the composed daemon's unified-rewind verbs (rewind.plan / rewind.apply)
 * serve CONVERSATION scope live in this process — not just files.
 *
 * The SDK's registerGatewayVerbGroups constructs the UnifiedRewindService with
 * `conversation: deps.conversationRewindPort ?? null`; absent that port,
 * conversation rewind is honestly reported unavailable on the wire. The TUI's
 * composition root (runtime/services.ts) now threads a conversationRewindPort
 * that resolves each anchor's live RewindableConversation from the per-session
 * registry the TUI populates at bootstrap (conversation-rewind-port.ts).
 *
 * This test pins that wiring the same way gateway-initiative-verbs.test.ts pins
 * the initiative families: compose the real vendored runtime, register a live
 * conversation + turn boundary for a session, then invoke rewind.plan over the
 * composed catalog and assert the conversation half comes back AVAILABLE with
 * the truncation counts — proving the port is threaded, not a 501/absent facade.
 *
 * It now also pins the two cases that used to be indistinguishable from each
 * other and from success. A session this daemon holds no conversation for is
 * reported UNAVAILABLE with the reason rather than as "0 messages to drop",
 * which is the answer a conversation already at the anchor gives. And a surface
 * running the loop in another process offers its conversation over the control
 * plane (rewind.conversation.*), which the composed catalog serves — the path
 * every client surface actually takes now that the loops left this process.
 */
import { describe, expect, test, afterAll } from 'bun:test';
import { getTestRuntimeServices, disposeTestRuntimeServicesAfterAll } from '../helpers/runtime-services.ts';
import { recordTurnAnchor, clearTurnAnchors } from '@pellux/goodvibes-sdk/platform/rewind';
import {
  registerSessionConversation,
  unregisterSessionConversation,
} from '../../runtime/conversation-rewind-port.ts';
import type { RewindableConversation } from '../../runtime/conversation-rewind-port.ts';

// Stop the shared test runtime graph when this file ends. Called here, not
// registered inside the helper, for the reason its doc comment gives.
disposeTestRuntimeServicesAfterAll();

const SESSION = 's-daemon-rewind';

/** Minimal conversation the port needs: message count + snapshot/truncate. */
function makeFakeConversation(count: number): RewindableConversation {
  let messages = Array.from({ length: count }, (_, i) => ({ role: 'user', content: `m${i}` }));
  return {
    getMessageCount: () => messages.length,
    toJSON: () => ({ messages: messages.map((m) => ({ ...m })) }),
    fromJSON: (data: { messages: unknown[] }) => { messages = data.messages.map((m) => ({ ...(m as object) })) as typeof messages; },
    removeMessagesAfter: (n: number) => { messages = messages.slice(0, n); },
    rebuildHistory: () => {},
  } as unknown as RewindableConversation;
}

interface RewindPlanResult {
  readonly conversation: { readonly available: boolean; readonly messagesToDrop: number; readonly messagesRemaining: number } | null;
  readonly token: string;
  readonly warnings: readonly string[];
}

afterAll(() => {
  clearTurnAnchors(SESSION);
  unregisterSessionConversation(SESSION);
});

describe('composed daemon serves conversation-scope rewind live', () => {
  const services = getTestRuntimeServices();

  test('rewind.plan + rewind.apply descriptors are registered in the composed catalog', () => {
    expect(services.gatewayMethods.get('rewind.plan')).toBeTruthy();
    expect(services.gatewayMethods.get('rewind.apply')).toBeTruthy();
  });

  test('rewind.plan conversation scope resolves the live session conversation (available, real counts)', async () => {
    registerSessionConversation(SESSION, makeFakeConversation(5)); // 5 messages now
    recordTurnAnchor(SESSION, { turnId: 't-daemon-1', label: 'do the thing', messageCount: 3, at: Date.now() }); // boundary keeps 3

    const plan = (await services.gatewayMethods.invoke('rewind.plan', {
      methodId: 'rewind.plan',
      body: { sessionId: SESSION, turnId: 't-daemon-1', scope: 'conversation' },
    } as never)) as RewindPlanResult;

    expect(plan.conversation).toBeTruthy();
    expect(plan.conversation?.available).toBe(true); // the port is threaded — not the absent-store default
    expect(plan.conversation?.messagesToDrop).toBe(2);
    expect(plan.conversation?.messagesRemaining).toBe(3);
    expect(typeof plan.token).toBe('string');
  });

  test('rewind.apply conversation scope truncates the live conversation via the daemon verb', async () => {
    const conv = makeFakeConversation(5);
    registerSessionConversation(SESSION, conv);
    recordTurnAnchor(SESSION, { turnId: 't-daemon-2', label: 'apply', messageCount: 2, at: Date.now() });

    const applied = (await services.gatewayMethods.invoke('rewind.apply', {
      methodId: 'rewind.apply',
      body: { sessionId: SESSION, turnId: 't-daemon-2', scope: 'conversation', confirm: true },
    } as never)) as { receipt: { conversation: { rewound: boolean; droppedMessages: number } | null } | null; refused: boolean };

    expect(applied.refused).toBe(false);
    expect(applied.receipt?.conversation?.rewound).toBe(true);
    expect(applied.receipt?.conversation?.droppedMessages).toBe(3);
    expect(conv.getMessageCount()).toBe(2); // the live conversation was actually truncated
  });
});

describe('a session nobody is hosting is reported unavailable, not as zero', () => {
  const services = getTestRuntimeServices();

  test('rewind.plan says why it cannot answer instead of reporting a count', async () => {
    const plan = (await services.gatewayMethods.invoke('rewind.plan', {
      methodId: 'rewind.plan',
      body: { sessionId: 's-nobody-is-hosting-this', scope: 'conversation' },
    } as never)) as RewindPlanResult;

    expect(plan.conversation?.available).toBe(false);
    expect(plan.conversation?.messagesToDrop).toBe(0);
    // The warning is the whole point: "nobody here holds those messages" and
    // "there is nothing to drop" are different facts, and a caller acting on
    // the wrong one rewinds nothing and believes it worked.
    //
    // The words are this daemon's own: no surface offered this session, so the
    // broker fell through to the in-process port, which says why IT cannot
    // answer rather than letting the generic no-host message stand in for it.
    expect(plan.warnings.join(' ')).toContain('holds no live conversation for that session');
  });

  test('rewind.apply does not claim a truncation it could not have performed', async () => {
    const applied = (await services.gatewayMethods.invoke('rewind.apply', {
      methodId: 'rewind.apply',
      body: { sessionId: 's-nobody-is-hosting-this', scope: 'conversation', confirm: true },
    } as never)) as {
      receipt: { conversation: { rewound: boolean } | null; warnings: readonly string[] } | null;
      refused: boolean;
    };

    expect(applied.refused).toBe(false);
    expect(applied.receipt?.conversation?.rewound).toBe(false);
    expect(applied.receipt?.warnings.join(' ')).toContain('conversation rewind skipped');
  });
});

describe('a surface in another process serves its own conversation over the control plane', () => {
  const services = getTestRuntimeServices();
  const WIRE_SESSION = 's-client-hosted';

  test('the host verbs are registered and handled on the composed catalog', () => {
    for (const id of [
      'rewind.conversation.host.register',
      'rewind.conversation.host.release',
      'rewind.conversation.hosts.list',
      'rewind.conversation.requests.take',
      'rewind.conversation.requests.answer',
    ]) {
      expect(services.gatewayMethods.get(id), `${id} is not cataloged`).toBeTruthy();
      expect(services.gatewayMethods.hasHandler(id), `${id} has no handler`).toBe(true);
    }
  });

  test('an offered conversation answers the plan with the surface\'s own counts', async () => {
    const registered = (await services.gatewayMethods.invoke('rewind.conversation.host.register', {
      methodId: 'rewind.conversation.host.register',
      body: { sessionId: WIRE_SESSION, label: 'a client surface' },
    } as never)) as { host: { hostId: string } };
    const hostId = registered.host.hostId;

    // The daemon asks; the surface answers. Both halves run here because there
    // is no second process in a test, but the path is the wire path: the
    // question comes back out of take, and the answer goes in through answer.
    const planned = services.gatewayMethods.invoke('rewind.plan', {
      methodId: 'rewind.plan',
      body: { sessionId: WIRE_SESSION, scope: 'conversation' },
    } as never) as Promise<RewindPlanResult>;

    let requestId = '';
    for (let attempt = 0; attempt < 200 && !requestId; attempt += 1) {
      const taken = (await services.gatewayMethods.invoke('rewind.conversation.requests.take', {
        methodId: 'rewind.conversation.requests.take',
        body: { hostId, waitMs: 50 },
      } as never)) as { requests: readonly { requestId: string; kind: string }[] };
      requestId = taken.requests[0]?.requestId ?? '';
    }
    expect(requestId).not.toBe('');

    await services.gatewayMethods.invoke('rewind.conversation.requests.answer', {
      methodId: 'rewind.conversation.requests.answer',
      body: { hostId, requestId, messagesToDrop: 4, messagesRemaining: 9 },
    } as never);

    const plan = await planned;
    expect(plan.conversation?.available).toBe(true);
    expect(plan.conversation?.messagesToDrop).toBe(4);
    expect(plan.conversation?.messagesRemaining).toBe(9);

    await services.gatewayMethods.invoke('rewind.conversation.host.release', {
      methodId: 'rewind.conversation.host.release',
      body: { sessionId: WIRE_SESSION, hostId },
    } as never);
  });
});
