import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MAX_PATH_MATCHERS_PER_MEMORY,
  normalizePathMatchers,
  normalizeRelatedPaths,
  scorePathMatchers,
} from "../utils/path-matchers.js";

describe("normalizePathMatchers", () => {
  it("normalizes path matchers, strips line noise, and de-duplicates values", () => {
    assert.deepEqual(
      normalizePathMatchers([
        "./src/feature.ts:12",
        "src/feature.ts#L20-L30",
        "docs/**/*.md",
      ]),
      ["src/feature.ts", "docs/**/*.md"],
    );
  });

  it("rejects catch-all, absolute, and parent-traversal matchers", () => {
    assert.throws(() => normalizePathMatchers(["**/*"]), /too broad/u);
    assert.throws(() => normalizePathMatchers(["/tmp/file.ts"]), /must be relative/u);
    assert.throws(() => normalizePathMatchers(["../secret.txt"]), /must stay within/u);
  });

  it("caps matcher count per memory", () => {
    const excessiveMatchers = Array.from(
      { length: MAX_PATH_MATCHERS_PER_MEMORY + 1 },
      (_, index) => `src/file-${String(index)}.ts`,
    );

    assert.throws(
      () => normalizePathMatchers(excessiveMatchers),
      /cannot exceed/u,
    );
  });
});

describe("normalizeRelatedPaths", () => {
  it("normalizes related paths and strips transcript suffixes", () => {
    assert.deepEqual(
      normalizeRelatedPaths(["./src/app.ts:44:2", "src/app.ts#L10"]),
      ["src/app.ts"],
    );
  });
});

describe("scorePathMatchers", () => {
  it("ranks exact file over exact directory, single-glob, and deep-glob matches", () => {
    const relatedPath = ["src/features/feature.ts"];

    const exactFileScore = scorePathMatchers(["src/features/feature.ts"], relatedPath);
    const exactDirectoryScore = scorePathMatchers(["src/features"], relatedPath);
    const singleGlobScore = scorePathMatchers(["src/features/*.ts"], relatedPath);
    const deepGlobScore = scorePathMatchers(["src/**/*.ts"], relatedPath);

    assert.equal(typeof exactFileScore, "number");
    assert.equal(typeof exactDirectoryScore, "number");
    assert.equal(typeof singleGlobScore, "number");
    assert.equal(typeof deepGlobScore, "number");
    assert.ok((exactFileScore ?? 0) > (exactDirectoryScore ?? 0));
    assert.ok((exactDirectoryScore ?? 0) > (singleGlobScore ?? 0));
    assert.ok((singleGlobScore ?? 0) > (deepGlobScore ?? 0));
  });

  it("returns null when no related path matches any matcher", () => {
    assert.equal(
      scorePathMatchers(["src/features/*.ts"], ["docs/guide.md"]),
      null,
    );
  });
});
