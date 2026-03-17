const memoryFtsMigration = {
  version: 3,
  name: "memory-fts",
  sql: `
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      id UNINDEXED,
      tags_text
    );
  `
};
export {
  memoryFtsMigration
};
