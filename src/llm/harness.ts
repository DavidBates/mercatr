import { loadTemplate, defaultTemplatePath, interpolate } from './templates.js';
import { logResponse } from './logger.js';
import { generateText, resolveLlmSettings } from './provider.js';
import type { BuiltContext } from '../context/types.js';
import type { PreflightEntry } from './logger.js';

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
      return query.seedArtists && query.seedArtists.length > 0
        ? `Build a thematic playlist around "${query.theme}", grounded in the worlds of ${query.seedArtists.join(', ')}`
        : `Build a thematic playlist around "${query.theme}"`;
  }
}

export async function runQuery(
  context: BuiltContext,
  options: HarnessOptions = {}
): Promise<HarnessResult> {
  const { model } = resolveLlmSettings({ model: options.model, usage: 'main' });
  const expand = options.expand ?? false;
  const templatePath = options.templatePath ?? defaultTemplatePath(context.queryType);
  const template = loadTemplate(templatePath);

  const queryString = buildQueryString(context);
  const vars = {
    context: context.contextText,
    query: queryString,
    diversityBlock: expand ? template.diversityExpand : template.diversityBaseline,
    expandModeRequirement: expand ? EXPAND_MODE_REQUIREMENT : '',
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

  const llmResult = await generateText({
    model,
    usage: 'main',
    maxTokens: DEFAULT_MAX_TOKENS,
    systemPrompt,
    userPrompt,
  });
  const response = llmResult.text;

  logResponse({
    timestamp: new Date().toISOString(),
    queryType: context.queryType,
    expandMode: expand,
    templatePath,
    model: llmResult.model,
    systemPrompt,
    userPrompt,
    response,
    ...(options.preflight ? { preflight: options.preflight } : {}),
  });

  return { response, systemPrompt, userPrompt, model: llmResult.model, dryRun: false };
}
