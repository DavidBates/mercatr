# Voice Feature Specification

## Overview

Mercatr supports optional voice personas that change how analysis and recommendations are delivered. A voice affects substance as well as tone — how the model frames connections, what it chooses to foreground, and the register it speaks in. Without a voice flag, the system behaves as it does today.

Voices are plain prose files stored in `prompts/voices/`. They are referenced by filename without extension, either via the `--voice` CLI flag or a dropdown in the web interface.

---

## File Structure

```
prompts/
  voices/
    manifest.json
    knowledgeable-friend.md
    gonzo.md
    [additional voices...]
```

### Voice files

Each voice file is freeform prose. No delimiters, no template variables. The prose should describe the persona's analytical sensibility, not just their tone — what they notice, what they lead with, what they consider worth saying.

**Example: `prompts/voices/knowledgeable-friend.md`**

```
Write as a knowledgeable, enthusiastic friend sharing a discovery — someone who has spent 
years thinking hard about music and genuinely can't wait to show you what they found. 

Lead with what's surprising or exciting about the connection, not with scene-setting. 
Trust the listener to keep up; don't over-explain. Use specific detail where it illuminates, 
but keep the energy moving. This should feel like a conversation over a drink, not a review 
written for publication.
```

**Example: `prompts/voices/gonzo.md`**

```
Write as a gonzo music journalist — opinionated, digressive, and unafraid to make the 
argument personal. You have a point of view and you're going to make it. 

Lead with the most outrageous or counterintuitive connection and defend it hard. Let the 
analysis veer into cultural criticism, personal history, or provocation when it serves the 
argument. Structure is subordinate to momentum. The reader should finish feeling like they 
just argued about music with someone who really meant it.
```

### manifest.json

A static manifest listing available voices for the web interface. Each entry includes a machine-readable key (matching the filename without extension), a display label, and an optional short description shown in the UI.

```json
{
  "voices": [
    {
      "id": "knowledgeable-friend",
      "label": "Knowledgeable Friend",
      "description": "Enthusiastic and personal, like sharing a discovery over a drink."
    },
    {
      "id": "gonzo",
      "label": "Gonzo",
      "description": "Opinionated, digressive, and willing to make it personal."
    }
  ]
}
```

Adding a new voice requires: creating the `.md` file and adding an entry to `manifest.json`. No code changes needed.

---

## Prompt Integration

When a voice is active, its prose is injected into the system prompt as a final section, under a `## Voice` header, after all other system prompt content and before the `---user---` delimiter.

**Injection point (all three prompt templates):**

```
[existing system prompt content]

{{voiceBlock}}

---user---
```

The `voiceBlock` variable is assembled by the prompt loader:

- If `--voice` is set and the file exists: inject `## Voice\n\n{contents of voice file}`
- If `--voice` is not set: inject nothing (empty string)
- If `--voice` is set but the file does not exist: exit with an error before any API calls

Positioning the voice block last in the system prompt gives it higher effective priority than the analytical instructions above it, which is intentional — the persona should shape how the analysis is expressed, not be overridden by it.

---

## CLI

### New flag

`--voice <name>` — Load a voice persona from `prompts/voices/<name>.md`.

Works with all three commands (`explore`, `bridge`, `theme`).

```bash
npx tsx src/cli.ts explore --artist "Phoebe Bridgers" --voice gonzo
npx tsx src/cli.ts bridge --from "Miles Davis" --to "Aphex Twin" --voice knowledgeable-friend
npx tsx src/cli.ts theme --theme "highway loneliness" --voice gonzo
```

### Error handling

If the specified voice file does not exist, exit before making any API calls:

```
✗  Voice not found: "gonzo"
   Available voices: knowledgeable-friend
   Voice files should be placed in prompts/voices/
```

---

## Web Interface

### Dropdown

A voice selector dropdown is added to the query form, populated from `manifest.json` at server startup. The first option is always a blank/default state:

```
Voice (optional)
  [None]
  Knowledgeable Friend
  Gonzo
```

When a voice is selected, its `id` is passed to the backend as a `voice` parameter alongside the existing query parameters.

### API

The existing query endpoints accept an optional `voice` parameter:

```
POST /api/explore   { artist, track?, voice? }
POST /api/bridge    { from, to, voice? }
POST /api/theme     { theme, seedArtist?, voice? }
```

The backend resolves the voice file by id using the same logic as the CLI. If `voice` is omitted or null, behavior is unchanged.

### Server startup

`manifest.json` is read once at server startup and held in memory. The `/api/voices` endpoint returns the manifest for the frontend to consume:

```
GET /api/voices → { voices: [...] }
```

The frontend fetches this on page load to populate the dropdown. This keeps the manifest as the single source of truth without requiring a rebuild when voices are added.

---

## Logging

The voice id (or null) is included in the existing log schema alongside other preflight metadata:

```json
{
  "command": "explore",
  "voice": "gonzo",
  "preflight": { ... },
  "prompt": { ... },
  "response": { ... }
}
```

---

## Acceptance Criteria

- `--voice <name>` loads `prompts/voices/<name>.md` and injects its contents into the system prompt
- An invalid voice name exits with a clear error before any API calls
- Omitting `--voice` produces identical behavior to the current system
- The web UI dropdown is populated from `manifest.json`
- Selecting a voice in the web UI passes it through to the backend and into the prompt
- Selecting no voice in the web UI produces identical behavior to the current system
- Adding a new voice (file + manifest entry) requires no code changes
- The active voice id is recorded in the run log

---

## Out of Scope

- Voice files do not support template variables or section delimiters
- Voices cannot override diversity constraints, output structure, or any section other than the persona
- There is no default voice; the no-voice state is explicitly supported and not a fallback
- Voice validation (beyond file existence) is not performed — content is the author's responsibility
