import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { ZodError } from 'zod';

import { DEFAULT_BACKGROUND_HOOK_HEARTBEAT_INTERVAL_MS } from '../shared/constants.js';
import { normalizePathForMatch } from '../shared/fs-utils.js';
import { transcriptToMarkdown } from '../shared/transcript-filter.js';
import { logError } from '../shared/logger.js';
import { appendEventLog } from '../shared/logs.js';
import { getGlobalPaths } from '../shared/paths.js';
import {
  type WorkerAction,
  workerOutputSchema,
  type WorkerPayload,
  workerPayloadSchema,
} from './contracts.js';

export const CONFIDENCE_THRESHOLD = 0.75;

interface ClaudeRunResult {
  code: number;
  stderr: string;
  stdout: string;
}

interface ActionApplyResult {
  ok: true;
}

interface ActionApplyError {
  ok: false;
  code: string;
  message: string;
}

type ActionApplyOutcome = ActionApplyResult | ActionApplyError;

interface WorkerContext {
  transcriptMarkdownPath: string;
  last3Interactions: string;
  relatedPaths: string[];
}

interface ExtractionParseDebugInfo {
  content_block_count?: number;
  content_text_block_count?: number;
  has_result_object?: boolean;
  has_result_string?: boolean;
  parse_error?: string;
  parser_stage: string;
  stdout_chars: number;
  stdout_preview: string;
  top_level_keys?: string[];
}

class ExtractionParseError extends Error {
  public readonly debugInfo: ExtractionParseDebugInfo;

  public constructor(message: string, debugInfo: ExtractionParseDebugInfo) {
    super(message);
    this.name = 'ExtractionParseError';
    this.debugInfo = debugInfo;
  }
}

const CLAUDE_OUTPUT_PREVIEW_MAX_CHARS = 1600;

interface WorkerDependencies {
  appendEventLogFn: typeof appendEventLog;
  applyActionFn: (
    endpoint: { host: string; port: number },
    repoId: string,
    action: WorkerAction,
  ) => Promise<ActionApplyOutcome>;
  prepareTranscriptContextFn: typeof prepareTranscriptContext;
  runClaudeFn: typeof runClaudePrompt;
}

const defaultDependencies: WorkerDependencies = {
  appendEventLogFn: appendEventLog,
  applyActionFn: applyAction,
  prepareTranscriptContextFn: prepareTranscriptContext,
  runClaudeFn: runClaudePrompt,
};

function summarizeClaudeRunResult(result: ClaudeRunResult): Record<string, unknown> {
  return {
    exit_code: result.code,
    stderr_chars: result.stderr.length,
    stderr_line_count: countLines(result.stderr),
    stderr_preview: summarizeTextPreview(result.stderr, CLAUDE_OUTPUT_PREVIEW_MAX_CHARS),
    stderr_tail_preview: summarizeTextTailPreview(result.stderr, CLAUDE_OUTPUT_PREVIEW_MAX_CHARS),
    stderr_sha256: sha256(result.stderr),
    stdout_chars: result.stdout.length,
    stdout_line_count: countLines(result.stdout),
    stdout_preview: summarizeTextPreview(result.stdout, CLAUDE_OUTPUT_PREVIEW_MAX_CHARS),
    stdout_tail_preview: summarizeTextTailPreview(result.stdout, CLAUDE_OUTPUT_PREVIEW_MAX_CHARS),
    stdout_sha256: sha256(result.stdout),
  };
}

function buildLogData(
  payload: WorkerPayload,
  extra?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const hookId = payload.background_hook_id;
  if (!hookId && !extra) {
    return undefined;
  }
  return {
    ...(hookId ? { hook_id: hookId } : {}),
    ...extra,
  };
}

function buildErrorDebugData(error: unknown): Record<string, unknown> | undefined {
  if (error instanceof ExtractionParseError) {
    return {
      error_name: error.name,
      parser_debug: error.debugInfo,
    };
  }
  if (error instanceof ZodError) {
    return {
      error_name: error.name,
      validation_issues: error.issues.slice(0, 12).map((issue) => ({
        code: issue.code,
        message: issue.message,
        path: issue.path.join('.'),
      })),
    };
  }
  if (error instanceof Error) {
    return {
      error_name: error.name,
    };
  }
  return undefined;
}

