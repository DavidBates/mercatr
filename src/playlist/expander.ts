import path from 'path';
import { fileURLToPath } from 'url';
import { LastfmClient } from '../lastfm/client.js';
import { buildContext } from '../context/builder.js';
import { runQuery } from '../llm/harness.js';
import { checkArtistConfidence } from '../llm/artistConfidence.js';
import { runThemeTranslation } from '../llm/themeTranslate.js';
import { summarizePlaylistThemes } from '../llm/playlistThemeSummary.js';
import { getPlaylistData } from '../ytmusic/client.js';
import type { SimilarArtist } from '../lastfm/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PLAYLIST_EXPAND_TEMPLATE_PATH = path.resolve(__dirname, '../../prompts/playlist-expand.md');

export interface PlaylistExpandOptions {
  playlist: string;
  model?: string;
  templatePath?: string;
  noCache?: boolean;
  expand?: boolean;
  maxTracks?: number;
}

export interface PlaylistExploreTheme {
  artist: string;
  track: string;
  themeSentence: string;
}

export interface PlaylistExpandResult {
  playlistId: string;
  playlistTitle: string;
  playlistTrackCount: number;
  sourceTrackCount: number;
  analyzedTrackCount: number;
  skippedTracks: string[];
  seedArtistsUsed: string[];
  overallTheme: string;
  trackThemes: PlaylistExploreTheme[];
  response: string;
  systemPrompt: string;
  userPrompt: string;
  model: string;
}

const DEFAULT_PLAYLIST_SAMPLE_SIZE = 5;
const DEFAULT_SEED_ARTIST_LIMIT = 8;

function normalizeMaxTracks(maxTracks: number | undefined): number | undefined {
  if (maxTracks === undefined) return undefined;
  if (!Number.isInteger(maxTracks) || maxTracks <= 0) {
    throw new Error(`--max-tracks must be a positive integer, received: ${maxTracks}`);
  }
  return maxTracks;
}

function sampleTracksRandomly<T>(items: T[], sampleSize: number): T[] {
  const shuffled = [...items];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, Math.min(sampleSize, shuffled.length));
}

function buildSourcePlaylistContext(
  playlistTitle: string,
  sourceTracks: Array<{ artist: string; track: string }>,
  trackThemes: PlaylistExploreTheme[],
  skippedTracks: string[]
): string {
  const lines: string[] = [];
  lines.push('## Source Playlist');
  lines.push(`Title: ${playlistTitle}`);
  lines.push('Tracks:');
  sourceTracks.forEach((item, index) => {
    lines.push(`${index + 1}. "${item.track}" by ${item.artist}`);
  });

  lines.push('\n## Per-Track Theme Summary');
  trackThemes.forEach((entry, index) => {
    lines.push(`${index + 1}. "${entry.track}" by ${entry.artist}: ${entry.themeSentence}`);
  });

  if (skippedTracks.length > 0) {
    lines.push('\n## Skipped Source Tracks');
    skippedTracks.forEach(item => lines.push(`- ${item}`));
  }

  return lines.join('\n');
}

function aggregateSimilarArtists(
  exploredTracks: Array<{ artist: string; similarArtists: SimilarArtist[] }>,
  limit = DEFAULT_SEED_ARTIST_LIMIT
): string[] {
  const artistStats = new Map<string, { count: number; totalMatch: number; artist: string }>();

  for (const explored of exploredTracks) {
    for (const similar of explored.similarArtists) {
      const key = similar.name.toLowerCase();
      const existing = artistStats.get(key);
      if (existing) {
        existing.count += 1;
        existing.totalMatch += similar.match;
      } else {
        artistStats.set(key, {
          count: 1,
          totalMatch: similar.match,
          artist: similar.name,
        });
      }
    }
  }

  const sourceArtistNames = new Set(exploredTracks.map(track => track.artist.toLowerCase()));

  return Array.from(artistStats.values())
    .filter(stat => !sourceArtistNames.has(stat.artist.toLowerCase()))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      const bAvg = b.totalMatch / b.count;
      const aAvg = a.totalMatch / a.count;
      if (bAvg !== aAvg) return bAvg - aAvg;
      return a.artist.localeCompare(b.artist);
    })
    .slice(0, limit)
    .map(stat => stat.artist);
}

