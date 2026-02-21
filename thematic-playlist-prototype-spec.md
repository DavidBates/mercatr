# Thematic Playlist Engine — Prototype Spec

## Purpose

This document is a technical specification for a prototype music recommendation system. It is designed to be passed to Claude Code (or another AI-assisted development tool) as the primary implementation guide. The spec describes architecture, data flow, interfaces, and constraints — but leaves implementation details to the developer's judgment.

## Project overview

### What this is

A CLI-based prototype for generating **thematic music playlists with transparent reasoning**. Given a seed (an artist, a song, or a theme), the system queries Last.fm for structured folksonomy data, assembles that data as context, and passes it to an LLM (Claude, via the Anthropic API) with a configurable prompt to generate thematic connections, playlist suggestions, and explanations of why songs belong together.

### What this is not

- Not an audio analysis pipeline — no local audio files, no spectral features, no signal processing
- Not a "sounds like" recommender — the goal is thematic and affective connections *across* genres and decades, not acoustic similarity
- Not a web application (yet) — CLI only for this prototype

### Core design principle

The system's distinctive value is **musical diversity through thematic coherence**. It should surface connections between, say, Elliott Smith and Hank Williams and Portishead — artists that share emotional terrain but sound nothing alike. The LLM layer provides the interpretive reasoning that makes these connections legible and compelling.

---

## Architecture

Three layers plus supporting infrastructure:

```
┌─────────────────────────────────────────────┐
│                  CLI Interface               │
│         (commands, output formatting)        │
└──────────────────────┬──────────────────────┘
                       │
┌──────────────────────▼──────────────────────┐
│              Context Builder                 │
│   (assembles Last.fm data + prompt template  │
│    into a structured LLM request)            │
└───────┬──────────────────────────┬──────────┘
        │                          │
┌───────▼───────┐          ┌──────▼──────────┐
│  Last.fm      │          │  LLM Harness    │
│  Client       │          │  (Anthropic SDK)│
│  + Cache      │          │  + Prompt       │
│               │          │    Templates    │
└───────────────┘          └─────────────────┘
```

### Layer 1: Last.fm Client

A thin wrapper around the Last.fm API that handles authentication, rate limiting, and response caching.

#### API key

Requires a Last.fm API key, read from environment variable `LASTFM_API_KEY`.

- Docs: https://www.last.fm/api
- Key creation: https://www.last.fm/api/account/create
- Base URL: `https://ws.audioscrobbler.com/2.0/`
- All requests use `format=json` query parameter

#### Rate limiting

Last.fm enforces 5 requests per second per IP, averaged over 5 minutes. The client must throttle requests to stay under this limit. A simple approach: maintain a queue and ensure no more than 5 requests are dispatched per rolling 1-second window.

#### Required methods

Each method should accept relevant parameters and return typed responses. All methods should check cache before making network requests.

| Method | Last.fm endpoint | Purpose |
|---|---|---|
| `getArtistTopTags(artist)` | `artist.getTopTags` | Folksonomy tags with popularity counts for an artist |
| `getTrackTopTags(artist, track)` | `track.getTopTags` | Folksonomy tags with popularity counts for a specific track |
| `getSimilarArtists(artist, limit?)` | `artist.getSimilar` | Artists similar to the given artist, with match scores |
| `getArtistInfo(artist)` | `artist.getInfo` | Bio, stats, tags summary, similar artists |
| `getTopArtistsForTag(tag, limit?)` | `tag.getTopArtists` | Top artists tagged with a given tag |
| `getTopTracksForTag(tag, limit?)` | `tag.getTopTracks` | Top tracks tagged with a given tag |
| `getTagInfo(tag)` | `tag.getInfo` | Tag description and usage stats |

#### Caching

Use a file-based cache to avoid redundant API calls during iterative exploration.

- Cache location: `.cache/lastfm/` directory in the project root
- Cache key: a deterministic hash or slug derived from the endpoint name + parameters
- Cache format: JSON files containing the raw API response plus a timestamp
- Cache TTL: 24 hours by default, configurable via environment variable `LASTFM_CACHE_TTL_HOURS`
- The cache should be inspectable — a developer should be able to browse `.cache/lastfm/` and understand what's cached by looking at filenames

### Layer 2: Context Builder

Translates raw Last.fm data into structured context suitable for LLM consumption. This is the bridge between "data I have" and "question I'm asking."

#### Responsibilities

- Orchestrate multiple Last.fm calls to gather context for a given query type
- Filter and prioritize data (e.g., drop low-count tags, limit similar artists to top N)
- Format the assembled data as a structured text block that gets inserted into a prompt template
- The context builder should be **query-type-aware** — different queries need different data assemblies

#### Query types (initial set)

