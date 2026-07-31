import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Composition guard for the exec prompt-answer handler and the loopback-fetch
 * ask.
 *
 * Both ride the approval broker, and both must be built ONCE and shared, because
 * every consumer that calls `setDependencies` replaces the dependency object
 * WHOLESALE — a caller that rebuilds either one installs a second handler whose
 * asks land in a different place, and a caller that forgets to re-pass one drops
 * it entirely. That is not hypothetical: it is how an interactive command
 * stopped on a terminal prompt and hung to timeout with no ask and no card.
 *
 * The daemon has one composition root and one `setDependencies` call, so the
 * shape to pin here is narrower than it was when a bootstrap sequence re-wired
 * the orchestrator after the fact: built once, exposed on the services surface
 * for whoever else needs it, and passed to the orchestrator from that same
 * binding rather than rebuilt.
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

const REQUIRED_FIELDS = ['execPromptAnswerHandler', 'localhostFetchApproval'] as const;

describe('exec prompt-answer and loopback-fetch wiring — one handler each, shared', () => {
  const services = readFileSync(join(ROOT, 'src/runtime/services.ts'), 'utf8');
  const orchestratorDeps = objectLiteralAfter(services, 'agentOrchestrator.setDependencies(');
  const returnedServices = objectLiteralAfter(services, 'const services: RuntimeServices =');

  test('each is built exactly once from the approval broker', () => {
    expect(services).toContain('const execPromptAnswerHandler = buildExecPromptAnswerHandler(');
    expect(services).toContain('const localhostFetchApproval = buildLocalhostFetchApproval(');
    // Exactly one CALL each (the import names the symbol without calling it).
    expect(services.split('buildExecPromptAnswerHandler(')).toHaveLength(2);
    expect(services.split('buildLocalhostFetchApproval(')).toHaveLength(2);
  });

  for (const field of REQUIRED_FIELDS) {
    test(`the orchestrator is given ${field}`, () => {
      expect(orchestratorDeps).toContain(`${field},`);
    });
    test(`${field} is exposed on the services surface so no other consumer rebuilds it`, () => {
      expect(returnedServices).toContain(`${field},`);
    });
  }
});
