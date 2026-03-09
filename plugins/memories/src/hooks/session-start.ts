import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { ensureEngine } from '../engine/ensure-engine.js';
import { REQUIRED_ENGINE_NODE_MAJOR } from '../engine/node-runtime.js';
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
import { appendEventLog } from '../shared/logs.js';
import { formatMemoryRecallMarkdown } from '../shared/markdown.js';
import { ensureProjectDirectories } from '../shared/paths.js';
import type { SearchResponse } from '../shared/types.js';
import {
  getEngineJson,
  isEngineUnavailableError,
  postEngineJson,
  resolveHookProjectRoot,
} from './common.js';
import { type SessionStartPayload, sessionStartPayloadSchema } from './schemas.js';

const execFileAsync = promisify(execFile);
const GENERIC_STARTUP_FAILURE_MESSAGE = 'Memories could not be launched, see details in the logs';
const MAX_SESSION_START_OLLAMA_TIMEOUT_MS = 2500;

type OllamaStartupIssueCode =
  | 'ollama_not_installed'
  | 'ollama_service_not_running'
  | 'ollama_model_missing';

interface StartupIssue {
  additionalContext: string;
  detail: string;
  systemMessage: string;
}

interface OllamaStartupIssue extends StartupIssue {
  code: OllamaStartupIssueCode;
}

interface SessionStartDependencies {
  appendEventLogFn: typeof appendEventLog;
  diagnoseOllamaFn: () => Promise<OllamaStartupIssue | null>;
  ensureEngineFn: typeof ensureEngine;
  ensureProjectDirectoriesFn: typeof ensureProjectDirectories;
  getEngineJsonFn: typeof getEngineJson;
  postEngineJsonFn: typeof postEngineJson;
}

const defaultDependencies: SessionStartDependencies = {
  appendEventLogFn: appendEventLog,
  diagnoseOllamaFn: diagnoseOllamaStartupIssue,
  ensureEngineFn: ensureEngine,
  ensureProjectDirectoriesFn: ensureProjectDirectories,
  getEngineJsonFn: getEngineJson,
  postEngineJsonFn: postEngineJson,
};

class OllamaServiceNotRunningError extends Error {}

function renderStartupMemoryContext(markdown: string): string {
  const indentedMarkdown = markdown
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');

  return [
    '<memory>',
    '  <guidance>',
    '    The `recall` tool is your main memory brain for this project.',
    '    REQUIRED: call `recall` before acting. Do not skip.',
    '    Before commands, edits, updates, creations, deletions, or final recommendations, run `recall` to validate the intended action against remembered rules, decisions, preferences, and prior context.',
    '    If the user names a file, path, command, or requested change, treat that as a cue to check memory first. Direct instructions do not override remembered project rules.',
    '    If memory conflicts with the requested action, stop, explain the conflict, and ask or propose a compliant alternative.',
    '    Memory capture runs automatically after the session. No separate memory-write tool is available or needed; use `recall` only when you need stored context.',
    '    This startup block contains only pinned memories, not the full memory set. Run `recall` whenever broader context or constraints may matter.',
    '  </guidance>',
    '  <pinned_memories>',
    indentedMarkdown,
    '  </pinned_memories>',
    '</memory>',
  ].join('\n');
}

function macOsOllamaSetupCommands(
  code: OllamaStartupIssueCode,
  model: string,
): [string, string, string] {
  switch (code) {
    case 'ollama_not_installed':
      return ['brew install ollama', 'brew services start ollama', `ollama pull ${model}`];
    case 'ollama_service_not_running':
      return ['brew services start ollama', 'brew services list', 'ollama list'];
    case 'ollama_model_missing':
      return ['ollama list', `ollama pull ${model}`, `ollama show ${model}`];
  }
}

function formatCommandList(commands: [string, string, string]): string {
  const [first, second, third] = commands;
  return `\`${first}\`, \`${second}\`, and \`${third}\``;
}

function describeOllamaIssue(code: OllamaStartupIssueCode, model: string): string {
  switch (code) {
    case 'ollama_not_installed':
      return 'Ollama is not installed';
    case 'ollama_service_not_running':
      return 'Ollama is installed but the background service is not running';
    case 'ollama_model_missing':
      return `the Ollama model \`${model}\` is not installed`;
  }
}

function renderOllamaSystemMessage(code: OllamaStartupIssueCode, model: string): string {
  const commands = macOsOllamaSetupCommands(code, model);
  return `Memories could not be launched on macOS because ${describeOllamaIssue(code, model)}. Run ${formatCommandList(commands)}. Or ask Claude to do it for you.`;
}

