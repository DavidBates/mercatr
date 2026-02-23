import 'dotenv/config';
import readline from 'readline';
import { Command } from 'commander';
import { LastfmClient } from './lastfm/client.js';
import { buildContext } from './context/builder.js';
import { runQuery } from './llm/harness.js';
import { checkArtistConfidence, CONFIDENCE_TEMPLATE_PATH } from './llm/artistConfidence.js';
import { runThemeTranslation, THEME_TRANSLATE_TEMPLATE_PATH } from './llm/themeTranslate.js';
import { logResponse } from './llm/logger.js';
import { extractTracks } from './llm/trackExtract.js';
import { writeXspf } from './export/xspf.js';
import { expandYoutubeMusicPlaylist, PLAYLIST_EXPAND_TEMPLATE_PATH } from './playlist/expander.js';
import type { PreflightEntry } from './llm/logger.js';
import type { PreflightEntry as ArtistPreflightEntry, ConfidenceResult } from './llm/artistConfidence.js';
import type { ThemeTranslateEntry } from './llm/themeTranslate.js';
import type { ThemeQuery } from './context/types.js';

const program = new Command();

program
  .name('mercatr')
  .description('Thematic music playlist generator')
  .version('0.1.0');

function collectSeedArtist(value: string, previous?: string[]): string[] {
  return [...(previous ?? []), value];
}

function normalizeSeedArtists(options: Record<string, unknown>): string[] | undefined {
  const fromRepeated = Array.isArray(options.seedArtist)
    ? options.seedArtist
    : (typeof options.seedArtist === 'string' ? [options.seedArtist] : []);
  const fromVariadic = Array.isArray(options.seedArtists)
    ? options.seedArtists
    : (typeof options.seedArtists === 'string' ? [options.seedArtists] : []);

  const normalized = [...fromRepeated, ...fromVariadic]
    .map(value => String(value).trim())
    .filter(value => value.length > 0);

  if (normalized.length === 0) return undefined;
  return [...new Set(normalized)];
}

// Shared flags
function addSharedFlags(cmd: Command): Command {
  return cmd
    .option('--verbose', 'Print assembled Last.fm context to stderr')
    .option('--dry-run', 'Print full prompt without calling the LLM')
    .option('--no-cache', 'Bypass Last.fm cache for this run')
    .option('--model <model>', 'Override the LLM model')
    .option('--template <path>', 'Override the prompt template file path')
    .option('--expand', 'Use expanded genre diversity mode')
    .option('--export [path]', 'Export playlist as XSPF file (optional path, defaults to playlist-{timestamp}.xspf)');
}

// explore command
const exploreCmd = addSharedFlags(
  program
    .command('explore')
    .description('Explore an artist or song thematically')
    .requiredOption('--artist <artist>', 'Artist name')
    .option('--track <track>', 'Track name (optional)')
);

exploreCmd.action(async (options) => {
  await run(options, {
    type: 'explore',
    artist: options.artist,
    track: options.track,
  });
});

// bridge command
const bridgeCmd = addSharedFlags(
  program
    .command('bridge')
    .description('Find thematic connections between two artists')
    .requiredOption('--from <artist>', 'First artist')
    .requiredOption('--to <artist>', 'Second artist')
);

bridgeCmd.action(async (options) => {
  await run(options, {
    type: 'bridge',
    fromArtist: options.from,
    toArtist: options.to,
  });
});

// theme command
const themeCmd = addSharedFlags(
  program
    .command('theme')
    .description('Build a thematic playlist around a theme or mood')
    .requiredOption('--theme <theme>', 'Theme or mood')
    .option(
      '--seed-artist <artist>',
      'Optional seed artist (repeat to provide multiple artists)',
      collectSeedArtist
    )
    .option('--seed-artists <artists...>', 'Optional seed artists list')
);

themeCmd.action(async (options) => {
  const seedArtists = normalizeSeedArtists(options as Record<string, unknown>);
  await run(options, {
    type: 'theme',
    theme: options.theme,
    ...(seedArtists ? { seedArtists } : {}),
  });
});

