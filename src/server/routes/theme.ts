import { Router } from 'express';
import { LastfmClient } from '../../lastfm/client.js';
import { checkArtistConfidence } from '../../llm/artistConfidence.js';
import { runThemeTranslation } from '../../llm/themeTranslate.js';
import { buildContext } from '../../context/builder.js';
import { runQuery } from '../../llm/harness.js';

const router = Router();

router.post('/', async (req, res) => {
  const { theme, seedArtist, voice } = req.body as { theme?: string; seedArtist?: string; voice?: string };

  if (!theme) {
    res.status(400).json({ error: 'theme is required' });
    return;
  }

  try {
    const client = new LastfmClient({ noCache: false });

    let resolvedSeed: string | undefined;
    if (seedArtist) {
      const { result } = await checkArtistConfidence(seedArtist, client);
      if (result.confidence === 'low') {
        res.status(404).json({ error: result.reasoning, type: 'artist_not_found' });
        return;
      }
      resolvedSeed = result.resolvedName ?? seedArtist;
    }

    const { result: translation } = await runThemeTranslation(theme);
    const { translatedTags, moodTerms, genreHints } = translation;

    const query = {
      type: 'theme' as const,
      theme,
      translatedTags,
      translateMetadata: { moodTerms, genreHints },
      ...(resolvedSeed ? { seedArtist: resolvedSeed } : {}),
    };

    const context = await buildContext(client, query);
    const { response } = await runQuery(context, { expand: false, voice });

    const seedCorrected = resolvedSeed && seedArtist && resolvedSeed.toLowerCase() !== seedArtist.toLowerCase();

    res.json({
      response,
      ...(seedCorrected ? { resolvedArtist: resolvedSeed, originalInput: seedArtist } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    res.status(500).json({ error: message });
  }
});

export default router;
