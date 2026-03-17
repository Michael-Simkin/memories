import type {
  LearningJob,
  LearningJobState,
} from "../../shared/types/jobs.js";
import type { CurrentContext } from "../../shared/types/space.js";

export interface ResolveActiveLearningSpaceOptions {
  spaceId?: string | undefined;
  context?: CurrentContext | undefined;
}

export interface EnqueueActiveLearningJobInput
  extends ResolveActiveLearningSpaceOptions {
  id?: string | undefined;
  transcriptPath: string;
  lastAssistantMessage?: string | null | undefined;
  sessionId?: string | null | undefined;
  enqueuedAt?: string | undefined;
  updatedAt?: string | undefined;
}

export interface EnqueueLearningJobInput {
  id?: string | undefined;
  spaceId: string;
  rootPath: string;
  transcriptPath: string;
  enqueueKey?: string | undefined;
  lastAssistantMessage?: string | null | undefined;
  sessionId?: string | null | undefined;
  state?: LearningJobState | undefined;
  leaseOwner?: string | null | undefined;
  leaseExpiresAt?: string | null | undefined;
  attemptCount?: number | undefined;
  errorText?: string | null | undefined;
  enqueuedAt?: string | undefined;
  startedAt?: string | null | undefined;
  finishedAt?: string | null | undefined;
  updatedAt?: string | undefined;
}

export interface UpdateLearningJobInput {
  jobId: string;
  lastAssistantMessage?: string | null | undefined;
  sessionId?: string | null | undefined;
  state?: LearningJobState | undefined;
  leaseOwner?: string | null | undefined;
  leaseExpiresAt?: string | null | undefined;
  attemptCount?: number | undefined;
  errorText?: string | null | undefined;
  startedAt?: string | null | undefined;
  finishedAt?: string | null | undefined;
  updatedAt?: string | undefined;
}

export interface LeaseLearningJobInput {
  leaseOwner: string;
  leaseDurationMs: number;
  leasedAt?: string | undefined;
}

export interface StartLearningJobInput {
  jobId: string;
  leaseOwner: string;
  startedAt?: string | undefined;
}

export interface HeartbeatLearningJobInput {
  jobId: string;
  leaseOwner: string;
  leaseDurationMs: number;
  heartbeatedAt?: string | undefined;
}

export interface FinalizeLearningJobInput {
  jobId: string;
  leaseOwner: string;
  finishedAt?: string | undefined;
  errorText?: string | null | undefined;
}

export interface ListLearningJobsOptions {
  spaceId?: string | undefined;
  state?: LearningJobState | undefined;
  limit?: number | undefined;
}

export type PersistedLearningJob = LearningJob;
