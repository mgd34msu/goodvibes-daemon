import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONVERSATIONAL_TURN_TOOLS, conversationalTurnSpawnOptions } from '@pellux/goodvibes-sdk/platform/personal-capture';

/**
 * Composition guard for what an agent answering a channel message is given.
 *
 * The reported failure: the owner pasted a full flight itinerary into a chat,
 * got a warm reply, and nothing was stored anywhere. The cause was in this
 * file's continuation runner. It spawned the answering agent with
 * `restrictTools: true` and no `tools` list; `deriveEffectiveTools` reads that
 * as "only the tools named" and none were named, so the run got an EMPTY tool
 * registry. The agent could emit text and do nothing else. There was also no
 * capture tool to call and no instruction saying that recording what the owner
 * said is part of answering him.
 *
 * So three things have to stay true at the composition root, and each of them
 * is a separate way to put the defect back:
 *
 *   1. The spawn carries `conversationalTurnSpawnOptions`, which names the
 *      tools, supplies the instruction, and carries the write authority.
 *   2. It is spread BEFORE the routing builder, so a routing intent that
 *      explicitly named tools still wins. That builder emits a `tools` key only
 *      when it actually has one, so this ordering is the whole mechanism.
 *   3. The bare `context: shared-session:<id>` line is gone. Left in place
 *      after the spread it would overwrite the instruction with a bare label,
 *      and the agent would once again not know it is supposed to record
 *      anything — a silent regression with a passing tool list.
 *
 * Plus the two ends of the capture port: the gateway verb groups fill it, and
 * the agent orchestrator reads it when it builds a run's tool registry. Miss
 * the first and `profile` writes nowhere; miss the second and `profile` is
 * never registered at all.
 */

const ROOT = join(import.meta.dir, '..', '..', '..');

/** Extract the balanced-brace object literal that opens immediately after `marker`. */
function objectLiteralAfter(source: string, marker: string): string {
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`marker not found: ${marker}`);
  const open = source.indexOf('{', start);
  if (open < 0) throw new Error(`no object literal after: ${marker}`);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced object literal after: ${marker}`);
}

const services = readFileSync(join(ROOT, 'src/runtime/services.ts'), 'utf8');

describe('a channel turn is spawned able to record what the owner just said', () => {
  const spawnCall = objectLiteralAfter(services, 'const record = agentManager.spawn(');

  test('the continuation runner spawn carries conversationalTurnSpawnOptions', () => {
    // Without it the spawn is `restrictTools: true` with no tool list, which is
    // an empty registry: text out, nothing recorded.
    expect(spawnCall).toContain('...conversationalTurnSpawnOptions(input, {');
    expect(spawnCall).toContain('configReader: configManager');
  });

  test('conversationalTurnSpawnOptions is spread before buildSharedSessionAgentSpawnRoutingInput', () => {
    // Order is the mechanism, not a style choice: the routing builder emits
    // `tools` only when a routing intent actually named some, and when it does
    // that explicit list has to win over the conversational default.
    const captureIdx = spawnCall.indexOf('...conversationalTurnSpawnOptions(');
    const routingIdx = spawnCall.indexOf('...buildSharedSessionAgentSpawnRoutingInput(');
    expect(captureIdx).toBeGreaterThan(-1);
    expect(routingIdx).toBeGreaterThan(-1);
    expect(captureIdx).toBeLessThan(routingIdx);
  });

  test('the bare shared-session context line no longer overwrites the turn instruction', () => {
    // `conversationalTurnSpawnOptions` supplies a context that tells the agent
    // recording is part of answering. A leftover `context:` key after the
    // spread replaces that with a bare label and the capture ability goes quiet
    // while every tool-list assertion above still passes.
    expect(spawnCall).not.toContain('context: `shared-session:');
  });

  test('the conversation gate is left exactly as it was', () => {
    // This change adds the ability to record; it does not change what opens a
    // work chain. A channel follow-up still gets an answer.
    expect(spawnCall).toContain('...continuationChainOptions(input, {');
  });
});

describe('both ends of the personal-capture port are wired at the composition root', () => {
  test('one holder is constructed and shared', () => {
    expect(services).toContain('const personalCapture = new PersonalCaptureHolder();');
    // A second holder would leave one end filled and the other empty.
    expect(services.split('new PersonalCaptureHolder()').length - 1).toBe(1);
  });

  test('the gateway verb group deps include personalCapture, so the port gets filled', () => {
    // The verb groups own the owner-profile store and the occasions service.
    // Without this the `profile` tool exists and has nowhere to write.
    const gatewayDeps = objectLiteralAfter(services, 'attachWsOnlyGatewayVerbHandlers(gatewayMethods,');
    expect(gatewayDeps).toContain('personalCapture,');
  });

  test('the agent orchestrator deps include personalCapture, so the profile tool is registered', () => {
    // registerAllTools registers `profile` only when the holder is supplied.
    // Without this the instruction tells the agent to capture and the tool it
    // is told to call does not exist.
    const orchestratorDeps = objectLiteralAfter(services, 'agentOrchestrator.setDependencies(');
    expect(orchestratorDeps).toContain('personalCapture,');
  });
});

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
