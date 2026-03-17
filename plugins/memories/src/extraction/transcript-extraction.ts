import path from "node:path";
import { readFile } from "node:fs/promises";

import { normalizeNonEmptyString } from "../shared/utils/strings.js";
import { normalizeRelatedPaths } from "../shared/utils/path-matchers.js";

const MAX_TRANSCRIPT_SEGMENTS = 60;
const MAX_TRANSCRIPT_EXCERPT_CHARS = 24_000;
const MAX_QUERY_TEXT_CHARS = 4_000;
const MAX_RELATED_PATHS = 12;

interface CollectedTranscriptString {
  keyPath: string;
  value: string;
}

export interface TranscriptSnapshot {
  queryText: string;
  relatedPaths: string[];
  transcriptExcerpt: string;
}

function stripTranscriptNoise(value: string): string {
  return value
    .replace(/\bL\d+:/gu, "")
    .replace(/\r\n/gu, "\n")
    .trim();
}

function safeParseJsonLine(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return line;
  }
}

function collectTranscriptStrings(
  value: unknown,
  keyPath = "",
): CollectedTranscriptString[] {
  if (typeof value === "string") {
    const normalizedValue = normalizeNonEmptyString(stripTranscriptNoise(value));

    if (!normalizedValue) {
      return [];
    }

    return [
      {
        keyPath,
        value: normalizedValue,
      },
    ];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      collectTranscriptStrings(item, `${keyPath}[${String(index)}]`),
    );
  }

  if (!value || typeof value !== "object") {
    return [];
  }

  return Object.entries(value).flatMap(([entryKey, entryValue]) =>
    collectTranscriptStrings(
      entryValue,
      keyPath.length === 0 ? entryKey : `${keyPath}.${entryKey}`,
    ),
  );
}

function extractPathTokens(text: string): string[] {
  const tokens = new Set<string>();
  const patterns = [
    /`([^`\n]+)`/gu,
    /"([^"\n]+)"/gu,
    /'([^'\n]+)'/gu,
    /(^|[\s(])((?:\.{0,2}\/)?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._*?-]+)+(?:[#:]L?\d+(?::\d+)?)?)/gmu,
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const capturedValue = match[2] ?? match[1];

      if (!capturedValue) {
        continue;
      }

      tokens.add(capturedValue);
    }
  }

  return Array.from(tokens);
}

function toRelatedPath(
  rootPath: string,
  candidatePath: string,
): string | null {
  const trimmedCandidatePath = candidatePath.trim();

  if (
    trimmedCandidatePath.length === 0 ||
    trimmedCandidatePath.includes("://") ||
    trimmedCandidatePath.startsWith("@")
  ) {
    return null;
  }

  let relativeCandidatePath = trimmedCandidatePath;

  if (path.isAbsolute(trimmedCandidatePath)) {
    const resolvedRelativePath = path.relative(rootPath, trimmedCandidatePath);

    if (
      resolvedRelativePath.length === 0 ||
      resolvedRelativePath === ".." ||
      resolvedRelativePath.startsWith(`..${path.sep}`) ||
      path.isAbsolute(resolvedRelativePath)
    ) {
      return null;
    }

    relativeCandidatePath = resolvedRelativePath;
  }

  try {
    const normalizedRelatedPaths = normalizeRelatedPaths([relativeCandidatePath]);

    return normalizedRelatedPaths[0] ?? null;
  } catch {
    return null;
  }
}

function buildTranscriptExcerpt(values: string[]): string {
  const trimmedValues = values.slice(-MAX_TRANSCRIPT_SEGMENTS);
  let transcriptExcerpt = trimmedValues.join("\n\n");

  if (transcriptExcerpt.length <= MAX_TRANSCRIPT_EXCERPT_CHARS) {
    return transcriptExcerpt;
  }

  transcriptExcerpt = transcriptExcerpt.slice(
    transcriptExcerpt.length - MAX_TRANSCRIPT_EXCERPT_CHARS,
  );

  return transcriptExcerpt.trimStart();
}

function buildQueryText(
  transcriptExcerpt: string,
  lastAssistantMessage: string | null | undefined,
): string {
  const normalizedLastAssistantMessage = normalizeNonEmptyString(lastAssistantMessage);

  if (normalizedLastAssistantMessage) {
    return normalizedLastAssistantMessage.slice(0, MAX_QUERY_TEXT_CHARS);
  }

  return transcriptExcerpt.slice(-MAX_QUERY_TEXT_CHARS).trim();
}

export async function extractTranscriptSnapshot(
  transcriptPath: string,
  rootPath: string,
  lastAssistantMessage: string | null | undefined,
): Promise<TranscriptSnapshot> {
  const transcriptText = await readFile(transcriptPath, "utf8");
  const transcriptLines = transcriptText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const collectedStrings = transcriptLines.flatMap((line) =>
    collectTranscriptStrings(safeParseJsonLine(line)),
  );
  const excerptSourceValues = collectedStrings.map(({ value }) => value);
  const transcriptExcerpt = buildTranscriptExcerpt(
    excerptSourceValues.length === 0 ? [stripTranscriptNoise(transcriptText)] : excerptSourceValues,
  );
  const relatedPaths = Array.from(
    new Set(
      collectedStrings.flatMap(({ keyPath, value }) => {
        const tokenSource =
          keyPath.endsWith("path") ||
          keyPath.endsWith("file_path") ||
          keyPath.endsWith("cwd") ||
          keyPath.endsWith("project_root")
            ? [value]
            : extractPathTokens(value);

        return tokenSource
          .map((candidatePath) => toRelatedPath(rootPath, candidatePath))
          .filter((candidatePath): candidatePath is string => candidatePath !== null);
      }),
    ),
  ).slice(0, MAX_RELATED_PATHS);
  const queryText = buildQueryText(transcriptExcerpt, lastAssistantMessage);

  if (queryText.length === 0) {
    throw new Error("Unable to derive learning query text from the transcript.");
  }

  return {
    queryText,
    relatedPaths,
    transcriptExcerpt,
  };
}
