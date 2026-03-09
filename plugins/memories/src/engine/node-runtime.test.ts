import { describe, expect, it } from 'vitest';

import {
  parseNodeMajor,
  REQUIRED_ENGINE_NODE_MAJOR,
  selectPreferredNodeRuntime,
} from './node-runtime.js';

describe('node runtime selection', () => {
  it('parses semver strings with or without a leading v', () => {
    expect(parseNodeMajor('24.11.1')).toBe(24);
    expect(parseNodeMajor('v22.14.0')).toBe(22);
  });

  it('prefers Node 24 even when a newer major is available', () => {
    const selected = selectPreferredNodeRuntime([
      { executable: '/tmp/node-22', version: '22.14.0' },
      { executable: '/tmp/node-26', version: '26.1.0' },
      { executable: '/tmp/node-24', version: `${REQUIRED_ENGINE_NODE_MAJOR}.11.1` },
    ]);

    expect(selected).toEqual({
      executable: '/tmp/node-24',
      major: REQUIRED_ENGINE_NODE_MAJOR,
      version: `${REQUIRED_ENGINE_NODE_MAJOR}.11.1`,
    });
  });

  it('falls back to the newest supported major when Node 24 is unavailable', () => {
    const selected = selectPreferredNodeRuntime([
      { executable: '/tmp/node-22', version: '22.14.0' },
      { executable: '/tmp/node-25-old', version: '25.0.0' },
      { executable: '/tmp/node-25-new', version: '25.1.0' },
    ]);

    expect(selected).toEqual({
      executable: '/tmp/node-25-new',
      major: 25,
      version: '25.1.0',
    });
  });
});
