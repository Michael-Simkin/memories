import { spawn } from 'node:child_process';
import path from 'node:path';

import type { z } from 'zod';

import type { workerActionSchema} from '../extraction/contracts.js';
import { workerOutputSchema } from '../extraction/contracts.js';
import type { CandidateInsight } from './types.js';

type WorkerAction = z.infer<typeof workerActionSchema>;

function buildConsolidationPrompt(
  candidates: CandidateInsight[],
  projectRoot: string,
): string {
  const candidatesText = JSON.stringify(
    candidates.map((c, i) => ({
      index: i,
      content: c.content,
      memory_type: c.memory_type,
      tags: c.tags,
      is_pinned: c.is_pinned,
      path_matchers: c.path_matchers,
      confidence: c.confidence,
      source_session: c.source_session,
    })),
    null,
    2,
  );

  return [
    'You are a memory consolidation agent. You have candidate memory insights extracted from multiple historical sessions for a single project.',
    'Your job is to deduplicate, merge, and select the best version of each concept, then output final memory actions.',
    'Return strict JSON only (no prose, no markdown fences) with this exact shape:',
    '{"actions":[...]}',
    '',
    '## Available tool',
    '',
    '**recall tool** — Search existing project memories to check for duplicates before creating.',
    `Always pass project_root: "${projectRoot}"`,
    'Always pass include_debug_metadata: true (to get memory IDs for update/delete).',
    '',
    '## Workflow',
    '',
    '1. Group the candidates below by concept/topic.',
    '2. For each group, call recall to check if the concept already exists in the database.',
    '3. Decide:',
    '   - If it already exists and is up-to-date → skip',
    '   - If it exists but needs updating → emit update with the memory_id from recall',
    '   - If multiple candidates express the same concept → merge into one create with the best wording',
    '   - If the concept is unique and valuable → emit create',
    '   - If a candidate is low-quality or ephemeral → skip',
    '',
    '## Action contracts',
    '',
    '- create: {"action":"create","confidence":0..1,"reason":"...","memory_type":"fact|rule|decision|episode","content":"...","tags":[...],"is_pinned":boolean,"path_matchers":[{"path_matcher":"..."}]}',
    '- update: {"action":"update","confidence":0..1,"reason":"...","memory_id":"...","updates":{"content?":"...","tags?":[...],"is_pinned?":boolean,"path_matchers?":[{"path_matcher":"..."}]}}',
    '- delete: {"action":"delete","confidence":0..1,"reason":"...","memory_id":"..."}',
    '- skip: {"action":"skip","confidence":0..1,"reason":"..."}',
    '',
    '## Rules',
    '',
    '- Do not invent memory IDs — only use IDs returned by the recall tool.',
    '- update/delete must target existing memory IDs from recall results.',
    '- ALMOST ALL memories should be is_pinned=false.',
    '- is_pinned=true only for rare project-wide invariants.',
    '- Prefer fewer, higher-quality memories over many similar ones.',
    '- Never include secrets.',
    '',
    `## Candidates (${candidates.length} total from ${new Set(candidates.map((c) => c.source_session)).size} sessions)`,
    '',
    candidatesText,
  ].join('\n');
}

export interface ConsolidationResult {
  actions: WorkerAction[];
  actionsApplied: number;
  errors: string[];
}

export async function consolidateProject(
  candidates: CandidateInsight[],
  projectRoot: string,
  endpoint: { host: string; port: number },
  repoId: string,
  pluginRoot: string,
): Promise<ConsolidationResult> {
  if (candidates.length === 0) {
    return { actions: [], actionsApplied: 0, errors: [] };
  }

  const prompt = buildConsolidationPrompt(candidates, projectRoot);
  const claudeResult = await runClaudeWithRecall(prompt, projectRoot, pluginRoot);

  if (claudeResult.code !== 0) {
    throw new Error(`Claude exited with status ${claudeResult.code}: ${claudeResult.stderr}`);
  }

  const actions = parseConsolidationOutput(claudeResult.stdout);
  const errors: string[] = [];
  let actionsApplied = 0;

  for (const action of actions) {
    if (action.action === 'skip' || action.confidence < 0.75) {
      continue;
    }

    const result = await applyAction(endpoint, repoId, action);
    if (result.ok) {
      actionsApplied++;
    } else {
      errors.push(`${action.action}: ${result.message}`);
    }
  }

  return { actions, actionsApplied, errors };
}

