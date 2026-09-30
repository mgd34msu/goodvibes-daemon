/**
 * The WRFC fix engine stops with the runtime.
 *
 * createAgentGraph (the SDK) builds an orchestration engine for the WRFC
 * controller's planned-fix phase. The engine holds listeners and a debounced
 * disk writer until it is disposed, so a runtime that stops without disposing
 * it leaves both alive for the rest of the process. services.ts registers that
 * disposal on the graph's disposal scope; this file stops a real daemon and
 * watches the engine go quiet.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { PhaseSpec } from '@pellux/goodvibes-sdk/platform/orchestration';
import { startDaemonFixture, type DaemonFixture } from '../../testing/daemon-fixture.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

let fixture: DaemonFixture | null = null;

beforeAll(async () => {
  fixture = await startDaemonFixture({ root: makeProjectTempDir('gv-wrfc-fix-engine'), hostSessions: false });
});

afterAll(async () => {
  // The test below stops the fixture itself; this covers a failure before that.
  await fixture?.stop().catch(() => undefined);
});

const FIX_PHASE: PhaseSpec = {
  role: 'fixer',
  capacity: 1,
  gate: { scope: 'off', gates: [] },
  kind: 'fix',
};

describe('the WRFC fix engine built by createAgentGraph', () => {
  test('delivers events while the runtime runs, and none after the runtime stops', async () => {
    const running = fixture!;
    const engine = running.services.wrfcFixEngine;
    const workstream = engine.createWorkstream({
      title: 'fix-engine disposal probe',
      phases: [{ role: 'engineer', capacity: 1, gate: { scope: 'off', gates: [] }, kind: 'engineer' }],
      items: [],
    });
    const events: string[] = [];
    engine.on((event) => { events.push(event.type); });

    // While the runtime runs, the engine is live: inserting a phase is heard.
    expect(engine.insertPhase(workstream.id, 1, FIX_PHASE)).not.toBeNull();
    expect(events).toEqual(['phase-inserted']);

    fixture = null;
    await running.stop();
    events.length = 0;

    // Stopped with the runtime: the same call reaches no listener.
    engine.insertPhase(workstream.id, 1, FIX_PHASE);
    expect(events).toEqual([]);
  });
});