These represent the kinds of questions the system can answer. Each query type defines what Last.fm data to gather and what prompt template to use.

1. **`explore`** — "Tell me about this artist/song thematically and suggest unexpected connections"
   - Data needed: artist top tags, artist info, similar artists (with their top tags), track tags if a specific song is provided
   - Depth: 1 hop (seed artist + their similar artists)

2. **`bridge`** — "What thematic connections exist between these two artists/songs?"
   - Data needed: top tags and info for both artists, their similar artists, any overlapping tags
   - Depth: data for both endpoints

3. **`theme`** — "Build a playlist around this theme/mood across genres and decades"
   - Data needed: top artists and tracks for the given tag, plus top tags for those artists (to find cross-genre candidates)
   - Depth: tag → artists → their tags (to find artists tagged with the theme but also tagged with diverse genres)

Each query type should map to a prompt template (see Layer 3).

#### Tag filtering

Last.fm tags are noisy. The context builder should:

- Filter tags below a configurable minimum count threshold (default: suggest 10, but make this tunable)
- Normalize tag casing (Last.fm returns mixed case)
- Optionally group tags by rough category (genre, mood, era, descriptor) — this is aspirational for the prototype but the data structure should allow for it later

### Layer 3: LLM Harness

Calls the Anthropic API with assembled context and configurable prompts. Designed for experimentation.

#### Anthropic SDK setup

- Use `@anthropic-ai/sdk` (official TypeScript SDK)
- API key from environment variable `ANTHROPIC_API_KEY`
- Model: `claude-sonnet-4-20250514` as default, overridable via environment variable `ANTHROPIC_MODEL`
- Reasonable default for `max_tokens` (suggestion: 4096 for exploratory responses)

#### Prompt template system

Prompts should be stored as **separate template files**, not hardcoded in source. This is critical for the experimentation workflow — the developer should be able to edit a prompt file and re-run without recompiling.

- Template location: `prompts/` directory in the project root
- Template format: Markdown files with simple variable interpolation (e.g., `{{context}}`, `{{query}}`, `{{artist_name}}`)
- Each query type has a corresponding template file: `prompts/explore.md`, `prompts/bridge.md`, `prompts/theme.md`
- Templates should define both the system prompt and the user message structure

#### Template structure

Each template file should contain two sections, separated by a clear delimiter:

```markdown
---system---
You are a music critic and cultural analyst with deep knowledge spanning...

{{context}}

---user---
{{query}}
```

The harness reads the template, interpolates variables, and sends the system/user messages to the API.

#### Response logging

Every LLM call should be logged for review:

- Log location: `logs/` directory
- Log format: JSON file containing timestamp, query type, template used, full prompt (system + user), model, and complete response
- Filenames should be timestamped and include the query type for browsability

#### Starter prompt templates

Include these as starting points. They should be good enough to produce useful results, but the developer will iterate on them.

##### `prompts/explore.md`

The explore template should instruct the LLM to:
- Analyze the thematic and emotional terrain of the seed artist/song based on the provided tag data and the LLM's own cultural knowledge
- Identify the *emotional stance* and recurring themes (not just genre or sound)
- Suggest 5-10 songs from **different genres and decades** that share thematic or emotional connections
- For each suggestion, explain the specific thematic connection — what do these songs share beyond surface-level genre?
- Explicitly seek diversity: different decades, different genres, different cultural contexts
- Note where the tag data supports or contradicts the LLM's own knowledge

##### `prompts/bridge.md`

The bridge template should instruct the LLM to:
- Analyze both artists/songs for their thematic content, emotional register, and cultural positioning
- Identify specific thematic bridges between them (shared concerns, complementary perspectives, emotional parallels)
- Suggest a 5-song "path" between the two that could function as a playlist transition
- Explain each step in the path — what connects each song to its neighbors and to the endpoints?

##### `prompts/theme.md`

The theme template should instruct the LLM to:
- Take the provided theme/mood and the Last.fm data showing which artists and tracks are associated with it
- Build a playlist of 10-15 songs that explore the theme across genres and decades
- Organize the playlist with an intentional arc or progression (not random)
- Explain the playlist's structure — why this order, what journey does it take the listener on?
- Prioritize unexpected or cross-genre selections over obvious choices

---

## CLI Interface

The prototype uses a command-line interface. Keep it simple — this is for developer use, not end users.

### Commands

```bash
# Explore an artist
npx tsx src/cli.ts explore --artist "Elliott Smith"

# Explore a specific song
npx tsx src/cli.ts explore --artist "Radiohead" --track "How to Disappear Completely"

# Bridge two artists
npx tsx src/cli.ts bridge --from "Nick Drake" --to "Frank Ocean"

# Theme-based playlist
npx tsx src/cli.ts theme --theme "loneliness in crowded places"

# Theme with a seed artist for grounding
npx tsx src/cli.ts theme --theme "performative happiness" --seed-artist "Carly Rae Jepsen"
```

