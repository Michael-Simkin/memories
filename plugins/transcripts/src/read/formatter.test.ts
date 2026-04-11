import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { readTranscriptRange } from './formatter.js';

async function writeTestTranscript(lines: unknown[]): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'transcripts-fmt-'));
  const filePath = path.join(dir, 'test.jsonl');
  const content = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  await writeFile(filePath, content, 'utf8');
  return filePath;
}

describe('formatter', () => {
  it('formats user and assistant lines with line numbers', async () => {
    const filePath = await writeTestTranscript([
      {
        type: 'user',
        cwd: '/project',
        timestamp: '2026-04-10T12:00:00Z',
        message: { role: 'user', content: 'Hello' },
      },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hi there' }],
        },
      },
    ]);

    const result = readTranscriptRange(filePath, 1, 2);

    expect(result.header).toContain('2026-04-10');
    expect(result.header).toContain('/project');
    expect(result.lines).toHaveLength(2);
    expect(result.lines[0]).toContain('L1');
    expect(result.lines[0]).toContain('**User**');
    expect(result.lines[0]).toContain('Hello');
    expect(result.lines[1]).toContain('L2');
    expect(result.lines[1]).toContain('**Assistant**');
    expect(result.lines[1]).toContain('Hi there');
  });

  it('renders noise lines as empty', async () => {
    const filePath = await writeTestTranscript([
      { type: 'file-history-snapshot', snapshot: {} },
      { type: 'progress', message: { role: 'assistant', content: 'streaming...' } },
      {
        type: 'user',
        cwd: '/x',
        timestamp: '2026-01-01T00:00:00Z',
        message: { role: 'user', content: 'Real message' },
      },
    ]);

    const result = readTranscriptRange(filePath, 1, 3);
    expect(result.lines).toHaveLength(3);
    expect(result.lines[0]).toBe('L1 |');
    expect(result.lines[1]).toBe('L2 |');
    expect(result.lines[2]).toContain('Real message');
  });

  it('preserves line numbers for sparse ranges', async () => {
    const filePath = await writeTestTranscript([
      { type: 'file-history-snapshot', snapshot: {} },
      { type: 'file-history-snapshot', snapshot: {} },
      { type: 'file-history-snapshot', snapshot: {} },
      {
        type: 'user',
        cwd: '/x',
        timestamp: '2026-01-01T00:00:00Z',
        message: { role: 'user', content: 'Line four' },
      },
    ]);

    const result = readTranscriptRange(filePath, 3, 4);
    expect(result.lines).toHaveLength(2);
    expect(result.lines[0]).toBe('L3 |');
    expect(result.lines[1]).toContain('L4');
    expect(result.lines[1]).toContain('Line four');
  });

  it('clamps range to file boundaries', async () => {
    const filePath = await writeTestTranscript([
      {
        type: 'user',
        cwd: '/x',
        timestamp: '2026-01-01T00:00:00Z',
        message: { role: 'user', content: 'Only line' },
      },
    ]);

    const result = readTranscriptRange(filePath, 1, 100);
    expect(result.lines).toHaveLength(1);
  });

  it('drops thinking and sidechain content', async () => {
    const filePath = await writeTestTranscript([
      {
        type: 'assistant',
        cwd: '/x',
        timestamp: '2026-01-01T00:00:00Z',
        isSidechain: true,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'subagent output' }],
        },
      },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'secret thoughts' },
            { type: 'text', text: 'visible' },
          ],
        },
      },
    ]);

    const result = readTranscriptRange(filePath, 1, 2);
    expect(result.lines[0]).toBe('L1 |'); // sidechain → empty
    expect(result.lines[1]).toContain('visible');
    expect(result.lines[1]).not.toContain('secret thoughts');
  });

  it('formats tool_use names in read output', async () => {
    const filePath = await writeTestTranscript([
      {
        type: 'assistant',
        cwd: '/x',
        timestamp: '2026-01-01T00:00:00Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Checking file' },
            { type: 'tool_use', name: 'Read', id: 't1', input: {} },
          ],
        },
      },
    ]);

    const result = readTranscriptRange(filePath, 1, 1);
    expect(result.lines[0]).toContain('[Tool: Read]');
  });
});
