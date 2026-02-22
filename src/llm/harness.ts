import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';
import { loadTemplate, defaultTemplatePath, interpolate } from './templates.js';
import { logResponse } from './logger.js';
import type { BuiltContext } from '../context/types.js';
import type { PreflightEntry } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const VOICES_DIR = path.resolve(__dirname, '../../prompts/voices');

function buildVoiceBlock(voiceId?: string): string {
  if (!voiceId) return '';
  const contents = fs.readFileSync(path.join(VOICES_DIR, `${voiceId}.md`), 'utf-8').trim();
  return `\n\n## Voice\n\n${contents}`;
}

const DEFAULT_MODEL = 'claude-sonnet-4-20250514';
const DEFAULT_MAX_TOKENS = 4096;

const EXPAND_MODE_REQUIREMENT =
  '\n- **Expanded mode is active**: Treat genre and decade diversity as a hard ' +
  'requirement, not a preference. If a selection is from indie, alternative, ' +
  'or mainstream hip-hop, it must earn its place against stronger competition ' +
  'from underrepresented genres.';

export interface HarnessOptions {
  model?: string;
  templatePath?: string;
  dryRun?: boolean;
  expand?: boolean;
  preflight?: PreflightEntry[];
  voice?: string;
}

export interface HarnessResult {
  response: string;
  systemPrompt: string;
  userPrompt: string;
  model: string;
  dryRun: boolean;
}

function buildQueryString(context: BuiltContext): string {
  const { query } = context;
  switch (query.type) {
    case 'explore':
      return query.track
        ? `Explore the song "${query.track}" by ${query.artist}`
        : `Explore the artist ${query.artist}`;
    case 'bridge':
      return `Find thematic bridges between ${query.fromArtist} and ${query.toArtist}`;
    case 'theme':
      return query.seedArtist
        ? `Build a thematic playlist around "${query.theme}", grounded in the world of ${query.seedArtist}`
        : `Build a thematic playlist around "${query.theme}"`;
  }
}

export async function runQuery(
  context: BuiltContext,
  options: HarnessOptions = {}
): Promise<HarnessResult> {
  const model = options.model ?? process.env.ANTHROPIC_MODEL ?? DEFAULT_MODEL;
  const expand = options.expand ?? false;
  const templatePath = options.templatePath ?? defaultTemplatePath(context.queryType);
  const template = loadTemplate(templatePath);

  const queryString = buildQueryString(context);
  const vars = {
    context: context.contextText,
    query: queryString,
    diversityBlock: expand ? template.diversityExpand : template.diversityBaseline,
    expandModeRequirement: expand ? EXPAND_MODE_REQUIREMENT : '',
    voiceBlock: buildVoiceBlock(options.voice),
  };

  const systemPrompt = interpolate(template.system, vars);
  const userPrompt = interpolate(template.user, vars);

  if (options.dryRun) {
    return {
      response: '',
      systemPrompt,
      userPrompt,
      model,
      dryRun: true,
    };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY environment variable is not set');

  const client = new Anthropic({ apiKey });

  const message = await client.messages.create({
    model,
    max_tokens: DEFAULT_MAX_TOKENS,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const response = message.content
    .filter(block => block.type === 'text')
    .map(block => (block as { type: 'text'; text: string }).text)
    .join('\n');

  logResponse({
    timestamp: new Date().toISOString(),
    queryType: context.queryType,
    expandMode: expand,
    voice: options.voice ?? null,
    templatePath,
    model,
    systemPrompt,
    userPrompt,
    response,
    ...(options.preflight ? { preflight: options.preflight } : {}),
  });

  return { response, systemPrompt, userPrompt, model, dryRun: false };
}
