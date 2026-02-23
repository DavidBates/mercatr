import { Router } from 'express';
import { LastfmClient } from '../../lastfm/client.js';
import { checkArtistConfidence } from '../../llm/artistConfidence.js';
import { runThemeTranslation } from '../../llm/themeTranslate.js';
import { buildContext } from '../../context/builder.js';
import { runQuery } from '../../llm/harness.js';

const router = Router();

router.post('/', async (req, res) => {
  const { theme, seedArtist, seedArtists } = req.body as {
    theme?: string;
    seedArtist?: string;
    seedArtists?: string[];
  };

  if (!theme) {
    res.status(400).json({ error: 'theme is required' });
    return;
  }

  try {
    const client = new LastfmClient({ noCache: false });

    const normalizedSeedArtists = [
      ...(Array.isArray(seedArtists) ? seedArtists : []),
      ...(seedArtist ? [seedArtist] : []),
    ]
      .map(name => name.trim())
      .filter(name => name.length > 0);

    const dedupedSeedArtists = [...new Set(normalizedSeedArtists)];

    let resolvedSeedArtists: string[] = [];
    if (dedupedSeedArtists.length > 0) {
      const confidenceResults = await Promise.all(
        dedupedSeedArtists.map(async artist => ({
          original: artist,
          confidence: await checkArtistConfidence(artist, client),
        }))
      );

      const lowConfidence = confidenceResults.find(entry => entry.confidence.result.confidence === 'low');
      if (lowConfidence) {
        res.status(404).json({
          error: lowConfidence.confidence.result.reasoning,
          type: 'artist_not_found',
          artist: lowConfidence.original,
        });
        return;
      }

      resolvedSeedArtists = confidenceResults.map(
        entry => entry.confidence.result.resolvedName ?? entry.original
      );
    }

    const { result: translation } = await runThemeTranslation(theme);
    const { translatedTags, moodTerms, genreHints } = translation;

    const query = {
      type: 'theme' as const,
      theme,
      translatedTags,
      translateMetadata: { moodTerms, genreHints },
      ...(resolvedSeedArtists.length > 0 ? { seedArtists: resolvedSeedArtists } : {}),
    };

    const context = await buildContext(client, query);
    const { response } = await runQuery(context, { expand: false });

    const seedCorrected = dedupedSeedArtists.length > 0
      && dedupedSeedArtists.some((artist, index) =>
        resolvedSeedArtists[index]?.toLowerCase() !== artist.toLowerCase()
      );

    res.json({
      response,
      ...(seedCorrected ? { resolvedArtist: resolvedSeedArtists, originalInput: dedupedSeedArtists } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    res.status(500).json({ error: message });
  }
});

export default router;
