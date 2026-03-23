import { existsSync } from 'node:fs';

import { logError, logInfo } from '../shared/logger.js';
import { consolidateProject } from './consolidate.js';
import { discoverTranscripts } from './discover.js';
import { extractCandidates } from './extract-candidates.js';
import type { BackfillState, CandidateInsight, DiscoveredTranscript } from './types.js';

const DEFAULT_CONCURRENCY = 5;

export class BackfillOrchestrator {
  private state: BackfillState = createIdleState();
  private candidatesByRepo = new Map<string, CandidateInsight[]>();
  private cancelled = false;
  private endpoint: { host: string; port: number };
  private pluginRoot: string;

  constructor(endpoint: { host: string; port: number }, pluginRoot: string) {
    this.endpoint = endpoint;
    this.pluginRoot = pluginRoot;
  }

  getState(): BackfillState {
    return this.state;
  }

  isRunning(): boolean {
    return !['idle', 'done', 'error'].includes(this.state.status);
  }

  cancel(): void {
    this.cancelled = true;
    this.state.status = 'done';
  }

  async run(targetRepoId: string): Promise<void> {
    if (this.isRunning()) {
      throw new Error('Backfill is already running');
    }

    this.state = createIdleState();
    this.state.repoId = targetRepoId;
    this.candidatesByRepo.clear();
    this.cancelled = false;

    try {
      this.state.status = 'discovering';
      this.state.startedAt = new Date().toISOString();
      logInfo('Backfill started: discovering transcripts', { targetRepoId });

      const discovery = await discoverTranscripts();
      if (this.cancelled) return;

      const repoTranscripts = discovery.transcripts.filter((t) => t.repoId === targetRepoId);
      const repoProjects = new Map<string, typeof repoTranscripts>();
      if (repoTranscripts.length > 0) {
        repoProjects.set(targetRepoId, repoTranscripts);
      }

      this.state.discovery = {
        totalTranscripts: repoTranscripts.length,
        totalProjects: repoProjects.size,
      };
      logInfo('Backfill discovery complete', {
        transcripts: repoTranscripts.length,
        targetRepoId,
      });

      this.state.status = 'phase1';
      this.state.phase1.total = repoTranscripts.length;
      this.state.phase1.results = repoTranscripts.map((t) => ({
        sessionId: t.sessionId,
        repoId: t.repoId,
        transcriptPath: t.transcriptPath,
        status: 'pending',
      }));

      await this.runPhase1(repoTranscripts);
      if (this.cancelled) return;

      this.state.status = 'phase2';
      const repoIds = [...repoProjects.keys()];
      this.state.phase2.total = repoIds.length;
      this.state.phase2.results = repoIds.map((repoId) => ({
        repoId,
        status: 'pending',
      }));

      await this.runPhase2(repoProjects);
      if (this.cancelled) return;

      this.state.status = 'done';
      logInfo('Backfill complete');
    } catch (error) {
      this.state.status = 'error';
      logError('Backfill failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async runPhase1(transcripts: DiscoveredTranscript[]): Promise<void> {
    const queue = [...transcripts];
    const running = new Map<string, Promise<void>>();

    const processNext = async (): Promise<void> => {
      while (queue.length > 0 && running.size < DEFAULT_CONCURRENCY && !this.cancelled) {
        const transcript = queue.shift()!;
        const resultEntry = this.state.phase1.results.find(
          (r) => r.sessionId === transcript.sessionId,
        );
        if (!resultEntry) continue;

        resultEntry.status = 'running';
        this.state.phase1.running++;

        const promise = this.extractOne(transcript, resultEntry).then(() => {
          running.delete(transcript.sessionId);
        });
        running.set(transcript.sessionId, promise);
      }
    };

    await processNext();

    while (running.size > 0 && !this.cancelled) {
      await Promise.race([...running.values()]);
      await processNext();
    }
  }

  private async extractOne(
    transcript: DiscoveredTranscript,
    resultEntry: BackfillState['phase1']['results'][number],
  ): Promise<void> {
    try {
      const candidates = await extractCandidates(
        transcript.transcriptPath,
        transcript.sessionId,
      );

      resultEntry.status = 'done';
      resultEntry.candidateCount = candidates.length;
      this.state.phase1.completed++;
      this.state.phase1.running--;

      const existing = this.candidatesByRepo.get(transcript.repoId) ?? [];
      existing.push(...candidates);
      this.candidatesByRepo.set(transcript.repoId, existing);
    } catch (error) {
      resultEntry.status = 'error';
      resultEntry.error = error instanceof Error ? error.message : String(error);
      this.state.phase1.failed++;
      this.state.phase1.running--;
      logError('Phase 1 extraction failed', {
        sessionId: transcript.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async runPhase2(
    projects: Map<string, DiscoveredTranscript[]>,
  ): Promise<void> {
    for (const [repoId, transcripts] of projects) {
      if (this.cancelled) return;

      const resultEntry = this.state.phase2.results.find((r) => r.repoId === repoId);
      if (!resultEntry) continue;

      const candidates = this.candidatesByRepo.get(repoId) ?? [];
      resultEntry.candidateInputCount = candidates.length;

      const projectRoot = transcripts[0]!.cwd;

      if (candidates.length === 0 || !existsSync(projectRoot)) {
        resultEntry.status = 'done';
        resultEntry.actionsApplied = 0;
        if (!existsSync(projectRoot)) {
          resultEntry.error = 'project directory no longer exists';
        }
        this.state.phase2.completed++;
        continue;
      }

      resultEntry.status = 'running';
      this.state.phase2.running++;

      try {
        const result = await consolidateProject(
          candidates,
          projectRoot,
          this.endpoint,
          repoId,
          this.pluginRoot,
        );

        resultEntry.status = 'done';
        resultEntry.actionsApplied = result.actionsApplied;
        this.state.phase2.completed++;
        this.state.phase2.running--;

        if (result.errors.length > 0) {
          resultEntry.error = result.errors.join('; ');
        }

        logInfo('Phase 2 consolidation complete', {
          repoId,
          candidateCount: candidates.length,
          actionsApplied: result.actionsApplied,
        });
      } catch (error) {
        resultEntry.status = 'error';
        resultEntry.error = error instanceof Error ? error.message : String(error);
        this.state.phase2.completed++;
        this.state.phase2.running--;
        logError('Phase 2 consolidation failed', {
          repoId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}

function createIdleState(): BackfillState {
  return {
    status: 'idle',
    phase1: { total: 0, completed: 0, running: 0, failed: 0, results: [] },
    phase2: { total: 0, completed: 0, running: 0, results: [] },
  };
}
