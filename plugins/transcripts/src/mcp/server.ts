import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import {
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  READ_MAX_LINES,
} from '../shared/constants.js';
import { logError, logInfo } from '../shared/logger.js';
import { readSyncLock } from '../shared/lockfile.js';
import { getGlobalPaths } from '../shared/paths.js';
import { isPidAlive } from '../shared/fs-utils.js';
import type { SearchResult } from '../shared/types.js';
import { TranscriptStore } from '../storage/database.js';
import { EmbeddingClient } from '../sync/embedder.js';
import { scanTranscripts } from '../sync/scanner.js';
import { searchTranscripts } from '../search/retrieval.js';
import { readTranscriptRange } from '../read/formatter.js';

let cachedStore: TranscriptStore | null = null;

function getStore(): TranscriptStore {
  if (!cachedStore) {
    const paths = getGlobalPaths();
    cachedStore = new TranscriptStore(paths.dbPath);
  }
  return cachedStore;
}

const searchInputFields = {
  query: z
    .string()
    .trim()
    .min(1)
    .describe('Semantic search query to find relevant transcript segments.'),
  limit: z
    .coerce.number()
    .int()
    .min(1)
    .max(MAX_SEARCH_LIMIT)
    .optional()
    .describe(`Number of results to return (default ${DEFAULT_SEARCH_LIMIT}, max ${MAX_SEARCH_LIMIT}).`),
};

const readInputFields = {
  transcript_path: z
    .string()
    .trim()
    .min(1)
    .describe('Absolute path to the transcript .jsonl file.'),
  start_line: z
    .coerce.number()
    .int()
    .min(1)
    .describe('Start line number (1-based, inclusive).'),
  end_line: z
    .coerce.number()
    .int()
    .min(1)
    .describe('End line number (1-based, inclusive).'),
};

function formatSearchResults(results: SearchResult[]): string {
  if (results.length === 0) {
    return '# Transcript Search\n\nNo matching transcripts found.';
  }

  const lines = ['# Transcript Search Results\n'];

  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    const date = new Date(r.sessionTimestamp).toISOString().split('T')[0]!;
    lines.push(
      `## Match ${i + 1} — ${date} (${r.projectPath}) — score: ${r.score}\n`,
      `**${r.role}** (line ${r.lineNumber}): ${r.snippet}\n`,
      `> \`read_transcript("${r.transcriptPath}", ${Math.max(1, r.lineNumber - 3)}, ${r.lineNumber + 3})\`\n`,
    );
  }

  return lines.join('\n');
}

function createServer(): McpServer {
  const server = new McpServer({
    name: 'transcripts',
    version: '0.1.1',
  });

  server.registerTool(
    'search_transcripts',
    {
      description:
        'Search past Claude Code session transcripts semantically. Returns matching locations ' +
        'with snippets and metadata. Use read_transcript to get full context around matches. ' +
        'Results include timestamps so you can judge recency.',
      inputSchema: searchInputFields,
    },
    async (rawInput: unknown) => {
      try {
        const parsed = z.object(searchInputFields).parse(rawInput);
        const store = getStore();
        const embedder = new EmbeddingClient();
        const results = await searchTranscripts(
          store,
          embedder,
          parsed.query,
          parsed.limit ?? DEFAULT_SEARCH_LIMIT,
        );
        return {
          content: [{ type: 'text' as const, text: formatSearchResults(results) }],
        };
      } catch (error) {
        if (error instanceof z.ZodError) {
          return {
            content: [{ type: 'text' as const, text: 'search_transcripts requires a non-empty `query` parameter.' }],
            isError: true,
          };
        }
        return {
          content: [
            {
              type: 'text' as const,
              text: `Search error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'read_transcript',
    {
      description:
        'Read a range of lines from a Claude Code session transcript file. ' +
        'Returns formatted conversation with line numbers. Noise lines (tool results, ' +
        `system messages) are rendered as empty rows. Max ${READ_MAX_LINES} lines per call. ` +
        'Use this after search_transcripts to get full context around a match.',
      inputSchema: readInputFields,
    },
    async (rawInput: unknown) => {
      try {
        const parsed = z.object(readInputFields).parse(rawInput);

        const requestedRange = parsed.end_line - parsed.start_line + 1;
        if (requestedRange > READ_MAX_LINES) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Requested ${requestedRange} lines but max is ${READ_MAX_LINES}. Narrow your range.`,
              },
            ],
            isError: true,
          };
        }

        const result = readTranscriptRange(
          parsed.transcript_path,
          parsed.start_line,
          parsed.end_line,
        );

        const output = [result.header, '', ...result.lines].join('\n');
        return {
          content: [{ type: 'text' as const, text: output }],
        };
      } catch (error) {
        if (error instanceof z.ZodError) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'read_transcript requires transcript_path, start_line, and end_line.',
              },
            ],
            isError: true,
          };
        }

        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('ENOENT')) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Transcript file not found: ${(rawInput as Record<string, unknown>).transcript_path}`,
              },
            ],
            isError: true,
          };
        }

        return {
          content: [{ type: 'text' as const, text: `Read error: ${message}` }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'sync_status',
    {
      description:
        'Check the status of the transcript indexing sync job. Shows how many transcripts ' +
        'are indexed, how many are on disk, whether sync is currently running, and error counts.',
      inputSchema: {},
    },
    async () => {
      try {
        const paths = getGlobalPaths();
        const store = getStore();
        const stats = store.getSyncStats();
        const onDisk = scanTranscripts(paths.claudeProjectsDir);
        const lock = await readSyncLock(paths.syncLockPath);
        const running = lock ? isPidAlive(lock.pid) : false;

        const lines = [
          '# Transcript Sync Status\n',
          `**Sync**: ${running ? `running (PID ${lock!.pid}, started ${lock!.started_at})` : 'idle'}`,
          `**Transcripts on disk**: ${onDisk.length}`,
          `**Indexed**: ${stats.complete} complete, ${stats.errors} errors, ${stats.total} total`,
          `**Chunks**: ${stats.chunks}`,
          `**Embeddings**: ${stats.embeddings}`,
        ];

        if (onDisk.length > stats.total) {
          lines.push(`\n_${onDisk.length - stats.total} transcripts pending indexing._`);
        }

        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Status error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  return server;
}

async function run(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logInfo('MCP transcript server started');
}

void run().catch((error) => {
  logError('MCP transcript server failed to start', {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
