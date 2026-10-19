import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

export class LocalD1PreparedStatement {
  private db: DatabaseSync;
  private sql: string;
  private params: SQLInputValue[];

  constructor(db: DatabaseSync, sql: string, params: SQLInputValue[] = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }

  bind(...params: SQLInputValue[]): LocalD1PreparedStatement {
    return new LocalD1PreparedStatement(this.db, this.sql, params);
  }

  async first<T = Record<string, unknown>>(colName?: string): Promise<T | null> {
    const stmt = this.db.prepare(this.sql);
    const row = stmt.get(...this.params) as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    if (colName !== undefined) {
      return (row[colName] as T) ?? null;
    }
    return row as T;
  }

  async all<T = Record<string, unknown>>(): Promise<{ success: boolean; results: T[] }> {
    const stmt = this.db.prepare(this.sql);
    const results = stmt.all(...this.params) as T[];
    return { success: true, results };
  }

  async run(): Promise<{ success: boolean; meta: { changes: number; last_row_id: number } }> {
    const stmt = this.db.prepare(this.sql);
    const result = stmt.run(...this.params);
    return {
      success: true,
      meta: {
        changes: Number(result.changes),
        last_row_id: Number(result.lastInsertRowid),
      },
    };
  }
}

export class LocalD1Database {
  private db: DatabaseSync;

  constructor(dbPath = ':memory:', schemaSqlPath?: string) {
    if (dbPath !== ':memory:') {
      const dir = path.dirname(dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA foreign_keys = ON;');

    const resolvedSchemaPath =
      schemaSqlPath || path.resolve(process.cwd(), 'infrastructure/cloudflare/schema.sql');
    if (fs.existsSync(resolvedSchemaPath)) {
      const schema = fs.readFileSync(resolvedSchemaPath, 'utf8');
      this.db.exec(schema);
    }
  }

  prepare(sql: string): LocalD1PreparedStatement {
    return new LocalD1PreparedStatement(this.db, sql);
  }

  async exec(sql: string): Promise<{ count: number }> {
    this.db.exec(sql);
    return { count: 0 };
  }

  async batch(statements: LocalD1PreparedStatement[]): Promise<unknown[]> {
    const results: unknown[] = [];
    this.db.exec('BEGIN TRANSACTION;');
    try {
      for (const stmt of statements) {
        results.push(await stmt.run());
      }
      this.db.exec('COMMIT;');
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }
    return results;
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // ignore
    }
  }
}

export interface LocalR2ObjectBody {
  key: string;
  size: number;
  etag: string;
  httpMetadata?: { contentType?: string };
  arrayBuffer(): Promise<ArrayBuffer>;
  bytes(): Promise<Uint8Array>;
  text(): Promise<string>;
}

export class LocalR2Bucket {
  private persistDir?: string;
  private bucketDir: string;
  private memoryStore = new Map<
    string,
    {
      data: Uint8Array;
      meta: { key: string; size: number; etag: string; httpMetadata?: { contentType?: string } };
    }
  >();

  constructor(persistDir?: string) {
    this.persistDir = persistDir;
    this.bucketDir = persistDir ? path.resolve(persistDir, 'r2') : '';
    if (this.bucketDir && !fs.existsSync(this.bucketDir)) {
      fs.mkdirSync(this.bucketDir, { recursive: true });
    }
  }

  private getFilePath(key: string): string {
    const safeKey = key.replace(/[^a-zA-Z0-9-_.]/g, '__');
    return path.join(this.bucketDir, safeKey);
  }

