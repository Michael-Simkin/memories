import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';

import { DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT } from '../shared/constants.js';
import { isLoopback, readLockMetadata } from '../shared/lockfile.js';
import { error } from '../shared/logger.js';
import { formatMemoryRecallMarkdown } from '../shared/markdown.js';
import { getProjectPaths, resolveProjectRoot } from '../shared/paths.js';
import { searchResponseSchema } from '../shared/types.js';

const toolInputFields = {
  query: z.string().min(1),
  project_root: z.string().optional(),
  limit: z.number().int().min(1).max(MAX_SEARCH_LIMIT).optional(),
  memory_types: z.array(z.enum(['fact', 'rule', 'decision', 'episode'])).optional(),
  include_pinned: z.boolean().optional(),
};

const toolInputSchema = z.object(toolInputFields);

async function run(): Promise<void> {
  const server = new McpServer({
    name: 'memories',
    version: '0.1.0',
  });

  server.registerTool(
    'recall',
    {
      description: 'Search memory engine and return markdown recall output.',
      inputSchema: toolInputFields,
    },
    async (rawInput: unknown) => {
      const parsed = toolInputSchema.parse(rawInput);
      const input = {
        query: parsed.query,
        project_root: parsed.project_root,
        limit: parsed.limit ?? DEFAULT_SEARCH_LIMIT,
        include_pinned: parsed.include_pinned ?? true,
        memory_types: parsed.memory_types,
      };
      const projectRoot = resolveProjectRoot(input.project_root);
      const lockPath = getProjectPaths(projectRoot).lockPath;
      const lock = await readLockMetadata(lockPath);

      if (!lock) {
        throw new Error(`ENGINE_NOT_FOUND: lock file not found at ${lockPath}`);
      }
      if (!isLoopback(lock.host)) {
        throw new Error(`INVALID_LOCK_HOST: ${lock.host}`);
      }

      const timeoutMs = Number.parseInt(process.env.MEMORIES_MCP_ENGINE_TIMEOUT_MS ?? '2500', 10);
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        Number.isFinite(timeoutMs) ? timeoutMs : 2500,
      );

      try {
        const response = await fetch(`http://${lock.host}:${lock.port}/memories/search`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            include_pinned: input.include_pinned,
            limit: input.limit,
            query: input.query,
            ...(input.memory_types ? { memory_types: input.memory_types } : {}),
          }),
        });
        if (!response.ok) {
          const body = await response.text();
          throw new Error(`${response.status}: ${response.statusText} ${body}`);
        }
        const payload = searchResponseSchema.parse(await response.json());
        const markdown = formatMemoryRecallMarkdown({
          query: payload.meta.query,
          results: payload.results,
          durationMs: payload.meta.duration_ms,
          source: payload.meta.source,
        });
        return {
          content: [{ type: 'text', text: markdown }],
        };
      } catch (callError: unknown) {
        const message = callError instanceof Error ? callError.message : String(callError);
        throw new Error(`ENGINE_CALL_FAILED: ${message}`);
      } finally {
        clearTimeout(timer);
      }
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

void run().catch((runError: unknown) => {
  error('MCP server startup failed', {
    error: runError instanceof Error ? runError.message : String(runError),
  });
  process.exit(1);
});
