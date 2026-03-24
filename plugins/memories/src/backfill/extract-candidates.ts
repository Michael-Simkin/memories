import { spawn } from 'node:child_process';

import { z } from 'zod';

import type { CandidateInsight } from './types.js';

const candidateSchema = z.object({
  content: z.string().trim().min(1),
  memory_type: z.enum(['guide', 'context']),
  tags: z.array(z.string().trim().min(1)).default([]),
  is_pinned: z.boolean().default(false),
  path_matchers: z
    .array(
      z.union([
        z.object({ path_matcher: z.string() }),
        z.string().transform((s) => ({ path_matcher: s })),
      ]),
    )
    .default([]),
  confidence: z.number().min(0).max(1),
  reason: z.string().default(''),
});

const candidatesOutputSchema = z.object({
  candidates: z.array(candidateSchema),
});

function buildPhase1Prompt(transcriptPath: string): string {
  return [
    'You are a memory extraction agent. Your job is to read a Claude Code session transcript and extract durable insights worth remembering for future sessions.',
    '',
    '## Transcript',
    '',
    `The transcript is a JSONL file at: ${transcriptPath}`,
    'The file is JSONL (one JSON object per line) and may be very large.',
    'IMPORTANT: Use Bash to pre-filter the file before reading. For example:',
    `  grep -E '"type":"(user|assistant)"' '${transcriptPath}' | head -200`,
    'This extracts only user/assistant conversation lines, skipping noise (progress, system, etc.).',
    'Then use the Read tool or Bash to examine the filtered content.',
    '',
    '## Understanding the transcript format',
    '',
    'Each line is a JSON object. Key fields:',
    '- `type`: "user", "assistant", "progress", "system", "file-history-snapshot"',
    '- `message.content`: the actual text (string) or content blocks (array)',
    '',
    'Focus on lines where `type` is "user" or "assistant" — these are the actual conversation.',
    'SKIP these entirely: `type` = "progress" (streaming updates), "system", "file-history-snapshot".',
    'SKIP lines where `isSidechain` = true (internal subagent work).',
    'For assistant messages, ignore content blocks with `type` = "thinking" (internal reasoning).',
    'Tool calls (`tool_use`) and tool results (`tool_result`) have some context but the real insights are in user/assistant text.',
    '',
    '## What to extract',
    '',
    '- Conventions, constraints, preferences, behavioral rules ("always do X", "never do Y", "we use X for Y")',
    '- Stable repo knowledge: structural facts, file locations, architecture, key exports',
    '- Architectural decisions and their rationale',
    '- Workflow conventions and patterns',
    '',
    'Do NOT extract:',
    '- Ephemeral debugging steps, typo fixes, or one-off tasks',
    '- Secrets, credentials, or tokens',
    '- Content that only makes sense in the context of that one session',
    '',
    '## Output format',
    '',
    'After reading the transcript, return strict JSON only (no prose, no markdown fences):',
    '{"candidates":[...]}',
    '',
    'Each candidate:',
    '- content: the memory text (clear, self-contained)',
    '- memory_type: "guide" | "context"',
    '- tags: relevant keywords',
    '- is_pinned: almost always false (true only for rare project-wide invariants)',
    '- path_matchers: file paths this relates to (if any)',
    '- confidence: 0..1',
    '- reason: why this is worth remembering',
    '',
    'Split composite insights into separate candidates (one concept each).',
    'If nothing is worth extracting, return {"candidates":[]}.',
  ].join('\n');
}

export async function extractCandidates(
  transcriptPath: string,
  sessionId: string,
): Promise<CandidateInsight[]> {
  const prompt = buildPhase1Prompt(transcriptPath);
  const result = await runClaudeWithRead(prompt);

  if (result.code !== 0) {
    throw new Error(`Claude exited with status ${result.code}: ${result.stderr}`);
  }

  const parsed = parsePhase1Output(result.stdout);
  return parsed.map((c) => ({ ...c, source_session: sessionId }));
}

function parsePhase1Output(raw: string): Array<z.infer<typeof candidateSchema>> {
  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }

  const jsonText = extractJsonText(trimmed);
  if (!jsonText) {
    return [];
  }

  try {
    const result = candidatesOutputSchema.parse(JSON.parse(jsonText));
    return result.candidates;
  } catch {
    return [];
  }
}

function extractJsonText(raw: string): string | null {
  let outer: unknown;
  try {
    outer = JSON.parse(raw);
  } catch {
    return extractFromFences(raw);
  }

  if (!outer || typeof outer !== 'object') {
    return null;
  }

  const record = outer as Record<string, unknown>;

  if (typeof record.result === 'string') {
    const inner = record.result as string;
    const fromFences = extractFromFences(inner);
    if (fromFences) return fromFences;
    const fromBrace = extractJsonFromBrace(inner);
    if (fromBrace) return fromBrace;
    return inner;
  }

  if (Array.isArray(record.candidates)) {
    return raw;
  }

  if (Array.isArray(record.content)) {
    for (const block of record.content as Array<Record<string, unknown>>) {
      if (block?.type === 'text' && typeof block.text === 'string') {
        const fromFences = extractFromFences(block.text as string);
        if (fromFences) return fromFences;
        return block.text as string;
      }
    }
  }

  return raw;
}

function extractFromFences(text: string): string | null {
  const match = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  return match?.[1]?.trim() ?? null;
}

function extractJsonFromBrace(text: string): string | null {
  const idx = text.indexOf('{"candidates"');
  if (idx === -1) return null;
  const jsonPart = text.slice(idx);
  try {
    JSON.parse(jsonPart);
    return jsonPart;
  } catch {
    return null;
  }
}

function runClaudeWithRead(prompt: string): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'claude',
      [
        '--bare',
        '-p',
        '--output-format',
        'json',
        '--no-session-persistence',
        '--model',
        'claude-sonnet-4-6',
        '--allowedTools',
        'Read,Bash',
      ],
      {
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
