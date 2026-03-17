import path from "node:path";
import { normalizeNonEmptyString } from "./strings.js";
const DISALLOWED_BROAD_PATH_MATCHERS = /* @__PURE__ */ new Set(["*", "**", "**/*", "/", "./"]);
const MAX_PATH_MATCHERS_PER_MEMORY = 8;
function stripPathNoise(value) {
  return value.replace(/#L\d+(?:-L?\d+)?$/u, "").replace(/:(?:\d+)(?::\d+)?$/u, "");
}
function normalizeRelativePathLike(value) {
  const normalizedValue = normalizeNonEmptyString(value)?.replaceAll("\\", "/");
  if (!normalizedValue) {
    throw new Error("Path matcher must be a non-empty string.");
  }
  const withoutNoise = stripPathNoise(normalizedValue).replace(/^\.\/+/u, "");
  const withoutTrailingSlash = withoutNoise.endsWith("/") ? withoutNoise.slice(0, -1) : withoutNoise;
  const normalizedPath = path.posix.normalize(withoutTrailingSlash);
  if (normalizedPath.length === 0 || normalizedPath === "." || normalizedPath === ".." || normalizedPath.startsWith("../")) {
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
function escapeRegExp(text) {
  return text.replace(/[|\\{}()[\]^$+?.]/gu, "\\$&");
}
function globToRegExp(pattern) {
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
function getPathMatcherCategory(pathMatcher) {
  if (pathMatcher.includes("**")) {
    return "deep_glob";
  }
  if (pathMatcher.includes("*")) {
    return "single_glob";
  }
  return "exact";
}
function getPathMatcherSpecificity(pathMatcher) {
  return pathMatcher.replaceAll("*", "").length / 1e3;
}
function scorePathMatcher(pathMatcher, relatedPath) {
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
function normalizePathMatchers(pathMatchers) {
  const normalizedPathMatchers = Array.from(
    new Set((pathMatchers ?? []).map((pathMatcher) => normalizeRelativePathLike(pathMatcher)))
  );
  if (normalizedPathMatchers.length > MAX_PATH_MATCHERS_PER_MEMORY) {
    throw new Error(
      `Path matcher count cannot exceed ${String(MAX_PATH_MATCHERS_PER_MEMORY)} entries per memory.`
    );
  }
  return normalizedPathMatchers;
}
function normalizeRelatedPaths(relatedPaths) {
  return Array.from(
    new Set((relatedPaths ?? []).map((relatedPath) => normalizeRelativePathLike(relatedPath)))
  );
}
function scorePathMatchers(pathMatchers, relatedPaths) {
  let bestScore = null;
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
export {
  MAX_PATH_MATCHERS_PER_MEMORY,
  normalizePathMatchers,
  normalizeRelatedPaths,
  scorePathMatchers
};
