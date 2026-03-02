import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import picomatch from 'picomatch';

import { normalizePathForMatch } from '../shared/fs-utils.js';
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

interface TranscriptContext {
  relatedPaths: string[];
  transcriptSnippet: string;
}

const COMMAND_PATH_REGEX =
  /(?:^|[\s"'`])((?:\/[^\s"'`]+)|(?:\.\.?\/[^\s"'`]+)|(?:[A-Za-z0-9._-]+\/[A-Za-z0-9._/-]+))(?=$|[\s"'`])/g;
const INLINE_PATH_REGEX =
  /(?:\/[A-Za-z0-9._-][A-Za-z0-9._/\\-]*|(?:\.\.?\/)?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+)/g;
const BARE_FILENAME_REGEX = /\b[A-Za-z0-9._-]+\.[A-Za-z0-9]{1,12}\b/g;
const NATURAL_LANGUAGE_FILE_REGEX =
  /\b([a-z0-9][a-z0-9 _-]{0,80}?)\s+([a-z0-9]{1,8})\s+file\b/gi;

function readHandoffArg(argv: string[]): string | null {
  const index = argv.indexOf('--handoff');
  if (index === -1) {
    return null;
  }
  return argv[index + 1] ?? null;
}

async function readTranscriptContext(
  transcriptPath: string,
  projectRoot: string,
): Promise<TranscriptContext> {
  const raw = await readFile(transcriptPath, 'utf8');
  const lines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const recentLines = lines.slice(Math.max(0, lines.length - 300));
  const snippetLines = recentLines.slice(Math.max(0, recentLines.length - 120));
  const events = recentLines
    .map((line) => safeJsonParse(line))
    .filter((line): line is Record<string, unknown> => isObject(line));

  return {
    relatedPaths: collectRelatedPathsFromEvents(events, projectRoot),
    transcriptSnippet: snippetLines.join('\n'),
  };
}

