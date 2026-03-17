import { normalizeNonEmptyString } from "../utils/strings.js";
class OriginNormalizationService {
  static URL_PROTOCOLS = /* @__PURE__ */ new Set(["git:", "http:", "https:", "ssh:"]);
  static normalizeHost(host) {
    return host.trim().toLowerCase();
  }
  static normalizeRepositoryPath(repositoryPath) {
    const trimmedRepositoryPath = repositoryPath.trim().replace(/\/+$/u, "");
    const withoutGitSuffix = trimmedRepositoryPath.replace(/\.git$/iu, "");
    return withoutGitSuffix.split("/").map((segment) => segment.trim()).filter((segment) => segment.length > 0);
  }
  static finalizeNormalizedOrigin(parts) {
    const normalizedHost = OriginNormalizationService.normalizeHost(parts.host);
    const normalizedRepositoryPath = OriginNormalizationService.normalizeRepositoryPath(
      parts.repositoryPath
    );
    if (normalizedHost.length === 0 || normalizedRepositoryPath.length < 2) {
      return null;
    }
    return `${normalizedHost}/${normalizedRepositoryPath.join("/")}`;
  }
  static parseScpLikeOrigin(originUrl) {
    if (originUrl.includes("://")) {
      return null;
    }
    const match = /^(?:[^@\s/]+@)?(?<host>[^:/\s]+):(?<repositoryPath>.+)$/u.exec(originUrl);
    if (!match?.groups) {
      return null;
    }
    const host = match.groups["host"];
    const repositoryPath = match.groups["repositoryPath"];
    if (!host || !repositoryPath) {
      return null;
    }
    return {
      host,
      repositoryPath
    };
  }
  static parseUrlOrigin(originUrl) {
    try {
      const parsedUrl = new URL(originUrl);
      if (!OriginNormalizationService.URL_PROTOCOLS.has(parsedUrl.protocol) || parsedUrl.hostname.length === 0) {
        return null;
      }
      return {
        host: parsedUrl.hostname,
        repositoryPath: parsedUrl.pathname
      };
    } catch {
      return null;
    }
  }
  static normalizeOriginUrl(originUrl) {
    const trimmedOriginUrl = normalizeNonEmptyString(originUrl);
    if (!trimmedOriginUrl) {
      return null;
    }
    const parsedOrigin = OriginNormalizationService.parseScpLikeOrigin(trimmedOriginUrl) ?? OriginNormalizationService.parseUrlOrigin(trimmedOriginUrl);
    return parsedOrigin ? OriginNormalizationService.finalizeNormalizedOrigin(parsedOrigin) : null;
  }
  static hasUsableOrigin(originUrl) {
    return typeof originUrl === "string" && OriginNormalizationService.normalizeOriginUrl(originUrl) !== null;
  }
}
export {
  OriginNormalizationService
};