  async put(
    key: string,
    value: Uint8Array | ArrayBuffer | string,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<void> {
    let bytes: Uint8Array;
    if (typeof value === 'string') {
      bytes = new TextEncoder().encode(value);
    } else if (value instanceof ArrayBuffer) {
      bytes = new Uint8Array(value);
    } else {
      bytes = value;
    }

    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    const etag = `"${hash}"`;
    const meta = {
      key,
      size: bytes.length,
      etag,
      httpMetadata: options?.httpMetadata,
    };

    if (this.persistDir) {
      const filePath = this.getFilePath(key);
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(filePath, bytes);
      fs.writeFileSync(`${filePath}.meta.json`, JSON.stringify(meta));
    } else {
      this.memoryStore.set(key, { data: bytes, meta });
    }
  }

  async get(key: string): Promise<LocalR2ObjectBody | null> {
    let bytes: Uint8Array;
    let meta: { key: string; size: number; etag: string; httpMetadata?: { contentType?: string } };

    if (this.persistDir) {
      const filePath = this.getFilePath(key);
      const metaPath = `${filePath}.meta.json`;
      if (!fs.existsSync(filePath) || !fs.existsSync(metaPath)) {
        return null;
      }
      bytes = new Uint8Array(fs.readFileSync(filePath));
      meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    } else {
      const item = this.memoryStore.get(key);
      if (!item) {
        return null;
      }
      bytes = item.data;
      meta = item.meta;
    }

    return {
      key: meta.key,
      size: meta.size,
      etag: meta.etag,
      httpMetadata: meta.httpMetadata,
      async arrayBuffer() {
        return bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ) as ArrayBuffer;
      },
      async bytes() {
        return bytes;
      },
      async text() {
        return new TextDecoder().decode(bytes);
      },
    };
  }

  async head(key: string): Promise<{
    key: string;
    size: number;
    etag: string;
    httpMetadata?: { contentType?: string };
  } | null> {
    const obj = await this.get(key);
    if (!obj) {
      return null;
    }
    return {
      key: obj.key,
      size: obj.size,
      etag: obj.etag,
      httpMetadata: obj.httpMetadata,
    };
  }

  async delete(key: string): Promise<void> {
    if (this.persistDir) {
      const filePath = this.getFilePath(key);
      const metaPath = `${filePath}.meta.json`;
      try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
      } catch {
        // ignore
      }
    } else {
      this.memoryStore.delete(key);
    }
  }

  async list(options?: { prefix?: string }): Promise<{
    objects: Array<{ key: string; size: number; etag: string }>;
  }> {
    const objects: Array<{ key: string; size: number; etag: string }> = [];
    const prefix = options?.prefix || '';

    if (this.persistDir) {
      if (fs.existsSync(this.bucketDir)) {
        const files = fs.readdirSync(this.bucketDir);
        for (const file of files) {
          if (file.endsWith('.meta.json')) {
            try {
              const metaPath = path.join(this.bucketDir, file);
              const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
              if (meta.key.startsWith(prefix)) {
                objects.push({ key: meta.key, size: meta.size, etag: meta.etag });
              }
            } catch {
              // ignore
            }
          }
        }
      }
    } else {
      for (const [key, item] of this.memoryStore.entries()) {
        if (key.startsWith(prefix)) {
          objects.push({ key: item.meta.key, size: item.meta.size, etag: item.meta.etag });
        }
      }
    }

    return { objects };
  }
}

export class LocalSqlStorage {
  private db: DatabaseSync;
  public rowsRead = 0;
  public rowsWritten = 0;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  exec<T = Record<string, unknown>>(
    query: string,
    ...bindings: SQLInputValue[]
  ): { toArray(): T[]; one(): T; rowsRead: number; rowsWritten: number } {
    const stmt = this.db.prepare(query);
    const isWrite = /^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)/i.test(query);
    let rows: T[] = [];
    if (isWrite) {
      const res = stmt.run(...bindings);
      this.rowsWritten += Number(res.changes || 0);
    } else {
      rows = stmt.all(...bindings) as T[];
      this.rowsRead += rows.length;
    }

    const currentRowsRead = this.rowsRead;
    const currentRowsWritten = this.rowsWritten;
    return {
      toArray() {
        return rows;
      },
      one() {
        return rows[0] as T;
      },
      rowsRead: currentRowsRead,
      rowsWritten: currentRowsWritten,
    };
  }
}

export class LocalDurableObjectState {
  public readonly id: { toString(): string; name?: string };
  public readonly storage: {
    sql: LocalSqlStorage;
    get<T>(key: string): Promise<T | undefined>;
    put<T>(key: string, val: T): Promise<void>;
    delete(key: string): Promise<boolean>;
  };
  private websockets = new Set<WebSocket>();
  private wsTags = new Map<WebSocket, string[]>();
  private kvStore = new Map<string, unknown>();
  private db: DatabaseSync;

  constructor(id: { toString(): string; name?: string }, db: DatabaseSync) {
    this.id = id;
    this.db = db;
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS _do_kv (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);',
    );
    const sqlStorage = new LocalSqlStorage(db);
    const kv = this.kvStore;

