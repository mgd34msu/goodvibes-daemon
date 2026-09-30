#!/usr/bin/env bun
/**
 * check-architecture.ts, static analysis gate run in CI via `bun run architecture:check`.
 *
 * Ported from the sibling repos' equivalents (goodvibes-agent/scripts/check-architecture.ts
 * and goodvibes-tui/scripts/check-architecture.ts), carrying across only the
 * rules that describe something real about THIS repo's layout. Rules whose
 * subject does not exist here (the TUI's hex-literal and selected-index
 * ratchets, the Agent's Knowledge-route snippet requirements) are not ported,
 * and no new rule was invented to fill the space.
 *
 * What this checks, runtime dependency structure only (the line-count cap and
 * the text-pattern rules were removed; see docs/testing-and-validation.md):
 *   1. Import-cycle detection, Tarjan SCC over the src/ runtime import graph
 *   2. Layer-boundary rules, codified allowed dependency directions
 *   3. Boundary rules that guard nothing (a layer that is not a src/ directory)
 *
 * --- LAYER MAP ---------------------------------------------------------------
 *
 * Layer 0  foundation   config, core
 * Layer 1  services     cluster, runtime
 * Layer 2  surface      cli        (command catalog + flag types)
 * Layer 3  entrypoint   daemon     (src/daemon/cli.ts is the composition root)
 *
 * Edges actually present at HEAD (measured, not assumed):
 *   daemon  -> cli, cluster, config, core, runtime
 *   runtime -> config, daemon
 *   testing -> runtime
 *
 * Enforced FORBIDDEN directions. Following the siblings' discipline, a boundary
 * rule is added only where HEAD has zero violations, so the rule catches the
 * next regression rather than describing an aspiration:
 *   - config  -> cli, cluster, daemon, runtime
 *   - core    -> cli, cluster, config, daemon, runtime
 *   - cluster -> cli, daemon, runtime
 *   - cli     -> daemon
 *
 * `runtime -> daemon` is a live edge and is therefore NOT banned.
 * -----------------------------------------------------------------------------
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const SRC_ROOT = join(ROOT, 'src');

function walk(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(abs));
      continue;
    }
    if (entry.isFile() && abs.endsWith('.ts')) {
      files.push(abs);
    }
  }
  return files;
}

function isTestSource(path: string): boolean {
  return path.includes('/src/test/') || path.endsWith('.test.ts') || path.includes('/__tests__/');
}

// --- Import-graph utilities --------------------------------------------------

/**
 * Matches bare relative import/export/require specifiers.
 *
 * Only relative imports are resolved; `@/`-aliased and package specifiers are
 * invisible to the cycle detector and the layer checker, the same coverage gap
 * the sibling implementations carry.
 */
const IMPORT_RE =
  /(?:^|\n)\s*(?:import|export)\s+(?:[^'"]*\s+from\s+)?['"](\.[^'"]+)['"]|(?:^|\n)\s*(?:const|let|var)\s+.*=\s*require\(['"](\.[^'"]+)['"]\)/g;

/**
 * Matches the same shape but only for TYPE-only imports/exports
 * (`import type ... from`, `export type ... from`).
 *
 * Type-only edges are erased by the compiler and cannot produce a runtime
 * initialization cycle, so they are excluded from the graph. Without this the
 * detector reports src/cli/types.ts <-> src/cli/command-catalog.ts, a pair
 * whose two edges are both `import type` and which has no runtime existence at
 * all. The siblings' detectors predate this distinction; the boundary rules
 * below are likewise about runtime dependencies, not type references.
 */
const TYPE_IMPORT_RE =
  /(?:^|\n)\s*(?:import|export)\s+type\s+[^'"]*from\s+['"](\.[^'"]+)['"]/g;

function matchSpecifiers(text: string, re: RegExp): string[] {
  const out: string[] = [];
  const local = new RegExp(re.source, re.flags);
  let m: RegExpExecArray | null;
  while ((m = local.exec(text)) !== null) {
    const spec = m[1] ?? m[2];
    if (spec) out.push(spec);
  }
  return out;
}

/** Relative import specifiers with runtime effect (type-only edges removed). */
function extractRuntimeImports(text: string): string[] {
  const typeOnly = new Set(matchSpecifiers(text, TYPE_IMPORT_RE));
  return matchSpecifiers(text, IMPORT_RE).filter((spec) => !typeOnly.has(spec));
}

/** Resolve a relative specifier to an absolute file, trying .ts and /index.ts. */
function resolveImport(fromFile: string, spec: string): string | null {
  const target = resolve(dirname(fromFile), spec);
  for (const candidate of [target, target + '.ts', join(target, 'index.ts')]) {
    if (existsSync(candidate) && !statSync(candidate).isDirectory()) {
      return candidate;
    }
  }
  return null;
}

function buildImportGraph(files: string[]): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();
  for (const file of files) {
    const deps = new Set<string>();
    for (const spec of extractRuntimeImports(readFileSync(file, 'utf-8'))) {
      // Targets outside the non-test set have no outbound edges, so they act as
      // leaves and never form an SCC.
      const resolved = resolveImport(file, spec);
      if (resolved) deps.add(resolved);
    }
    graph.set(file, deps);
  }
  return graph;
}