function parseConsolidationOutput(raw: string): WorkerAction[] {
  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }

  const jsonText = extractJsonText(trimmed);
  if (!jsonText) {
    return [];
  }

  try {
    const parsed = JSON.parse(jsonText) as Record<string, unknown>;
    if (Array.isArray(parsed.actions)) {
      parsed.actions = (parsed.actions as Array<Record<string, unknown>>).map(normalizeAction);
    }
    const result = workerOutputSchema.parse(parsed);
    return result.actions;
  } catch {
    return [];
  }
}

function normalizeAction(action: Record<string, unknown>): Record<string, unknown> {
  if (Array.isArray(action.path_matchers)) {
    action.path_matchers = (action.path_matchers as unknown[]).map((pm) =>
      typeof pm === 'string' ? { path_matcher: pm } : pm,
    );
  }
  if (action.updates && typeof action.updates === 'object') {
    const updates = action.updates as Record<string, unknown>;
    if (Array.isArray(updates.path_matchers)) {
      updates.path_matchers = (updates.path_matchers as unknown[]).map((pm) =>
        typeof pm === 'string' ? { path_matcher: pm } : pm,
      );
    }
  }
  return action;
}

function extractJsonText(raw: string): string | null {
  let outer: unknown;
  try {
    outer = JSON.parse(raw);
  } catch {
    return extractFromText(raw);
  }

  if (!outer || typeof outer !== 'object') {
    return null;
  }

  const record = outer as Record<string, unknown>;
  if (typeof record.result === 'string') {
    return extractFromText(record.result as string);
  }
  if (Array.isArray(record.actions)) {
    return raw;
  }
  return raw;
}

function extractFromText(text: string): string | null {
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch?.[1]) return fenceMatch[1].trim();

  const braceIdx = text.indexOf('{"actions"');
  if (braceIdx !== -1) {
    const jsonPart = text.slice(braceIdx);
    try { JSON.parse(jsonPart); return jsonPart; } catch { /* invalid JSON, fall through */ }
  }

  return null;
}

function runClaudeWithRecall(
  prompt: string,
  projectRoot: string,
  pluginRoot: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const mcpServerPath = path.join(pluginRoot, 'dist', 'mcp', 'search-server.js');
  const mcpConfig = JSON.stringify({
    mcpServers: {
      memories: {
        type: 'stdio',
        command: process.execPath,
        args: [mcpServerPath],
      },
    },
  });

  return new Promise((resolve, reject) => {
    const child = spawn(
      'claude',
      [
        '-p',
        '--output-format', 'json',
        '--no-session-persistence',
        '--model', 'claude-sonnet-4-6',
        '--mcp-config', mcpConfig,
        '--allowedTools', 'mcp__memories__recall',
      ],
      {
        cwd: projectRoot,
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

async function applyAction(
  endpoint: { host: string; port: number },
  repoId: string,
  action: WorkerAction,
): Promise<{ ok: boolean; message?: string }> {
  if (action.action === 'skip') {
    return { ok: true };
  }

  try {
    if (action.action === 'create') {
      const response = await fetch(`http://${endpoint.host}:${endpoint.port}/memories/add`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          repo_id: repoId,
          memory_type: action.memory_type,
          content: action.content,
          tags: action.tags,
          is_pinned: action.is_pinned,
          path_matchers: action.path_matchers,
        }),
      });
      if (!response.ok) {
        return { ok: false, message: `create failed: ${response.status}` };
      }
      return { ok: true };
    }

    if (action.action === 'update') {
      const response = await fetch(
        `http://${endpoint.host}:${endpoint.port}/memories/${action.memory_id}`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ repo_id: repoId, ...action.updates }),
        },
      );
      if (!response.ok) {
        return { ok: false, message: `update failed: ${response.status}` };
      }
      return { ok: true };
    }

    if (action.action === 'delete') {
      const response = await fetch(
        `http://${endpoint.host}:${endpoint.port}/memories/${action.memory_id}?repo_id=${encodeURIComponent(repoId)}`,
        { method: 'DELETE' },
      );
      if (!response.ok) {
        return { ok: false, message: `delete failed: ${response.status}` };
      }
      return { ok: true };
    }

    return { ok: true };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
