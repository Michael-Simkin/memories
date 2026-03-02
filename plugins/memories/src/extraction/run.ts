import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';

import { error } from '../shared/logger.js';
import { appendOperationLog, hookLog } from '../shared/logs.js';
import { getProjectPaths } from '../shared/paths.js';
import { extractionOutputSchema, type MemoryAction, workerPayloadSchema } from './contracts.js';

const CONFIDENCE_THRESHOLD = 0.75;

interface EngineSearchResponse {
  results: Array<{
    id: string;
    memory_type: string;
    content: string;
    tags: string[];
    score: number;
    is_pinned: boolean;
    updated_at: string;
  }>;
  meta: {
    query: string;
    returned: number;
    duration_ms: number;
    source: string;
  };
}

function readHandoffArg(argv: string[]): string | null {
  const index = argv.indexOf('--handoff');
  if (index === -1) {
    return null;
  }
  return argv[index + 1] ?? null;
}

async function readTranscriptSnippet(transcriptPath: string): Promise<string> {
  const raw = await readFile(transcriptPath, 'utf8');
  const lines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const tail = lines.slice(Math.max(0, lines.length - 80));
  return tail.join('\n');
}

function buildExtractionPrompt(input: {
  transcriptSnippet: string;
  lastAssistantMessage?: string;
  candidateMemories: EngineSearchResponse['results'];
}): string {
  const candidateText =
    input.candidateMemories.length === 0
      ? '[]'
      : JSON.stringify(
          input.candidateMemories.map((memory) => ({
            id: memory.id,
            memory_type: memory.memory_type,
            content: memory.content,
            tags: memory.tags,
            is_pinned: memory.is_pinned,
          })),
          null,
          2,
        );

  return [
    'SYSTEM',
    'You are the memory curator for a local Claude Code memory engine.',
    'Extract only durable, high-signal memories from the provided session context.',
    'Never invent facts. Never include secrets, tokens, passwords, private keys, or credentials.',
    'Prefer precision over recall. If uncertain, output `skip`.',
    '',
    'TASK',
    'Return all high-confidence memory actions as strict JSON (no markdown, no prose).',
    '',
    'MEMORY TYPES',
    '- fact: stable project/domain truth',
    '- rule: recurring instruction/preference/constraint',
    '- decision: chosen approach with rationale/tradeoff',
    '- episode: notable one-off event worth later reference',
    '',
    'ACTION RULES',
    '- create: new durable memory not already present',
    '- update: existing memory is same concept but content/tags/pin/matchers must change',
    '- delete: existing memory explicitly invalidated/superseded',
    '- skip: no durable action',
    '',
    'PINNING RULES',
    '- Set `is_pinned=true` only for durable context that should be injected every SessionStart',
    '  (e.g., stable user preferences, hard project rules, long-lived architecture decisions).',
    '- Keep `is_pinned=false` for transient implementation notes, one-off episodes, and short-lived decisions.',
    '- If uncertain whether something should be pinned, prefer `is_pinned=false`.',
    '',
    'OUTPUT JSON SCHEMA',
    '{',
    '  "actions": [',
    '    {',
    '      "action": "create|update|delete|skip",',
    '      "memory_type": "fact|rule|decision|episode",',
    '      "id": "required for update/delete; forbidden for create",',
    '      "content": "required for create/update",',
    '      "tags": ["string"],',
    '      "is_pinned": false,',
    '      "path_matchers": [',
    '        { "path_matcher": "glob-like string", "priority": 100 }',
    '      ],',
    '      "confidence": 0.0,',
    '      "reason": "short justification",',
    '      "evidence": ["direct quote or concise reference from the session"]',
    '    }',
    '  ]',
    '}',
    '',
    'HARD CONSTRAINTS',
    '- Output must be a valid JSON object with key `actions` only.',
    '- `confidence` must be in [0,1].',
    '- Emit only high-confidence actions (default threshold: `confidence >= 0.75`).',
    '- Do not emit duplicate actions for the same semantic memory.',
    '- For `delete`, include `id`, `reason`, and evidence of explicit invalidation.',
    '',
    'EXISTING MEMORY CANDIDATES',
    candidateText,
    '',
    'LAST ASSISTANT MESSAGE',
    input.lastAssistantMessage ?? '',
    '',
    'TRANSCRIPT SNIPPET',
    input.transcriptSnippet,
  ].join('\n');
}