/** Tarjan's Strongly Connected Components; SCCs larger than one node are cycles. */
function findCycles(graph: Map<string, Set<string>>): string[][] {
  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Map<string, boolean>();
  const stack: string[] = [];
  const sccs: string[][] = [];
  let counter = 0;

  function strongconnect(v: string): void {
    index.set(v, counter);
    lowlink.set(v, counter);
    counter++;
    stack.push(v);
    onStack.set(v, true);

    for (const w of graph.get(v) ?? new Set<string>()) {
      if (!index.has(w)) {
        strongconnect(w);
        lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
      } else if (onStack.get(w)) {
        lowlink.set(v, Math.min(lowlink.get(v)!, index.get(w)!));
      }
    }

    if (lowlink.get(v) === index.get(v)) {
      const scc: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.set(w, false);
        scc.push(w);
      } while (w !== v);
      if (scc.length > 1) sccs.push(scc);
    }
  }

  for (const node of graph.keys()) {
    if (!index.has(node)) strongconnect(node);
  }
  return sccs;
}

/** Format a cycle as an ordered chain, starting from its lexicographically first file. */
function formatCycleChain(cycle: string[], graph: Map<string, Set<string>>): string {
  const start = [...cycle].sort()[0]!;
  const cycleSet = new Set(cycle);
  const chain: string[] = [start];
  const visited = new Set<string>([start]);
  let current = start;

  for (let i = 0; i < cycle.length; i++) {
    let next: string | null = null;
    for (const n of graph.get(current) ?? new Set<string>()) {
      if (cycleSet.has(n) && !visited.has(n)) {
        next = n;
        break;
      }
    }
    if (next === null) break;
    chain.push(next);
    visited.add(next);
    current = next;
  }
  chain.push(start);
  return chain.map((f) => relative(ROOT, f)).join(' -> ');
}

// --- Layer-boundary rule engine ----------------------------------------------

/** Top-level src/ subdirectory for a path; null for files directly in src/. */
function srcLayer(absPath: string): string | null {
  const parts = relative(SRC_ROOT, absPath).split('/');
  if (parts.length <= 1) return null;
  return parts[0]!;
}

type LayerBoundaryRule = {
  readonly name: string;
  /** Why the boundary exists; becomes part of the violation message. */
  readonly rationale: string;
  readonly fromLayers: ReadonlySet<string>;
  readonly toLayers: ReadonlySet<string>;
  /** Composition roots that legitimately bridge layers, relative to the repo root. */
  readonly exemptFiles?: ReadonlySet<string>;
};

