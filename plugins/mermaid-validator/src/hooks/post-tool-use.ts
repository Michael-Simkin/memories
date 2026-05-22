import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

import { z } from 'zod';

import { renderReport, validateMarkdown } from '../validator/validate.js';

const MARKDOWN_EXT = new Set(['.md', '.markdown', '.mdx']);

const payloadSchema = z.object({
  tool_name: z.string().optional(),
  tool_input: z
    .object({
      file_path: z.string().optional(),
    })
    .optional(),
});

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8').trim();
}

async function main(): Promise<void> {
  const raw = await readStdin();
  if (!raw) process.exit(0);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    process.exit(0);
  }
  const payload = payloadSchema.safeParse(parsed);
  if (!payload.success) process.exit(0);

  const filePath = payload.data.tool_input?.file_path;
  if (!filePath) process.exit(0);
  if (!MARKDOWN_EXT.has(extname(filePath).toLowerCase())) process.exit(0);

  let content: string;
  try {
    content = await readFile(filePath, 'utf8');
  } catch {
    process.exit(0);
  }

  if (!content.includes('```mermaid')) process.exit(0);

  const result = await validateMarkdown(content);
  if (result.failures.length === 0) process.exit(0);

  process.stderr.write(renderReport(filePath, result) + '\n');
  process.exit(2);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`mermaid-validator: skipped — ${msg}\n`);
  process.exit(0);
});
