import path from 'path';
import { fileURLToPath } from 'url';
import { loadTemplate, interpolate } from './templates.js';
import { generateText } from './provider.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PLAYLIST_THEME_SUMMARY_TEMPLATE_PATH = path.resolve(
  __dirname,
  '../../prompts/playlist-theme-summary.md'
);

export interface PlaylistThemeSummaryInput {
  artist: string;
  track: string;
  exploreResponse: string;
}

export interface TrackThemeSummary {
  artist: string;
  track: string;
  themeSentence: string;
}

export interface PlaylistThemeSummaryResult {
  trackThemes: TrackThemeSummary[];
  overallTheme: string;
}

function stripCodeFence(text: string): string {
  return text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
}

function validateSummary(
  data: unknown,
  expectedCount: number
): PlaylistThemeSummaryResult {
  if (!data || typeof data !== 'object') {
    throw new Error('playlist-theme-summary response is not an object');
  }

  const trackThemes = (data as { trackThemes?: unknown }).trackThemes;
  const overallTheme = (data as { overallTheme?: unknown }).overallTheme;

  if (!Array.isArray(trackThemes)) {
    throw new Error('playlist-theme-summary response is missing trackThemes array');
  }
  if (typeof overallTheme !== 'string' || overallTheme.trim() === '') {
    throw new Error('playlist-theme-summary response is missing overallTheme');
  }
  if (trackThemes.length !== expectedCount) {
    throw new Error(
      `playlist-theme-summary returned ${trackThemes.length} track themes, expected ${expectedCount}`
    );
  }

  const normalizedTrackThemes = trackThemes.map((item, index) => {
    if (!item || typeof item !== 'object') {
      throw new Error(`playlist-theme-summary entry ${index + 1} is invalid`);
    }

    const artist = (item as { artist?: unknown }).artist;
    const track = (item as { track?: unknown }).track;
    const themeSentence = (item as { themeSentence?: unknown }).themeSentence;

    if (typeof artist !== 'string' || artist.trim() === '') {
      throw new Error(`playlist-theme-summary entry ${index + 1} is missing artist`);
    }
    if (typeof track !== 'string' || track.trim() === '') {
      throw new Error(`playlist-theme-summary entry ${index + 1} is missing track`);
    }
    if (typeof themeSentence !== 'string' || themeSentence.trim() === '') {
      throw new Error(`playlist-theme-summary entry ${index + 1} is missing themeSentence`);
    }

    return {
      artist: artist.trim(),
      track: track.trim(),
      themeSentence: themeSentence.trim(),
    };
  });

  return {
    trackThemes: normalizedTrackThemes,
    overallTheme: overallTheme.trim(),
  };
}

export async function summarizePlaylistThemes(
  inputs: PlaylistThemeSummaryInput[],
  model?: string
): Promise<{ result: PlaylistThemeSummaryResult }> {
  if (inputs.length === 0) {
    throw new Error('No playlist analyses provided for theme summary');
  }

  const template = loadTemplate(PLAYLIST_THEME_SUMMARY_TEMPLATE_PATH);
  const userPrompt = interpolate(template.user, {
    entriesJson: JSON.stringify(inputs, null, 2),
  });

  const completion = await generateText({
    model,
    usage: 'main',
    maxTokens: 2048,
    systemPrompt: template.system,
    userPrompt,
  });

  const rawText = stripCodeFence(completion.text);

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new Error(`Failed to parse playlist theme summary response: ${completion.text}`);
  }

  return {
    result: validateSummary(parsed, inputs.length),
  };
}
