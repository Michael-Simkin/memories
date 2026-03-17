import { isMainModule, runNoopHook } from "./hook-runtime.js";
if (isMainModule(import.meta.url)) {
  void runNoopHook();
}
