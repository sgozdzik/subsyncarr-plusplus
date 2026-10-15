import Database from 'better-sqlite3';

export interface Run {
  id: string;
  start_time: number;
  end_time: number | null;
  total_files: number;
  completed: number;
  skipped: number;
  failed: number;
  total_engines: number;
  completed_engines: number;
  status: 'running' | 'completed' | 'cancelled';
  logs: string;
  source: RunSource;
}

/** What started a run: the schedule, a dashboard button, or files picked in the Library. */
export type RunSource = 'scheduled' | 'manual' | 'manual-paths' | 'library';

/** Result details stored with the per-file, per-engine state (for the Library and Diagnostics pages). */
export interface EngineRunDetails {
  message: string;
  details?: string;
  durationMs?: number;
}

export interface FileResult {
  id: number;
  run_id: string;
  file_path: string;
  video_path: string | null;
  status: 'pending' | 'processing' | 'completed' | 'skipped' | 'error';
  current_engine: string | null;
  engines: string; // JSON stringified { ffsubsync?: {...}, autosubsync?: {...}, alass?: {...} }
  created_at: number;
  updated_at: number;
}

export interface EngineFailureTracking {
  id: number;
  file_path: string;
  engine: string;
  consecutive_failures: number;
  last_failure_time: number | null;
  last_success_time: number | null;
  is_skipped: boolean;
  last_status: 'success' | 'failure' | null;
  last_message: string | null;
  last_details: string | null;
  last_duration_ms: number | null;
  last_run_time: number | null;
  created_at: number;
  updated_at: number;
}

export interface FileHistoryEntry extends FileResult {
  run_start_time: number;
  run_source: RunSource | null;
}

