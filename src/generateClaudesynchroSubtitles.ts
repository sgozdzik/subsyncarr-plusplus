import { createHash } from 'crypto';
import { existsSync, openSync, readSync, closeSync } from 'fs';
import { basename, dirname, extname, join } from 'path';
import { EngineOptions, ProcessingResult, runProcess } from './helpers';

// Language tags as they appear in subtitle file names (Plex/Jellyfin/Bazarr conventions).
const LANGUAGE_GROUPS: [string, string[]][] = [
  ['pl', ['pl', 'pol', 'polish', 'polski']],
  ['en', ['en', 'eng', 'english']],
  ['de', ['de', 'ger', 'deu', 'german']],
  ['fr', ['fr', 'fre', 'fra', 'french']],
  ['es', ['es', 'spa', 'spanish']],
  ['it', ['it', 'ita', 'italian']],
  ['cs', ['cs', 'cze', 'ces', 'czech']],
  ['sk', ['sk', 'slo', 'slk']],
  ['ru', ['ru', 'rus', 'russian']],
  ['uk', ['uk', 'ukr']],
  ['pt', ['pt', 'por']],
  ['nl', ['nl', 'dut', 'nld']],
  ['sv', ['sv', 'swe']],
  ['no', ['no', 'nor', 'nob']],
  ['da', ['da', 'dan']],
  ['fi', ['fi', 'fin']],
  ['hu', ['hu', 'hun']],
  ['ro', ['ro', 'rum', 'ron']],
  ['tr', ['tr', 'tur']],
  ['el', ['el', 'gre', 'ell']],
  ['ja', ['ja', 'jpn']],
  ['ko', ['ko', 'kor']],
  ['zh', ['zh', 'chi', 'zho']],
];
const LANGUAGE_TAGS = new Map(LANGUAGE_GROUPS.flatMap(([lang, tags]) => tags.map((tag) => [tag, lang] as const)));

const TEXT_SUBTITLE_PATTERNS = [
  /^\{\d+\}\{\d*\}/m, // MicroDVD
  /^\[\d+\]\[\d*\]/m, // MPL2
  /^\d{1,2}:\d{2}:\d{2}[:=]/m, // TMPlayer
  /\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->/, // SubRip
];

export function claudesynchroLanguages(): string[] {
  return (process.env.CLAUDESYNCHRO_LANGUAGES || 'pl')
    .split(',')
    .map((lang) => lang.trim().toLowerCase())
    .filter(Boolean);
}

/** Language tag in a subtitle file name, e.g. "Movie (2024).pl.srt" -> "pl". */
export function subtitleLanguageTag(subtitlePath: string, videoPath: string): string | null {
  const videoStem = basename(videoPath, extname(videoPath));
  let stem = basename(subtitlePath, extname(subtitlePath));
  if (stem.startsWith(videoStem)) {
    stem = stem.slice(videoStem.length);
  }
  const tokens = stem
    .split(/[.\s_[\]()-]+/)
    .filter(Boolean)
    .reverse();
  for (const token of tokens) {
    const lang = LANGUAGE_TAGS.get(token.toLowerCase());
    if (lang) {
      return lang;
    }
  }
  return null;
}

export function claudesynchroOutputPath(subtitlePath: string, videoPath: string): string {
  const stem = basename(subtitlePath, extname(subtitlePath));
  const tagged = subtitleLanguageTag(subtitlePath, videoPath) !== null;
  const lang = claudesynchroLanguages()[0] || 'pl';
  return join(dirname(subtitlePath), tagged ? `${stem}.claudesynchro.srt` : `${stem}.${lang}.claudesynchro.srt`);
}

/** Napiprojekt-style .txt subtitles (MicroDVD / MPL2 / TMPlayer) are common for Polish. */
export function looksLikeSubtitleText(filePath: string): boolean {
  let fd: number | null = null;
  try {
    fd = openSync(filePath, 'r');
    const buffer = Buffer.alloc(4096);
    const bytes = readSync(fd, buffer, 0, buffer.length, 0);
    const head = buffer.subarray(0, bytes).toString('latin1');
    return TEXT_SUBTITLE_PATTERNS.some((pattern) => pattern.test(head));
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      closeSync(fd);
    }
  }
}

export function claudesynchroReportPath(subtitlePath: string): string {
  const dataDir = process.env.CLAUDESYNCHRO_DATA_DIR || '/app/data/claudesynchro';
  const name = createHash('sha1').update(subtitlePath, 'utf8').digest('hex').slice(0, 16);
  return join(dataDir, 'reports', `${name}.json`);
}

interface ClaudesynchroJson {
  status: 'synced' | 'low_confidence' | 'skipped' | 'setup_error' | 'error';
  message: string;
  output: string | null;
  confidence: number | null;
}

export async function generateClaudesynchroSubtitles(
  srtPath: string,
  videoPath: string,
  options: EngineOptions,
): Promise<ProcessingResult> {
  const lang = subtitleLanguageTag(srtPath, videoPath);
  const languages = claudesynchroLanguages();
  if (lang !== null && !languages.includes(lang)) {
    return {
      success: true,
      skipped: true,
      message: `Skipping ${basename(srtPath)} - language "${lang}" is not in CLAUDESYNCHRO_LANGUAGES (${languages.join(',')})`,
    };
  }

  const outputPath = claudesynchroOutputPath(srtPath, videoPath);
  if (!options.force && existsSync(outputPath)) {
    return { success: true, message: `Skipping ${outputPath} - already processed`, skipped: true };
  }

  const args = ['sync', '--video', videoPath, '--subtitle', srtPath, '--output', outputPath, '--json'];
  console.log(
    `${new Date().toLocaleString()} Processing: claudesynchro ${args.map((a) => JSON.stringify(a)).join(' ')}`,
  );
  const outcome = await runProcess('claudesynchro', args, options);
  const stderr = outcome.stderr || undefined;

  if (outcome.cancelled) {
    return { success: false, cancelled: true, message: 'Cancelled: claudesynchro', stderr };
  }
  if (outcome.timedOut) {
    return {
      success: false,
      message: `Timeout: claudesynchro took longer than ${Math.round(options.timeoutMs / 60000)} min`,
      stderr,
    };
  }
  if (outcome.error) {
    return { success: false, message: `Could not start claudesynchro: ${outcome.error.message}`, stderr };
  }

  const lastLine = outcome.stdout.trim().split('\n').pop() || '';
  let parsed: ClaudesynchroJson | null = null;
  try {
    parsed = JSON.parse(lastLine) as ClaudesynchroJson;
  } catch {
    parsed = null;
  }
  const message = parsed?.message || `claudesynchro exited with code ${outcome.code}`;
  if (outcome.code === 0 && parsed?.status === 'synced') {
    return { success: true, message, stdout: lastLine };
  }
  if (outcome.code === 3 || parsed?.status === 'skipped') {
    return { success: true, skipped: true, message: `Skipped: ${message}` };
  }
  if (outcome.code === 4 || parsed?.status === 'setup_error') {
    return { success: false, setupError: true, message, stdout: lastLine || undefined, stderr };
  }
  return { success: false, message, stdout: lastLine || undefined, stderr };
}
