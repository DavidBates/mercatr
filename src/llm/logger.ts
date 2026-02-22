import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { PreflightEntry as ArtistPreflightEntry } from './artistConfidence.js';
import type { ThemeTranslateEntry } from './themeTranslate.js';

export type PreflightEntry = ArtistPreflightEntry | ThemeTranslateEntry;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = path.resolve(__dirname, '../../logs');

export interface LogEntry {
  timestamp: string;
  queryType: string;
  expandMode?: boolean;
  voice?: string | null;
  templatePath?: string;
  model?: string;
  systemPrompt?: string;
  userPrompt?: string;
  response?: string;
  preflight?: PreflightEntry[];
  halted?: boolean;
  exportPath?: string;
}

export function logResponse(entry: LogEntry): void {
  fs.mkdirSync(LOGS_DIR, { recursive: true });

  const ts = entry.timestamp.replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const filename = `${ts}__${entry.queryType}.json`;
  const filepath = path.join(LOGS_DIR, filename);

  fs.writeFileSync(filepath, JSON.stringify(entry, null, 2));
}
