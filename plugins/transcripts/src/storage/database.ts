import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { logInfo, logWarn } from '../shared/logger.js';
import { resolvePluginRoot } from '../shared/paths.js';

export interface SyncCheckpoint {
  mtime: number;
  linesTotal: number;
  linesIndexed: number;
  projectPath: string;
  sessionTimestamp: number;
  status: string;
}

export class TranscriptStore {
  private readonly db: DatabaseSync;
  private sqliteVecLoaded = false;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath, {
      allowExtension: true,
      enableForeignKeyConstraints: true,
    });

    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 5000');

    this.tryLoadSqliteVec();
    this.initializeSchema();
  }

  private tryLoadSqliteVec(): void {
    const pluginRoot = resolvePluginRoot();
    const arch = os.arch() === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
    const extensionPath = path.join(pluginRoot, 'vendor', 'sqlite-vec', arch, 'vec0');

    if (!existsSync(`${extensionPath}.dylib`)) {
      logWarn('sqlite-vec extension not found, using app-side cosine fallback', { arch });
      return;
    }

    try {
      this.db.loadExtension(extensionPath);
      this.sqliteVecLoaded = true;
      logInfo('sqlite-vec extension loaded');
    } catch (error) {
      logWarn('Failed to load sqlite-vec, using app-side cosine fallback', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sync_progress (
        transcript_path    TEXT PRIMARY KEY,
        file_mtime         INTEGER NOT NULL,
        lines_total        INTEGER NOT NULL DEFAULT 0,
        lines_indexed      INTEGER NOT NULL DEFAULT 0,
        project_path       TEXT NOT NULL DEFAULT '',
        session_timestamp  INTEGER NOT NULL DEFAULT 0,
        status             TEXT NOT NULL CHECK(status IN ('complete', 'partial', 'error'))
      );

      CREATE TABLE IF NOT EXISTS chunks (
        chunk_id          TEXT PRIMARY KEY,
        transcript_path   TEXT NOT NULL,
        line_number       INTEGER NOT NULL,
        role              TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
        chunk_text        TEXT NOT NULL,
        chunk_index       INTEGER NOT NULL DEFAULT 0,
        session_timestamp INTEGER NOT NULL,
        project_path      TEXT NOT NULL,
        FOREIGN KEY (transcript_path) REFERENCES sync_progress(transcript_path)
      );

      CREATE TABLE IF NOT EXISTS chunk_embeddings (
        chunk_id    TEXT PRIMARY KEY,
        vector_json TEXT NOT NULL,
        FOREIGN KEY (chunk_id) REFERENCES chunks(chunk_id)
      );

      CREATE INDEX IF NOT EXISTS idx_chunks_transcript
        ON chunks(transcript_path);
      CREATE INDEX IF NOT EXISTS idx_chunks_project
        ON chunks(project_path);
    `);

    this.migrateSchema();
  }

  private migrateSchema(): void {
    const columns = this.db
      .prepare("PRAGMA table_info(sync_progress)")
      .all() as Array<{ name: string }>;
    const columnNames = new Set(columns.map((c) => c.name));

    if (!columnNames.has('lines_total')) {
      this.db.exec("ALTER TABLE sync_progress ADD COLUMN lines_total INTEGER NOT NULL DEFAULT 0");
    }
    if (!columnNames.has('project_path')) {
      this.db.exec("ALTER TABLE sync_progress ADD COLUMN project_path TEXT NOT NULL DEFAULT ''");
    }
    if (!columnNames.has('session_timestamp')) {
      this.db.exec("ALTER TABLE sync_progress ADD COLUMN session_timestamp INTEGER NOT NULL DEFAULT 0");
    }
  }

  getCheckpoint(transcriptPath: string): SyncCheckpoint | null {
    const row = this.db
      .prepare(
        `SELECT file_mtime, lines_total, lines_indexed, project_path, session_timestamp, status
         FROM sync_progress WHERE transcript_path = ?`,
      )
      .get(transcriptPath) as {
      file_mtime: number;
      lines_total: number;
      lines_indexed: number;
      project_path: string;
      session_timestamp: number;
      status: string;
    } | undefined;

    if (!row) return null;
    return {
      mtime: row.file_mtime,
      linesTotal: row.lines_total,
      linesIndexed: row.lines_indexed,
      projectPath: row.project_path,
      sessionTimestamp: row.session_timestamp,
      status: row.status,
    };
  }

  deleteChunksForTranscript(transcriptPath: string): void {
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare('DELETE FROM chunk_embeddings WHERE chunk_id IN (SELECT chunk_id FROM chunks WHERE transcript_path = ?)')
        .run(transcriptPath);
      this.db
        .prepare('DELETE FROM chunks WHERE transcript_path = ?')
        .run(transcriptPath);
      this.db
        .prepare('DELETE FROM sync_progress WHERE transcript_path = ?')
        .run(transcriptPath);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  insertChunk(chunk: {
    chunkId: string;
    transcriptPath: string;
    lineNumber: number;
    role: string;
    chunkText: string;
    chunkIndex: number;
    sessionTimestamp: number;
    projectPath: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO chunks (chunk_id, transcript_path, line_number, role, chunk_text, chunk_index, session_timestamp, project_path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        chunk.chunkId,
        chunk.transcriptPath,
        chunk.lineNumber,
        chunk.role,
        chunk.chunkText,
        chunk.chunkIndex,
        chunk.sessionTimestamp,
        chunk.projectPath,
      );
  }

  insertEmbedding(chunkId: string, vector: number[]): void {
    this.db
      .prepare('INSERT INTO chunk_embeddings (chunk_id, vector_json) VALUES (?, ?)')
      .run(chunkId, JSON.stringify(vector));
  }

  setCheckpoint(
    transcriptPath: string,
    mtime: number,
    linesTotal: number,
    linesIndexed: number,
    projectPath: string,
    sessionTimestamp: number,
    status: string,
  ): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO sync_progress
         (transcript_path, file_mtime, lines_total, lines_indexed, project_path, session_timestamp, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(transcriptPath, mtime, linesTotal, linesIndexed, projectPath, sessionTimestamp, status);
  }

  getAllEmbeddings(): Array<{
    chunkId: string;
    transcriptPath: string;
    lineNumber: number;
    role: string;
    chunkText: string;
    sessionTimestamp: number;
    projectPath: string;
    vector: number[];
  }> {
    const rows = this.db
      .prepare(
        `SELECT c.chunk_id, c.transcript_path, c.line_number, c.role, c.chunk_text,
                c.session_timestamp, c.project_path, e.vector_json
         FROM chunks c
         JOIN chunk_embeddings e ON c.chunk_id = e.chunk_id`,
      )
      .all() as Array<{
      chunk_id: string;
      transcript_path: string;
      line_number: number;
      role: string;
      chunk_text: string;
      session_timestamp: number;
      project_path: string;
      vector_json: string;
    }>;

    return rows.map((row) => ({
      chunkId: row.chunk_id,
      transcriptPath: row.transcript_path,
      lineNumber: row.line_number,
      role: row.role,
      chunkText: row.chunk_text,
      sessionTimestamp: row.session_timestamp,
      projectPath: row.project_path,
      vector: JSON.parse(row.vector_json) as number[],
    }));
  }

  getSyncStats(): { total: number; complete: number; errors: number; chunks: number; embeddings: number } {
    const progress = this.db
      .prepare('SELECT status, COUNT(*) as cnt FROM sync_progress GROUP BY status')
      .all() as Array<{ status: string; cnt: number }>;

    let complete = 0;
    let errors = 0;
    let total = 0;
    for (const row of progress) {
      total += row.cnt;
      if (row.status === 'complete') complete = row.cnt;
      if (row.status === 'error') errors = row.cnt;
    }

    const chunkRow = this.db
      .prepare('SELECT COUNT(*) as cnt FROM chunks')
      .get() as { cnt: number };
    const embeddingRow = this.db
      .prepare('SELECT COUNT(*) as cnt FROM chunk_embeddings')
      .get() as { cnt: number };

    return { total, complete, errors, chunks: chunkRow.cnt, embeddings: embeddingRow.cnt };
  }

  getAllSyncedPaths(): Set<string> {
    const rows = this.db
      .prepare('SELECT transcript_path FROM sync_progress')
      .all() as Array<{ transcript_path: string }>;
    return new Set(rows.map((r) => r.transcript_path));
  }

  beginTransaction(): void {
    this.db.exec('BEGIN');
  }

  commitTransaction(): void {
    this.db.exec('COMMIT');
  }

  rollbackTransaction(): void {
    this.db.exec('ROLLBACK');
  }

  close(): void {
    this.db.close();
  }
}
