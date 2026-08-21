#!/usr/bin/env bun
/**
 * coverage-gate.ts, aggregate coverage enforcement (thin toolchain adapter).
 *
 * The parse + floor-comparison mechanic is owned by
 * @pellux/goodvibes-toolchain (evaluateCoverageGate / parseCoverageSummary);
 * the floors and the coverage command live in this repo's toolchain.config.json
 * (single source). This module is a thin adapter that keeps the daemon-specific
 * evidence layer: the exact reported lines, the cross-file-interference note,
 * and the temp-dir hygiene the whole-suite spawn needs.
 *
 * Why a separate whole-suite process at all:
 * - `bun run test` (scripts/run-tests.ts) spawns one bun process PER FILE for
 *   TMPDIR isolation; a bunfig coverageThreshold would gate each file. Aggregate
 *   enforcement needs one whole-suite process.
 * - Correctness is gated by `bun run test`; a failure seen only in the
 *   single-process run is cross-file interference, reported here as a note
 *   rather than dressed up as a coverage problem.
 * - IMPORTANT: bunfig.toml must not set `coverage = false`, that key overrides
 *   the CLI --coverage flag and the child emits no coverage table at all.
 *
 * Floors are a RATCHET (toolchain.config.json coverage.funcsFloor /
 * linesFloor): set just below the measured baseline, raised as coverage
 * improves, never lowered without an explicit decision. They catch
 * regressions, not a percentage.
 */
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  evaluateCoverageGate,
  parseCoverageSummary as toolchainParseCoverageSummary,
} from '@pellux/goodvibes-toolchain';
import { sweepStaleOsTmpEntries } from './stale-tmp-sweep.ts';

interface CoverageConfigShape {
  readonly funcsFloor: number;
  readonly linesFloor: number;
  readonly command?: readonly string[];
}

function loadCoverageConfig(root: string = process.cwd()): CoverageConfigShape {
  const raw = JSON.parse(readFileSync(join(root, 'toolchain.config.json'), 'utf8')) as { coverage?: CoverageConfigShape };
  if (!raw.coverage) throw new Error('toolchain.config.json has no `coverage` section');
  return raw.coverage;
}

const coverageConfig = loadCoverageConfig();

export const FUNCS_FLOOR = coverageConfig.funcsFloor;
export const LINES_FLOOR = coverageConfig.linesFloor;

export interface CoverageSummary {
  funcsPct: number;
  linesPct: number;
}

/** Parse the bun text coverage "All files" row (delegates to the toolchain). */
export function parseCoverageSummary(output: string): CoverageSummary | null {
  return toolchainParseCoverageSummary(output);
}

/** Extract "N fail" from the bun run summary; null when absent. */
export function parseFailCount(output: string): number | null {
  const match = output.replace(/\x1b\[[0-9;]*m/g, '').match(/^\s*(\d+)\s+fail\s*$/m);
  if (!match) return null;
  return Number.parseInt(match[1] ?? '', 10);
}

export interface GateResult {
  pass: boolean;
  lines: string[];
}

export function evaluateGate(output: string): GateResult {
  const evaluated = evaluateCoverageGate(output, { funcsFloor: FUNCS_FLOOR, linesFloor: LINES_FLOOR });
  if (!evaluated.summary) {
    return {
      pass: false,
      lines: ['coverage-gate: FAIL; no coverage table found in output (did the run crash before reporting?)'],
    };
  }
  const funcsOk = evaluated.summary.funcsPct >= FUNCS_FLOOR;
  const linesOk = evaluated.summary.linesPct >= LINES_FLOOR;
  const lines: string[] = [
    'coverage-gate: functions ' + evaluated.summary.funcsPct.toFixed(2) + '% (floor ' + FUNCS_FLOOR + '%): ' + (funcsOk ? 'OK' : 'BELOW FLOOR'),
    'coverage-gate: lines     ' + evaluated.summary.linesPct.toFixed(2) + '% (floor ' + LINES_FLOOR + '%): ' + (linesOk ? 'OK' : 'BELOW FLOOR'),
  ];
  const failCount = parseFailCount(output);
  if (failCount !== null && failCount > 0) {
    lines.push(
      'coverage-gate: note; ' + failCount + ' test(s) failed in whole-suite (single-process) mode.',
      'coverage-gate: correctness is gated by bun run test (per-file isolation); single-process',
      'coverage-gate: failures indicate cross-file interference debt, tracked separately.',
    );
  }
  const pass = funcsOk && linesOk;
  lines.push(pass ? 'coverage-gate: PASS' : 'coverage-gate: FAIL');
  return { pass, lines };
}

export interface RunGateOptions {
  /** Command to spawn; defaults to the configured whole-suite coverage run. */
  cmd?: string[];
  /** Working directory; defaults to process.cwd(). */
  cwd?: string;
}

/**
 * Spawn the coverage run, combine stdout+stderr, and evaluate the gate.
 * Exported (with an injectable command) so the spawn path itself is testable.
 */
export async function runCoverageGate(options: RunGateOptions = {}): Promise<GateResult> {
  const cwd = options.cwd ?? process.cwd();
  const configured = coverageConfig.command ? [...coverageConfig.command] : ['bun', 'test', '--coverage', 'src'];
  const cmd = options.cmd ?? configured;
  // This spawns a single whole-suite `bun test` directly. Unlike `bun run test`
  // (scripts/run-tests.ts) there is no per-file TMPDIR redirection and no
  // temp-cleanup preload here, so anything the suite creates via a raw
  // mkdtemp(tmpdir()) call lands in the real OS temp dir. Sweep this project's
  // own known-stale entries there before the run (age-gated, see
  // scripts/stale-tmp-sweep.ts) so this entry point, which run-tests.ts's own
  // comment already points at, is not the one path left unswept.
  sweepStaleOsTmpEntries(tmpdir());
  // Fence git's upward repo discovery at `.test-tmp` for the same reason
  // scripts/run-tests.ts does: makeProjectTempDir scratch has no `.git` of its
  // own and sits inside this project's repo, so any test needing a genuinely
  // non-repo directory would otherwise resolve to the project root. Set in the
  // spawn env (not mutated later) so it is part of the child's own startup
  // snapshot; Bun.spawnSync-based git calls only honor a ceiling set before the
  // process starts.
  const testTmpRoot = join(cwd, '.test-tmp');
  const existingCeiling = process.env.GIT_CEILING_DIRECTORIES;
  const ceilingEntries = existingCeiling ? existingCeiling.split(':') : [];
  if (!ceilingEntries.includes(testTmpRoot)) ceilingEntries.push(testTmpRoot);
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: ceilingEntries.join(':') };
  const proc = Bun.spawn(cmd, { cwd, env, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  // Sweep again after the run (mirrors run-tests.ts's before-and-after
  // pattern): entries this pass created under the real temp dir are reclaimed
  // now rather than waiting for the next invocation.
  sweepStaleOsTmpEntries(tmpdir());
  const result = evaluateGate(stdout + '\n' + stderr);
  if (!result.pass && parseCoverageSummary(stdout + '\n' + stderr) === null) {
    result.lines.push('coverage-gate: child exit code ' + exitCode);
  }
  return result;
}

async function main(): Promise<void> {
  const result = await runCoverageGate();
  for (const line of result.lines) {
    console.log(line);
  }
  process.exit(result.pass ? 0 : 1);
}

if (import.meta.main) {
  await main();
}
