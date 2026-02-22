import { Router } from 'express';
import { LastfmClient } from '../../lastfm/client.js';
import { checkArtistConfidence } from '../../llm/artistConfidence.js';
import { buildContext } from '../../context/builder.js';
import { runQuery } from '../../llm/harness.js';

const router = Router();

router.post('/', async (req, res) => {
  const { from, to, voice } = req.body as { from?: string; to?: string; voice?: string };

  if (!from || !to) {
    res.status(400).json({ error: 'from and to are required' });
    return;
  }

  try {
    const client = new LastfmClient({ noCache: false });
    const [fromCheck, toCheck] = await Promise.all([
      checkArtistConfidence(from, client),
      checkArtistConfidence(to, client),
    ]);

    if (fromCheck.result.confidence === 'low') {
      res.status(404).json({ error: fromCheck.result.reasoning, type: 'artist_not_found', artist: from });
      return;
    }
    if (toCheck.result.confidence === 'low') {
      res.status(404).json({ error: toCheck.result.reasoning, type: 'artist_not_found', artist: to });
      return;
    }

    const resolvedFrom = fromCheck.result.resolvedName ?? from;
    const resolvedTo = toCheck.result.resolvedName ?? to;

    const query = { type: 'bridge' as const, fromArtist: resolvedFrom, toArtist: resolvedTo };
    const context = await buildContext(client, query);
    const { response } = await runQuery(context, { expand: false, voice });

    const fromCorrected = resolvedFrom.toLowerCase() !== from.toLowerCase();
    const toCorrected = resolvedTo.toLowerCase() !== to.toLowerCase();

    res.json({
      response,
      ...((fromCorrected || toCorrected) ? {
        resolvedArtist: [resolvedFrom, resolvedTo],
        originalInput: [from, to],
      } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    res.status(500).json({ error: message });
  }
});

export default router;