function summarizeTextPreview(text: string, maxChars: number): string {
  const normalized = text.replaceAll('\r\n', '\n');
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars)}…[truncated ${normalized.length - maxChars} chars]`;
}

function summarizeTextTailPreview(text: string, maxChars: number): string {
  const normalized = text.replaceAll('\r\n', '\n');
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `…[truncated ${normalized.length - maxChars} chars]${normalized.slice(-maxChars)}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function countLines(text: string): number {
  if (!text) {
    return 0;
  }
  return text.split('\n').length;
}


interface BackgroundHookLeaseController {
  finish: (status: 'ok' | 'error' | 'skipped', detail?: string) => Promise<void>;
}

async function postBackgroundHookSignal(
  endpoint: { host: string; port: number },
  route: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const response = await fetch(`http://${endpoint.host}:${endpoint.port}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${response.status}: ${response.statusText} ${body}`);
  }
}

function createBackgroundHookLeaseController(
  payload: WorkerPayload,
): BackgroundHookLeaseController {
  if (!payload.background_hook_id) {
    return {
      finish: async () => {},
    };
  }

  let closed = false;
  let heartbeatFailed = false;
  const heartbeat = async (): Promise<void> => {
    try {
      await postBackgroundHookSignal(
        payload.endpoint,
        `/background-hooks/${payload.background_hook_id}/heartbeat`,
        { pid: process.pid },
      );
      heartbeatFailed = false;
    } catch (error) {
      if (!heartbeatFailed) {
        heartbeatFailed = true;
        logError('Background hook heartbeat failed', {
          background_hook_id: payload.background_hook_id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  void heartbeat();
  const heartbeatTimer = setInterval(() => {
    void heartbeat();
  }, DEFAULT_BACKGROUND_HOOK_HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref?.();

  return {
    finish: async (status, detail) => {
      if (closed) {
        return;
      }
      closed = true;
      clearInterval(heartbeatTimer);
      try {
        await postBackgroundHookSignal(
          payload.endpoint,
          `/background-hooks/${payload.background_hook_id}/finish`,
          {
            detail,
            pid: process.pid,
            status,
          },
        );
      } catch (error) {
        logError('Background hook finish failed', {
          background_hook_id: payload.background_hook_id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}

export function readHandoffArg(argv: string[]): string | null {
  const index = argv.indexOf('--handoff');
  if (index === -1) {
    return null;
  }
  return argv[index + 1] ?? null;
}

export function decodeWorkerPayload(encodedHandoff: string): WorkerPayload {
  const decoded = Buffer.from(encodedHandoff, 'base64').toString('utf8');
  const parsed = JSON.parse(decoded) as unknown;
  return workerPayloadSchema.parse(parsed);
}

export async function executeWorker(
  payload: WorkerPayload,
  dependencies: WorkerDependencies = defaultDependencies,
): Promise<void> {
  const projectPaths = getGlobalPaths();
  const backgroundHookLease = createBackgroundHookLeaseController(payload);
  let backgroundHookStatus: 'ok' | 'error' | 'skipped' = 'ok';
  let backgroundHookDetail = 'completed';
  await dependencies.appendEventLogFn(projectPaths.eventLogPath, {
    at: new Date().toISOString(),
    event: 'extraction/start',
    kind: 'operation',
    status: 'ok',
    ...(payload.session_id ? { session_id: payload.session_id } : {}),
    ...(buildLogData(payload) ? { data: buildLogData(payload) } : {}),
  });

  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT ?? path.dirname(path.dirname(__filename));
  let transcriptMarkdownPath: string | undefined;

  try {
    const context = await dependencies.prepareTranscriptContextFn(
      payload.transcript_path,
      payload.project_root,
    );
    transcriptMarkdownPath = context.transcriptMarkdownPath;
    await dependencies.appendEventLogFn(projectPaths.eventLogPath, {
      at: new Date().toISOString(),
      event: 'extraction/context',
      kind: 'operation',
      status: 'ok',
      ...(payload.session_id ? { session_id: payload.session_id } : {}),
      data: buildLogData(payload, {
        related_path_count: context.relatedPaths.length,
        transcript_path: payload.transcript_path,
        transcript_markdown_path: context.transcriptMarkdownPath,
        last3_interactions_chars: context.last3Interactions.length,
      }),
    });
    const prompt = buildExtractionPrompt({
      last3Interactions: context.last3Interactions,
      transcriptMarkdownPath: context.transcriptMarkdownPath,
      relatedPaths: context.relatedPaths,
      projectRoot: payload.project_root,
      ...(payload.last_assistant_message
        ? { lastAssistantMessage: payload.last_assistant_message }
        : {}),
    });

    const claudeResult = await dependencies.runClaudeFn(prompt, payload.project_root, pluginRoot);
    const claudeRunSummary = summarizeClaudeRunResult(claudeResult);
    await dependencies.appendEventLogFn(projectPaths.eventLogPath, {
      at: new Date().toISOString(),
      event: 'extraction/claude-response',
      kind: 'operation',
      status: claudeResult.code === 0 ? 'ok' : 'error',
      ...(payload.session_id ? { session_id: payload.session_id } : {}),
      ...(claudeResult.code === 0
        ? {}
        : { detail: `claude exited with status ${claudeResult.code}` }),
      data: buildLogData(payload, claudeRunSummary),
    });
    if (claudeResult.code !== 0) {
      throw new Error(`Claude exited with status ${claudeResult.code}: ${claudeResult.stderr}`);
    }

    let output: ReturnType<typeof workerOutputSchema.parse>;
    try {
      output = parseWorkerOutput(claudeResult.stdout);
    } catch (error) {
      await dependencies.appendEventLogFn(projectPaths.eventLogPath, {
        at: new Date().toISOString(),
        event: 'extraction/parse',
        kind: 'operation',
        status: 'error',
        ...(payload.session_id ? { session_id: payload.session_id } : {}),
        detail: error instanceof Error ? error.message : String(error),
        ...(buildLogData(payload, buildErrorDebugData(error)) ? { data: buildLogData(payload, buildErrorDebugData(error)) } : {}),
      });
      throw error;
    }
    await dependencies.appendEventLogFn(projectPaths.eventLogPath, {
      at: new Date().toISOString(),
      event: 'extraction/parse',
      kind: 'operation',
      status: 'ok',
      ...(payload.session_id ? { session_id: payload.session_id } : {}),
      detail: `parsed ${output.actions.length} actions`,
      data: buildLogData(payload, {
        action_types: output.actions.map((action) => action.action),
      }),
    });
    const sanitizedActions = output.actions.map((action) =>
      sanitizeWorkerAction(action, context.relatedPaths),
    );

    let failed = false;
    for (const action of sanitizedActions) {
      if (action.action === 'skip' || action.confidence < CONFIDENCE_THRESHOLD) {
        await dependencies.appendEventLogFn(projectPaths.eventLogPath, {
          at: new Date().toISOString(),
          event: 'extraction/skip',
          kind: 'operation',
          status: 'skipped',
          ...(payload.session_id ? { session_id: payload.session_id } : {}),
          detail: action.reason ?? 'low confidence or skip action',
          data: buildLogData(payload, {
            action: action.action,
            confidence: action.confidence,
          }),
        });
        continue;
      }

      const outcome = await dependencies.applyActionFn(payload.endpoint, payload.repo_id, action);
      if (!outcome.ok) {
        failed = true;
        await dependencies.appendEventLogFn(projectPaths.eventLogPath, {
          at: new Date().toISOString(),
          event: 'extraction/apply',
          kind: 'operation',
          status: 'error',
          ...(payload.session_id ? { session_id: payload.session_id } : {}),
          ...(action.action === 'update' || action.action === 'delete'
            ? { memory_id: action.memory_id }
            : {}),
          detail: `${outcome.code}: ${outcome.message}`,
          data: buildLogData(payload, {
            action: action.action,
            confidence: action.confidence,
          }),
        });
        break;
      }

      await dependencies.appendEventLogFn(projectPaths.eventLogPath, {
        at: new Date().toISOString(),
        event: 'extraction/apply',
        kind: 'operation',
        status: 'ok',
        ...(payload.session_id ? { session_id: payload.session_id } : {}),
        ...(action.action === 'update' || action.action === 'delete'
          ? { memory_id: action.memory_id }
          : {}),
        detail: action.reason ?? action.action,
        data: buildLogData(payload, {
          action: action.action,
          confidence: action.confidence,
        }),
      });
    }

    await dependencies.appendEventLogFn(projectPaths.eventLogPath, {
      at: new Date().toISOString(),
      event: 'extraction/complete',
      kind: 'operation',
      status: failed ? 'error' : 'ok',
      ...(payload.session_id ? { session_id: payload.session_id } : {}),
      detail: failed ? 'stopped after first write failure' : 'completed',
      ...(buildLogData(payload) ? { data: buildLogData(payload) } : {}),
    });
    backgroundHookStatus = failed ? 'error' : 'ok';
    backgroundHookDetail = failed ? 'stopped after first write failure' : 'completed';
  } catch (error) {
    backgroundHookStatus = 'error';
    backgroundHookDetail = error instanceof Error ? error.message : String(error);
    await dependencies.appendEventLogFn(projectPaths.eventLogPath, {
      at: new Date().toISOString(),
      event: 'extraction/error',
      kind: 'operation',
      status: 'error',
      ...(payload.session_id ? { session_id: payload.session_id } : {}),
      detail: error instanceof Error ? error.message : String(error),
      ...(buildLogData(payload, buildErrorDebugData(error)) ? { data: buildLogData(payload, buildErrorDebugData(error)) } : {}),
    });
    logError('Stop worker failed', {
      error: error instanceof Error ? error.message : String(error),
      ...(buildErrorDebugData(error) ? { debug: buildErrorDebugData(error) } : {}),
    });
  } finally {
    if (transcriptMarkdownPath) {
      await unlink(transcriptMarkdownPath).catch(() => {});
    }
    await backgroundHookLease.finish(backgroundHookStatus, backgroundHookDetail);
  }
}

export async function prepareTranscriptContext(
  transcriptPath: string,
  projectRoot: string,
): Promise<WorkerContext> {
  const raw = await readFile(transcriptPath, 'utf8');
  const lines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const recentLines = lines.slice(Math.max(0, lines.length - 300));
  const relatedPaths = new Set<string>();
  for (const line of recentLines) {
    const parsed = safeJsonParse(line);
    if (!parsed || typeof parsed !== 'object') {
      continue;
    }
    for (const value of collectPathValues(parsed)) {
      const normalized = normalizeCandidatePath(value, projectRoot);
      if (normalized) {
        relatedPaths.add(normalized);
      }
    }
  }

  const markdown = transcriptToMarkdown(lines);
  const markdownLines = markdown.split('\n');
  const last3 = extractLast3Interactions(markdownLines);

  const tmpDir = path.join(getGlobalPaths().memoriesDir, 'tmp');
  await mkdir(tmpDir, { recursive: true });
  const transcriptMarkdownPath = path.join(tmpDir, `transcript-${Date.now()}.md`);
  await writeFile(transcriptMarkdownPath, markdown, 'utf8');

  return {
    transcriptMarkdownPath,
    last3Interactions: last3,
    relatedPaths: [...relatedPaths].slice(0, 80),
  };
}


function extractLast3Interactions(markdownLines: string[]): string {
  let userMessageCount = 0;
  let sliceStart = 0;

  for (let i = markdownLines.length - 1; i >= 0; i--) {
    if (markdownLines[i]!.startsWith('User: ')) {
      userMessageCount++;
      if (userMessageCount >= 3) {
        sliceStart = i;
        break;
      }
    }
  }

  return markdownLines.slice(sliceStart).join('\n');
}

function collectPathValues(value: unknown): string[] {
  const collected: string[] = [];

  const walk = (node: unknown, parentKey = ''): void => {
    if (typeof node === 'string') {
      if (parentKey.toLowerCase().includes('path')) {
        collected.push(node);
      }
      for (const token of node.matchAll(/(?:\.{0,2}\/)?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+/g)) {
        const maybePath = token[0];
        if (maybePath) {
          collected.push(maybePath);
        }
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) {
        walk(item, parentKey);
      }
      return;
    }
    if (node && typeof node === 'object') {
      for (const [key, child] of Object.entries(node)) {
        walk(child, key);
      }
    }
  };

  walk(value);
  return collected;
}

function normalizeCandidatePath(rawPath: string, projectRoot: string): string | null {
  const trimmed = rawPath.trim().replaceAll('\\', '/');
  if (!trimmed || trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return null;
  }

  const withoutLineSuffix = trimmed.replace(/:[0-9]+$/g, '');
  const normalized = normalizePathForMatch(withoutLineSuffix);
  if (!normalized || normalized === '.' || normalized === '/') {
    return null;
  }

  if (path.isAbsolute(normalized)) {
    const relative = path.relative(projectRoot, normalized).replaceAll('\\', '/');
    if (relative.startsWith('..')) {
      return null;
    }
    return normalizePathForMatch(relative);
  }

  return normalized;
}

function buildExtractionPrompt(input: {
  last3Interactions: string;
  transcriptMarkdownPath: string;
  relatedPaths: string[];
  projectRoot: string;
  lastAssistantMessage?: string;
}): string {
  return [
    'You are a memory extraction agent. Analyze this conversation transcript and extract durable memories.',
    'Return strict JSON only (no prose, no markdown fences) with this exact top-level shape:',
    '{"actions":[...]}',
    '',
    '## Available tools',
    '',
    '1. **Read tool** — The full conversation transcript (cleaned markdown) is available at:',
    `   ${input.transcriptMarkdownPath}`,
    '   Use the Read tool if the last 3 interactions below are insufficient context.',
    '',
    '2. **recall tool** — Search existing project memories before creating, updating, or deleting.',
    `   Always pass project_root: "${input.projectRoot}"`,
    '   Always pass include_debug_metadata: true (to get memory IDs needed for update/delete actions).',
    '   Search for concepts you intend to memorize to check for duplicates or memories that need updating.',
    '',
    '## Workflow',
    '',
    '1. Read the last 3 interactions below to understand what happened.',
    '2. Identify candidate insights worth memorizing.',
    '3. For each candidate, call the recall tool to check if a similar memory already exists.',
    '4. Decide on actions: create new memories, update existing ones, delete outdated ones, or skip.',
    '5. If the last 3 interactions lack context, use the Read tool on the full transcript.',
    '6. Output your final JSON with all actions.',
    '',
    '## Extraction strategy',
    '',
    '- Even when the transcript focuses on a specific flow (e.g. tests, a controller, a workflow), actively look for general principles that apply across the project. Phrases like "the core principle is...", "we use real X and only mock Y", "always do X", or similar project-wide guidance should be extracted as separate memories (typically memory_type=rule).',
    '- Split composite content into multiple memories when it mixes distinct concepts. One memory per concept: e.g. a general principle (rule), a file/structure fact (fact), a workflow step (episode), an architectural choice (decision). Do not create a single "kitchen sink" memory that bundles unrelated ideas.',
    '- memory_type guidance: rule = general principles, preferences, constraints, "how we do X"; fact = structural facts, file locations, exports, types; decision = architectural choices, trade-offs; episode = specific event, workflow step, or contextual detail.',
    '',
    '## Allowed action contracts',
    '',
    '- create: {"action":"create","confidence":0..1,"reason":"...","memory_type":"fact|rule|decision|episode","content":"...","tags":[...],"is_pinned":boolean,"path_matchers":[{"path_matcher":"..."}]}',
    '- update: {"action":"update","confidence":0..1,"reason":"...","memory_id":"...","updates":{"content?":"...","tags?":[...],"is_pinned?":boolean,"path_matchers?":[{"path_matcher":"..."}]}}',
    '- delete: {"action":"delete","confidence":0..1,"reason":"...","memory_id":"..."}',
    '- skip: {"action":"skip","confidence":0..1,"reason":"..."}',
    '',
    '## Hard requirements',
    '',
    '- Every create action MUST include memory_type.',
    '- memory_type must be exactly one of: fact, rule, decision, episode.',
    '- update/delete must target existing memory ids obtained from the recall tool.',
    '- If required fields are missing or uncertain, emit skip instead of partial create/update/delete.',
    '- Do not invent memory IDs — only use IDs returned by the recall tool.',
    '',
    '## Safety rules',
    '',
    '- prefer no-op when uncertain',
    '- never include secrets',
    '- create/update may include path_matchers only when file scope is clear',
    '- confidence must be in range [0,1]',
    '',
    '## Pinning rules',
    '',
    '- ALMOST ALL memories should be is_pinned=false. Pinned memories are injected into EVERY session start, consuming context budget. Only pin if the memory is critical to virtually every future task.',
    '- is_pinned=true is reserved for rare, project-wide invariants: e.g. "this is a Python 3.12 monorepo" or "never commit to main directly". Most projects have 0-3 pinned memories total.',
    '- is_pinned=false for: file-specific rules, per-directory constraints, tech preferences, workflow steps, "do not edit X", "use Y for Z", and anything discoverable via recall search.',
    '- if uncertain, ALWAYS default to is_pinned=false.',
    "- only change an existing memory's is_pinned state when the transcript explicitly asks for it to be pinned/unpinned.",
    '',
    '## Related paths',
    '',
    input.relatedPaths.length > 0
      ? input.relatedPaths.map((value) => `- ${value}`).join('\n')
      : '- none',
    '',
    '## Last assistant message',
    '',
    input.lastAssistantMessage ?? '(none)',
    '',
    '## Last 3 interactions',
    '',
    input.last3Interactions,
  ].join('\n');
}

async function runClaudePrompt(
  prompt: string,
  projectRoot: string,
  pluginRoot: string,
): Promise<ClaudeRunResult> {
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
        '--allowedTools', 'Read,mcp__memories__recall',
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
      resolve({
        code: code ?? 1,
        stdout,
        stderr,
      });
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

function parseWorkerOutput(rawStdout: string): ReturnType<typeof workerOutputSchema.parse> {
  const parsed = parseClaudeJson(rawStdout);
  return workerOutputSchema.parse(parsed);
}

function parseClaudeJson(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new ExtractionParseError('Claude extraction produced empty output', {
      parser_stage: 'top-level',
      stdout_chars: raw.length,
      stdout_preview: summarizeTextPreview(raw, CLAUDE_OUTPUT_PREVIEW_MAX_CHARS),
    });
  }

  let outer: unknown;
  try {
    outer = JSON.parse(trimmed) as unknown;
  } catch (error) {
    throw new ExtractionParseError('Claude extraction output was not valid JSON', {
      parser_stage: 'top-level',
      stdout_chars: raw.length,
      stdout_preview: summarizeTextPreview(raw, CLAUDE_OUTPUT_PREVIEW_MAX_CHARS),
      ...(error instanceof Error ? { parse_error: error.message } : {}),
    });
  }

  if (workerOutputSchema.safeParse(outer).success) {
    return outer;
  }
  if (isActionsObject(outer)) {
    return outer;
  }

  const topLevelKeys = isRecord(outer) ? Object.keys(outer) : [];
  const parseDebugInfo: ExtractionParseDebugInfo = {
    parser_stage: 'payload-extraction',
    stdout_chars: raw.length,
    stdout_preview: summarizeTextPreview(raw, CLAUDE_OUTPUT_PREVIEW_MAX_CHARS),
    ...(topLevelKeys.length > 0 ? { top_level_keys: topLevelKeys } : {}),
  };

  if (outer && typeof outer === 'object') {
    const candidate = outer as {
      content?: Array<{ text?: string }>;
      result?: unknown;
    };
    parseDebugInfo.has_result_string = typeof candidate.result === 'string';
    parseDebugInfo.has_result_object = !!candidate.result && typeof candidate.result === 'object';
    parseDebugInfo.content_block_count = Array.isArray(candidate.content)
      ? candidate.content.length
      : 0;
    parseDebugInfo.content_text_block_count = Array.isArray(candidate.content)
      ? candidate.content.filter((block) => typeof block?.text === 'string').length
      : 0;

    if (typeof candidate.result === 'string') {
      const parsedResult = parseWorkerOutputFromText(candidate.result);
      if (parsedResult) {
        return parsedResult;
      }
    }

    if (Array.isArray(candidate.content)) {
      for (const block of candidate.content) {
        if (typeof block.text !== 'string') {
          continue;
        }
        const parsedBlock = parseWorkerOutputFromText(block.text);
        if (parsedBlock) {
          return parsedBlock;
        }
      }
    }
  }

  throw new ExtractionParseError(
    'Claude extraction output did not include a valid actions payload',
    parseDebugInfo,
  );
}

function parseWorkerOutputFromText(text: string): unknown | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  const direct = safeJsonParse(trimmed);
  if (direct && isActionsObject(direct)) {
    return direct;
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (!fenced || !fenced[1]) {
    return null;
  }
  const fromFence = safeJsonParse(fenced[1]);
  if (fromFence && isActionsObject(fromFence)) {
    return fromFence;
  }
  return null;
}

function sanitizeWorkerAction(action: WorkerAction, relatedPaths: string[]): WorkerAction {
  if (action.action === 'create') {
    return {
      ...action,
      path_matchers: sanitizePathMatchers(action.path_matchers, relatedPaths),
    };
  }
  if (action.action === 'update' && action.updates.path_matchers) {
    return {
      ...action,
      updates: {
        ...action.updates,
        path_matchers: sanitizePathMatchers(action.updates.path_matchers, relatedPaths),
      },
    };
  }
  return action;
}

function sanitizePathMatchers(
  matchers: Array<{ path_matcher: string }>,
  relatedPaths: string[],
): Array<{ path_matcher: string }> {
  const disallowed = new Set(['*', '**', '**/*', '/', './']);
  const byBasename = new Map<string, string>(
    relatedPaths.map((relatedPath) => [path.posix.basename(relatedPath), relatedPath]),
  );

  const seen = new Set<string>();
  const sanitized: Array<{ path_matcher: string }> = [];

  for (const matcher of matchers) {
    const raw = matcher.path_matcher.trim();
    if (!raw) {
      continue;
    }
    const withoutLineSuffix = raw.replace(/:(?:L)?\d+$/i, '');
    let normalized = normalizePathForMatch(withoutLineSuffix);
    if (!normalized || disallowed.has(normalized)) {
      continue;
    }

    if (!normalized.includes('/') && byBasename.has(normalized)) {
      normalized = byBasename.get(normalized) ?? normalized;
    }
    if (disallowed.has(normalized) || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    sanitized.push({ path_matcher: normalized });
    if (sanitized.length >= 12) {
      break;
    }
  }

  return sanitized;
}


async function applyAction(
  endpoint: { host: string; port: number },
  repoId: string,
  action: WorkerAction,
): Promise<ActionApplyOutcome> {
  if (action.action === 'skip') {
    return { ok: true };
  }

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
    return toActionApplyOutcome(response);
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
    return toActionApplyOutcome(response);
  }

  const response = await fetch(
    `http://${endpoint.host}:${endpoint.port}/memories/${action.memory_id}?repo_id=${encodeURIComponent(repoId)}`,
    {
      method: 'DELETE',
    },
  );
  return toActionApplyOutcome(response);
}

async function toActionApplyOutcome(response: Response): Promise<ActionApplyOutcome> {
  if (response.ok) {
    return { ok: true };
  }

  try {
    const body = (await response.json()) as { error?: { code?: string; message?: string } };
    return {
      ok: false,
      code: body.error?.code ?? `HTTP_${response.status}`,
      message: body.error?.message ?? response.statusText,
    };
  } catch {
    return {
      ok: false,
      code: `HTTP_${response.status}`,
      message: response.statusText,
    };
  }
}

function safeJsonParse(input: string): unknown | null {
  try {
    return JSON.parse(input) as unknown;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isActionsObject(value: unknown): value is { actions: unknown[] } {
  return isRecord(value) && Array.isArray(value.actions);
}

async function runFromCli(): Promise<void> {
  const encodedHandoff = readHandoffArg(process.argv);
  if (!encodedHandoff) {
    return;
  }

  const payload = decodeWorkerPayload(encodedHandoff);
  await executeWorker(payload);
}

void runFromCli();
