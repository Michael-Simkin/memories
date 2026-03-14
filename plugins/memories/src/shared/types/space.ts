import type { z } from "zod";

import type {
  currentContextSchema,
  spaceKindSchema,
  spaceMetadataSchema,
} from "../schemas/space.js";

export type CurrentContext = z.infer<typeof currentContextSchema>;
export type SpaceKind = z.infer<typeof spaceKindSchema>;
export type SpaceMetadata = z.infer<typeof spaceMetadataSchema>;