async function runClaudePrompt(
  prompt: string,
): Promise<{ code: number; stderr: string; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'claude',
      [
        '-p',
        '--output-format',
        'json',
        '--no-session-persistence',
        '--dangerously-skip-permissions',
        '--model',
        'claude-opus-4-6',
      ],
      {
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
    child.on('error', (spawnError) => reject(spawnError));
    child.on('close', (code) => {
      resolve({
        code: code ?? 1,
        stderr,
        stdout,
      });
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

function parseCliJson(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('Claude extraction produced empty output');
  }
  const outer = JSON.parse(trimmed) as unknown;

  if (extractionOutputSchema.safeParse(outer).success) {
    return outer;
  }

  if (isObject(outer)) {
    const result = outer.result;
    if (typeof result === 'string') {
      const fromResultString = tryParseExtractionPayload(result);
      if (fromResultString) {
        return fromResultString;
      }
    }
    if (isObject(result) && extractionOutputSchema.safeParse(result).success) {
      return result;
    }

    const content = outer.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!isObject(block)) {
          continue;
        }
        if (typeof block.text !== 'string') {
          continue;
        }
        const fromText = tryParseExtractionPayload(block.text);
        if (fromText) {
          return fromText;
        }
      }
    }
  }

  throw new Error(
    `Claude extraction output did not include an actions payload. Top-level keys: ${listTopLevelKeys(outer)}`,
  );
}

function tryParseExtractionPayload(value: string): unknown | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const direct = safeJsonParse(trimmed);
  if (direct && extractionOutputSchema.safeParse(direct).success) {
    return direct;
  }

  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fencedMatch) {
    const fencedJson = safeJsonParse(fencedMatch[1] ?? '');
    if (fencedJson && extractionOutputSchema.safeParse(fencedJson).success) {
      return fencedJson;
    }
  }

  return null;
}

function safeJsonParse(value: string): unknown | null {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function listTopLevelKeys(value: unknown): string {
  if (!isObject(value)) {
    return '(non-object JSON output)';
  }
  const keys = Object.keys(value);
  return keys.length > 0 ? keys.join(', ') : '(none)';
}

async function searchCandidates(
  endpoint: { host: string; port: number },
  query: string,
): Promise<EngineSearchResponse> {
  const response = await fetch(`http://${endpoint.host}:${endpoint.port}/memories/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      include_pinned: true,
      limit: 20,
      query,
    }),
  });
  if (!response.ok) {
    throw new Error(`Candidate lookup failed: ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as EngineSearchResponse;
}

async function applyAction(
  endpoint: { host: string; port: number },
  action: MemoryAction,
): Promise<{ ok: true } | { code: string; message: string; ok: false }> {
  if (action.action === 'skip' || action.confidence < CONFIDENCE_THRESHOLD) {
    return { ok: true };
  }

  if (action.action === 'create') {
    const response = await fetch(`http://${endpoint.host}:${endpoint.port}/memories/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: action.content,
        is_pinned: action.is_pinned,
        memory_type: action.memory_type,
        path_matchers: action.path_matchers,
        tags: action.tags,
      }),
    });
    return handleActionResponse(response);
  }

  if (action.action === 'update') {
    const response = await fetch(`http://${endpoint.host}:${endpoint.port}/memories/${action.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: action.content,
        is_pinned: action.is_pinned,
        path_matchers: action.path_matchers,
        tags: action.tags,
      }),
    });
    return handleActionResponse(response);
  }

  if (action.action === 'delete') {
    const response = await fetch(`http://${endpoint.host}:${endpoint.port}/memories/${action.id}`, {
      method: 'DELETE',
    });
    return handleActionResponse(response);
  }

  return { ok: true };
}

