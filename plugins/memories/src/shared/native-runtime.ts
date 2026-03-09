import path from 'node:path';

export interface NativeRuntimeIdentity {
  abi?: string;
  arch?: string;
  platform?: NodeJS.Platform;
}

export function resolveNativeRuntimeRoot(
  pluginRoot: string,
  identity: NativeRuntimeIdentity = {},
): string {
  return path.join(pluginRoot, 'native', nativeRuntimeCacheKey(identity));
}

export function nativeRuntimeCacheKey(identity: NativeRuntimeIdentity = {}): string {
  const abi = identity.abi ?? process.versions.modules ?? 'unknown';
  const platform = identity.platform ?? process.platform;
  const arch = identity.arch ?? process.arch;
  return `${platform}-${arch}-abi${abi}`;
}

export function isNativeAbiMismatchError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.message.includes('NODE_MODULE_VERSION') ||
    /compiled against a different Node\.js version/i.test(error.message)
  );
}
