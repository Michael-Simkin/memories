class RuntimeSupportService {
  static parseNodeMajorVersion(nodeVersion) {
    const match = /^v?(?<major>\d+)(?:\.\d+){0,2}$/u.exec(nodeVersion);
    const majorVersion = match?.groups?.["major"];
    if (!majorVersion) {
      throw new Error(`Unable to parse the Node version string "${nodeVersion}".`);
    }
    return Number.parseInt(majorVersion, 10);
  }
  static assertSupportedRuntime(input = {}) {
    const platform = input.platform ?? process.platform;
    const arch = input.arch ?? process.arch;
    const nodeVersion = input.nodeVersion ?? process.version;
    const nodeMajorVersion = RuntimeSupportService.parseNodeMajorVersion(nodeVersion);
    if (platform !== "darwin") {
      throw new Error(
        `Claude Memory V1 supports macOS only. Received platform "${platform}".`
      );
    }
    if (arch !== "arm64") {
      throw new Error(
        `Claude Memory V1 supports darwin-arm64 only. Received architecture "${arch}".`
      );
    }
    if (nodeMajorVersion !== 24) {
      throw new Error(
        `Claude Memory V1 requires Node 24. Received "${nodeVersion}".`
      );
    }
    return {
      platform,
      arch,
      nodeVersion,
      nodeMajorVersion
    };
  }
}
export {
  RuntimeSupportService
};
