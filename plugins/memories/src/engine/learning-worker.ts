import { execFile } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";

import {
  learningActionDocumentJsonSchema,
  learningActionDocumentSchema,
  type LearningActionDocument,
  type MemoryLearningAction,
} from "../extraction/learning-actions.js";
import { extractTranscriptSnapshot } from "../extraction/transcript-extraction.js";
import { OllamaEmbeddingService } from "../shared/services/ollama-embedding-service.js";
import { normalizePathMatchers } from "../shared/utils/path-matchers.js";
import { EventRepository } from "../storage/repositories/event-repository.js";
import { LearningJobRepository } from "../storage/repositories/learning-job-repository.js";
import { MemoryRepository } from "../storage/repositories/memory-repository.js";
import { MemoryRetrievalRepository } from "../storage/repositories/memory-retrieval-repository.js";
import { SpaceRegistryRepository } from "../storage/repositories/space-registry-repository.js";

const DEFAULT_LEARNING_WORKER_POLL_INTERVAL_MS = 1_000;
const DEFAULT_LEARNING_JOB_LEASE_DURATION_MS = 30_000;
const DEFAULT_LEARNING_JOB_HEARTBEAT_INTERVAL_MS = 10_000;
const MAX_CANDIDATE_MEMORIES = 12;

interface LearningWorkerSearchResult {
  content: string;
  id: string;
  is_pinned: boolean;
  matched_by: string[];
  memory_type: string;
  path_matchers: string[];
  tags: string[];
  updated_at: string;
}

interface LearningWorkerPromptInput {
  candidateMemories: LearningWorkerSearchResult[];
  relatedPaths: string[];
  rootPath: string;
  spaceDisplayName: string;
  spaceId: string;
  spaceKind: string;
  transcriptExcerpt: string;
}

export interface RunLearningModelInput extends LearningWorkerPromptInput {
  abortSignal: AbortSignal;
}

export interface StartLearningWorkerOptions {
  database: DatabaseSync;
  embedText?: ((text: string) => Promise<number[] | undefined>) | undefined;
  heartbeatIntervalMs?: number | undefined;
  leaseDurationMs?: number | undefined;
  pollIntervalMs?: number | undefined;
  runLearningModel?:
    | ((input: RunLearningModelInput) => Promise<LearningActionDocument>)
    | undefined;
  touchActivity?: (() => Promise<void>) | undefined;
}

export interface StartedLearningWorker {
  close(): Promise<void>;
  closed: Promise<void>;
}

interface ResolvedLearningWorkerOptions {
  database: DatabaseSync;
  embedText: (text: string) => Promise<number[] | undefined>;
  heartbeatIntervalMs: number;
  leaseDurationMs: number;
  runLearningModel: (
    input: RunLearningModelInput,
  ) => Promise<LearningActionDocument>;
  touchActivity: () => Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function summarizeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function isMissingTranscriptError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const errorCode =
    "code" in error && typeof error.code === "string" ? error.code : null;