function renderOllamaAdditionalContext(code: OllamaStartupIssueCode, model: string): string {
  const commands = macOsOllamaSetupCommands(code, model);
  return [
    '<memory-setup>',
    `Memories are unavailable because ${describeOllamaIssue(code, model)} on macOS.`,
    'If the user asks you to fix this, run these commands in order:',
    ...commands.map((command) => `- \`${command}\``),
    'Do not run setup commands unless the user asks.',
    '</memory-setup>',
  ].join('\n');
}

function createOllamaStartupIssue(
  code: OllamaStartupIssueCode,
  model: string,
  detail: string,
): OllamaStartupIssue {
  return {
    additionalContext: renderOllamaAdditionalContext(code, model),
    code,
    detail,
    systemMessage: renderOllamaSystemMessage(code, model),
  };
}

function renderNodeRuntimeSystemMessage(): string {
  return (
    `Memories could not be launched because Node ${REQUIRED_ENGINE_NODE_MAJOR} is not available for engine startup. ` +
    `Run \`nvm install ${REQUIRED_ENGINE_NODE_MAJOR}\` and relaunch Claude, or set \`MEMORIES_NODE_BIN\` to the absolute path of a Node ${REQUIRED_ENGINE_NODE_MAJOR} binary. ` +
    'Or ask Claude to do it for you.'
  );
}

function renderNodeRuntimeAdditionalContext(): string {
  return [
    '<memory-setup>',
    `Memories are unavailable because Node ${REQUIRED_ENGINE_NODE_MAJOR} was not found for engine startup.`,
    'If the user asks you to fix this, choose one of these options:',
    `- \`nvm install ${REQUIRED_ENGINE_NODE_MAJOR}\``,
    `- relaunch Claude from a shell where \`nvm use ${REQUIRED_ENGINE_NODE_MAJOR}\` is active`,
    `- ask the user for an absolute Node ${REQUIRED_ENGINE_NODE_MAJOR} binary path and set \`MEMORIES_NODE_BIN=/absolute/path/to/node\` before launching Claude`,
    'Do not run setup commands unless the user asks.',
    '</memory-setup>',
  ].join('\n');
}

