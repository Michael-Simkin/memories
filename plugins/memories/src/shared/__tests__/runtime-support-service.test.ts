import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { RuntimeSupportService } from "../services/runtime-support-service.js";

describe("RuntimeSupportService", () => {
  it("accepts the supported darwin-arm64 Node 24 runtime", () => {
    const runtimeDetails = RuntimeSupportService.assertSupportedRuntime({
      platform: "darwin",
      arch: "arm64",
      nodeVersion: "v24.11.1",
    });

    assert.deepEqual(runtimeDetails, {
      platform: "darwin",
      arch: "arm64",
      nodeVersion: "v24.11.1",
      nodeMajorVersion: 24,
    });
  });

  it("rejects non-macOS platforms", () => {
    assert.throws(
      () =>
        RuntimeSupportService.assertSupportedRuntime({
          platform: "linux",
          arch: "arm64",
          nodeVersion: "v24.11.1",
        }),
      /supports macOS only/u,
    );
  });

  it("rejects non-arm64 architectures", () => {
    assert.throws(
      () =>
        RuntimeSupportService.assertSupportedRuntime({
          platform: "darwin",
          arch: "x64",
          nodeVersion: "v24.11.1",
        }),
      /supports darwin-arm64 only/u,
    );
  });

  it("rejects non-Node-24 runtimes", () => {
    assert.throws(
      () =>
        RuntimeSupportService.assertSupportedRuntime({
          platform: "darwin",
          arch: "arm64",
          nodeVersion: "v22.10.0",
        }),
      /requires Node 24/u,
    );
  });
});
