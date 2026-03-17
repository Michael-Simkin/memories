import { RuntimeSupportService } from "../shared/services/runtime-support-service.js";
function main() {
  RuntimeSupportService.assertSupportedRuntime();
  process.stderr.write(
    "Claude Memory engine lifecycle is not implemented yet in this rebuild.\n"
  );
  process.exitCode = 1;
}
main();
