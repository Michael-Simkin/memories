import { readFileSync } from 'node:fs';

import { logError, logInfo } from '../shared/logger.js';
import { removeSyncLockIfOwned, writeSyncLock } from '../shared/lockfile.js';
import { ensureGlobalDirectories } from '../shared/paths.js';
import { TranscriptStore } from '../storage/database.js';
import { chunkTurns } from './chunker.js';
import { EmbeddingClient } from './embedder.js';
import { parseTranscriptFile } from './parser.js';
import { scanTranscripts } from './scanner.js';

async function run(): Promise<void> {
  const paths = await ensureGlobalDirectories();

  await writeSyncLock(paths.syncLockPath);
  logInfo('Sync started');

  const store = new TranscriptStore(paths.dbPath);
  const embedder = new EmbeddingClient();
  let totalIndexed = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  try {
    const transcripts = scanTranscripts(paths.claudeProjectsDir);
    const syncedPaths = store.getAllSyncedPaths();

    for (const transcript of transcripts) {
      const existing = store.getSyncStatus(transcript.path);

      if (existing && existing.mtime >= transcript.mtime && existing.status === 'complete') {
        totalSkipped++;
        continue;
      }

      try {
        await indexTranscript(store, embedder, transcript.path, transcript.mtime);
        totalIndexed++;
      } catch (error) {
        logError('Failed to index transcript', {
          path: transcript.path,
          error: error instanceof Error ? error.message : String(error),
        });
        store.setSyncProgress(transcript.path, transcript.mtime, 0, 'error');
        totalErrors++;
      }
    }

    const currentPaths = new Set(transcripts.map((t) => t.path));
    for (const syncedPath of syncedPaths) {
      if (!currentPaths.has(syncedPath)) {
        store.deleteChunksForTranscript(syncedPath);
        logInfo('Removed stale transcript', { path: syncedPath });
      }
    }
  } finally {
    store.close();
    await removeSyncLockIfOwned(paths.syncLockPath);
  }

  logInfo('Sync complete', { indexed: totalIndexed, skipped: totalSkipped, errors: totalErrors });
}

async function indexTranscript(
  store: TranscriptStore,
  embedder: EmbeddingClient,
  transcriptPath: string,
  mtime: number,
): Promise<void> {
  const rawContent = readFileSync(transcriptPath, 'utf8');
  const rawLines = rawContent.split('\n');

  const { metadata, turns } = parseTranscriptFile(rawLines);
  if (turns.length === 0) {
    store.setSyncProgress(transcriptPath, mtime, 0, 'complete');
    return;
  }

  const chunks = chunkTurns(turns, transcriptPath, metadata.sessionTimestamp, metadata.projectPath);

  store.deleteChunksForTranscript(transcriptPath);
  store.beginTransaction();

  try {
    // Insert sync_progress first so FK constraint on chunks is satisfied
    store.setSyncProgress(transcriptPath, mtime, 0, 'partial');

    let embeddedCount = 0;

    for (const chunk of chunks) {
      store.insertChunk(chunk);

      const vector = await embedder.embed(chunk.chunkText);
      if (vector) {
        store.insertEmbedding(chunk.chunkId, vector);
        embeddedCount++;
      }
    }

    store.setSyncProgress(transcriptPath, mtime, embeddedCount, 'complete');
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

void run().catch((error) => {
  logError('Sync runner failed', {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
