export interface MermaidBlock {
  index: number;
  startLine: number;
  source: string;
}

const FENCE_RE = /(^|\n)([ \t]*)```mermaid[^\n]*\n([\s\S]*?)\n[ \t]*```/g;

export function extractMermaidBlocks(markdown: string): MermaidBlock[] {
  const blocks: MermaidBlock[] = [];
  let match: RegExpExecArray | null;
  let i = 0;
  while ((match = FENCE_RE.exec(markdown)) !== null) {
    const leadingNewline = match[1] ?? '';
    const openOffset = match.index + leadingNewline.length;
    const startLine = lineAt(markdown, openOffset) + 1;
    const source = (match[3] ?? '').replace(/\r\n/g, '\n');
    blocks.push({ index: ++i, startLine, source });
  }
  return blocks;
}

function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i++) {
    if (text.charCodeAt(i) === 10) line++;
  }
  return line;
}
