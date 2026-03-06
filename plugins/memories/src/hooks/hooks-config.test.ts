import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

interface HookConfig {
  hooks: Record<
    string,
    Array<{
      hooks: Array<{
        command?: string;
        type: string;
      }>;
    }>
  >;
}

describe('hooks.json command templates', () => {
  it('quotes CLAUDE_PLUGIN_ROOT so install paths with spaces still work', async () => {
    const rawConfig = await readFile(new URL('../../hooks/hooks.json', import.meta.url), 'utf8');
    const config = JSON.parse(rawConfig) as HookConfig;
    const commands = Object.values(config.hooks)
      .flatMap((entries) => entries)
      .flatMap((entry) => entry.hooks)
      .map((hook) => hook.command)
      .filter((command): command is string => typeof command === 'string');

    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      expect(command).toMatch(/^node "\$\{CLAUDE_PLUGIN_ROOT\}\/dist\/hooks\/[^"]+\.js"$/);
    }
  });
});