async function handleActionResponse(
  response: Response,
): Promise<{ ok: true } | { code: string; message: string; ok: false }> {
  if (response.ok) {
    return { ok: true };
  }
  try {
    const body = (await response.json()) as { error?: { code?: string; message?: string } };
    const code = body.error?.code ?? `HTTP_${response.status}`;
    const message = body.error?.message ?? response.statusText;
    return { code, message, ok: false };
  } catch {
    return { code: `HTTP_${response.status}`, message: response.statusText, ok: false };
  }
}

async function run(): Promise<void> {
  const encoded = readHandoffArg(process.argv);
  if (!encoded) {
    return;
  }

  const decoded = Buffer.from(encoded, 'base64').toString('utf8');
  const payload = workerPayloadSchema.parse(JSON.parse(decoded) as unknown);
  const projectPaths = getProjectPaths(payload.project_root);

  try {
    await hookLog(projectPaths.hookLogPath, {
      at: new Date().toISOString(),
      event: 'StopWorker',
      status: 'ok',
      session_id: payload.session_id,
      detail: 'worker-started',
    });

    const transcriptSnippet = await readTranscriptSnippet(payload.transcript_path);
    const candidateQuery = payload.last_assistant_message ?? transcriptSnippet.slice(0, 500);
    const candidates = await searchCandidates(payload.endpoint, candidateQuery);

    const prompt = buildExtractionPrompt({
      transcriptSnippet,
      candidateMemories: candidates.results,
      ...(payload.last_assistant_message
        ? { lastAssistantMessage: payload.last_assistant_message }
        : {}),
    });

    const claudeResult = await runClaudePrompt(prompt);
    if (claudeResult.code !== 0) {
      throw new Error(`Claude exited with ${claudeResult.code}: ${claudeResult.stderr}`);
    }

    const extraction = extractionOutputSchema.parse(parseCliJson(claudeResult.stdout));
    for (const action of extraction.actions) {
      const operationAt = new Date().toISOString();
      if (action.action === 'skip' || action.confidence < CONFIDENCE_THRESHOLD) {
        await appendOperationLog(projectPaths.operationLogPath, {
          at: operationAt,
          op: 'extraction/skip',
          status: 'skipped',
          detail: action.reason,
          data: {
            action: action.action,
            confidence: action.confidence,
          },
        });
        continue;
      }

      const result = await applyAction(payload.endpoint, action);
      if (!result.ok) {
        await appendOperationLog(projectPaths.operationLogPath, {
          at: operationAt,
          op: 'extraction/apply',
          status: 'error',
          memory_id: action.id,
          detail: `${result.code}: ${result.message}`,
          data: { action: action.action },
        });
        break;
      }

      await appendOperationLog(projectPaths.operationLogPath, {
        at: operationAt,
        op: 'extraction/apply',
        status: 'ok',
        memory_id: action.id,
        detail: action.reason,
        data: { action: action.action, confidence: action.confidence },
      });
    }

    await hookLog(projectPaths.hookLogPath, {
      at: new Date().toISOString(),
      event: 'StopWorker',
      status: 'ok',
      session_id: payload.session_id,
      detail: 'worker-completed',
    });
  } catch (runError: unknown) {
    await appendOperationLog(projectPaths.operationLogPath, {
      at: new Date().toISOString(),
      op: 'extraction/error',
      status: 'error',
      detail: runError instanceof Error ? runError.message : String(runError),
    });
    await hookLog(projectPaths.hookLogPath, {
      at: new Date().toISOString(),
      event: 'StopWorker',
      status: 'error',
      session_id: payload.session_id,
      detail: runError instanceof Error ? runError.message : String(runError),
    });
    error('Stop worker failed', {
      error: runError instanceof Error ? runError.message : String(runError),
    });
  }
}

void run();
