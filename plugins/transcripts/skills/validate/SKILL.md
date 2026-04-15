---
name: validate
description: >
  Validate implementation plan against past session transcripts before coding.
  Analyzes the current task, decomposes it into implementation aspects, then
  spawns parallel subagents (one per aspect) using /validate-aspect to search
  for rules and preferences. Collects all results into a unified rulebook.
---

<instructions>
You are about to implement something. Before writing any code, validate your approach against past session transcripts.

1. Look at the current conversation context — what is the user asking you to implement?
2. Decompose the task into 2-5 distinct implementation aspects. Examples:
   - "Add API route with auth and tests" → aspects: http-routes, authentication, testing
   - "Create new DB model with migration" → aspects: database-models, migrations, data-access-patterns
   - "Build React component with state" → aspects: react-components, state-management, styling
3. For EACH aspect, invoke the `/validate-aspect` skill with that aspect as the argument. Use the Skill tool for each one — they will run as parallel forked subagents.
4. Wait for all subagents to return their rulebooks.
5. Compile the results into a single unified rulebook and present it to the user before implementing.

Do NOT search transcripts yourself. Do NOT try to handle all aspects in one shot. Each aspect MUST be a separate `/validate-aspect` invocation.
</instructions>
