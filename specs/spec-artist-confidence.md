# Feature Spec: Artist Confidence & Entity Resolution

## Problem

When a user supplies an artist name that doesn't exist in Last.fm (or exists under a different spelling), the system currently proceeds as if it has valid data. The LLM fills the gap with plausible-sounding inference, producing outputs that look reasonable but are built on fabricated premises. This is not surfaced to the user.

**Observed failure mode:** "Samantha Carpenter" (no Last.fm data) → model invented an artist profile and built a bridge playlist from it.

---

## Goal

Add a preliminary entity resolution step that:
1. Confirms whether the supplied artist name maps to a known Last.fm entity
2. If confidence is low, either suggests corrections or halts with a clear signal before the main prompt fires
3. Logs the resolution step as a first-class event

---

## Prompt Template

**File:** `prompts/artist-confidence.md`

This template is called before any query type that accepts a seed artist (`explore`, `bridge`).

### Template Content

```
You are an entity resolution assistant for a music information system.

A user has supplied an artist name. Your job is to assess whether this name maps 
to a real, identifiable musical artist and — if not — suggest the most likely 
intended match.

## Supplied Name
{{artistName}}

## Last.fm Lookup Result
{{lastfmData}}
{{#if noData}}
No artist data was returned from Last.fm for this name.
{{/if}}

## Your Task

Return a JSON object with the following fields:

{
  "confidence": "high" | "medium" | "low",
  "resolvedName": "<canonical artist name, or null if unresolvable>",
  "alternativeSuggestions": ["<suggestion 1>", "<suggestion 2>"],  // if confidence < high
  "reasoning": "<one sentence explaining your assessment>",
  "proceed": true | false
}

### Confidence Definitions

- **high**: The name matches a well-known artist. Last.fm data is present and consistent. Proceed.
- **medium**: The name is close to a known artist (possible typo, alternate spelling, or disambiguation needed). Last.fm data may be absent or thin. Suggest alternatives, ask user to confirm before proceeding.
- **low**: The name does not match any identifiable artist. Last.fm data is absent. Do not proceed.

### Guidelines

- A name with no Last.fm data is not automatically low confidence — the artist may be real but under-indexed. Use your broader knowledge.
- Prefer resolving to the most likely intended artist rather than failing.
- If two artists share a name (e.g. "The Church" could be multiple bands), note the ambiguity in reasoning.
- Do not invent biographical details about artists you are uncertain about.

Return only the JSON object. No preamble.
```

---

## CLI Integration

### Where It Fires

Before the main LLM call in any command that accepts `--artist` or positional artist arguments (`explore`, `bridge` artist A and B).

### Flow

```
user input: artist name
    ↓
Last.fm lookup (existing behavior)
    ↓
artist-confidence prompt fires with: { artistName, lastfmData }
    ↓
parse JSON response
    ↓
if confidence === 'high'
    → proceed to main prompt (existing flow)
if confidence === 'medium'
    → print suggestions to user, prompt for confirmation
    → on confirm: proceed with resolvedName
    → on reject: halt
if confidence === 'low'
    → print error with alternativeSuggestions if any
    → halt; do not fire main prompt
```

### User-facing output (medium confidence example)

```
⚠  Artist not found: "Samantha Carpenter"
   Did you mean: Sabrina Carpenter?
   Proceed with Sabrina Carpenter? (y/n)
```

---

## Logging

The existing log schema is:
```json
{
  "timestamp", "queryType", "templatePath", "model", "systemPrompt", "userPrompt", "response"
}
```

When the artist confidence step fires, append a `preflight` array to the log entry:

```json
{
  "timestamp": "...",
  "queryType": "bridge",
  "preflight": [
    {
      "step": "artist-confidence",
      "templatePath": "prompts/artist-confidence.md",
      "input": {
        "artistName": "Samantha Carpenter",
        "lastfmDataPresent": false
      },
      "output": {
        "confidence": "medium",
        "resolvedName": "Sabrina Carpenter",
        "alternativeSuggestions": ["Sabrina Carpenter"],
        "reasoning": "Name is likely a misremembering of pop artist Sabrina Carpenter.",
        "proceed": false
      },
      "userConfirmed": true,
      "resolvedTo": "Sabrina Carpenter"
    }
  ],
  "templatePath": "...",
  "model": "...",
  "systemPrompt": "...",
  "userPrompt": "...",
  "response": "..."
}
```

If the step results in a halt (confidence `low`, or user declined `medium`), the log entry is written with only the `preflight` array — no `systemPrompt`, `userPrompt`, or `response` fields. `queryType` is set to the intended query type, and a `halted` boolean is added at the top level.

---

## Acceptance Criteria

- [ ] `prompts/artist-confidence.md` exists and matches the template above
- [ ] Confidence step fires before main prompt for `explore` and both artists in `bridge`
- [ ] `high` confidence: no user-visible change to existing flow
- [ ] `medium` confidence: user is prompted to confirm before proceeding
- [ ] `low` confidence: query halts with clear error; main prompt does not fire
- [ ] All preflight steps appear in logs regardless of outcome
- [ ] Halted queries produce a log entry with `"halted": true` and no response field
- [ ] Resolved artist name (not original input) is used in all downstream Last.fm calls and prompt construction
