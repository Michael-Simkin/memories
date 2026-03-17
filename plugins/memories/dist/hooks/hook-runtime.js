async function runNoopHook() {
  try {
    for await (const chunk of process.stdin) {
      void chunk;
    }
  } catch {
  }
}
export {
  runNoopHook
};