  return errorCode === "ENOENT";
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`;
}

function buildLearningPrompt(input: LearningWorkerPromptInput): string {
  const candidateMemoryLines =
    input.candidateMemories.length === 0
      ? ["- None"]
      : input.candidateMemories.map((candidateMemory, index) =>
          [
            `- Candidate ${String(index + 1)}`,
            `  id: ${candidateMemory.id}`,
            `  type: ${candidateMemory.memory_type}`,
            `  pinned: ${candidateMemory.is_pinned ? "true" : "false"}`,
            `  matched_by: ${candidateMemory.matched_by.join(", ")}`,
            `  tags: ${candidateMemory.tags.join(", ") || "(none)"}`,
            `  path_matchers: ${candidateMemory.path_matchers.join(", ") || "(none)"}`,
            `  updated_at: ${candidateMemory.updated_at}`,
            `  content: ${truncateText(candidateMemory.content, 600)}`,
          ].join("\n"),
        );
  const relatedPathLines =
    input.relatedPaths.length === 0
      ? ["- None"]
      : input.relatedPaths.map((relatedPath) => `- ${relatedPath}`);

  return [
    "You extract durable project memories for Claude Memory.",
    "",
    "Return only structured JSON that matches the provided schema.",
    "",
    "Rules:",
    "- Work only inside the provided memory space.",
    "- Prefer no action over a speculative action.",
    "- Use confidence=high only for stable, actionable memories that will likely matter again.",
    "- Use create for net-new memories, update for existing candidate memories by id, and delete only when a candidate memory is now clearly wrong or obsolete.",
    "- Path matchers must stay relative to the memory space root.",
    "- If confidence is not high, still include the action with low or medium confidence so the engine can ignore it safely.",
    "- Do not invent file paths, tags, or facts that are not grounded in the transcript.",
    "",
    `Space id: ${input.spaceId}`,
    `Space kind: ${input.spaceKind}`,
    `Space display name: ${input.spaceDisplayName}`,
    `Space root: ${input.rootPath}`,
    "",
    "Related paths:",
    ...relatedPathLines,
    "",
    "Candidate memories:",
    ...candidateMemoryLines,
    "",
    "Transcript excerpt:",
    input.transcriptExcerpt,
  ].join("\n");
}

function findLearningActionDocument(value: unknown): LearningActionDocument | null {
  const parsedDocument = learningActionDocumentSchema.safeParse(value);

  if (parsedDocument.success) {
    return parsedDocument.data;
  }

  if (typeof value === "string") {
    try {
      return findLearningActionDocument(JSON.parse(value) as unknown);
    } catch {
      return null;
    }
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const nestedDocument = findLearningActionDocument(item);

      if (nestedDocument) {
        return nestedDocument;
      }
    }

    return null;
  }

  if (!isRecord(value)) {
    return null;
  }

  for (const nestedValue of Object.values(value)) {
    const nestedDocument = findLearningActionDocument(nestedValue);

    if (nestedDocument) {
      return nestedDocument;
    }
  }

  return null;
}

function parseLearningModelOutput(stdoutText: string): LearningActionDocument {
  const structuredDocument = findLearningActionDocument(stdoutText.trim());

  if (!structuredDocument) {
    throw new Error(
      "Internal Claude learning output did not match the required structured schema.",
    );
  }

  return structuredDocument;
}

async function defaultEmbedText(text: string): Promise<number[] | undefined> {
  try {
    return await OllamaEmbeddingService.embedText(text);
  } catch {
    return undefined;
  }
}

async function defaultRunLearningModel(
  input: RunLearningModelInput,
): Promise<LearningActionDocument> {
  const prompt = buildLearningPrompt(input);

  return new Promise((resolve, reject) => {
    execFile(
      "claude",
      [
        "-p",
        "--output-format",
        "json",
        "--json-schema",
        JSON.stringify(learningActionDocumentJsonSchema),
        prompt,
      ],
      {
        cwd: input.rootPath,
        encoding: "utf8",
        env: {
          ...process.env,
          CLAUDE_CODE_SIMPLE: "1",
        },
        maxBuffer: 8 * 1024 * 1024,
        signal: input.abortSignal,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `Internal Claude learning call failed: ${summarizeError(error)}${stderr ? ` (${stderr.trim()})` : ""}.`,
            ),
          );
          return;
        }

        try {
          resolve(parseLearningModelOutput(stdout));
        } catch (parseError) {
          reject(
            new Error(
              `${summarizeError(parseError)}${stderr ? ` (${stderr.trim()})` : ""}.`,
            ),
          );
        }
      },
    );
  });
}

function recordLearningJobEvent(
  database: DatabaseSync,
  options: {
    data?: Record<string, unknown> | undefined;
    detail?: string | undefined;
    event: string;
    jobId: string;
    rootPath: string;
    spaceId: string;
    status: "error" | "info" | "success" | "warning";
  },
): void {
  EventRepository.recordEvent(database, {
    spaceId: options.spaceId,
    rootPath: options.rootPath,
    event: options.event,
    kind: "learning_job",
    status: options.status,
    jobId: options.jobId,
    detail: options.detail,
    data: options.data,
  });
}

async function applyLearningAction(
  database: DatabaseSync,
  action: MemoryLearningAction,
  options: {
    embedText: (text: string) => Promise<number[] | undefined>;
    spaceId: string;
  },
): Promise<{ memoryId: string | null; type: MemoryLearningAction["type"] }> {
  if (action.type === "create") {
    const semanticEmbedding = await options.embedText(action.content);
    const createdMemory = MemoryRepository.createMemory(database, {
      spaceId: options.spaceId,
      memoryType: action.memory_type,
      content: action.content,
      tags: action.tags,
      isPinned: action.is_pinned,
      pathMatchers: normalizePathMatchers(action.path_matchers),
      semanticEmbedding,
    });

    return {
      memoryId: createdMemory.id,
      type: action.type,
    };
  }

  const existingMemory = MemoryRepository.getMemoryById(database, action.memory_id);

  if (!existingMemory || existingMemory.space_id !== options.spaceId) {
    throw new Error(
      `Unable to apply learning action because memory "${action.memory_id}" is unavailable in the owning space.`,
    );
  }

  if (action.type === "update") {
    const semanticEmbedding =
      action.content === undefined
        ? undefined
        : await options.embedText(action.content);
    const updatedMemory = MemoryRepository.updateMemory(database, {
      memoryId: action.memory_id,
      memoryType: action.memory_type,
      content: action.content,
      tags: action.tags,
      isPinned: action.is_pinned,
      pathMatchers:
        action.path_matchers === undefined
          ? undefined
          : normalizePathMatchers(action.path_matchers),
      semanticEmbedding,
    });

    return {
      memoryId: updatedMemory.id,
      type: action.type,
    };
  }

  MemoryRepository.deleteMemory(database, {
    memoryId: action.memory_id,
  });

  return {
    memoryId: action.memory_id,
    type: action.type,
  };
}

async function processLearningJob(
  job: NonNullable<ReturnType<typeof LearningJobRepository.leaseNextLearningJob>>,
  options: ResolvedLearningWorkerOptions,
  abortSignal: AbortSignal,
): Promise<void> {
  const runningJob = LearningJobRepository.startLearningJob(options.database, {
    jobId: job.id,
    leaseOwner: job.lease_owner ?? "",
    startedAt: new Date().toISOString(),
  });

  if (!runningJob) {
    return;
  }

  await options.touchActivity();
  recordLearningJobEvent(options.database, {
    event: "job-running",
    jobId: runningJob.id,
    rootPath: runningJob.root_path,
    spaceId: runningJob.space_id,
    status: "info",
  });

  const heartbeatState: {
    failure: Error | null;
  } = {
    failure: null,
  };
  const heartbeatInterval = setInterval(() => {
    void (async () => {
      if (abortSignal.aborted || heartbeatState.failure !== null) {
        return;
      }

      const heartbeatedJob = LearningJobRepository.heartbeatLearningJob(
        options.database,
        {
          jobId: runningJob.id,
          leaseOwner: runningJob.lease_owner ?? "",
          leaseDurationMs: options.leaseDurationMs,
          heartbeatedAt: new Date().toISOString(),
        },
      );

      if (!heartbeatedJob) {
        heartbeatState.failure = new Error(
          `Lost the active lease for learning job "${runningJob.id}".`,
        );
        return;
      }

      await options.touchActivity();
    })();
  }, options.heartbeatIntervalMs);

  try {
    const space = SpaceRegistryRepository.getSpaceById(
      options.database,
      runningJob.space_id,
    );

    if (!space) {
      throw new Error(`Unable to find memory space "${runningJob.space_id}".`);
    }

    const transcriptSnapshot = await extractTranscriptSnapshot(
      runningJob.transcript_path,
      runningJob.root_path,
      runningJob.last_assistant_message,
    );
    const queryEmbedding = await options.embedText(transcriptSnapshot.queryText);
    const candidateMemories = MemoryRetrievalRepository.searchMemories(
      options.database,
      {
        spaceId: runningJob.space_id,
        query: transcriptSnapshot.queryText,
        queryEmbedding,
        relatedPaths: transcriptSnapshot.relatedPaths,
        limit: MAX_CANDIDATE_MEMORIES,
      },
    ).results as LearningWorkerSearchResult[];
    const learningDocument = await options.runLearningModel({
      abortSignal,
      candidateMemories,
      relatedPaths: transcriptSnapshot.relatedPaths,
      rootPath: runningJob.root_path,
      spaceDisplayName: space.displayName,
      spaceId: runningJob.space_id,
      spaceKind: space.spaceKind,
      transcriptExcerpt: transcriptSnapshot.transcriptExcerpt,
    });

    if (heartbeatState.failure !== null) {
      throw heartbeatState.failure;
    }

    const highConfidenceActions = learningDocument.actions.filter(
      (action) => action.confidence === "high",
    );
    let appliedActionCount = 0;

    for (const action of highConfidenceActions) {
      if (abortSignal.aborted) {
        return;
      }

      const appliedAction = await applyLearningAction(options.database, action, {
        embedText: options.embedText,
        spaceId: runningJob.space_id,
      });

      appliedActionCount += 1;
      await options.touchActivity();
      recordLearningJobEvent(options.database, {
        event: "job-action-applied",
        jobId: runningJob.id,
        rootPath: runningJob.root_path,
        spaceId: runningJob.space_id,
        status: "success",
        detail: `${appliedAction.type} memory action applied.`,
        data: {
          action_type: appliedAction.type,
          confidence: action.confidence,
          memory_id: appliedAction.memoryId,
        },
      });
    }

    const completedJob = LearningJobRepository.completeLearningJob(options.database, {
      jobId: runningJob.id,
      leaseOwner: runningJob.lease_owner ?? "",
      finishedAt: new Date().toISOString(),
    });

    if (!completedJob) {
      throw new Error(`Unable to complete learning job "${runningJob.id}".`);
    }

    await options.touchActivity();
    recordLearningJobEvent(options.database, {
      event: "job-completed",
      jobId: completedJob.id,
      rootPath: completedJob.root_path,
      spaceId: completedJob.space_id,
      status: "success",
      detail: learningDocument.summary,
      data: {
        action_count: learningDocument.actions.length,
        applied_action_count: appliedActionCount,
        high_confidence_action_count: highConfidenceActions.length,
      },
    });
  } catch (error) {
    const effectiveError =
      heartbeatState.failure !== null ? heartbeatState.failure : error;

    if (abortSignal.aborted && heartbeatState.failure === null) {
      return;
    }

    const finishedAt = new Date().toISOString();
    const errorMessage = summarizeError(effectiveError);
    let finalizedJob: ReturnType<typeof LearningJobRepository.failLearningJob>;

    if (isMissingTranscriptError(effectiveError)) {
      finalizedJob = LearningJobRepository.skipLearningJob(options.database, {
        jobId: runningJob.id,
        leaseOwner: runningJob.lease_owner ?? "",
        finishedAt,
        errorText: errorMessage,
      });
    } else {
      finalizedJob = LearningJobRepository.failLearningJob(options.database, {
        jobId: runningJob.id,
        leaseOwner: runningJob.lease_owner ?? "",
        finishedAt,
        errorText: errorMessage,
      });
    }

    await options.touchActivity();
    recordLearningJobEvent(options.database, {
      event: finalizedJob?.state === "skipped" ? "job-skipped" : "job-failed",
      jobId: runningJob.id,
      rootPath: runningJob.root_path,
      spaceId: runningJob.space_id,
      status: finalizedJob?.state === "skipped" ? "warning" : "error",
      detail: errorMessage,
    });
  } finally {
    clearInterval(heartbeatInterval);
  }
}

export function startLearningWorker(
  options: StartLearningWorkerOptions,
): StartedLearningWorker {
  const embedText = options.embedText ?? defaultEmbedText;
  const heartbeatIntervalMs =
    options.heartbeatIntervalMs ?? DEFAULT_LEARNING_JOB_HEARTBEAT_INTERVAL_MS;
  const leaseDurationMs =
    options.leaseDurationMs ?? DEFAULT_LEARNING_JOB_LEASE_DURATION_MS;
  const pollIntervalMs =
    options.pollIntervalMs ?? DEFAULT_LEARNING_WORKER_POLL_INTERVAL_MS;
  const runLearningModel = options.runLearningModel ?? defaultRunLearningModel;
  const touchActivity = options.touchActivity ?? (async () => {});
  const leaseOwner = `engine:${String(process.pid)}`;
  let isClosing = false;
  let closePromise: Promise<void> | null = null;
  let currentJobPromise: Promise<void> | null = null;
  let currentJobAbortController: AbortController | null = null;
  let closedResolver: (() => void) | null = null;
  const closed = new Promise<void>((resolve) => {
    closedResolver = resolve;
  });

  const pollForWork = async (): Promise<void> => {
    if (isClosing || currentJobPromise !== null) {
      return;
    }

    const leasedJob = LearningJobRepository.leaseNextLearningJob(options.database, {
      leaseOwner,
      leaseDurationMs,
      leasedAt: new Date().toISOString(),
    });

    if (!leasedJob) {
      return;
    }

    await touchActivity();
    recordLearningJobEvent(options.database, {
      event: "job-leased",
      jobId: leasedJob.id,
      rootPath: leasedJob.root_path,
      spaceId: leasedJob.space_id,
      status: "info",
    });

    currentJobAbortController = new AbortController();
    currentJobPromise = processLearningJob(
      leasedJob,
      {
        database: options.database,
        embedText,
        heartbeatIntervalMs,
        leaseDurationMs,
        runLearningModel,
        touchActivity,
      },
      currentJobAbortController.signal,
    ).finally(() => {
      currentJobAbortController = null;
      currentJobPromise = null;
    });
  };
  const pollWorkerSafely = (): void => {
    void pollForWork().catch((error: unknown) => {
      if (isClosing) {
        return;
      }

      try {
        EventRepository.recordEvent(options.database, {
          event: "worker-poll-failed",
          kind: "learning_job",
          status: "error",
          detail: summarizeError(error),
        });
      } catch {
        // Ignore secondary logging failures while the worker is already unhealthy.
      }
    });
  };

  const pollInterval = setInterval(() => {
    pollWorkerSafely();
  }, pollIntervalMs);

  pollWorkerSafely();

  const close = async (): Promise<void> => {
    if (closePromise) {
      return closePromise;
    }

    closePromise = (async () => {
      isClosing = true;
      clearInterval(pollInterval);
      currentJobAbortController?.abort();

      if (currentJobPromise) {
        await currentJobPromise;
      }

      closedResolver?.();
    })();

    return closePromise;
  };

  return {
    close,
    closed,
  };
}
