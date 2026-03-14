import type { z } from "zod";

import type {
  learningJobSchema,
  learningJobStateSchema,
} from "../schemas/jobs.js";

export type LearningJob = z.infer<typeof learningJobSchema>;
export type LearningJobState = z.infer<typeof learningJobStateSchema>;
