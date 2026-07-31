/**
 * sql-js.d.ts — types for the untyped `sql.js` package, for this compilation.
 *
 * An ambient `declare module` is scoped to the program that compiles it: a
 * dependency's copy is not visible here, and this one is not emitted into
 * anything this package publishes. So a project that imports `sql.js` and
 * wants it typed states the shape itself — sharing it is not a thing the
 * language offers. `src/daemon/handlers/sqlite-store.ts` is the importer.
 */
declare module 'sql.js' {
  interface Database {
    run(sql: string, params?: (string | number | Uint8Array | null)[]): void;
    exec(sql: string, params?: (string | number)[]): Array<{ columns: string[]; values: unknown[][] }>;
    export(): Uint8Array;
    close(): void;
  }

  interface SqlJsStatic {
    Database: new (data?: Uint8Array | Buffer) => Database;
  }

  function initSqlJs(): Promise<SqlJsStatic>;
  export default initSqlJs;
}