const LAYER_BOUNDARY_RULES: readonly LayerBoundaryRule[] = [
  {
    // config is read in every context, including a daemon booting before any
    // command surface exists. An upward edge would make settings unreadable
    // without dragging the whole process graph in behind them.
    name: 'config-no-upward-imports',
    rationale: 'config is a foundational layer read in every context and must not depend on cli, cluster, runtime, or the daemon entrypoint',
    fromLayers: new Set(['config']),
    toLayers: new Set(['cli', 'cluster', 'daemon', 'runtime']),
  },
  {
    // core holds the domain types every other layer agrees on. Any outbound
    // edge from it inverts the direction the whole tree depends in.
    name: 'core-no-upward-imports',
    rationale: 'core is the shared domain layer and must not depend on any layer above it',
    fromLayers: new Set(['core']),
    toLayers: new Set(['cli', 'cluster', 'config', 'daemon', 'runtime']),
  },
  {
    // cluster membership is composed BY the daemon, not the other way round.
    name: 'cluster-no-upward-imports',
    rationale: 'cluster is composed by the daemon entrypoint and must not import cli, runtime, or daemon modules',
    fromLayers: new Set(['cluster']),
    toLayers: new Set(['cli', 'daemon', 'runtime']),
  },
  {
    // The command catalog describes commands; src/daemon/cli.ts wires them up.
    // The reverse edge would make the catalog un-listable without booting.
    name: 'cli-no-entrypoint-imports',
    rationale: 'the cli command surface is consumed by the daemon entrypoint and must not import it back',
    fromLayers: new Set(['cli']),
    toLayers: new Set(['daemon']),
  },
];

function checkLayerBoundaries(
  graph: Map<string, Set<string>>,
  rules: readonly LayerBoundaryRule[],
): string[] {
  const found: string[] = [];
  for (const rule of rules) {
    for (const [fromFile, deps] of graph) {
      const fromLayer = srcLayer(fromFile);
      if (!fromLayer || !rule.fromLayers.has(fromLayer)) continue;
      const relFrom = relative(ROOT, fromFile);
      if (rule.exemptFiles?.has(relFrom)) continue;
      for (const toFile of deps) {
        const toLayer = srcLayer(toFile);
        if (!toLayer || !rule.toLayers.has(toLayer)) continue;
        found.push(`[${rule.name}] ${relFrom} -> ${relative(ROOT, toFile)}: ${rule.rationale}`);
      }
    }
  }
  return found;
}

// --- Main analysis -----------------------------------------------------------

const allSourceFiles = walk(SRC_ROOT);
const nonTestFiles = allSourceFiles.filter((file) => !isTestSource(file));
const violations: string[] = [];

const startMs = Date.now();

// --- Cycle detection ---------------------------------------------------------

const graph = buildImportGraph(nonTestFiles);
const cycles = findCycles(graph);
for (const cycle of cycles) {
  violations.push(`[import-cycle] ${cycle.length}-file cycle: ${formatCycleChain(cycle, graph)}`);
}

// --- Layer-boundary enforcement ----------------------------------------------

for (const v of checkLayerBoundaries(graph, LAYER_BOUNDARY_RULES)) {
  violations.push(v);
}

// --- Rules that guard nothing ------------------------------------------------

// A boundary rule naming a directory that is not under src/ matches nothing:
// the same vacuous-pass class as a missing rule target, reached through the
// other half of the engine.
const liveLayers = new Set(
  readdirSync(SRC_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name),
);
for (const rule of LAYER_BOUNDARY_RULES) {
  for (const layer of [...rule.fromLayers, ...rule.toLayers]) {
    if (!liveLayers.has(layer)) {
      violations.push(
        `[${rule.name}] names the layer "${layer}", which is not a directory under src/;`
        + ' the rule matches nothing; remove the layer (and the rule, if nothing live is left)',
      );
    }
  }
}

// --- Report ------------------------------------------------------------------

const elapsedMs = Date.now() - startMs;

if (violations.length > 0) {
  console.error('Architecture check failed:\n');
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

console.log(
  `Architecture check passed for ${nonTestFiles.length} non-test source files.` +
  ` (${cycles.length} cycles found, ${LAYER_BOUNDARY_RULES.length} boundary rules active,` +
  ` ${Math.round(elapsedMs / 1000)}s)`,
);
