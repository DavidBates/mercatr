import { Router } from 'express';
import { expandYoutubeMusicPlaylist } from '../../playlist/expander.js';

const router = Router();

router.post('/', async (req, res) => {
  const { playlist, maxTracks } = req.body as { playlist?: string; maxTracks?: number };

  if (!playlist || playlist.trim() === '') {
    res.status(400).json({ error: 'playlist is required' });
    return;
  }

  let parsedMaxTracks: number | undefined;
  if (maxTracks !== undefined) {
    if (!Number.isInteger(maxTracks) || maxTracks <= 0) {
      res.status(400).json({ error: 'maxTracks must be a positive integer when provided' });
      return;
    }
    parsedMaxTracks = maxTracks;
  }

  try {
    const result = await expandYoutubeMusicPlaylist({
      playlist: playlist.trim(),
      maxTracks: parsedMaxTracks,
      noCache: false,
      expand: false,
    });

    const response = [
      `# Playlist Expansion: ${result.playlistTitle}`,
      `Derived theme: ${result.overallTheme}`,
      '',
      result.response,
    ].join('\n');

    res.json({
      response,
      playlistId: result.playlistId,
      playlistTitle: result.playlistTitle,
      playlistTrackCount: result.playlistTrackCount,
      overallTheme: result.overallTheme,
      sourceTrackCount: result.sourceTrackCount,
      analyzedTrackCount: result.analyzedTrackCount,
      skippedTracks: result.skippedTracks,
      seedArtistsUsed: result.seedArtistsUsed,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    res.status(500).json({ error: message });
  }
});

export default router;
