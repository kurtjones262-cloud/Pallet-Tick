import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, StatementSync } from 'node:sqlite';
import { D1Database, D1PreparedStatement, D1Response, D1Result } from './types.ts';

class NodeSqlitePreparedStatement implements D1PreparedStatement {
  private stmt: StatementSync;
  private boundValues: unknown[] = [];

  constructor(stmt: StatementSync, boundValues: unknown[] = []) {
    this.stmt = stmt;
    this.boundValues = boundValues;
  }

  bind(...values: unknown[]): D1PreparedStatement {
    return new NodeSqlitePreparedStatement(this.stmt, values);
  }

  async first<T = unknown>(colName?: string): Promise<T | null> {
    try {
      const row = this.stmt.get(...(this.boundValues as any[])) as Record<string, unknown> | undefined;
      if (!row) return null;
      if (colName) {
        return (row[colName] as T) ?? null;
      }
      return row as T;
    } catch (err) {
      console.error('NodeSqlitePreparedStatement.first error:', err);
      throw err;
    }
  }

  async run<T = unknown>(): Promise<D1Response> {
    try {
      const res = this.stmt.run(...(this.boundValues as any[]));
      return {
        success: true,
        meta: {
          changes: res.changes,
          last_row_id: Number(res.lastInsertRowid),
        },
      };
    } catch (err: any) {
      console.error('NodeSqlitePreparedStatement.run error:', err);
      throw err;
    }
  }

  async all<T = unknown>(): Promise<D1Result<T>> {
    try {
      const rows = this.stmt.all(...(this.boundValues as any[])) as T[];
      return {
        success: true,
        results: rows,
        meta: { count: rows.length },
      };
    } catch (err: any) {
      console.error('NodeSqlitePreparedStatement.all error:', err);
      throw err;
    }
  }

  async raw<T = unknown>(): Promise<T[]> {
    const res = await this.all<T>();
    return res.results;
  }
}

export class NodeSqliteD1Adapter implements D1Database {
  private db: DatabaseSync;

  constructor(dbPath: string, schemaSql?: string) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA journal_mode = WAL;');

    if (schemaSql) {
      this.db.exec(schemaSql);
    }

    // Safely apply Phase 2 migrations if existing database was created in Phase 1
    const safeAddCol = (table: string, colDef: string) => {
      try {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${colDef}`);
      } catch {}
    };

    safeAddCol('users', 'employee_code TEXT');
    safeAddCol('users', 'pin_salt TEXT');
    safeAddCol('users', 'last_login_at TEXT');
    safeAddCol('users', 'failed_login_attempts INTEGER NOT NULL DEFAULT 0');
    safeAddCol('users', 'locked_until TEXT');
    safeAddCol('users', 'created_by TEXT');

    safeAddCol('scan_events', 'employee_name TEXT');
    safeAddCol('scan_events', 'employee_role TEXT');
    safeAddCol('scan_events', "event_action TEXT DEFAULT 'part_scan'");

    safeAddCol('delivery_parts', 'revision TEXT');
    safeAddCol('delivery_parts', 'manually_edited INTEGER NOT NULL DEFAULT 0');
    safeAddCol('delivery_parts', 'original_ocr_values TEXT');
    safeAddCol('delivery_parts', 'last_edited_by TEXT');
    safeAddCol('delivery_parts', 'last_edited_at TEXT');

    // Upgrade users table if an older local SQLite table had a restrictive role CHECK constraint
    try {
      const tblInfo = this.db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'")
        .get() as { sql?: string } | undefined;
      if (tblInfo?.sql && tblInfo.sql.includes('CHECK') && !tblInfo.sql.includes('super_admin')) {
        this.db.exec('PRAGMA foreign_keys = OFF;');
        this.db.exec(`
          CREATE TABLE users_new (
            id TEXT PRIMARY KEY,
            employee_name TEXT NOT NULL,
            employee_code TEXT UNIQUE,
            pin_hash TEXT,
            pin_salt TEXT,
            role TEXT NOT NULL DEFAULT 'employee' CHECK (role IN ('super_admin', 'admin', 'supervisor', 'employee', 'operator')),
            active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
            failed_login_attempts INTEGER NOT NULL DEFAULT 0,
            locked_until TEXT,
            last_login_at TEXT,
            created_by TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          INSERT INTO users_new (
            id, employee_name, employee_code, pin_hash, pin_salt, role, active,
            failed_login_attempts, locked_until, last_login_at, created_by, created_at, updated_at
          )
          SELECT
            id, employee_name, employee_code, pin_hash, pin_salt,
            CASE WHEN role IN ('receiver', 'operator') THEN 'employee' ELSE role END,
            active, COALESCE(failed_login_attempts, 0), locked_until, last_login_at, created_by, created_at, updated_at
          FROM users;
          DROP TABLE users;
          ALTER TABLE users_new RENAME TO users;
        `);
        this.db.exec('PRAGMA foreign_keys = ON;');
      }
    } catch {}

    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          last_activity_at TEXT NOT NULL,
          user_agent TEXT,
          ip_address TEXT
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_users_employee_code ON users(employee_code);
        CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
        CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
        CREATE INDEX IF NOT EXISTS idx_scans_user ON scan_events(user_id);
      `);
    } catch {}
  }


  prepare(query: string): D1PreparedStatement {
    const stmt = this.db.prepare(query);
    return new NodeSqlitePreparedStatement(stmt);
  }

  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    this.db.exec('BEGIN TRANSACTION;');
    try {
      const results: D1Result<T>[] = [];
      for (const st of statements) {
        const res = await st.all<T>();
        results.push(res);
      }
      this.db.exec('COMMIT;');
      return results;
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }
  }

  async exec(query: string): Promise<{ count: number; duration: number }> {
    const start = performance.now();
    this.db.exec(query);
    const duration = performance.now() - start;
    return { count: 1, duration };
  }
}

let singletonInstance: NodeSqliteD1Adapter | null = null;

export function getLocalDevDatabase(customDbPath?: string): D1Database {
  if (!singletonInstance) {
    const rootDir = process.cwd();
    const dbPath = customDbPath || path.resolve(rootDir, '.data', 'pallettrack.db');
    const schemaFile = path.resolve(rootDir, 'schema.sql');
    let schemaSql = '';
    if (fs.existsSync(schemaFile)) {
      schemaSql = fs.readFileSync(schemaFile, 'utf-8');
    }
    singletonInstance = new NodeSqliteD1Adapter(dbPath, schemaSql);
  }
  return singletonInstance;
}