export class SubsyncarrPlusDatabase {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.initSchema();
  }

  private initSchema() {
    // Optimize SQLite for low memory usage
    this.db.pragma('cache_size = -1000'); // 1MB cache (negative means KB)
    this.db.pragma('mmap_size = 0'); // Disable memory-mapping
    this.db.pragma('journal_mode = WAL'); // Better concurrency
    this.db.pragma('temp_store = MEMORY'); // Keep temp data in memory
    this.db.pragma('auto_vacuum = INCREMENTAL'); // Reclaim space gradually

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        start_time INTEGER NOT NULL,
        end_time INTEGER,
        total_files INTEGER NOT NULL,
        completed INTEGER DEFAULT 0,
        skipped INTEGER DEFAULT 0,
        failed INTEGER DEFAULT 0,
        total_engines INTEGER DEFAULT 0,
        completed_engines INTEGER DEFAULT 0,
        status TEXT NOT NULL,
        logs TEXT DEFAULT ''
      );

      CREATE TABLE IF NOT EXISTS file_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        video_path TEXT,
        status TEXT NOT NULL,
        current_engine TEXT,
        engines TEXT DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY(run_id) REFERENCES runs(id)
      );

      CREATE INDEX IF NOT EXISTS idx_file_results_run
        ON file_results(run_id);
      CREATE INDEX IF NOT EXISTS idx_file_results_status
        ON file_results(status);
    `);

    // Migration: Add logs column if it doesn't exist
    const columns = this.db.pragma('table_info(runs)') as Array<{ name: string }>;
    const hasLogsColumn = columns.some((col) => col.name === 'logs');
    if (!hasLogsColumn) {
      this.db.exec(`ALTER TABLE runs ADD COLUMN logs TEXT DEFAULT ''`);
    }

    // Migration: Add total_engines and completed_engines columns if they don't exist
    const hasTotalEnginesColumn = columns.some((col) => col.name === 'total_engines');
    if (!hasTotalEnginesColumn) {
      this.db.exec(`ALTER TABLE runs ADD COLUMN total_engines INTEGER DEFAULT 0`);
    }
    const hasCompletedEnginesColumn = columns.some((col) => col.name === 'completed_engines');
    if (!hasCompletedEnginesColumn) {
      this.db.exec(`ALTER TABLE runs ADD COLUMN completed_engines INTEGER DEFAULT 0`);
    }

    // Migration: Create engine_failure_tracking table
    const tables = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='engine_failure_tracking'")
      .all();
    if (tables.length === 0) {
      this.db.exec(`
        CREATE TABLE engine_failure_tracking (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          file_path TEXT NOT NULL,
          engine TEXT NOT NULL,
          consecutive_failures INTEGER DEFAULT 0,
          last_failure_time INTEGER,
          last_success_time INTEGER,
          is_skipped BOOLEAN DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(file_path, engine)
        );

        CREATE INDEX idx_failure_tracking_file ON engine_failure_tracking(file_path);
        CREATE INDEX idx_failure_tracking_skipped ON engine_failure_tracking(is_skipped);
      `);
    }

    // Migration (Subsyncarr++): what started a run
    if (!columns.some((col) => col.name === 'source')) {
      this.db.exec(`ALTER TABLE runs ADD COLUMN source TEXT DEFAULT 'scheduled'`);
    }

    // Migration (Subsyncarr++): last result per file and engine, shown in the Library / Diagnostics
    const trackingColumns = this.db.pragma('table_info(engine_failure_tracking)') as Array<{ name: string }>;
    const addTrackingColumn = (name: string, type: string) => {
      if (!trackingColumns.some((col) => col.name === name)) {
        this.db.exec(`ALTER TABLE engine_failure_tracking ADD COLUMN ${name} ${type}`);
      }
    };
    addTrackingColumn('last_status', 'TEXT');
    addTrackingColumn('last_message', 'TEXT');
    addTrackingColumn('last_details', 'TEXT');
    addTrackingColumn('last_duration_ms', 'INTEGER');
    addTrackingColumn('last_run_time', 'INTEGER');

    // Migration (Subsyncarr++): settings changed in the web UI (override environment variables)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_file_results_path ON file_results(file_path);
    `);
  }

  // Settings methods
  getSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? row.value : null;
  }

  setSetting(key: string, value: string | null): void {
    if (value === null) {
      this.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, Date.now());
  }

  // Run methods
  createRun(id: string, totalFiles: number, source: RunSource = 'scheduled'): void {
    const stmt = this.db.prepare(`
      INSERT INTO runs (id, start_time, total_files, status, source)
      VALUES (?, ?, ?, 'running', ?)
    `);
    stmt.run(id, Date.now(), totalFiles, source);
  }

  updateRun(id: string, updates: Partial<Run>): void {
    const fields = Object.keys(updates)
      .map((k) => `${k} = ?`)
      .join(', ');
    const values = Object.values(updates);
    this.db.prepare(`UPDATE runs SET ${fields} WHERE id = ?`).run(...values, id);
  }

  getRun(id: string): Run | null {
    const result = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id);
    return result ? (result as Run) : null;
  }

  getRunHistory(limit: number = 50): Run[] {
    return this.db
      .prepare(
        `
      SELECT * FROM runs
      ORDER BY start_time DESC
      LIMIT ?
    `,
      )
      .all(limit) as Run[];
  }

  /**
   * Delete old runs and their associated file results
   */
  deleteOldRuns(olderThanDays: number): number {
    const cutoffTime = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;

    // Use transaction for atomicity
    const deleteFiles = this.db.prepare(
      'DELETE FROM file_results WHERE run_id IN (SELECT id FROM runs WHERE start_time < ?)',
    );
    const deleteRuns = this.db.prepare('DELETE FROM runs WHERE start_time < ?');

    const transaction = this.db.transaction(() => {
      deleteFiles.run(cutoffTime);
      const result = deleteRuns.run(cutoffTime);
      return result.changes;
    });

    return transaction();
  }

  /**
   * Trim logs for runs older than specified days, keeping only summary
   */
  trimOldLogs(olderThanDays: number, maxLogLength: number = 1000): number {
    const cutoffTime = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;

    const stmt = this.db.prepare(`
      UPDATE runs
      SET logs = SUBSTR(logs, 1, ?) || '\n... (log trimmed to save space)'
      WHERE start_time < ? AND LENGTH(logs) > ?
    `);

    const result = stmt.run(maxLogLength, cutoffTime, maxLogLength);
    return result.changes;
  }

  /**
   * Vacuum database to reclaim space after deletions
   */
  vacuum(): void {
    this.db.pragma('incremental_vacuum');
  }

  /**
   * Get database file size statistics
   */
  getDatabaseStats(): { sizeBytes: number; pageCount: number; pageSize: number } {
    const pageCount = this.db.pragma('page_count', { simple: true }) as number;
    const pageSize = this.db.pragma('page_size', { simple: true }) as number;

    return {
      pageCount,
      pageSize,
      sizeBytes: pageCount * pageSize,
    };
  }

  // File methods
  createFileResult(runId: string, filePath: string, videoPath: string | null): void {
    const stmt = this.db.prepare(`
      INSERT INTO file_results
        (run_id, file_path, video_path, status, created_at, updated_at)
      VALUES (?, ?, ?, 'pending', ?, ?)
    `);
    const now = Date.now();
    stmt.run(runId, filePath, videoPath, now, now);
  }

  updateFileResult(runId: string, filePath: string, updates: Partial<FileResult>): void {
    const updatesWithTimestamp = { ...updates, updated_at: Date.now() };
    const fields = Object.keys(updatesWithTimestamp)
      .map((k) => `${k} = ?`)
      .join(', ');
    const values = Object.values(updatesWithTimestamp);
    this.db
      .prepare(
        `
      UPDATE file_results
      SET ${fields}
      WHERE run_id = ? AND file_path = ?
    `,
      )
      .run(...values, runId, filePath);
  }

  getFileResults(runId: string): FileResult[] {
    return this.db
      .prepare(
        `
      SELECT * FROM file_results
      WHERE run_id = ?
      ORDER BY created_at ASC
    `,
      )
      .all(runId) as FileResult[];
  }

  /** Recent results for one file across runs (newest first). */
  getFileHistory(filePath: string, limit: number = 10): FileHistoryEntry[] {
    return this.db
      .prepare(
        `SELECT f.*, r.start_time AS run_start_time, r.source AS run_source
         FROM file_results f JOIN runs r ON r.id = f.run_id
         WHERE f.file_path = ?
         ORDER BY f.id DESC
         LIMIT ?`,
      )
      .all(filePath, limit) as FileHistoryEntry[];
  }

  // Engine failure tracking methods
  getEngineFailureTracking(filePath: string, engine: string): EngineFailureTracking | null {
    return this.db
      .prepare(
        `SELECT * FROM engine_failure_tracking
         WHERE file_path = ? AND engine = ?`,
      )
      .get(filePath, engine) as EngineFailureTracking | null;
  }

  getAllSkippedEngines(filePath: string, maxFailures: number): string[] {
    const results = this.db
      .prepare(
        `SELECT engine FROM engine_failure_tracking
         WHERE file_path = ? AND consecutive_failures >= ?`,
      )
      .all(filePath, maxFailures) as Array<{ engine: string }>;
    return results.map((r) => r.engine);
  }

  recordEngineFailure(
    filePath: string,
    engine: string,
    maxFailures: number,
    details?: EngineRunDetails,
    countsTowardsLimit = true,
  ): void {
    const existing = this.getEngineFailureTracking(filePath, engine);
    const now = Date.now();
    const failures = (existing?.consecutive_failures ?? 0) + (countsTowardsLimit ? 1 : 0);

    this.db
      .prepare(
        `
      INSERT INTO engine_failure_tracking
        (file_path, engine, consecutive_failures, last_failure_time, is_skipped,
         last_status, last_message, last_details, last_duration_ms, last_run_time, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'failure', ?, ?, ?, ?, ?, ?)
      ON CONFLICT(file_path, engine) DO UPDATE SET
        consecutive_failures = excluded.consecutive_failures,
        last_failure_time = excluded.last_failure_time,
        is_skipped = excluded.is_skipped,
        last_status = 'failure',
        last_message = excluded.last_message,
        last_details = excluded.last_details,
        last_duration_ms = excluded.last_duration_ms,
        last_run_time = excluded.last_run_time,
        updated_at = excluded.updated_at
    `,
      )
      .run(
        filePath,
        engine,
        failures,
        now,
        failures >= maxFailures ? 1 : 0,
        details?.message ?? null,
        details?.details ?? null,
        details?.durationMs ?? null,
        now,
        now,
        now,
      );
  }

  recordEngineSuccess(filePath: string, engine: string, details?: EngineRunDetails): void {
    const now = Date.now();
    this.db
      .prepare(
        `
      INSERT INTO engine_failure_tracking
        (file_path, engine, consecutive_failures, last_success_time, is_skipped,
         last_status, last_message, last_details, last_duration_ms, last_run_time, created_at, updated_at)
      VALUES (?, ?, 0, ?, 0, 'success', ?, ?, ?, ?, ?, ?)
      ON CONFLICT(file_path, engine) DO UPDATE SET
        consecutive_failures = 0,
        last_success_time = excluded.last_success_time,
        is_skipped = 0,
        last_status = 'success',
        last_message = excluded.last_message,
        last_details = excluded.last_details,
        last_duration_ms = excluded.last_duration_ms,
        last_run_time = excluded.last_run_time,
        updated_at = excluded.updated_at
    `,
      )
      .run(
        filePath,
        engine,
        now,
        details?.message ?? null,
        details?.details ?? null,
        details?.durationMs ?? null,
        now,
        now,
        now,
      );
  }

  /** Every file/engine state row; the Library joins these with the files on disk. */
  getAllEngineStates(): EngineFailureTracking[] {
    return this.db.prepare('SELECT * FROM engine_failure_tracking').all() as EngineFailureTracking[];
  }

  getEngineStatesForFile(filePath: string): EngineFailureTracking[] {
    return this.db
      .prepare('SELECT * FROM engine_failure_tracking WHERE file_path = ? ORDER BY engine')
      .all(filePath) as EngineFailureTracking[];
  }

  getRecentFailures(limit: number = 50): EngineFailureTracking[] {
    return this.db
      .prepare(
        `SELECT * FROM engine_failure_tracking
         WHERE last_status = 'failure'
         ORDER BY last_failure_time DESC
         LIMIT ?`,
      )
      .all(limit) as EngineFailureTracking[];
  }

  getAutoSkipped(maxFailures: number): EngineFailureTracking[] {
    return this.db
      .prepare(
        `SELECT * FROM engine_failure_tracking
         WHERE consecutive_failures >= ?
         ORDER BY last_failure_time DESC`,
      )
      .all(maxFailures) as EngineFailureTracking[];
  }

  resetEngineSkipStatus(filePath: string, engine?: string): void {
    const now = Date.now();

    if (engine) {
      // Reset specific engine for specific file
      this.db
        .prepare(
          `
        UPDATE engine_failure_tracking
        SET consecutive_failures = 0,
            is_skipped = 0,
            updated_at = ?
        WHERE file_path = ? AND engine = ?
      `,
        )
        .run(now, filePath, engine);
    } else {
      // Reset all engines for specific file
      this.db
        .prepare(
          `
        UPDATE engine_failure_tracking
        SET consecutive_failures = 0,
            is_skipped = 0,
            updated_at = ?
        WHERE file_path = ?
      `,
        )
        .run(now, filePath);
    }
  }

  getFailureTrackingStats(maxFailures: number): {
    totalSkipped: number;
    skippedByEngine: Record<string, number>;
  } {
    const totalSkipped = this.db
      .prepare('SELECT COUNT(DISTINCT file_path) as count FROM engine_failure_tracking WHERE consecutive_failures >= ?')
      .get(maxFailures) as { count: number };

    const byEngine = this.db
      .prepare(
        `SELECT engine, COUNT(*) as count FROM engine_failure_tracking
         WHERE consecutive_failures >= ? GROUP BY engine`,
      )
      .all(maxFailures) as Array<{ engine: string; count: number }>;

    const skippedByEngine: Record<string, number> = {};
    byEngine.forEach((row) => {
      skippedByEngine[row.engine] = row.count;
    });

    return { totalSkipped: totalSkipped.count, skippedByEngine };
  }

  close() {
    this.db.close();
  }
}
