import {
  readJsonFromStdin,
  writeFailOpenOutput,
  writeHookOutput,
} from '../shared/hook-io.js';
import { logError } from '../shared/logger.js';
import { sessionEndPayloadSchema } from './schemas.js';

async function run(): Promise<void> {
  const payload = await readJsonFromStdin(sessionEndPayloadSchema);
  if (!payload) {
    writeFailOpenOutput();
    return;
  }
  writeHookOutput({ continue: true });
}

void run().catch((error) => {
  logError('SessionEnd hook entrypoint failed', {
    error: error instanceof Error ? error.message : String(error),
  });
  writeFailOpenOutput();
});
