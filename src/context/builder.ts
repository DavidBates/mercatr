import type { LastfmClient } from '../lastfm/client.js';
import type { Tag, SimilarArtist, TagArtist, TagTrack } from '../lastfm/types.js';
import type { Query, BuiltContext } from './types.js';

const MIN_TAG_COUNT = parseInt(process.env.MIN_TAG_COUNT ?? '10', 10);

function normalizeTags(tags: Tag[]): Tag[] {
  return tags
    .map(t => ({ ...t, name: t.name.toLowerCase() }))
    .filter(t => t.count >= MIN_TAG_COUNT)
    .sort((a, b) => b.count - a.count);
}

function formatTags(tags: Tag[], max = 15): string {
  return normalizeTags(tags)
    .slice(0, max)
    .map(t => `${t.name} (${t.count})`)
    .join(', ');
}

function formatSimilarArtists(artists: SimilarArtist[], max = 10): string {
  return artists
    .slice(0, max)
    .map(a => `${a.name} (match: ${(a.match * 100).toFixed(0)}%)`)
    .join(', ');
}

function aggregateSeedTags(tagGroups: Tag[][]): Tag[] {
  const merged = new Map<string, Tag>();

  for (const tags of tagGroups) {
    for (const tag of tags) {
      const key = tag.name.trim().toLowerCase();
      if (!key) continue;
      const existing = merged.get(key);
      if (existing) {
        existing.count += tag.count;
      } else {
        merged.set(key, {
          name: key,
          count: tag.count,
          url: tag.url,
        });
      }
    }
  }

  return Array.from(merged.values()).sort((a, b) => b.count - a.count);
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

export async function buildContext(client: LastfmClient, query: Query): Promise<BuiltContext> {
  switch (query.type) {
    case 'explore':
      return buildExploreContext(client, query);
    case 'bridge':
      return buildBridgeContext(client, query);
    case 'theme':
      return buildThemeContext(client, query);
  }
}

async function buildExploreContext(
  client: LastfmClient,
  query: Extract<Query, { type: 'explore' }>
): Promise<BuiltContext> {
  const { artist, track } = query;

  const [artistTags, artistInfo, similarArtists] = await Promise.all([
    client.getArtistTopTags(artist),
    client.getArtistInfo(artist),
    client.getSimilarArtists(artist, 10).catch(() => [] as SimilarArtist[]),
  ]);

  let trackTags: Tag[] = [];
  if (track) {
    trackTags = await client.getTrackTopTags(artist, track);
  }

  // Fetch top tags for each similar artist
  const similarWithTags = await Promise.all(
    similarArtists.slice(0, 8).map(async a => {
      const tags = await client.getArtistTopTags(a.name);
      return { artist: a, tags };
    })
  );

  const lines: string[] = [];
  lines.push(`## Seed Artist: ${artist}`);
  lines.push(`Listeners: ${parseInt(artistInfo.stats.listeners).toLocaleString()}`);
  lines.push(`Top tags: ${formatTags(artistTags)}`);
  if (artistInfo.bio.summary) {
    lines.push(`Bio: ${stripHtml(artistInfo.bio.summary).slice(0, 400)}`);
  }

  if (track && trackTags.length > 0) {
    lines.push(`\n## Seed Track: "${track}" by ${artist}`);
    lines.push(`Track tags: ${formatTags(trackTags)}`);
  }

  lines.push(`\n## Similar Artists (Last.fm)`);
  similarWithTags.forEach(({ artist: a, tags }) => {
    lines.push(`- ${a.name} (match: ${(a.match * 100).toFixed(0)}%) — tags: ${formatTags(tags, 8)}`);
  });

  const summary = [
    `Artist tags: ${normalizeTags(artistTags).length}`,
    `Similar artists: ${similarArtists.length}`,
    track ? `Track tags: ${normalizeTags(trackTags).length}` : null,
  ].filter(Boolean).join(', ');

  return {
    queryType: 'explore',
    query,
    contextText: lines.join('\n'),
    summary,
    similarArtists,
  };
}

async function buildBridgeContext(
  client: LastfmClient,
  query: Extract<Query, { type: 'bridge' }>
): Promise<BuiltContext> {
  const { fromArtist, toArtist } = query;

  const [fromTags, fromInfo, fromSimilar, toTags, toInfo, toSimilar] = await Promise.all([
    client.getArtistTopTags(fromArtist),
    client.getArtistInfo(fromArtist),
    client.getSimilarArtists(fromArtist, 15),
    client.getArtistTopTags(toArtist),
    client.getArtistInfo(toArtist),
    client.getSimilarArtists(toArtist, 15),
  ]);

  const normalizedFrom = normalizeTags(fromTags).map(t => t.name);
  const normalizedTo = normalizeTags(toTags).map(t => t.name);
  const overlapping = normalizedFrom.filter(t => normalizedTo.includes(t));

  const lines: string[] = [];
  lines.push(`## Artist A: ${fromArtist}`);
  lines.push(`Top tags: ${formatTags(fromTags)}`);
  if (fromInfo.bio.summary) {
    lines.push(`Bio: ${stripHtml(fromInfo.bio.summary).slice(0, 300)}`);
  }
  lines.push(`Similar artists: ${formatSimilarArtists(fromSimilar, 8)}`);

  lines.push(`\n## Artist B: ${toArtist}`);
  lines.push(`Top tags: ${formatTags(toTags)}`);
  if (toInfo.bio.summary) {
    lines.push(`Bio: ${stripHtml(toInfo.bio.summary).slice(0, 300)}`);
  }
  lines.push(`Similar artists: ${formatSimilarArtists(toSimilar, 8)}`);

  if (overlapping.length > 0) {
    lines.push(`\n## Overlapping Tags`);
    lines.push(overlapping.join(', '));
  } else {
    lines.push(`\n## Overlapping Tags`);
    lines.push('(none — these artists share no common high-count tags)');
  }

  const summary = [
    `${fromArtist} tags: ${normalizedFrom.length}`,
    `${toArtist} tags: ${normalizedTo.length}`,
    `Overlapping tags: ${overlapping.length}`,
  ].join(', ');

  return {
    queryType: 'bridge',
    query,
    contextText: lines.join('\n'),
    summary,
  };
}

async function buildThemeContext(
  client: LastfmClient,
  query: Extract<Query, { type: 'theme' }>
): Promise<BuiltContext> {
  const { theme, seedArtists, translatedTags, translateMetadata } = query;

  const lines: string[] = [];
  lines.push(`## Theme: "${theme}"`);

  let topArtists: TagArtist[] = [];
  let topTracks: TagTrack[] = [];
  let translationResultCount: number | undefined;

  if (translatedTags && translatedTags.length > 0) {
    // Tag Translation section
    lines.push(`\n## Tag Translation`);
    lines.push(`The user's theme was translated into the following Last.fm search terms:`);
    lines.push(translatedTags.join(', '));
    lines.push(`\nLast.fm data below reflects results for these terms, not the original theme.`);

    // Query each translated tag in parallel, aggregate and deduplicate
    const tagResults = await Promise.all(
      translatedTags.map(tag => Promise.all([
        client.getTopArtistsForTag(tag, 20).catch(() => [] as TagArtist[]),
        client.getTopTracksForTag(tag, 20).catch(() => [] as TagTrack[]),
      ]))
    );

    const seenArtists = new Set<string>();
    const seenTracks = new Set<string>();

    for (const [artists, tracks] of tagResults) {
      for (const a of artists) {
        if (!seenArtists.has(a.name)) {
          seenArtists.add(a.name);
          topArtists.push(a);
        }
      }
      for (const t of tracks) {
        const key = `${t.name}::${t.artist.name}`;
        if (!seenTracks.has(key)) {
          seenTracks.add(key);
          topTracks.push(t);
        }
      }
    }

    translationResultCount = seenArtists.size + seenTracks.size;
  } else {
    // Fallback: use raw theme string
    const [tagInfo, artists, tracks] = await Promise.all([
      client.getTagInfo(theme).catch(() => null),
      client.getTopArtistsForTag(theme, 20),
      client.getTopTracksForTag(theme, 20),
    ]);

    topArtists = artists;
    topTracks = tracks;

    if (tagInfo) {
      lines.push(`Tag reach: ${tagInfo.reach?.toLocaleString() ?? 'unknown'} artists`);
      if (tagInfo.wiki?.summary) {
        lines.push(`Description: ${stripHtml(tagInfo.wiki.summary).slice(0, 300)}`);
      }
    }
  }

  // Get tags for top artists
  const artistsWithTags = await Promise.all(
    topArtists.slice(0, 10).map(async (a: TagArtist) => {
      const tags = await client.getArtistTopTags(a.name);
      return { artist: a, tags };
    })
  );

  const searchLabel = translatedTags && translatedTags.length > 0
    ? translatedTags.join(', ')
    : theme;

  lines.push(`\n## Top Artists Tagged "${searchLabel}"`);
  artistsWithTags.forEach(({ artist: a, tags }) => {
    lines.push(`- ${a.name} — genres/tags: ${formatTags(tags, 6)}`);
  });

  if (topArtists.length > 10) {
    lines.push(`(+ ${topArtists.length - 10} more: ${topArtists.slice(10).map((a: TagArtist) => a.name).join(', ')})`);
  }

  lines.push(`\n## Top Tracks Tagged "${searchLabel}"`);
  topTracks.slice(0, 15).forEach((t: TagTrack) => {
    lines.push(`- "${t.name}" by ${t.artist.name}`);
  });

  if (translateMetadata) {
    lines.push(`\n## Translation Metadata`);
    lines.push(`Mood terms: ${translateMetadata.moodTerms.join(', ')}`);
    lines.push(`Genre hints: ${translateMetadata.genreHints.join(', ')}`);
  }

  let seedContext = '';
  const normalizedSeedArtists = seedArtists?.filter(name => name.trim().length > 0) ?? [];
  if (normalizedSeedArtists.length > 0) {
    const seedData = await Promise.all(
      normalizedSeedArtists.map(async seedArtist => {
        const [tags, info] = await Promise.all([
          client.getArtistTopTags(seedArtist),
          client.getArtistInfo(seedArtist),
        ]);
        return { seedArtist, tags, info };
      })
    );

    if (seedData.length === 1) {
      const seed = seedData[0];
      seedContext = [
        `\n## Seed Artist: ${seed.seedArtist}`,
        `Tags: ${formatTags(seed.tags)}`,
        seed.info.bio.summary ? `Bio: ${stripHtml(seed.info.bio.summary).slice(0, 300)}` : '',
      ].filter(Boolean).join('\n');
    } else {
      const aggregatedTags = aggregateSeedTags(seedData.map(seed => seed.tags));
      const linesForSeedContext: string[] = [];
      linesForSeedContext.push(`\n## Seed Artists (${seedData.length})`);
      if (aggregatedTags.length > 0) {
        linesForSeedContext.push(`Aggregated tags: ${formatTags(aggregatedTags, 20)}`);
      }

      for (const seed of seedData) {
        linesForSeedContext.push(`\n### ${seed.seedArtist}`);
        linesForSeedContext.push(`Tags: ${formatTags(seed.tags)}`);
        if (seed.info.bio.summary) {
          linesForSeedContext.push(`Bio: ${stripHtml(seed.info.bio.summary).slice(0, 300)}`);
        }
      }

      seedContext = linesForSeedContext.join('\n');
    }
  }

  if (seedContext) {
    lines.push(seedContext);
  }

  const summary = [
    `Top artists for tag: ${topArtists.length}`,
    `Top tracks for tag: ${topTracks.length}`,
    normalizedSeedArtists.length > 0 ? `Seed artists: ${normalizedSeedArtists.length}` : null,
  ].filter(Boolean).join(', ');

  return {
    queryType: 'theme',
    query,
    contextText: lines.join('\n'),
    summary,
    translationResultCount,
  };
}
