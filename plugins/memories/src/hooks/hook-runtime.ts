export async function runNoopHook(): Promise<void> {
  try {
    for await (const chunk of process.stdin) {
      void chunk;

      // Intentionally drain hook input and fail open.
    }
  } catch {
    // Hooks must stay fail-open during the rebuild.
  }
}
