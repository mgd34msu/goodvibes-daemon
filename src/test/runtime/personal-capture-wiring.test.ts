import { describe, expect, test } from 'bun:test';
import { CONVERSATIONAL_TURN_TOOLS, conversationalTurnSpawnOptions } from '@pellux/goodvibes-sdk/platform/personal-capture';

/**
 * What an agent answering a channel message is given.
 *
 * The reported failure: the owner pasted a full flight itinerary into a chat,
 * got a warm reply, and nothing was stored anywhere. The continuation runner
 * spawned the answering agent with `restrictTools: true` and no `tools` list;
 * `deriveEffectiveTools` reads that as "only the tools named" and none were
 * named, so the run got an EMPTY tool registry. The runner now spreads
 * `conversationalTurnSpawnOptions` into that spawn; these cases hold the
 * options it spreads to what the fix needs.
 */

describe('the spawn options a conversational turn is built from', () => {
  const built = conversationalTurnSpawnOptions(
    { sessionId: 'session-1', surfaceKind: 'telegram', surfaceId: 'owner-chat' },
    { configReader: { get: () => '' } },
  );

  test('the tool list is not empty, which is the exact failure being closed', () => {
    // An empty list alongside restrictTools is what handed the run a registry
    // with nothing in it.
    expect(built.tools.length).toBeGreaterThan(0);
    expect(built.restrictTools).toBe(true);
  });

  test('the tool list contains profile, the tool that records what the owner said', () => {
    expect(built.tools).toContain('profile');
    expect(CONVERSATIONAL_TURN_TOOLS).toContain('profile');
  });

  test('the context tells the agent to record rather than offer to record', () => {
    expect(built.context).toContain('session-1');
    expect(built.context.length).toBeGreaterThan('shared-session:session-1'.length);
  });

  test('no tool that could start a workstream or edit the project tree is granted', () => {
    // A conversational turn answers and records. It does not write files, edit
    // them, or run commands.
    for (const forbidden of ['write', 'edit', 'exec']) {
      expect(built.tools).not.toContain(forbidden);
    }
  });
});
