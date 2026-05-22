import { extractMermaidBlocks, type MermaidBlock } from './extract.js';
import { getMermaid } from './mermaid-env.js';

export interface BlockFailure {
  block: MermaidBlock;
  message: string;
}

export interface ValidateResult {
  totalBlocks: number;
  failures: BlockFailure[];
}

const MAX_ERROR_LINES = 6;
const MAX_ERROR_CHARS = 600;

export async function validateMarkdown(markdown: string): Promise<ValidateResult> {
  const blocks = extractMermaidBlocks(markdown);
  if (blocks.length === 0) return { totalBlocks: 0, failures: [] };

  const mermaid = await getMermaid();
  const failures: BlockFailure[] = [];
  for (const block of blocks) {
    try {
      await mermaid.parse(block.source);
    } catch (err) {
      failures.push({ block, message: formatError(err) });
    }
  }
  return { totalBlocks: blocks.length, failures };
}

function formatError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const trimmed = raw.split('\n').slice(0, MAX_ERROR_LINES).join('\n');
  return trimmed.length > MAX_ERROR_CHARS ? `${trimmed.slice(0, MAX_ERROR_CHARS)}…` : trimmed;
}

export function renderReport(filePath: string, result: ValidateResult): string {
  const { totalBlocks, failures } = result;
  const lines: string[] = [];
  lines.push(
    `✗ Mermaid validation failed in ${filePath} — ${failures.length}/${totalBlocks} block(s) bad:`,
  );
  for (const f of failures) {
    lines.push('');
    lines.push(`— block ${f.block.index} (starts at line ${f.block.startLine})`);
    lines.push(f.message);
  }
  lines.push('');
  lines.push('Fix each block above so it parses with the mermaid parser, then re-save the file.');
  return lines.join('\n');
}
