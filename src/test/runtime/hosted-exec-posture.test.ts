/**
 * hosted-exec-posture.test.ts — what THIS daemon states about a hosted turn's
 * exec.
 *
 * The engine's behaviour (a required boundary refuses an uncontained command,
 * the owner's terminal is denied outright) is the SDK's, and is proved there.
 * What this daemon owns is the STATEMENT: which posture it hands the engine,
 * and what its operator prompt tells a hosted turn it owes.
 *
 * That statement is the thing that went wrong. Every piece of the boundary was
 * wired and the daemon still hosted a turn that reached the whole host — the
 * process table, the owner's /proc, and his tmux session, where it typed —
 * because nothing in this composition ever said the boundary was required.
 */
import { afterAll, beforeAll, describe, it, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONVERSATIONAL_DIAGNOSIS_SECTION } from '@pellux/goodvibes-sdk/platform/agents';
import { createHostedSessionOptions } from '../../runtime/hosted-session-composition.ts';
import { disposeTestRuntimeServicesAfterAll, getTestRuntimeServices } from '../helpers/runtime-services.ts';

disposeTestRuntimeServicesAfterAll();

let root: string;
beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'gv-hosted-posture-')); });
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

/**
 * The floor this daemon builds for a workspace. Composing one runs the real
 * factory, which is the only place the posture is stated.
 */
async function floorFor(workspaceRoot: string) {
  const options = createHostedSessionOptions(getTestRuntimeServices());
  return await options.floorFactory({ workspaceRoot });
}

describe('the exec posture this daemon states', () => {
  it('states one at all — the engine is never left to a default here', async () => {
    const floor = await floorFor(root);
    try {
      expect(typeof floor.execPosture).toBe('function');
    } finally {
      await floor.dispose();
    }
  });

  it('every session this daemon hosts is conversational, and therefore contained', async () => {
    const floor = await floorFor(root);
    try {
      expect(floor.execPosture?.({ sessionId: 'hosted-1', workspaceRoot: root })).toBe('conversational');
    } finally {
      await floor.dispose();
    }
  });

  it('no session id or workspace talks this daemon into a workstream grant', async () => {
    const floor = await floorFor(root);
    try {
      for (const workspaceRoot of ['/', '/home/owner', root, process.cwd()]) {
        expect(floor.execPosture?.({ sessionId: 'hosted-x', workspaceRoot })).toBe('conversational');
      }
    } finally {
      await floor.dispose();
    }
  });
});

describe("this daemon's hosted operator prompt", () => {
  it('carries the conversational diagnosis contract, from the SDK rather than a second copy', () => {
    const options = createHostedSessionOptions(getTestRuntimeServices());
    const prompt = options.systemPrompt?.({ sessionId: 'hosted-1', workspaceRoot: '/tmp/ws' }) ?? '';
    expect(prompt).toContain(CONVERSATIONAL_DIAGNOSIS_SECTION);
  });

  it('still says what it always said about the workspace and the ask seam', () => {
    const options = createHostedSessionOptions(getTestRuntimeServices());
    const prompt = options.systemPrompt?.({ sessionId: 'hosted-1', workspaceRoot: '/tmp/ws' }) ?? '';
    expect(prompt).toContain('/tmp/ws');
    expect(prompt).toContain('an unanswered one is a refusal');
  });
});
