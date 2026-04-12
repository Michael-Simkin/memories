import { readFileSync } from 'node:fs';

import { logError, logInfo } from '../shared/logger.js';
import { removeSyncLockIfOwned, writeSyncLock } from '../shared/lockfile.js';
import { ensureGlobalDirectories } from '../shared/paths.js';
import { type SyncCheckpoint, TranscriptStore } from '../storage/database.js';
import { chunkTurns } from './chunker.js';
import { EmbeddingClient } from './embedder.js';
import { parseTranscriptFile } from './parser.js';
import { scanTranscripts } from './scanner.js';

const MAX_RESCAN_ROUNDS = 10;

async function run(): Promise<void> {
  const paths = await ensureGlobalDirectories();

  await writeSyncLock(paths.syncLockPath);
  logInfo('Sync started');

  const store = new TranscriptStore(paths.dbPath);
  const embedder = new EmbeddingClient();

  try {
    let round = 0;
    let totalIndexed = 0;
    let totalDelta = 0;
    let totalSkipped = 0;
    let totalErrors = 0;

    while (round < MAX_RESCAN_ROUNDS) {
      round++;
      const transcripts = scanTranscripts(paths.claudeProjectsDir);
      let changesThisRound = 0;

      for (const transcript of transcripts) {
        const checkpoint = store.getCheckpoint(transcript.path);

        if (checkpoint && checkpoint.mtime >= transcript.mtime && checkpoint.status === 'complete') {
          totalSkipped++;
          continue;
        }

        try {
          const result = await syncTranscript(store, embedder, transcript.path, transcript.mtime, checkpoint);
          if (result === 'full') totalIndexed++;
          if (result === 'delta') totalDelta++;
          changesThisRound++;
        } catch (error) {
          logError('Failed to index transcript', {
            path: transcript.path,
            error: error instanceof Error ? error.message : String(error),
          });
          store.setCheckpoint(transcript.path, transcript.mtime, 0, 0, '', 0, 'error');
          totalErrors++;
        }
      }

      // Clean up stale entries (deleted transcripts)
      if (round === 1) {
        const currentPaths = new Set(transcripts.map((t) => t.path));
        for (const syncedPath of store.getAllSyncedPaths()) {
          if (!currentPaths.has(syncedPath)) {
            store.deleteChunksForTranscript(syncedPath);
            logInfo('Removed stale transcript', { path: syncedPath });
          }
        }
      }

      if (changesThisRound === 0) {
        logInfo('No more changes detected', { round });
        break;
      }

      logInfo('Re-scanning for changes added during sync', { round, changesThisRound });
    }

    logInfo('Sync complete', {
      rounds: round,
      fullIndexed: totalIndexed,
      deltaIndexed: totalDelta,
      skipped: totalSkipped,
      errors: totalErrors,
    });
  } finally {
    store.close();
    await removeSyncLockIfOwned(paths.syncLockPath);
  }
}

async function syncTranscript(
  store: TranscriptStore,
  embedder: EmbeddingClient,
  transcriptPath: string,
  mtime: number,
  checkpoint: SyncCheckpoint | null,
): Promise<'full' | 'delta'> {
  const rawContent = readFileSync(transcriptPath, 'utf8');
  const rawLines = rawContent.split('\n');
  // Strip trailing empty line from final newline
  while (rawLines.length > 0 && rawLines[rawLines.length - 1]!.trim() === '') {
    rawLines.pop();
  }
  const currentLineCount = rawLines.length;

  // Delta sync: file grew since last checkpoint
  if (
    checkpoint &&
    checkpoint.status === 'complete' &&
    checkpoint.linesTotal > 0 &&
    currentLineCount > checkpoint.linesTotal
  ) {
    await indexDelta(store, embedder, transcriptPath, mtime, rawLines, checkpoint, currentLineCount);
    return 'delta';
  }

  // Full sync: new file, shrunk file, error recovery, or missing checkpoint data
  await indexFull(store, embedder, transcriptPath, mtime, rawLines, currentLineCount);
  return 'full';
}