function detectNodeRuntimeStartupIssue(error: unknown): StartupIssue | null {
  if (!(error instanceof Error)) {
    return null;
  }

  if (!error.message.includes(`Node ${REQUIRED_ENGINE_NODE_MAJOR}.x is required for engine startup`)) {
    return null;
  }

  return {
    additionalContext: renderNodeRuntimeAdditionalContext(),
    detail: error.message,
    systemMessage: renderNodeRuntimeSystemMessage(),
  };
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

function startupOllamaTimeoutMs(): number {
  const configuredTimeoutMs = parsePositiveInteger(
    process.env.MEMORIES_OLLAMA_TIMEOUT_MS,
    DEFAULT_OLLAMA_TIMEOUT_MS,
  );
  return Math.min(configuredTimeoutMs, MAX_SESSION_START_OLLAMA_TIMEOUT_MS);
}

async function fetchOllamaModelNames(baseUrl: string): Promise<string[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), startupOllamaTimeoutMs());

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/api/tags`, {
      method: 'GET',
      signal: controller.signal,
    });
  } catch (error) {
    throw new OllamaServiceNotRunningError(
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const responseText = await response.text();
    throw new Error(`Ollama tags request failed: ${response.status} ${response.statusText} ${responseText}`);
  }

  const payload = (await response.json()) as { models?: unknown };
  if (!Array.isArray(payload.models)) {
    throw new Error('Ollama tags response did not include a models array');
  }

  return payload.models.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') {
      return [];
    }

    const names: string[] = [];
    const maybeEntry = entry as { model?: unknown; name?: unknown };
    if (typeof maybeEntry.name === 'string') {
      names.push(maybeEntry.name);
    }
    if (typeof maybeEntry.model === 'string') {
      names.push(maybeEntry.model);
    }
    return names;
  });
}

function hasOllamaModel(modelNames: string[], model: string): boolean {
  return modelNames.some((entry) => {
    const trimmed = entry.trim();
    return trimmed === model || trimmed.startsWith(`${model}:`) || trimmed.split(':')[0] === model;
  });
}

async function diagnoseOllamaStartupIssue(): Promise<OllamaStartupIssue | null> {
  const profile = resolveOllamaProfile(process.env.MEMORIES_OLLAMA_PROFILE);
  const model = OLLAMA_PROFILE_CONFIG[profile].model;
  const baseUrl = (process.env.MEMORIES_OLLAMA_URL ?? DEFAULT_OLLAMA_URL).trim().replace(/\/+$/, '');

  if (!baseUrl) {
    throw new Error('Ollama URL is blank; memories require Ollama to launch.');
  }

  if (!(await isOllamaInstalled())) {
    return createOllamaStartupIssue(
      'ollama_not_installed',
      model,
      `OLLAMA_NOT_INSTALLED: ollama CLI not found; model=${model}; baseUrl=${baseUrl}`,
    );
  }

  let modelNames: string[];
  try {
    modelNames = await fetchOllamaModelNames(baseUrl);
  } catch (error) {
    if (error instanceof OllamaServiceNotRunningError) {
      return createOllamaStartupIssue(
        'ollama_service_not_running',
        model,
        `OLLAMA_SERVICE_NOT_RUNNING: ${error.message}; model=${model}; baseUrl=${baseUrl}`,
      );
    }
    throw error;
  }

  if (!hasOllamaModel(modelNames, model)) {
    return createOllamaStartupIssue(
      'ollama_model_missing',
      model,
      `OLLAMA_MODEL_MISSING: model=${model}; baseUrl=${baseUrl}; available=${modelNames.join(', ') || 'none'}`,
    );
  }

  return null;
}

export async function handleSessionStart(
  payload: SessionStartPayload,
  dependencies: SessionStartDependencies = defaultDependencies,
): Promise<HookResult> {
  const projectRoot = resolveHookProjectRoot(payload);
  const sessionId = payload.session_id?.trim();
  let eventLogPath: string | null = null;

  try {
    const paths = await dependencies.ensureProjectDirectoriesFn(projectRoot);
    eventLogPath = paths.eventLogPath;

    const ollamaIssue = await dependencies.diagnoseOllamaFn();
    if (ollamaIssue) {
      await dependencies.appendEventLogFn(paths.eventLogPath, {
        at: new Date().toISOString(),
        event: 'SessionStart',
        kind: 'hook',
        status: 'skipped',
        ...(sessionId ? { session_id: sessionId } : {}),
        detail: ollamaIssue.detail,
      });
      return {
        continue: true,
        systemMessage: ollamaIssue.systemMessage,
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: ollamaIssue.additionalContext,
        },
      };
    }

    const endpoint = await dependencies.ensureEngineFn(projectRoot);
    if (sessionId) {
      await dependencies.postEngineJsonFn(endpoint, '/sessions/connect', { session_id: sessionId });
    }

    const pinned = await dependencies.getEngineJsonFn<SearchResponse>(endpoint, '/memories/pinned');
    const markdown = formatMemoryRecallMarkdown({
      query: 'session-start:pinned',
      results: pinned.results,
      durationMs: pinned.meta.duration_ms,
      source: 'engine:/memories/pinned',
    });
    const memoryUiUrl = `http://${endpoint.host}:${endpoint.port}/ui`;

    await dependencies.appendEventLogFn(paths.eventLogPath, {
      at: new Date().toISOString(),
      event: 'SessionStart',
      kind: 'hook',
      status: 'ok',
      ...(sessionId ? { session_id: sessionId } : {}),
      detail: `ui=${memoryUiUrl}`,
    });

    return {
      continue: true,
      systemMessage: `Memory UI: ${memoryUiUrl}`,
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: renderStartupMemoryContext(markdown),
      },
    };
  } catch (error) {
    const nodeRuntimeIssue = detectNodeRuntimeStartupIssue(error);
    if (nodeRuntimeIssue && eventLogPath) {
      await dependencies.appendEventLogFn(eventLogPath, {
        at: new Date().toISOString(),
        event: 'SessionStart',
        kind: 'hook',
        status: 'skipped',
        ...(sessionId ? { session_id: sessionId } : {}),
        detail: nodeRuntimeIssue.detail,
      });
      return {
        continue: true,
        systemMessage: nodeRuntimeIssue.systemMessage,
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: nodeRuntimeIssue.additionalContext,
        },
      };
    }

    if (isEngineUnavailableError(error) && eventLogPath) {
      await dependencies.appendEventLogFn(eventLogPath, {
        at: new Date().toISOString(),
        event: 'SessionStart',
        kind: 'hook',
        status: 'skipped',
        ...(sessionId ? { session_id: sessionId } : {}),
        detail: error instanceof Error ? error.message : String(error),
      });
      return {
        continue: true,
        systemMessage: GENERIC_STARTUP_FAILURE_MESSAGE,
      };
    }

    if (eventLogPath) {
      await dependencies.appendEventLogFn(eventLogPath, {
        at: new Date().toISOString(),
        event: 'SessionStart',
        kind: 'hook',
        status: 'error',
        ...(sessionId ? { session_id: sessionId } : {}),
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    logError('SessionStart hook failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      continue: true,
      systemMessage: GENERIC_STARTUP_FAILURE_MESSAGE,
    };
  }
}

async function run(): Promise<void> {
  const payload = await readJsonFromStdin(sessionStartPayloadSchema);
  if (!payload) {
    writeFailOpenOutput();
    return;
  }
  const output = await handleSessionStart(payload);
  writeHookOutput(output);
}

void run().catch((error) => {
  logError('SessionStart hook entrypoint failed', {
    error: error instanceof Error ? error.message : String(error),
  });
  writeFailOpenOutput();
});
