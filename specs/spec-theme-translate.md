# Feature Spec: Theme → Folksonomy Tag Translation

## Problem

Last.fm's tag system is user-generated and reflects how listeners describe music experientially — genre labels, moods, cultural markers, era references. Abstract or analytical themes like "confronting imposter syndrome" or "bragging about toxic personality" have zero tag reach because no one has ever tagged a song that way.

When the `theme` query type receives a tag with zero reach, Last.fm contributes nothing to the context. The LLM proceeds using only its own training knowledge, which is fine, but the system loses its core value proposition: the two-layer hybrid of folksonomy data + cultural reasoning.

**Observed failure mode:** All three `theme` runs in the logs returned zero tag reach. Last.fm data fields were empty in every case.

---

## Goal

Add a preliminary translation step that converts a user-supplied abstract theme into a set of Last.fm-plausible folksonomy terms, then uses those terms for the Last.fm lookup rather than (or in addition to) the raw theme string.

---

## Prompt Template

**File:** `prompts/theme-translate.md`

This template fires only for the `theme` query type, before the Last.fm lookup.

### Template Content

```
You are a folksonomy translation assistant for a music tagging system.

A user wants to find music around an abstract theme. Last.fm uses user-generated 
tags that reflect how listeners actually describe music — not analytical concepts, 
but experiential and cultural language.

## User Theme
{{theme}}

## Your Task

Translate this theme into terms that are likely to exist as Last.fm tags. Think 
about how a music listener (not a critic or academic) would describe songs that 
explore this theme.

Return a JSON object:

{
  "originalTheme": "<the user's input>",
  "translatedTags": ["<tag 1>", "<tag 2>", "<tag 3>", "<tag 4>", "<tag 5>"],
  "moodTerms": ["<mood 1>", "<mood 2>"],
  "genreHints": ["<genre 1>", "<genre 2>"],
  "reasoning": "<2–3 sentences explaining the translation logic>"
}

### Guidelines for translatedTags

- Use lowercase, as Last.fm tags are typically lowercase
- Prefer short phrases over long ones ("self-doubt" over "confronting self-doubt")
- Include both emotional/mood terms AND genre terms that tend to cluster around this theme
- Think about what tags a listener would apply *while listening*, not while analyzing
- Include at least one "era" or "scene" tag if the theme has a natural cultural home
- Aim for tags with broad reach, not niche specificity

### Examples of good tag translations

User theme: "confronting imposter syndrome"
→ translatedTags: ["self-doubt", "anxiety", "empowerment", "underdog", "perseverance"]
→ moodTerms: ["melancholic", "uplifting", "introspective"]
→ genreHints: ["singer-songwriter", "hip-hop", "alternative"]

User theme: "bragging about toxic personality"  
→ translatedTags: ["swagger", "attitude", "rebellious", "provocative", "unapologetic"]
→ moodTerms: ["aggressive", "confident", "dark"]
→ genreHints: ["hip-hop", "punk", "rap rock"]

Return only the JSON object. No preamble.
```

---

## CLI Integration

### Where It Fires

Only for the `theme` query type, before the Last.fm tag lookup.

### Flow

```
user input: theme string
    ↓
theme-translate prompt fires with: { theme }
    ↓
parse JSON response → extract translatedTags, moodTerms, genreHints
    ↓
Last.fm lookup using translatedTags (query each tag, aggregate results)
    ↓
inject into main theme prompt:
  - original theme (unchanged — this is still what the LLM reasons about)
  - Last.fm data from translated tags
  - translation metadata (so the LLM knows what was searched)
```

### Last.fm query strategy

Query each tag in `translatedTags` separately. Aggregate and deduplicate results. Weight by tag relevance score if available. Pass the top N artists/tracks to the main prompt as usual.

The main `theme` system prompt receives an additional section:

```
## Tag Translation
The user's theme was translated into the following Last.fm search terms:
{{translatedTags}}

Last.fm data below reflects results for these terms, not the original theme.
```

This keeps the LLM informed that the data is one step removed from the original request — it can factor that into its reasoning.

---

## Logging

Append to the `preflight` array (same pattern as artist-confidence spec):

```json
{
  "preflight": [
    {
      "step": "theme-translate",
      "templatePath": "prompts/theme-translate.md",
      "input": {
        "theme": "confronting imposter syndrome"
      },
      "output": {
        "originalTheme": "confronting imposter syndrome",
        "translatedTags": ["self-doubt", "anxiety", "empowerment", "underdog", "perseverance"],
        "moodTerms": ["melancholic", "uplifting", "introspective"],
        "genreHints": ["singer-songwriter", "hip-hop", "alternative"],
        "reasoning": "Imposter syndrome is primarily about self-doubt and anxiety, but the 'confronting' framing implies eventual empowerment. Tags reflect both the emotional starting point and the arc toward resolution."
      },
      "lastfmTagsQueried": ["self-doubt", "anxiety", "empowerment", "underdog", "perseverance"],
      "lastfmResultsReturned": 14
    }
  ]
}
```

`lastfmResultsReturned` is the count of unique artists/tracks returned across all tag queries, after deduplication. This lets you quickly assess whether the translation actually improved data yield.

---

## Open Question: Tag Reach Threshold

Currently, zero tag reach means Last.fm contributes nothing. This spec doesn't define a minimum threshold for "good enough" data — that's a tuning question. For now, log the result count and proceed regardless. Once you have a few runs with translated tags, you'll have signal on what counts as useful yield.

---

## Acceptance Criteria

- [ ] `prompts/theme-translate.md` exists and matches the template above
- [ ] Translation step fires before Last.fm lookup for all `theme` queries
- [ ] Each tag in `translatedTags` is queried against Last.fm separately
- [ ] Results are aggregated and deduplicated before being passed to main prompt
- [ ] Main prompt system prompt includes the "Tag Translation" section noting the search terms used
- [ ] Original user theme is preserved unchanged as the primary framing for the LLM
- [ ] All translation preflight data appears in logs, including `lastfmResultsReturned`
- [ ] If translated tags also return zero results, this is logged but does not halt — the main prompt fires with a note that no Last.fm data was available