async function indexDelta(
  store: TranscriptStore,
  embedder: EmbeddingClient,
  transcriptPath: string,
  mtime: number,
  rawLines: string[],
  checkpoint: SyncCheckpoint,
  currentLineCount: number,
): Promise<void> {
  const deltaLines = rawLines.slice(checkpoint.linesTotal);
  const { turns } = parseTranscriptFile(deltaLines, checkpoint.linesTotal);

  if (turns.length === 0) {
    store.setCheckpoint(
      transcriptPath, mtime, currentLineCount, checkpoint.linesIndexed,
      checkpoint.projectPath, checkpoint.sessionTimestamp, 'complete',
    );
    return;
  }

  const chunks = chunkTurns(turns, transcriptPath, checkpoint.sessionTimestamp, checkpoint.projectPath);

  // Embed OUTSIDE transaction — this is the slow part (network I/O)
  const embeddings = await embedAllChunks(embedder, chunks);

  // Write in one fast batch — transaction held only for SQLite writes
  store.beginTransaction();
  try {
    for (let i = 0; i < chunks.length; i++) {
      store.insertChunk(chunks[i]!);
      if (embeddings[i]) {
        store.insertEmbedding(chunks[i]!.chunkId, embeddings[i]!);
      }
    }

    const embeddedCount = embeddings.filter(Boolean).length;
    store.setCheckpoint(
      transcriptPath, mtime, currentLineCount, checkpoint.linesIndexed + embeddedCount,
      checkpoint.projectPath, checkpoint.sessionTimestamp, 'complete',
    );
    store.commitTransaction();

    logInfo('Delta indexed transcript', {
      path: transcriptPath,
      newLines: deltaLines.length,
      newTurns: turns.length,
      newChunks: chunks.length,
      embedded: embeddedCount,
    });
  } catch (error) {
    store.rollbackTransaction();
    throw error;
  }
}

async function indexFull(
  store: TranscriptStore,
  embedder: EmbeddingClient,
  transcriptPath: string,
  mtime: number,
  rawLines: string[],
  currentLineCount: number,
): Promise<void> {
  const { metadata, turns } = parseTranscriptFile(rawLines);

  if (turns.length === 0) {
    store.deleteChunksForTranscript(transcriptPath);
    store.setCheckpoint(transcriptPath, mtime, currentLineCount, 0, metadata.projectPath, metadata.sessionTimestamp, 'complete');
    return;
  }

  const chunks = chunkTurns(turns, transcriptPath, metadata.sessionTimestamp, metadata.projectPath);

  // Embed OUTSIDE transaction — this is the slow part (network I/O)
  const embeddings = await embedAllChunks(embedder, chunks);

  // Write in one fast batch — transaction held only for SQLite writes
  store.deleteChunksForTranscript(transcriptPath);
  store.beginTransaction();

  try {
    store.setCheckpoint(
      transcriptPath, mtime, currentLineCount, 0,
      metadata.projectPath, metadata.sessionTimestamp, 'partial',
    );

    for (let i = 0; i < chunks.length; i++) {
      store.insertChunk(chunks[i]!);
      if (embeddings[i]) {
        store.insertEmbedding(chunks[i]!.chunkId, embeddings[i]!);
      }
    }

    const embeddedCount = embeddings.filter(Boolean).length;
    store.setCheckpoint(
      transcriptPath, mtime, currentLineCount, embeddedCount,
      metadata.projectPath, metadata.sessionTimestamp, 'complete',
    );
    store.commitTransaction();

    logInfo('Indexed transcript', {
      path: transcriptPath,
      turns: turns.length,
      chunks: chunks.length,
      embedded: embeddedCount,
    });
  } catch (error) {
    store.rollbackTransaction();
    throw error;
  }
}

async function embedAllChunks(
  embedder: EmbeddingClient,
  chunks: Array<{ chunkText: string }>,
): Promise<Array<number[] | null>> {
  const results: Array<number[] | null> = [];
  for (const chunk of chunks) {
    results.push(await embedder.embed(chunk.chunkText));
  }
  return results;
}

void run().catch((error) => {
  logError('Sync runner failed', {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
