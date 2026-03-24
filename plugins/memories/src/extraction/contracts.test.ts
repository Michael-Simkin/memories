import { describe, expect, it } from 'vitest';

import { workerActionSchema, workerOutputSchema, workerPayloadSchema } from './contracts.js';

describe('extraction contracts', () => {
  it('accepts valid worker payload and action set', () => {
    const payload = workerPayloadSchema.parse({
      endpoint: { host: '127.0.0.1', port: 4311 },
      project_root: '/tmp/project',
      repo_id: 'test-repo-id-0001',
      transcript_path: '/tmp/project/transcript.jsonl',
      session_id: 'session-1',
    });

    expect(payload.endpoint.port).toBe(4311);

    const output = workerOutputSchema.parse({
      actions: [
        {
          action: 'create',
          confidence: 0.9,
          memory_type: 'context',
          content: 'Use Node 20+',
          tags: ['runtime'],
          is_pinned: true,
          path_matchers: [{ path_matcher: 'package.json' }],
        },
        {
          action: 'skip',
          confidence: 0.3,
          reason: 'no durable memory',
        },
      ],
    });

    expect(output.actions).toHaveLength(2);
  });

  it('rejects malformed update actions', () => {
    const parsed = workerActionSchema.safeParse({
      action: 'update',
      confidence: 0.9,
      memory_id: 'm-1',
      updates: {},
    });
    expect(parsed.success).toBe(false);
  });
});
