import { memorySpacesAndSpaceRootsMigration } from "./001-memory-spaces-and-space-roots.js";
import { memoriesAndPathMatchersMigration } from "./002-memories-and-path-matchers.js";
import { memoryFtsMigration } from "./003-memory-fts.js";

export const STORAGE_MIGRATIONS = [
  memorySpacesAndSpaceRootsMigration,
  memoriesAndPathMatchersMigration,
  memoryFtsMigration,
];