const playlistExpandCmd = program
  .command('playlist-expand')
  .description('Expand a YouTube Music playlist with five new thematic recommendations')
  .requiredOption('--playlist <url-or-id>', 'YouTube Music playlist URL or playlist ID')
  .option('--verbose', 'Print per-track thematic summaries to stderr')
  .option('--no-cache', 'Bypass Last.fm cache for this run')
  .option('--model <model>', 'Override the LLM model')
  .option('--template <path>', 'Override the playlist expansion prompt template file path')
  .option('--expand', 'Use expanded genre diversity mode')
  .option('--max-tracks <count>', 'Random sample size (default: 5 tracks)', (value: string) => {
    const parsed = parseInt(value, 10);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error('--max-tracks must be a positive integer');
    }
    return parsed;
  })
  .option('--export [path]', 'Export playlist expansion as an XSPF file');

playlistExpandCmd.action(async (options) => {
  await runPlaylistExpand(options);
});

type QueryInput =
  | { type: 'explore'; artist: string; track?: string }
  | { type: 'bridge'; fromArtist: string; toArtist: string }
  | { type: 'theme'; theme: string; seedArtists?: string[] };

async function runPlaylistExpand(options: Record<string, unknown>): Promise<void> {
  try {
    const noCache = options.cache === false || options['no-cache'] === true;
    const model = options.model as string | undefined;

    process.stderr.write('Fetching and analyzing YouTube Music playlist...\n');

    const result = await expandYoutubeMusicPlaylist({
      playlist: options.playlist as string,
      model,
      templatePath: (options.template as string | undefined) ?? PLAYLIST_EXPAND_TEMPLATE_PATH,
      noCache,
      expand: Boolean(options.expand),
      maxTracks: options.maxTracks as number | undefined,
    });

    process.stderr.write(
      `Analyzed ${result.analyzedTrackCount}/${result.sourceTrackCount} playlist tracks\n`
    );
    if (result.skippedTracks.length > 0) {
      process.stderr.write(`Skipped ${result.skippedTracks.length} track(s)\n`);
    }

    if (options.verbose) {
      process.stderr.write('\n--- Per-Track Themes ---\n');
      result.trackThemes.forEach((entry, index) => {
        process.stderr.write(
          `${index + 1}. "${entry.track}" by ${entry.artist}: ${entry.themeSentence}\n`
        );
      });
      process.stderr.write('--- End Per-Track Themes ---\n\n');
    }

    process.stdout.write(`# Playlist Expansion: ${result.playlistTitle}\n`);
    process.stdout.write(`Derived theme: ${result.overallTheme}\n\n`);
    if (result.seedArtistsUsed.length > 0) {
      process.stderr.write(`Using similar artists as seeds: ${result.seedArtistsUsed.join(', ')}\n`);
    }
    process.stdout.write(result.response + '\n');

    if (options.export) {
      process.stderr.write('Extracting track list...\n');
      const tracks = await extractTracks(result.response, model);

      const exportPath = typeof options.export === 'string'
        ? options.export
        : `playlist-expand-${Date.now()}.xspf`;

      writeXspf(tracks, exportPath, {
        title: `Playlist Expansion: ${result.playlistTitle}`,
        description: 'Generated by mercatr playlist-expand',
      });
      process.stderr.write(`Exported ${tracks.length} tracks to ${exportPath}\n`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${message}\n`);
    process.exit(1);
  }
}

function askUser(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

interface ResolvedArtist {
  originalName: string;
  resolvedName: string;
  preflightEntry: ArtistPreflightEntry;
  halted: boolean;
}

async function resolveArtist(
  artistName: string,
  client: LastfmClient,
  queryType: string,
  model?: string
): Promise<ResolvedArtist> {
  process.stderr.write(`Checking artist: "${artistName}"...\n`);

  const { result, lastfmDataPresent } = await checkArtistConfidence(artistName, client, model);

  const baseEntry: Omit<ArtistPreflightEntry, 'userConfirmed' | 'resolvedTo'> = {
    step: 'artist-confidence',
    templatePath: CONFIDENCE_TEMPLATE_PATH,
    input: { artistName, lastfmDataPresent },
    output: result,
  };

  if (result.confidence === 'high') {
    const resolved = result.resolvedName ?? artistName;
    return {
      originalName: artistName,
      resolvedName: resolved,
      preflightEntry: { ...baseEntry, resolvedTo: resolved },
      halted: false,
    };
  }

  if (result.confidence === 'medium') {
    const suggestions = result.alternativeSuggestions.length > 0
      ? result.alternativeSuggestions
      : (result.resolvedName ? [result.resolvedName] : []);
    const suggestion = suggestions[0] ?? result.resolvedName ?? artistName;

    process.stderr.write(`\n⚠  Artist not found: "${artistName}"\n`);
    if (suggestion) {
      process.stderr.write(`   Did you mean: ${suggestion}?\n`);
    }

    const answer = await askUser(`   Proceed with ${suggestion}? (y/n) `);

    if (answer === 'y' || answer === 'yes') {
      return {
        originalName: artistName,
        resolvedName: suggestion,
        preflightEntry: { ...baseEntry, userConfirmed: true, resolvedTo: suggestion },
        halted: false,
      };
    } else {
      return {
        originalName: artistName,
        resolvedName: artistName,
        preflightEntry: { ...baseEntry, userConfirmed: false },
        halted: true,
      };
    }
  }

  // low confidence
  process.stderr.write(`\n✗  Unknown artist: "${artistName}"\n`);
  process.stderr.write(`   ${result.reasoning}\n`);
  if (result.alternativeSuggestions.length > 0) {
    process.stderr.write(`   Did you mean: ${result.alternativeSuggestions.join(', ')}?\n`);
  }

  return {
    originalName: artistName,
    resolvedName: artistName,
    preflightEntry: { ...baseEntry },
    halted: true,
  };
}

async function run(options: Record<string, unknown>, queryInput: QueryInput): Promise<void> {
  try {
    const noCache = options.cache === false || options['no-cache'] === true;
    const client = new LastfmClient({ noCache });
    const model = options.model as string | undefined;

    // --- Artist confidence preflight ---
    const preflight: PreflightEntry[] = [];
    const mutableQuery = { ...queryInput } as QueryInput;

    if (mutableQuery.type === 'explore') {
      const resolved = await resolveArtist(mutableQuery.artist, client, mutableQuery.type, model);
      preflight.push(resolved.preflightEntry);
      if (resolved.halted) {
        logResponse({ timestamp: new Date().toISOString(), queryType: mutableQuery.type, preflight, halted: true });
        process.exit(1);
      }
      (mutableQuery as { type: 'explore'; artist: string; track?: string }).artist = resolved.resolvedName;
    }

    if (mutableQuery.type === 'bridge') {
      const [fromResolved, toResolved] = await Promise.all([
        resolveArtist(mutableQuery.fromArtist, client, mutableQuery.type, model),
        resolveArtist(mutableQuery.toArtist, client, mutableQuery.type, model),
      ]);
      preflight.push(fromResolved.preflightEntry, toResolved.preflightEntry);
      if (fromResolved.halted || toResolved.halted) {
        logResponse({ timestamp: new Date().toISOString(), queryType: mutableQuery.type, preflight, halted: true });
        process.exit(1);
      }
      (mutableQuery as { type: 'bridge'; fromArtist: string; toArtist: string }).fromArtist = fromResolved.resolvedName;
      (mutableQuery as { type: 'bridge'; fromArtist: string; toArtist: string }).toArtist = toResolved.resolvedName;
    }

    if (mutableQuery.type === 'theme' && mutableQuery.seedArtists && mutableQuery.seedArtists.length > 0) {
      const resolvedSeedArtists = await Promise.all(
        mutableQuery.seedArtists.map(seedArtist =>
          resolveArtist(seedArtist, client, mutableQuery.type, model)
        )
      );
      preflight.push(...resolvedSeedArtists.map(entry => entry.preflightEntry));

      if (resolvedSeedArtists.some(entry => entry.halted)) {
        logResponse({ timestamp: new Date().toISOString(), queryType: mutableQuery.type, preflight, halted: true });
        process.exit(1);
      }

      (mutableQuery as { type: 'theme'; theme: string; seedArtists?: string[] }).seedArtists = resolvedSeedArtists
        .map(entry => entry.resolvedName);
    }

    // --- Theme-translate preflight ---
    let pendingTranslateEntry: Omit<ThemeTranslateEntry, 'lastfmResultsReturned'> | null = null;

    if (mutableQuery.type === 'theme') {
      process.stderr.write(`Translating theme to folksonomy tags...\n`);
      const translation = await runThemeTranslation(mutableQuery.theme, model);
      (mutableQuery as ThemeQuery).translatedTags = translation.result.translatedTags;
      (mutableQuery as ThemeQuery).translateMetadata = {
        moodTerms: translation.result.moodTerms,
        genreHints: translation.result.genreHints,
      };
      pendingTranslateEntry = {
        step: 'theme-translate',
        templatePath: THEME_TRANSLATE_TEMPLATE_PATH,
        input: { theme: mutableQuery.theme },
        output: translation.result,
        lastfmTagsQueried: translation.result.translatedTags,
      };
    }

    // --- Main pipeline ---
    process.stderr.write(`Gathering Last.fm data...\n`);

    const context = await buildContext(client, mutableQuery);

    if (pendingTranslateEntry !== null) {
      preflight.push({
        ...pendingTranslateEntry,
        lastfmResultsReturned: context.translationResultCount ?? 0,
      });
    }

    process.stderr.write(`Last.fm summary: ${context.summary}\n`);

    if (options.verbose) {
      process.stderr.write('\n--- Assembled Context ---\n');
      process.stderr.write(context.contextText + '\n');
      process.stderr.write('--- End Context ---\n\n');
    }

    const result = await runQuery(context, {
      model,
      templatePath: options.template as string | undefined,
      dryRun: Boolean(options.dryRun),
      expand: Boolean(options.expand),
      preflight: preflight.length > 0 ? preflight : undefined,
    });

    if (result.dryRun) {
      process.stdout.write('--- SYSTEM PROMPT ---\n');
      process.stdout.write(result.systemPrompt + '\n\n');
      process.stdout.write('--- USER PROMPT ---\n');
      process.stdout.write(result.userPrompt + '\n');
    } else {
      process.stdout.write(result.response + '\n');

      if (options.export) {
        process.stderr.write('Extracting track list...\n');
        const tracks = await extractTracks(result.response, model);

        const exportPath = typeof options.export === 'string'
          ? options.export
          : `playlist-${Date.now()}.xspf`;

        let title: string;
        switch (mutableQuery.type) {
          case 'explore':
            title = mutableQuery.track
              ? `Exploring ${mutableQuery.track} by ${mutableQuery.artist}`
              : `Exploring ${mutableQuery.artist}`;
            break;
          case 'bridge':
            title = `Bridge: ${mutableQuery.fromArtist} → ${mutableQuery.toArtist}`;
            break;
          case 'theme':
            title = mutableQuery.seedArtists && mutableQuery.seedArtists.length > 0
              ? `Theme: ${mutableQuery.theme} (seeded by ${mutableQuery.seedArtists.join(', ')})`
              : `Theme: ${mutableQuery.theme}`;
            break;
        }

        writeXspf(tracks, exportPath, { title, description: 'Generated by mercatr' });
        process.stderr.write(`Exported ${tracks.length} tracks to ${exportPath}\n`);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${message}\n`);
    process.exit(1);
  }
}

program.parseAsync(process.argv).catch(err => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
