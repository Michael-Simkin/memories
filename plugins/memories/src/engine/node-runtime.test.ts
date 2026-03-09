import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  parseNodeMajor,
  REQUIRED_ENGINE_NODE_MAJOR,
  resolveNpmInvocation,
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

  it('prefers npm-cli.js via the selected node even when an npm wrapper exists', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'memories-node-runtime-'));
    const binDirectory = path.join(tempRoot, 'bin');
    const npmCliDirectory =
      process.platform === 'win32'
        ? path.join(tempRoot, 'node_modules', 'npm', 'bin')
        : path.join(tempRoot, 'lib', 'node_modules', 'npm', 'bin');
    await mkdir(binDirectory, { recursive: true });
    await mkdir(npmCliDirectory, { recursive: true });

    const nodeExecutable = path.join(binDirectory, 'node');
    const npmExecutable = path.join(binDirectory, process.platform === 'win32' ? 'npm.cmd' : 'npm');
    const npmCliPath = path.join(npmCliDirectory, 'npm-cli.js');
    await writeFile(nodeExecutable, '', 'utf8');
    await writeFile(npmExecutable, '', 'utf8');
    await writeFile(npmCliPath, '', 'utf8');

    expect(resolveNpmInvocation(nodeExecutable)).toEqual({
      argsPrefix: [npmCliPath],
      command: nodeExecutable,
    });
  });

  it('falls back to npm-cli.js when the npm wrapper is missing', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'memories-node-runtime-'));
    const binDirectory = path.join(tempRoot, 'bin');
    const npmCliDirectory =
      process.platform === 'win32'
        ? path.join(tempRoot, 'node_modules', 'npm', 'bin')
        : path.join(tempRoot, 'lib', 'node_modules', 'npm', 'bin');
    await mkdir(binDirectory, { recursive: true });
    await mkdir(npmCliDirectory, { recursive: true });

    const nodeExecutable = path.join(binDirectory, 'node');
    const npmCliPath = path.join(npmCliDirectory, 'npm-cli.js');
    await writeFile(nodeExecutable, '', 'utf8');
    await writeFile(npmCliPath, '', 'utf8');

    expect(resolveNpmInvocation(nodeExecutable)).toEqual({
      argsPrefix: [npmCliPath],
      command: nodeExecutable,
    });
  });
});
