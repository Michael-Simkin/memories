import path from 'node:path';

import { ensureEngine } from '../engine/ensure-engine.js';
import { MAX_HOOK_INJECTION_TOKENS } from '../shared/constants.js';
import { readJsonFromStdin, writeFailOpenOutput, writeHookOutput } from '../shared/hook-io.js';
import { error } from '../shared/logger.js';
import { hookLog } from '../shared/logs.js';
import { ensureProjectDirectories } from '../shared/paths.js';
import { postEngineJson, resolveHookProjectRoot } from './common.js';
import { preToolUsePayloadSchema } from './schemas.js';

interface RetrievalResponse {
  markdown: string;
  meta: {
    query: string;
    returned: number;
    duration_ms: number;
    source: string;
  };
}

function collectPathCandidates(input: unknown): string[] {
  if (!input || typeof input !== 'object') {
    return [];
  }

  const candidates: string[] = [];
  const stack: unknown[] = [input];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== 'object') {
      continue;
    }

    if (Array.isArray(current)) {
      for (const entry of current) {
        stack.push(entry);
      }
      continue;
    }

    for (const [key, value] of Object.entries(current)) {
      if (typeof value === 'string') {
        const loweredKey = key.toLowerCase();
        if (
          loweredKey.includes('path') ||
          loweredKey.includes('file') ||
          loweredKey.includes('target')
        ) {
          candidates.push(value);
        }
      } else {
        stack.push(value);
      }
    }
  }

  return [...new Set(candidates)]
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => value.replaceAll('\\', '/'))
    .filter((value) => !path.isAbsolute(value) || value.startsWith('/'));
}

function buildQuery(toolName: string | undefined, toolInput: unknown): string {
  const name = toolName ?? 'unknown-tool';
  if (toolInput && typeof toolInput === 'object') {
    const serialized = JSON.stringify(toolInput);
    return `${name}: ${serialized.slice(0, 320)}`;
  }
  return name;
}

async function run(): Promise<void> {
  const payload = (await readJsonFromStdin(preToolUsePayloadSchema)) ?? {};
  const projectRoot = resolveHookProjectRoot(payload);
  const paths = await ensureProjectDirectories(projectRoot);

  try {
    const endpoint = await ensureEngine(projectRoot);
    const query = buildQuery(payload.tool_name, payload.tool_input);
    const targetPaths = collectPathCandidates(payload.tool_input);

    const retrieval = await postEngineJson<
      { query: string; target_paths: string[]; max_tokens: number },
      RetrievalResponse
    >(endpoint, '/retrieval/pretool', {
      query,
      target_paths: targetPaths,
      max_tokens: MAX_HOOK_INJECTION_TOKENS,
    });

    await hookLog(paths.hookLogPath, {
      at: new Date().toISOString(),
      event: 'PreToolUse',
      status: 'ok',
      session_id: payload.session_id,
      data: {
        returned: retrieval.meta.returned,
        tool_name: payload.tool_name,
      },
    });

    writeHookOutput({
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: retrieval.markdown,
      },
    });
  } catch (runError: unknown) {
    await hookLog(paths.hookLogPath, {
      at: new Date().toISOString(),
      event: 'PreToolUse',
      status: 'error',
      detail: runError instanceof Error ? runError.message : String(runError),
    });
    error('PreToolUse hook failed', {
      error: runError instanceof Error ? runError.message : String(runError),
    });
    writeFailOpenOutput();
  }
}

void run();