### Output

- Print the LLM response to stdout, formatted for terminal readability
- Print a summary of what Last.fm data was gathered (number of tags, similar artists found, etc.) to stderr so it doesn't interfere with the main output
- If the `--verbose` flag is set, also print the full assembled context that was sent to the LLM
- If the `--dry-run` flag is set, assemble the context and print the full prompt without calling the LLM — useful for prompt iteration

### Flags

| Flag | Description |
|---|---|
| `--verbose` | Print assembled context to stderr |
| `--dry-run` | Print full prompt without calling LLM |
| `--no-cache` | Bypass Last.fm cache for this run |
| `--model <model>` | Override the default Claude model |
| `--template <path>` | Override the default prompt template for this query type |

---

## Project structure

```
thematic-playlist-engine/
├── src/
│   ├── cli.ts                  # CLI entry point and argument parsing
│   ├── lastfm/
│   │   ├── client.ts           # Last.fm API client with rate limiting
│   │   ├── cache.ts            # File-based cache implementation
│   │   └── types.ts            # TypeScript types for Last.fm responses
│   ├── context/
│   │   ├── builder.ts          # Context assembly logic
│   │   └── types.ts            # Context-related types
│   ├── llm/
│   │   ├── harness.ts          # Anthropic API client wrapper
│   │   ├── templates.ts        # Template loading and interpolation
│   │   └── logger.ts           # Response logging
│   └── types.ts                # Shared types
├── prompts/
│   ├── explore.md              # Explore query template
│   ├── bridge.md               # Bridge query template
│   └── theme.md                # Theme query template
├── .cache/                     # Last.fm response cache (gitignored)
├── logs/                       # LLM response logs (gitignored)
├── .env.example                # Template for required environment variables
├── .gitignore
├── package.json
├── tsconfig.json
└── README.md
```

---

## Environment variables

```bash
# .env.example
LASTFM_API_KEY=your_lastfm_api_key_here
ANTHROPIC_API_KEY=your_anthropic_api_key_here

# Optional
ANTHROPIC_MODEL=claude-sonnet-4-20250514
LASTFM_CACHE_TTL_HOURS=24
```

---

## Dependencies

### Runtime

- `@anthropic-ai/sdk` — Anthropic API client
- `dotenv` — Environment variable loading
- `commander` or `yargs` — CLI argument parsing (developer's choice)

### Development

- `typescript`
- `tsx` — For running TypeScript directly without a build step
- `@types/node`

### Notable non-dependencies

- No web framework (no Express, no Fastify)
- No database (file-based cache only)
- No audio processing libraries
- No frontend build tools

---

## Implementation notes and constraints

### Error handling

- Last.fm API errors should be caught and reported clearly (artist not found, rate limit hit, network error)
- Anthropic API errors should distinguish between auth errors, rate limits, and content issues
- The CLI should never crash with an unhandled promise rejection — always catch and report

### TypeScript configuration

- Use strict mode
- Target ES2022 or later (for top-level await if desired)
- Use Node module resolution

### Testing approach

For the prototype, formal test coverage is not required. However:

- The Last.fm client methods should be independently callable (not tightly coupled to the context builder) so they can be tested in isolation
- The context builder should accept Last.fm data as input (not call the client internally) for testability — use dependency injection or pass data explicitly
- The prompt template system should be testable without an API key (template loading + interpolation)

### Future considerations (do not implement now, but don't preclude)

These are features the system may grow into. The prototype architecture should not make these difficult to add later:

- **MusicBrainz integration** for canonical identifiers and structured genre data
- **A web UI** for non-CLI interaction
- **Playlist export** to Spotify, Apple Music, or other services
- **Conversation mode** where the LLM response informs follow-up queries (multi-turn exploration)
- **Tag category classification** (grouping Last.fm tags into genre, mood, era, descriptor buckets)
- **Persistent storage** for playlists and exploration sessions

---

## Definition of done

The prototype is complete when:

1. `explore --artist "Elliott Smith"` returns a thematically reasoned set of cross-genre song suggestions
2. `bridge --from "Nick Drake" --to "Frank Ocean"` returns a thematic path between the two
3. `theme --theme "songs about masks people wear"` returns a diverse, curated playlist with reasoning
4. `--dry-run` on any command prints the full prompt without calling the LLM
5. `--verbose` shows what Last.fm data was assembled
6. Last.fm responses are cached and reused on subsequent runs
7. LLM responses are logged to `logs/` with full prompt context
8. Prompt templates are editable in `prompts/` without code changes
9. The README documents setup (API keys), usage (commands and flags), and prompt customization
