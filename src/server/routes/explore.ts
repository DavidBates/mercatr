import { Router } from 'express';
import { LastfmClient } from '../../lastfm/client.js';
import { checkArtistConfidence } from '../../llm/artistConfidence.js';
import { buildContext } from '../../context/builder.js';
import { runQuery } from '../../llm/harness.js';

const router = Router();

router.post('/', async (req, res) => {
  const { artist, track, voice } = req.body as { artist?: string; track?: string; voice?: string };

  if (!artist) {
    res.status(400).json({ error: 'artist is required' });
    return;
  }

  try {
    const client = new LastfmClient({ noCache: false });
    const { result } = await checkArtistConfidence(artist, client);

    if (result.confidence === 'low') {
      res.status(404).json({ error: result.reasoning, type: 'artist_not_found' });
      return;
    }

    const resolvedName = result.resolvedName ?? artist;
    const query = { type: 'explore' as const, artist: resolvedName, ...(track ? { track } : {}) };
    const context = await buildContext(client, query);
    const { response } = await runQuery(context, { expand: false, voice });

    const corrected = resolvedName.toLowerCase() !== artist.toLowerCase();
    res.json({
      response,
      ...(corrected ? { resolvedArtist: resolvedName, originalInput: artist } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    res.status(500).json({ error: message });
  }
});

export default router;
