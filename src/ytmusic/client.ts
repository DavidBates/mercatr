import YTMusic from 'ytmusic-api';

export interface PlaylistTrack {
  artist: string;
  track: string;
  videoId: string;
}

export interface PlaylistData {
  playlistId: string;
  title: string;
  tracks: PlaylistTrack[];
}

const PLAYLIST_ID_PATTERN = /^[A-Za-z0-9_-]{8,}$/;

export function extractPlaylistId(input: string): string {
  const raw = input.trim();
  if (!raw) {
    throw new Error('Playlist URL or playlist ID is required');
  }

  if (PLAYLIST_ID_PATTERN.test(raw) && !raw.includes('/')) {
    return raw;
  }

  try {
    const url = new URL(raw);
    const list = url.searchParams.get('list')?.trim();
    if (list) return list;
  } catch {
    // Ignore URL parse errors; regex fallback below handles malformed values.
  }

  const listMatch = raw.match(/[?&]list=([A-Za-z0-9_-]+)/);
  if (listMatch?.[1]) return listMatch[1];

  throw new Error(`Could not extract playlist ID from "${input}"`);
}

function dedupeTracks(tracks: PlaylistTrack[]): PlaylistTrack[] {
  const seen = new Set<string>();
  const deduped: PlaylistTrack[] = [];

  for (const track of tracks) {
    const key = `${track.artist.toLowerCase()}::${track.track.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(track);
  }

  return deduped;
}

export async function getPlaylistData(playlistInput: string): Promise<PlaylistData> {
  const playlistId = extractPlaylistId(playlistInput);
  const ytmusic = new YTMusic();
  const cookies = process.env.YTMUSIC_COOKIES;

  await ytmusic.initialize(cookies ? { cookies } : undefined);

  const [playlistMeta, playlistVideos] = await Promise.all([
    ytmusic.getPlaylist(playlistId),
    ytmusic.getPlaylistVideos(playlistId),
  ]);

  const tracks = dedupeTracks(
    playlistVideos
      .map(video => {
        const artist = video.artist?.name?.trim();
        const track = video.name?.trim();
        if (!artist || !track) return null;
        return { artist, track, videoId: video.videoId };
      })
      .filter((track): track is PlaylistTrack => track !== null)
  );

  return {
    playlistId,
    title: playlistMeta.name,
    tracks,
  };
}
