/**
 * dependency-check.test.ts — the local-tools and knowledge packages a hosted
 * turn reaches for, verified resolvable and working.
 *
 * A session this daemon HOSTS runs the same loop with the same tools a terminal
 * front-end runs: code search parses with tree-sitter, symbol lookups spawn a
 * language server, the code index and the knowledge stores read sql.js, fuzzy
 * matching is fuse.js, an artifact bundle is jszip. The platform declares all of
 * them optional — a surface that never opens a file needs none of them — so
 * "installed" is not something this product can assume from someone else's
 * manifest. It pins them itself, and this file is what makes a pin that failed
 * to install fail loudly here instead of quietly at the first hosted turn.
 *
 * These are not unit tests of a dependency's API. Each one confirms the package
 * resolves and can perform its primary operation without throwing.
 */
import { describe, test, expect } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(import.meta.dir, '..', '..', '..');

/**
 * The pin set, written out by hand rather than derived from package.json, so a
 * pin silently dropped fails here instead of quietly changing what a hosted
 * turn can do.
 */
const PINNED = [
  '@agentclientprotocol/sdk',
  '@ast-grep/napi',
  'bash-language-server',
  'fuse.js',
  'graphql',
  'jszip',
  'node-edge-tts',
  'pyright',
  'sql.js',
  'tree-sitter-css',
  'tree-sitter-javascript',
  'tree-sitter-json',
  'tree-sitter-python',
  'tree-sitter-typescript',
  'typescript-language-server',
  'vscode-langservers-extracted',
  'web-tree-sitter',
] as const;

describe('the local-tools pin set', () => {
  test('every package a hosted turn needs is pinned by this product, not inherited', () => {
    const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8')) as {
      dependencies: Record<string, string>;
    };
    const missing = PINNED.filter((name) => manifest.dependencies[name] === undefined);
    expect(missing).toEqual([]);
  });

  test('each pin says the same range the platform declares for it', () => {
    // The platform declares all of these optional, with a range of its own. A
    // narrower range here does not "pin harder" — it makes an install resolve a
    // version the platform's own code was not built against, or fail outright.
    const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8')) as {
      dependencies: Record<string, string>;
    };
    const platform = JSON.parse(
      readFileSync(join(repoRoot, 'node_modules', '@pellux', 'goodvibes-sdk', 'package.json'), 'utf-8'),
    ) as { optionalDependencies?: Record<string, string> };
    const disagreements = PINNED
      .filter((name) => platform.optionalDependencies?.[name] !== undefined)
      .filter((name) => manifest.dependencies[name] !== platform.optionalDependencies![name])
      .map((name) => `${name}: ${manifest.dependencies[name]} here, ${platform.optionalDependencies![name]} there`);
    expect(disagreements).toEqual([]);
  });

  test('the two provider packages nothing imports are gone', () => {
    // @anthropic-ai/vertex-sdk and @aws/bedrock-token-generator were declared
    // here and imported by nothing in this repository or the platform.
    const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8')) as {
      dependencies: Record<string, string>;
    };
    expect(manifest.dependencies['@anthropic-ai/vertex-sdk']).toBeUndefined();
    expect(manifest.dependencies['@aws/bedrock-token-generator']).toBeUndefined();
  });
});

describe('sql.js', () => {
  test('exports an initSqlJs factory function', async () => {
    const mod = await import('sql.js');
    const factory = mod.default ?? mod;
    expect(typeof factory).toBe('function');
  });

  test('can create a table and read a row back', async () => {
    const initSqlJs = (await import('sql.js')).default;
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run('CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT)');
    db.run('INSERT INTO t VALUES (1, ?)', ['hello']);
    const result = db.exec('SELECT val FROM t WHERE id = 1');
    expect(result.length).toBe(1);
    expect(result[0]!.values[0]![0]).toBe('hello');
    db.close();
  });
});

describe('fuse.js', () => {
  test('exports a Fuse constructor as default', async () => {
    const { default: Fuse } = await import('fuse.js');
    expect(typeof Fuse).toBe('function');
  });

  test('can search an index and return the match', async () => {
    const { default: Fuse } = await import('fuse.js');
    const fuse = new Fuse(
      [{ name: 'precision_read' }, { name: 'precision_write' }, { name: 'precision_exec' }],
      { keys: ['name'], threshold: 0.4 },
    );
    const results = fuse.search('read');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.item.name).toContain('read');
  });
});

describe('jszip', () => {
  test('can build an archive and read the entry back', async () => {
    const { default: JSZip } = await import('jszip');
    const zip = new JSZip();
    zip.file('note.txt', 'hello');
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    expect(bytes.byteLength).toBeGreaterThan(0);
    const reopened = await new JSZip().loadAsync(bytes);
    expect(await reopened.file('note.txt')!.async('string')).toBe('hello');
  });
});

describe('@ast-grep/napi', () => {
  test('can parse a TypeScript snippet and find a node in it', async () => {
    const { parse } = await import('@ast-grep/napi');
    const root = parse('TypeScript', 'function hello(name: string): string { return name; }');
    const funcs = root.root().findAll({ rule: { kind: 'function_declaration' } });
    expect(funcs.length).toBeGreaterThan(0);
  });
});

describe('tree-sitter grammars', () => {
  const nmRoot = join(repoRoot, 'node_modules');

  test.each([
    ['tree-sitter-typescript', 'tree-sitter-typescript.wasm'],
    ['tree-sitter-typescript', 'tree-sitter-tsx.wasm'],
    ['tree-sitter-javascript', 'tree-sitter-javascript.wasm'],
    ['tree-sitter-python', 'tree-sitter-python.wasm'],
    ['tree-sitter-json', 'tree-sitter-json.wasm'],
    ['tree-sitter-css', 'tree-sitter-css.wasm'],
    ['web-tree-sitter', 'web-tree-sitter.wasm'],
  ])('%s ships %s', (pkg, file) => {
    expect(existsSync(join(nmRoot, pkg, file))).toBe(true);
  });

  test('web-tree-sitter initialises its WASM runtime', async () => {
    const mod = await import('web-tree-sitter');
    // The package's typings do not declare init(), which is what actually loads
    // the runtime; every grammar parse below the surface goes through it.
    const Parser = (mod.default ?? mod.Parser) as unknown as { init(): Promise<void> };
    await Parser.init();
  });
});

describe('@agentclientprotocol/sdk', () => {
  // Hosted third-party coding agents: services.ts constructs AcpHostService,
  // which speaks this protocol over the agent's stdio.
  test('exports the connection classes the ACP host speaks through', async () => {
    const mod = await import('@agentclientprotocol/sdk');
    expect(typeof mod.AgentSideConnection).toBe('function');
    expect(typeof mod.ClientSideConnection).toBe('function');
    expect(typeof mod.ndJsonStream).toBe('function');
  });
});
