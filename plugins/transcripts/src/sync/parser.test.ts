import { describe, expect, it } from 'vitest';

import { parseTranscriptFile } from './parser.js';

function jsonl(...lines: unknown[]): string[] {
  return lines.map((l) => JSON.stringify(l));
}

describe('parser', () => {
  it('extracts user and assistant text turns', () => {
    const lines = jsonl(
      {
        type: 'user',
        timestamp: '2026-04-01T10:00:00Z',
        cwd: '/project/a',
        message: { role: 'user', content: 'Hello world' },
      },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hi there!' }],
        },
      },
    );

    const { metadata, turns } = parseTranscriptFile(lines);
    expect(metadata.projectPath).toBe('/project/a');
    expect(turns).toHaveLength(2);
    expect(turns[0]!.role).toBe('user');
    expect(turns[0]!.text).toBe('Hello world');
    expect(turns[0]!.lineNumber).toBe(1);
    expect(turns[1]!.role).toBe('assistant');
    expect(turns[1]!.text).toBe('Hi there!');
    expect(turns[1]!.lineNumber).toBe(2);
  });

  it('drops noise line types', () => {
    const lines = jsonl(
      { type: 'progress', message: { role: 'assistant', content: 'partial' } },
      { type: 'file-history-snapshot', snapshot: {} },
      { type: 'system', message: { role: 'system', content: 'sys prompt' } },
      { type: 'queue-operation' },
      { type: 'last-prompt' },
      { type: 'user', cwd: '/x', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'real' } },
    );

    const { turns } = parseTranscriptFile(lines);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.text).toBe('real');
  });

  it('drops sidechain messages', () => {
    const lines = jsonl(
      {
        type: 'assistant',
        isSidechain: true,
        message: { role: 'assistant', content: [{ type: 'text', text: 'subagent' }] },
      },
      {
        type: 'user',
        cwd: '/x',
        timestamp: '2026-01-01T00:00:00Z',
        message: { role: 'user', content: 'main thread' },
      },
    );

    const { turns } = parseTranscriptFile(lines);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.text).toBe('main thread');
  });

  it('drops thinking and image blocks from assistant content', () => {
    const lines = jsonl({
      type: 'assistant',
      cwd: '/x',
      timestamp: '2026-01-01T00:00:00Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'internal thought' },
          { type: 'text', text: 'visible response' },
          { type: 'image', source: { data: 'base64...' } },
        ],
      },
    });

    const { turns } = parseTranscriptFile(lines);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.text).toBe('visible response');
    expect(turns[0]!.text).not.toContain('internal thought');
    expect(turns[0]!.text).not.toContain('base64');
  });

  it('formats tool_use as [Tool: name]', () => {
    const lines = jsonl({
      type: 'assistant',
      cwd: '/x',
      timestamp: '2026-01-01T00:00:00Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me check.' },
          { type: 'tool_use', name: 'Read', id: 't1', input: { path: '/big/file' } },
        ],
      },
    });

    const { turns } = parseTranscriptFile(lines);
    expect(turns[0]!.text).toContain('[Tool: Read]');
    expect(turns[0]!.text).not.toContain('/big/file');
  });

  it('truncates tool_result content', () => {
    const longResult = 'x'.repeat(300);
    const lines = jsonl({
      type: 'user',
      cwd: '/x',
      timestamp: '2026-01-01T00:00:00Z',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: longResult },
        ],
      },
    });

    const { turns } = parseTranscriptFile(lines);
    expect(turns[0]!.text.length).toBeLessThan(300);
    expect(turns[0]!.text).toContain('...');
  });

  it('skips lines with empty content after filtering', () => {
    const lines = jsonl(
      {
        type: 'assistant',
        cwd: '/x',
        timestamp: '2026-01-01T00:00:00Z',
        message: {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'only thinking' }],
        },
      },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '\n\n' }],
        },
      },
    );

    const { turns } = parseTranscriptFile(lines);
    expect(turns).toHaveLength(0);
  });

  it('extracts metadata from first available cwd and timestamp', () => {
    const lines = jsonl(
      { type: 'file-history-snapshot', snapshot: {} },
      {
        type: 'user',
        cwd: '/my/project',
        timestamp: '2026-04-10T15:30:00Z',
        message: { role: 'user', content: 'test' },
      },
    );

    const { metadata } = parseTranscriptFile(lines);
    expect(metadata.projectPath).toBe('/my/project');
    expect(metadata.sessionTimestamp).toBe(new Date('2026-04-10T15:30:00Z').getTime());
  });

  it('handles malformed JSON lines gracefully', () => {
    const lines = [
      'not json at all',
      '{"type":"user","cwd":"/x","timestamp":"2026-01-01T00:00:00Z","message":{"role":"user","content":"valid"}}',
      '{broken json',
    ];

    const { turns } = parseTranscriptFile(lines);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.text).toBe('valid');
  });
});
