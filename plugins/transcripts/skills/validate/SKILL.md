---
name: validate
description: >
  Search past session transcripts for rules, preferences, and coding patterns
  related to a specific implementation aspect. Run this before implementing
  anything to validate your approach against established conventions.
  Invoke once per aspect, e.g. /validate http-routes
context: fork
---

# Transcript Validation

You have access to two MCP tools for searching past Claude Code sessions:

1. **`search_transcripts(query)`** — Semantic search. Returns matching transcript locations with snippets, scores, timestamps, and project paths.
2. **`read_transcript(transcript_path, start_line, end_line)`** — Read formatted lines from a transcript file. Max 50 lines per call. Noise rows appear as empty lines.

## Your task

You received an **aspect** to validate (from the skill argument). This is one area of the implementation that needs to be checked against past sessions.

## Workflow

1. Formulate 2-3 search queries related to the aspect. Be specific — e.g., for "http-routes" try queries like "REST API route structure", "express route middleware", "API endpoint conventions".
2. Call `search_transcripts` for each query.
3. Review the snippets and scores. For the most relevant hits (score > 0.6), call `read_transcript` to get surrounding context (typically ±5 lines around the match).
4. Look for:
   - Explicit rules or preferences the user stated
   - Corrections the user made ("don't do it that way")
   - Patterns that repeat across sessions
   - Recent sessions override older ones if they contradict
5. Compile your findings into a concise **rulebook** for this aspect.

## Output format

Return a structured rulebook:

```
## Rules: [aspect name]

### Must
- [Hard rules that must be followed]

### Prefer
- [Preferences that should be followed unless there's a good reason not to]

### Avoid
- [Anti-patterns or things the user has explicitly rejected]

### Patterns
- [Common patterns observed across sessions]

### Sources
- [session date] [project]: brief description of what was found
```

Keep it concise. Only include rules you have evidence for. If you found nothing relevant, say so.
