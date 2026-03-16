import path from "node:path";

import { normalizeNonEmptyString } from "./strings.js";

const DISALLOWED_BROAD_PATH_MATCHERS = new Set(["*", "**", "**/*", "/", "./"]);

export const MAX_PATH_MATCHERS_PER_MEMORY = 8;

function stripPathNoise(value: string): string {
  return value
    .replace(/#L\d+(?:-L?\d+)?$/u, "")
    .replace(/:(?:\d+)(?::\d+)?$/u, "");
}

function normalizeRelativePathLike(value: string): string {
  const normalizedValue = normalizeNonEmptyString(value)?.replaceAll("\\", "/");

  if (!normalizedValue) {
    throw new Error("Path matcher must be a non-empty string.");
  }

  const withoutNoise = stripPathNoise(normalizedValue).replace(/^\.\/+/u, "");
  const withoutTrailingSlash = withoutNoise.endsWith("/")
    ? withoutNoise.slice(0, -1)
    : withoutNoise;
  const normalizedPath = path.posix.normalize(withoutTrailingSlash);

  if (
    normalizedPath.length === 0 ||
    normalizedPath === "." ||
    normalizedPath === ".." ||
    normalizedPath.startsWith("../")
  ) {
    throw new Error("Path matchers must stay within the owning memory space root.");
  }

  if (normalizedPath.startsWith("/")) {
    throw new Error("Path matchers must be relative to the owning memory space root.");
  }

  if (DISALLOWED_BROAD_PATH_MATCHERS.has(normalizedPath)) {
    throw new Error(`Path matcher "${normalizedPath}" is too broad for V1 retrieval.`);
  }

  return normalizedPath;
}

function escapeRegExp(text: string): string {
  return text.replace(/[|\\{}()[\]^$+?.]/gu, "\\$&");
}

function globToRegExp(pattern: string): RegExp {
  let expression = "^";

  for (let index = 0; index < pattern.length; ) {
    const currentCharacter = pattern[index];
    const nextCharacter = pattern[index + 1];

    if (currentCharacter === "*" && nextCharacter === "*") {
      expression += ".*";
      index += 2;
      continue;
    }

    if (currentCharacter === "*") {
      expression += "[^/]*";
      index += 1;
      continue;
    }

    expression += escapeRegExp(currentCharacter ?? "");
    index += 1;
  }

  expression += "$";

  return new RegExp(expression, "u");
}

function getPathMatcherCategory(pathMatcher: string): "exact" | "single_glob" | "deep_glob" {
  if (pathMatcher.includes("**")) {
    return "deep_glob";
  }

  if (pathMatcher.includes("*")) {
    return "single_glob";
  }

  return "exact";
}

function getPathMatcherSpecificity(pathMatcher: string): number {
  return pathMatcher.replaceAll("*", "").length / 1000;
}

function scorePathMatcher(pathMatcher: string, relatedPath: string): number | null {
  const category = getPathMatcherCategory(pathMatcher);

  if (category === "exact") {
    if (relatedPath === pathMatcher) {
      return 400 + getPathMatcherSpecificity(pathMatcher);
    }

    if (relatedPath.startsWith(`${pathMatcher}/`)) {
      return 300 + getPathMatcherSpecificity(pathMatcher);
    }

    return null;
  }

  if (!globToRegExp(pathMatcher).test(relatedPath)) {
    return null;
  }

  if (category === "single_glob") {
    return 200 + getPathMatcherSpecificity(pathMatcher);
  }

  return 100 + getPathMatcherSpecificity(pathMatcher);
}

export function normalizePathMatchers(pathMatchers: string[] | undefined): string[] {
  const normalizedPathMatchers = Array.from(
    new Set((pathMatchers ?? []).map((pathMatcher) => normalizeRelativePathLike(pathMatcher))),
  );

  if (normalizedPathMatchers.length > MAX_PATH_MATCHERS_PER_MEMORY) {
    throw new Error(
      `Path matcher count cannot exceed ${String(MAX_PATH_MATCHERS_PER_MEMORY)} entries per memory.`,
    );
  }

  return normalizedPathMatchers;
}

export function normalizeRelatedPaths(relatedPaths: string[] | undefined): string[] {
  return Array.from(
    new Set((relatedPaths ?? []).map((relatedPath) => normalizeRelativePathLike(relatedPath))),
  );
}

export function scorePathMatchers(
  pathMatchers: string[],
  relatedPaths: string[],
): number | null {
  let bestScore: number | null = null;

  for (const pathMatcher of pathMatchers) {
    for (const relatedPath of relatedPaths) {
      const candidateScore = scorePathMatcher(pathMatcher, relatedPath);

      if (candidateScore === null) {
        continue;
      }

      if (bestScore === null || candidateScore > bestScore) {
        bestScore = candidateScore;
      }
    }
  }

  return bestScore;
}
