import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  DEFAULT_OLLAMA_TIMEOUT_MS,
  DEFAULT_OLLAMA_URL,
  OLLAMA_PROFILE_CONFIG,
  parsePositiveInteger,
  resolveOllamaProfile,
} from '../shared/constants.js';
import {
  type HookResult,
  readJsonFromStdin,
  writeFailOpenOutput,
  writeHookOutput,
} from '../shared/hook-io.js';
import { logError } from '../shared/logger.js';
import { sessionStartPayloadSchema } from '../shared/types.js';

const execFileAsync = promisify(execFile);
const MAX_STARTUP_OLLAMA_TIMEOUT_MS = 2500;

type OllamaIssueCode = 'ollama_not_installed' | 'ollama_service_not_running' | 'ollama_model_missing';

function resolveModel(): string {
  const profile = resolveOllamaProfile(process.env.TRANSCRIPTS_OLLAMA_PROFILE);
  return OLLAMA_PROFILE_CONFIG[profile].model;
}

function resolveBaseUrl(): string {
  return (process.env.TRANSCRIPTS_OLLAMA_URL ?? DEFAULT_OLLAMA_URL).trim().replace(/\/+$/, '');
}

function ollamaTimeoutMs(): number {
  return Math.min(
    parsePositiveInteger(process.env.TRANSCRIPTS_OLLAMA_TIMEOUT_MS, DEFAULT_OLLAMA_TIMEOUT_MS),
    MAX_STARTUP_OLLAMA_TIMEOUT_MS,
  );
}

function macOsSetupCommands(code: OllamaIssueCode, model: string): [string, string, string] {
  switch (code) {
    case 'ollama_not_installed':
      return ['brew install ollama', 'brew services start ollama', `ollama pull ${model}`];
    case 'ollama_service_not_running':
      return ['brew services start ollama', 'brew services list', 'ollama list'];
    case 'ollama_model_missing':
      return ['ollama list', `ollama pull ${model}`, `ollama show ${model}`];
  }
}

function describeIssue(code: OllamaIssueCode, model: string): string {
  switch (code) {
    case 'ollama_not_installed':
      return 'Ollama is not installed';
    case 'ollama_service_not_running':
      return 'Ollama is installed but the background service is not running';
    case 'ollama_model_missing':
      return `the Ollama model \`${model}\` is not installed`;
  }
}

function renderSetupSystemMessage(code: OllamaIssueCode, model: string): string {
  const cmds = macOsSetupCommands(code, model);
  return `Transcript search is unavailable because ${describeIssue(code, model)}. Run \`${cmds[0]}\`, \`${cmds[1]}\`, and \`${cmds[2]}\`. Or ask Claude to do it for you.`;
}

function renderSetupAdditionalContext(code: OllamaIssueCode, model: string): string {
  const cmds = macOsSetupCommands(code, model);
  return [
    '<transcript-search-setup>',
    `Transcript search is unavailable because ${describeIssue(code, model)} on macOS.`,
    'If the user asks you to fix this, run these commands in order:',
    ...cmds.map((c) => `- \`${c}\``),
    'Do not run setup commands unless the user asks.',
    '</transcript-search-setup>',
  ].join('\n');
}

async function isOllamaInstalled(): Promise<boolean> {
  try {
    await execFileAsync('ollama', ['--version']);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function fetchOllamaModelNames(baseUrl: string): Promise<string[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ollamaTimeoutMs());

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/api/tags`, {
      method: 'GET',
      signal: controller.signal,
    });
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) return [];

  const payload = (await response.json()) as { models?: unknown };
  if (!Array.isArray(payload.models)) return [];

  return payload.models.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const e = entry as { model?: unknown; name?: unknown };
    const names: string[] = [];
    if (typeof e.name === 'string') names.push(e.name);
    if (typeof e.model === 'string') names.push(e.model);
    return names;
  });
}

function hasModel(modelNames: string[], model: string): boolean {
  return modelNames.some((name) => {
    const trimmed = name.trim();
    return trimmed === model || trimmed.startsWith(`${model}:`) || trimmed.split(':')[0] === model;
  });
}

async function diagnoseOllama(): Promise<{ code: OllamaIssueCode; model: string } | null> {
  const model = resolveModel();
  const baseUrl = resolveBaseUrl();

  if (!(await isOllamaInstalled())) {
    return { code: 'ollama_not_installed', model };
  }

  const modelNames = await fetchOllamaModelNames(baseUrl);
  if (modelNames.length === 0) {
    return { code: 'ollama_service_not_running', model };
  }

  if (!hasModel(modelNames, model)) {
    return { code: 'ollama_model_missing', model };
  }

  return null;
}

function renderHealthyContext(): string {
  return [
    '<transcript-search>',
    '  <guidance>',
    '    Two MCP tools are available for searching past session transcripts:',
    '    - `search_transcripts(query)`: Semantic search returning locations, snippets, scores, and timestamps.',
    '    - `read_transcript(transcript_path, start_line, end_line)`: Read formatted conversation lines from a transcript file (max 50 lines).',
    '    Use the `/validate <aspect>` skill before implementing anything to check past sessions for relevant rules and preferences.',
    '    Recent sessions take precedence over older ones when rules conflict.',
    '  </guidance>',
    '</transcript-search>',
  ].join('\n');
}

async function handleSessionStart(): Promise<HookResult> {
  const issue = await diagnoseOllama();

  if (issue) {
    return {
      continue: true,
      systemMessage: renderSetupSystemMessage(issue.code, issue.model),
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: renderSetupAdditionalContext(issue.code, issue.model),
      },
    };
  }

  return {
    continue: true,
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: renderHealthyContext(),
    },
  };
}

async function run(): Promise<void> {
  const payload = await readJsonFromStdin(sessionStartPayloadSchema);
  if (!payload) {
    writeFailOpenOutput();
    return;
  }
  const output = await handleSessionStart();
  writeHookOutput(output);
}

void run().catch((error) => {
  logError('SessionStart hook failed', {
    error: error instanceof Error ? error.message : String(error),
  });
  writeFailOpenOutput();
});