    this.storage = {
      sql: sqlStorage,
      async get<T>(key: string): Promise<T | undefined> {
        if (kv.has(key)) {
          return kv.get(key) as T | undefined;
        }
        const row = db.prepare('SELECT value_json FROM _do_kv WHERE key = ?').get(key) as
          | { value_json: string }
          | undefined;
        if (!row) return undefined;
        const parsed = JSON.parse(row.value_json) as T;
        kv.set(key, parsed);
        return parsed;
      },
      async put<T>(key: string, val: T): Promise<void> {
        kv.set(key, val);
        db.prepare('INSERT OR REPLACE INTO _do_kv (key, value_json) VALUES (?, ?)').run(
          key,
          JSON.stringify(val),
        );
      },
      async delete(key: string): Promise<boolean> {
        const existed = kv.delete(key);
        const res = db.prepare('DELETE FROM _do_kv WHERE key = ?').run(key);
        return existed || Number(res.changes) > 0;
      },
    };
  }

  acceptWebSocket(ws: WebSocket, tags: string[] = []): void {
    this.websockets.add(ws);
    this.wsTags.set(ws, tags);
  }

  getWebSockets(tag?: string): WebSocket[] {
    if (!tag) {
      return Array.from(this.websockets);
    }
    const result: WebSocket[] = [];
    for (const ws of this.websockets) {
      const tags = this.wsTags.get(ws) || [];
      if (tags.includes(tag)) {
        result.push(ws);
      }
    }
    return result;
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // ignore
    }
  }
}

export class LocalDurableObjectNamespace {
  private persistDir?: string;
  private doDir: string;
  private states = new Map<string, LocalDurableObjectState>();
  private dbs = new Map<string, DatabaseSync>();

  constructor(persistDir?: string) {
    this.persistDir = persistDir;
    this.doDir = persistDir ? path.resolve(persistDir, 'do') : '';
    if (this.doDir && !fs.existsSync(this.doDir)) {
      fs.mkdirSync(this.doDir, { recursive: true });
    }
  }

  idFromName(name: string): { toString(): string; name: string } {
    const hash = crypto.createHash('sha256').update(name).digest('hex');
    return {
      toString() {
        return hash;
      },
      name,
    };
  }

  getState(idOrName: string | { toString(): string; name?: string }): LocalDurableObjectState {
    const strId = typeof idOrName === 'string' ? idOrName : idOrName.toString();
    const name = typeof idOrName === 'object' && idOrName !== null ? idOrName.name : undefined;

    if (this.states.has(strId)) {
      return this.states.get(strId)!;
    }

    let dbPath = ':memory:';
    if (this.persistDir) {
      dbPath = path.join(this.doDir, `${strId}.sqlite`);
      const dir = path.dirname(dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }

    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA foreign_keys = ON;');
    const schemaPath = path.resolve(process.cwd(), 'infrastructure/cloudflare/schema.sql');
    if (fs.existsSync(schemaPath)) {
      const schema = fs.readFileSync(schemaPath, 'utf8');
      db.exec(schema);
    }

    this.dbs.set(strId, db);
    const state = new LocalDurableObjectState({ toString: () => strId, name }, db);
    this.states.set(strId, state);
    return state;
  }

  closeAll(): void {
    for (const state of this.states.values()) {
      state.close();
    }
    this.states.clear();
    this.dbs.clear();
  }
}

export function createLocalCloudflareEnv(options?: { persistDir?: string; adminToken?: string }): {
  DB: LocalD1Database;
  ASSETS_BUCKET: LocalR2Bucket;
  SESSION_COORDINATOR: LocalDurableObjectNamespace;
  ADMIN_TOKEN: string;
  ENVIRONMENT: 'local';
  close(): void;
} {
  const db = new LocalD1Database(
    options?.persistDir ? path.join(options.persistDir, 'd1.sqlite') : ':memory:',
  );
  const r2 = new LocalR2Bucket(options?.persistDir);
  const doNamespace = new LocalDurableObjectNamespace(options?.persistDir);
  const adminToken = options?.adminToken || 'local-admin-token';

  return {
    DB: db,
    ASSETS_BUCKET: r2,
    SESSION_COORDINATOR: doNamespace,
    ADMIN_TOKEN: adminToken,
    ENVIRONMENT: 'local',
    close() {
      db.close();
      doNamespace.closeAll();
    },
  };
}