function buildExtractionPrompt(input: {
  transcriptSnippet: string;
  relatedPaths: string[];
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
    'PATH MATCHER QUALITY RULES',
    '- Use exact file matchers when memory is tied to one specific file (for example: `src/app.ts`).',
    '- Use directory globs (`dir/**`) only when memory clearly applies to multiple files under that directory.',
    '- Do not emit broad catch-all patterns (`*`, `**`, `**/*`, `/`).',
    '- If there is no clear file relation, use `path_matchers: []`.',
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
    'RELATED FILE CONTEXT (project-relative)',
    ...(input.relatedPaths.length > 0
      ? input.relatedPaths.slice(0, 80).map((relatedPath) => `- ${relatedPath}`)
      : ['- None detected']),
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
        cwd: process.env.PROJECT_ROOT ?? process.cwd(),
        env: {
          ...process.env,
          CLAUDE_CODE_SIMPLE: '1',
          CLAUDE_KB_RUN: '1',
          CLAUDE_MEMORY_INTERNAL_CLAUDE: '1',
        },
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

function collectRelatedPathsFromEvents(events: Record<string, unknown>[], projectRoot: string): string[] {
  const discovered = new Set<string>();
  for (const event of events) {
    const message = isObject(event.message) ? event.message : null;
    if (!message) {
      continue;
    }
    const content = Array.isArray(message.content) ? message.content : [];
    for (const block of content) {
      if (!isObject(block)) {
        continue;
      }
      if (block.type !== 'tool_use') {
        continue;
      }
      const input = isObject(block.input) ? block.input : null;
      if (!input) {
        continue;
      }
      collectPathCandidatesFromObject(input, projectRoot, discovered);
      const command = typeof input.command === 'string' ? input.command : null;
      if (command) {
        collectPathCandidatesFromCommand(command, projectRoot, discovered);
      }
    }
  }
  return [...discovered].sort();
}

function collectPathCandidatesFromObject(
  value: Record<string, unknown>,
  projectRoot: string,
  discovered: Set<string>,
): void {
  for (const [key, candidate] of Object.entries(value)) {
    if (typeof candidate === 'string') {
      const keyLower = key.toLowerCase();
      if (
        keyLower.includes('path') ||
        keyLower.includes('file') ||
        keyLower.includes('target') ||
        keyLower.includes('cwd')
      ) {
        const normalized = normalizeTranscriptPathCandidate(candidate, projectRoot);
        if (normalized) {
          discovered.add(normalized);
        }
      }
      continue;
    }
    if (Array.isArray(candidate)) {
      for (const entry of candidate) {
        if (isObject(entry)) {
          collectPathCandidatesFromObject(entry, projectRoot, discovered);
        } else if (typeof entry === 'string') {
          const normalized = normalizeTranscriptPathCandidate(entry, projectRoot);
          if (normalized) {
            discovered.add(normalized);
          }
        }
      }
      continue;
    }
    if (isObject(candidate)) {
      collectPathCandidatesFromObject(candidate, projectRoot, discovered);
    }
  }
}

function collectPathCandidatesFromCommand(
  command: string,
  projectRoot: string,
  discovered: Set<string>,
): void {
  for (const match of command.matchAll(COMMAND_PATH_REGEX)) {
    const candidate = match[1];
    if (!candidate) {
      continue;
    }
    const normalized = normalizeTranscriptPathCandidate(candidate, projectRoot);
    if (normalized) {
      discovered.add(normalized);
    }
  }
}

function normalizeTranscriptPathCandidate(candidate: string, projectRoot: string): string | null {
  let value = candidate.trim();
  if (!value) {
    return null;
  }

  value = value.replace(/^['"`]+|['"`]+$/g, '').replaceAll('\\', '/');
  if (!value || value.includes('*') || value.startsWith('http://') || value.startsWith('https://')) {
    return null;
  }
  if (value.startsWith('~') || value.startsWith('$') || value.includes('${')) {
    return null;
  }

  const projectRootPosix = projectRoot.replaceAll('\\', '/');
  if (path.isAbsolute(value)) {
    const absolutePosix = value.replaceAll('\\', '/');
    if (!absolutePosix.startsWith(`${projectRootPosix}/`) && absolutePosix !== projectRootPosix) {
      return null;
    }
    const relative = path.posix.relative(projectRootPosix, absolutePosix);
    value = relative;
  }

  const normalized = normalizePathForMatch(value);
  if (!normalized || normalized.startsWith('..')) {
    return null;
  }
  if (!/[A-Za-z0-9]/.test(normalized)) {
    return null;
  }
  return normalized;
}

function tightenActionPathMatchers(
  action: MemoryAction,
  relatedPaths: string[],
  projectRoot: string,
): MemoryAction {
  if (action.action === 'skip' || action.action === 'delete') {
    return action;
  }

  const relatedPathSet = new Set(relatedPaths);
  const explicitPaths = extractActionPathHints(action, projectRoot, relatedPaths)
    .map((pathHint) => resolveHintToRelatedPath(pathHint, relatedPaths))
    .filter((pathHint) => relatedPathSet.has(pathHint) || looksFileLikePath(pathHint));
  if (explicitPaths.length > 0) {
    const explicitMatchers: MemoryAction['path_matchers'] = explicitPaths.map((pathHint) => ({
      path_matcher: pathHint,
      priority: 220,
    }));
    if (arePathMatchersEqual(action.path_matchers, explicitMatchers)) {
      return action;
    }
    return {
      ...action,
      path_matchers: explicitMatchers,
    };
  }

  const sanitized = sanitizePathMatchers(action.path_matchers, relatedPaths, projectRoot);
  if (arePathMatchersEqual(action.path_matchers, sanitized)) {
    return action;
  }
  return {
    ...action,
    path_matchers: sanitized,
  };
}

function extractActionPathHints(
  action: MemoryAction,
  projectRoot: string,
  relatedPaths: string[],
): string[] {
  const combined = [action.content ?? '', action.reason, ...action.evidence].join('\n');
  const matched = new Set<string>();
  for (const pathMatch of combined.matchAll(INLINE_PATH_REGEX)) {
    const candidate = pathMatch[0];
    if (!candidate) {
      continue;
    }
    const normalized = normalizeTranscriptPathCandidate(candidate, projectRoot);
    if (normalized) {
      matched.add(normalized);
    }
  }
  for (const fileMatch of combined.matchAll(BARE_FILENAME_REGEX)) {
    const candidate = fileMatch[0];
    if (!candidate) {
      continue;
    }
    const normalized = normalizeTranscriptPathCandidate(candidate, projectRoot);
    if (normalized) {
      matched.add(normalized);
    }
  }
  for (const inferredPath of inferMentionedRelatedFiles(combined, relatedPaths)) {
    matched.add(inferredPath);
  }
  for (const naturalHint of extractNaturalLanguageFileHints(combined, relatedPaths)) {
    matched.add(naturalHint);
  }
  return [...matched];
}

function sanitizePathMatchers(
  inputMatchers: MemoryAction['path_matchers'],
  relatedPaths: string[],
  projectRoot: string,
): MemoryAction['path_matchers'] {
  const seen = new Set<string>();
  const sanitized: MemoryAction['path_matchers'] = [];
  for (const matcher of inputMatchers) {
    const normalizedPattern = normalizeMatcherPattern(matcher.path_matcher, projectRoot);
    if (!normalizedPattern || isOverlyBroadMatcher(normalizedPattern)) {
      continue;
    }

    if (relatedPaths.length > 0) {
      const matcherFn = picomatch(normalizedPattern, { dot: true });
      const matches = relatedPaths.filter((relatedPath) => matcherFn(relatedPath));
      if (matches.length === 0) {
        continue;
      }

      // Tighten wildcard matchers to exact file patterns when only one file is implicated.
      if ((normalizedPattern.includes('*') || isDirectoryMatcher(normalizedPattern)) && matches.length === 1) {
        const exact = matches[0] ?? normalizedPattern;
        if (!seen.has(exact)) {
          seen.add(exact);
          sanitized.push({ path_matcher: exact, priority: Math.max(200, matcher.priority) });
        }
        continue;
      }
    }

    if (seen.has(normalizedPattern)) {
      continue;
    }
    seen.add(normalizedPattern);
    sanitized.push({
      path_matcher: normalizedPattern,
      priority: clampPriority(matcher.priority),
    });
  }
  return sanitized;
}

function normalizeMatcherPattern(pattern: string, projectRoot: string): string | null {
  let normalized = pattern.trim().replace(/^['"`]+|['"`]+$/g, '').replaceAll('\\', '/');
  if (!normalized) {
    return null;
  }

  const projectRootPosix = projectRoot.replaceAll('\\', '/');
  if (path.isAbsolute(normalized)) {
    const absolutePosix = normalized.replaceAll('\\', '/');
    if (!absolutePosix.startsWith(`${projectRootPosix}/`) && absolutePosix !== projectRootPosix) {
      return null;
    }
    normalized = path.posix.relative(projectRootPosix, absolutePosix);
  }

  normalized = normalized.replaceAll(/\/{2,}/g, '/').replaceAll(/^\.\//g, '');
  if (!normalized || normalized.startsWith('..') || normalized.startsWith('/')) {
    return null;
  }
  return normalized;
}

function isDirectoryMatcher(matcher: string): boolean {
  return matcher.endsWith('/**') || matcher.endsWith('/**/*');
}

function isOverlyBroadMatcher(matcher: string): boolean {
  return (
    matcher === '*' ||
    matcher === '**' ||
    matcher === '**/*' ||
    matcher === '/' ||
    matcher === './*' ||
    matcher === './**' ||
    /^\*\*\/[^/*?]+\/\*\*\/?$/.test(matcher)
  );
}

function clampPriority(priority: number): number {
  if (!Number.isFinite(priority)) {
    return 100;
  }
  const rounded = Math.round(priority);
  if (rounded < 0) {
    return 0;
  }
  if (rounded > 1000) {
    return 1000;
  }
  return rounded;
}

function arePathMatchersEqual(
  left: MemoryAction['path_matchers'],
  right: MemoryAction['path_matchers'],
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    const lhs = left[index];
    const rhs = right[index];
    if (!lhs || !rhs) {
      return false;
    }
    if (lhs.path_matcher !== rhs.path_matcher || lhs.priority !== rhs.priority) {
      return false;
    }
  }
  return true;
}

function looksFileLikePath(value: string): boolean {
  const base = value.split('/').filter(Boolean).at(-1) ?? '';
  if (!base) {
    return false;
  }
  return base.includes('.') || base.startsWith('.');
}

function resolveHintToRelatedPath(hint: string, relatedPaths: string[]): string {
  if (relatedPaths.includes(hint)) {
    return hint;
  }
  if (hint.includes('/')) {
    return hint;
  }
  const lowerHint = hint.toLowerCase();
  const basenameMatches = relatedPaths.filter((relatedPath) => {
    return path.posix.basename(relatedPath).toLowerCase() === lowerHint;
  });
  if (basenameMatches.length === 1) {
    return basenameMatches[0] ?? hint;
  }
  return hint;
}

function inferMentionedRelatedFiles(text: string, relatedPaths: string[]): string[] {
  const loweredText = text.toLowerCase();
  const textTokens = toWordTokens(loweredText);
  if (textTokens.length === 0) {
    return [];
  }

  const tokenSet = new Set(textTokens);
  const scored: Array<{ path: string; score: number }> = [];
  for (const relatedPath of relatedPaths) {
    if (!looksFileLikePath(relatedPath)) {
      continue;
    }
    const base = path.posix.basename(relatedPath).toLowerCase();
    let score = 0;
    if (loweredText.includes(base)) {
      score += 0.7;
    }
    const baseTokens = toWordTokens(base).filter((token) => token.length >= 2);
    if (baseTokens.length === 0) {
      continue;
    }
    const matchedTokenCount = baseTokens.reduce((count, token) => {
      return tokenSet.has(token) ? count + 1 : count;
    }, 0);
    score += matchedTokenCount / baseTokens.length;
    if (score >= 0.85) {
      scored.push({ path: relatedPath, score });
    }
  }

  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  const topScore = scored[0]?.score ?? 0;
  if (topScore < 0.85) {
    return [];
  }
  return scored.filter((item) => item.score >= topScore - 0.05).map((item) => item.path);
}

function extractNaturalLanguageFileHints(text: string, relatedPaths: string[]): string[] {
  const hints = new Set<string>();
  for (const match of text.matchAll(NATURAL_LANGUAGE_FILE_REGEX)) {
    const stemRaw = match[1]?.trim();
    const extRaw = match[2]?.trim().toLowerCase();
    if (!stemRaw || !extRaw) {
      continue;
    }
    const stemTokens = toWordTokens(stemRaw).filter((token) => token.length >= 2);
    if (stemTokens.length === 0) {
      continue;
    }

    const relatedMatches = relatedPaths.filter((relatedPath) => {
      if (!looksFileLikePath(relatedPath)) {
        return false;
      }
      const base = path.posix.basename(relatedPath);
      const parsed = path.posix.parse(base);
      const fileExt = parsed.ext.replace(/^\./, '').toLowerCase();
      if (fileExt !== extRaw) {
        return false;
      }
      const baseTokens = toWordTokens(parsed.name);
      if (baseTokens.length === 0) {
        return false;
      }
      return stemTokens.every((token) => baseTokens.includes(token));
    });

    if (relatedMatches.length > 0) {
      for (const relatedMatch of relatedMatches) {
        hints.add(relatedMatch);
      }
      continue;
    }

    hints.add(`${stemTokens.join('_')}.${extRaw}`);
  }
  return [...hints];
}

function toWordTokens(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
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

    const transcript = await readTranscriptContext(payload.transcript_path, payload.project_root);
    const candidateQuery = payload.last_assistant_message ?? transcript.transcriptSnippet.slice(0, 500);
    const candidates = await searchCandidates(payload.endpoint, candidateQuery);

    const prompt = buildExtractionPrompt({
      transcriptSnippet: transcript.transcriptSnippet,
      relatedPaths: transcript.relatedPaths,
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
    const tightenedActions = extraction.actions.map((action) =>
      tightenActionPathMatchers(action, transcript.relatedPaths, payload.project_root),
    );
    for (const action of tightenedActions) {
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