export async function expandYoutubeMusicPlaylist(
  options: PlaylistExpandOptions
): Promise<PlaylistExpandResult> {
  const maxTracks = normalizeMaxTracks(options.maxTracks);
  const playlistData = await getPlaylistData(options.playlist);

  const sampleSize = maxTracks ?? DEFAULT_PLAYLIST_SAMPLE_SIZE;
  const sourceTracks = sampleTracksRandomly(playlistData.tracks, sampleSize);

  if (sourceTracks.length === 0) {
    throw new Error('No tracks found in the playlist');
  }

  const lastfmClient = new LastfmClient({ noCache: options.noCache ?? false });
  const exploredTracks: Array<{
    artist: string;
    track: string;
    exploreResponse: string;
    similarArtists: SimilarArtist[];
  }> = [];
  const skippedTracks: string[] = [];

  for (const sourceTrack of sourceTracks) {
    let resolvedArtist = sourceTrack.artist;

    try {
      const confidence = await checkArtistConfidence(sourceTrack.artist, lastfmClient, options.model);
      if (confidence.result.confidence === 'low') {
        skippedTracks.push(
          `"${sourceTrack.track}" by ${sourceTrack.artist} (artist unresolved: ${confidence.result.reasoning})`
        );
        continue;
      }
      resolvedArtist = confidence.result.resolvedName ?? sourceTrack.artist;
    } catch {
      resolvedArtist = sourceTrack.artist;
    }

    try {
      const exploreContext = await buildContext(lastfmClient, {
        type: 'explore',
        artist: resolvedArtist,
        track: sourceTrack.track,
      });

      const exploreResult = await runQuery(exploreContext, {
        model: options.model,
        expand: options.expand ?? false,
      });

      exploredTracks.push({
        artist: resolvedArtist,
        track: sourceTrack.track,
        exploreResponse: exploreResult.response,
        // Reuse similar artists already fetched by the explore context builder.
        similarArtists: exploreContext.similarArtists ?? [],
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      skippedTracks.push(
        `"${sourceTrack.track}" by ${sourceTrack.artist} (explore failed: ${errorMessage})`
      );
    }
  }

  if (exploredTracks.length === 0) {
    throw new Error('Unable to analyze playlist tracks. All tracks were skipped.');
  }

  const summary = await summarizePlaylistThemes(exploredTracks, options.model);
  const overallTheme = summary.result.overallTheme;
  const translation = await runThemeTranslation(overallTheme, options.model);
  const seedArtists = aggregateSimilarArtists(exploredTracks, DEFAULT_SEED_ARTIST_LIMIT);

  const themeContext = await buildContext(lastfmClient, {
    type: 'theme',
    theme: overallTheme,
    ...(seedArtists.length > 0 ? { seedArtists } : {}),
    translatedTags: translation.result.translatedTags,
    translateMetadata: {
      moodTerms: translation.result.moodTerms,
      genreHints: translation.result.genreHints,
    },
  });

  const sourceContext = buildSourcePlaylistContext(
    playlistData.title,
    sourceTracks,
    summary.result.trackThemes,
    skippedTracks
  );

  const mergedContext = {
    ...themeContext,
    contextText: `${themeContext.contextText}\n\n${sourceContext}`,
  };

  const expansion = await runQuery(mergedContext, {
    model: options.model,
    templatePath: options.templatePath ?? PLAYLIST_EXPAND_TEMPLATE_PATH,
    expand: options.expand ?? false,
  });

  return {
    playlistId: playlistData.playlistId,
    playlistTitle: playlistData.title,
    playlistTrackCount: playlistData.tracks.length,
    sourceTrackCount: sourceTracks.length,
    analyzedTrackCount: exploredTracks.length,
    skippedTracks,
    seedArtistsUsed: seedArtists,
    overallTheme,
    trackThemes: summary.result.trackThemes,
    response: expansion.response,
    systemPrompt: expansion.systemPrompt,
    userPrompt: expansion.userPrompt,
    model: expansion.model,
  };
}
