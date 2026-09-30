/**
 * dependency-check.test.ts, the local-tools and knowledge packages a hosted
 * turn reaches for, verified resolvable and working.
 *
 * A session this daemon HOSTS runs the same loop with the same tools a terminal
 * front-end runs: code search parses with tree-sitter, symbol lookups spawn a
 * language server, the code index and the knowledge stores read sql.js, fuzzy
 * matching is fuse.js, an artifact bundle is jszip. The platform declares all of
 * them optional, a surface that never opens a file needs none of them, so
 * "installed" is not something this product can assume from someone else's
 * manifest. It pins them itself, and this file is what makes a pin that failed
 * to install fail loudly here instead of quietly at the first hosted turn.
 *
 * These are not unit tests of a dependency's API. Each one confirms the package
 * resolves and can perform its primary operation without throwing.
 */
import { describe, test, expect } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(import.meta.dir, '..', '..', '..');

describe('sql.js', () => {
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
