import { normalizeNonEmptyString } from "../utils/strings.js";

interface ParsedOriginParts {
  host: string;
  repositoryPath: string;
}

export class OriginNormalizationService {
  private static readonly URL_PROTOCOLS = new Set(["git:", "http:", "https:", "ssh:"]);

  private static normalizeHost(host: string): string {
    return host.trim().toLowerCase();
  }

  private static normalizeRepositoryPath(repositoryPath: string): string[] {
    const trimmedRepositoryPath = repositoryPath.trim().replace(/\/+$/u, "");
    const withoutGitSuffix = trimmedRepositoryPath.replace(/\.git$/iu, "");

    return withoutGitSuffix
      .split("/")
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0);
  }

  private static finalizeNormalizedOrigin(parts: ParsedOriginParts): string | null {
    const normalizedHost = OriginNormalizationService.normalizeHost(parts.host);
    const normalizedRepositoryPath = OriginNormalizationService.normalizeRepositoryPath(
      parts.repositoryPath,
    );

    if (normalizedHost.length === 0 || normalizedRepositoryPath.length < 2) {
      return null;
    }

    return `${normalizedHost}/${normalizedRepositoryPath.join("/")}`;
  }

  private static parseScpLikeOrigin(originUrl: string): ParsedOriginParts | null {
    if (originUrl.includes("://")) {
      return null;
    }

    const match =
      /^(?:[^@\s/]+@)?(?<host>[^:/\s]+):(?<repositoryPath>.+)$/u.exec(originUrl);

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
      repositoryPath,
    };
  }

  private static parseUrlOrigin(originUrl: string): ParsedOriginParts | null {
    try {
      const parsedUrl = new URL(originUrl);

      if (
        !OriginNormalizationService.URL_PROTOCOLS.has(parsedUrl.protocol) ||
        parsedUrl.hostname.length === 0
      ) {
        return null;
      }

      return {
        host: parsedUrl.hostname,
        repositoryPath: parsedUrl.pathname,
      };
    } catch {
      return null;
    }
  }

  static normalizeOriginUrl(originUrl: string): string | null {
    const trimmedOriginUrl = normalizeNonEmptyString(originUrl);

    if (!trimmedOriginUrl) {
      return null;
    }

    const parsedOrigin =
      OriginNormalizationService.parseScpLikeOrigin(trimmedOriginUrl) ??
      OriginNormalizationService.parseUrlOrigin(trimmedOriginUrl);

    return parsedOrigin
      ? OriginNormalizationService.finalizeNormalizedOrigin(parsedOrigin)
      : null;
  }

  static hasUsableOrigin(originUrl: string | null | undefined): originUrl is string {
    return (
      typeof originUrl === "string" &&
      OriginNormalizationService.normalizeOriginUrl(originUrl) !== null
    );
  }
}
