declare module "node:sqlite" {
  export type SQLInputValue = string | number | bigint | Uint8Array | null;
  export type SQLParameter = SQLInputValue | Record<string, SQLInputValue>;

  export interface StatementResult {
    changes: number | bigint;
    lastInsertRowid: number | bigint;
  }

  export interface StatementSync {
    run(...anonymousParameters: SQLParameter[]): StatementResult;
    get(...anonymousParameters: SQLParameter[]): unknown;
    all(...anonymousParameters: SQLParameter[]): unknown[];
    iterate(...anonymousParameters: SQLParameter[]): IterableIterator<unknown>;
    columns(): Array<{ name: string }>;
    setAllowBareNamedParameters(enabled: boolean): this;
    setReadBigInts(enabled: boolean): this;
    readonly sourceSQL: string;
    readonly expandedSQL: string;
  }

  export interface DatabaseSyncOptions {
    open?: boolean;
    readOnly?: boolean;
    enableForeignKeyConstraints?: boolean;
    allowExtension?: boolean;
    timeout?: number;
  }

  export class DatabaseSync {
    constructor(path: string, options?: DatabaseSyncOptions);
    readonly isOpen: boolean;
    readonly isTransaction: boolean;
    open(): void;
    close(): void;
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    location(dbName?: string): string | null;
    loadExtension(path: string, entryPoint?: string): void;
  }
}
