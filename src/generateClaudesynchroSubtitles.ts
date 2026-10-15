import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, openSync, readSync, closeSync } from 'fs';
import { basename, dirname, extname, join } from 'path';
import { ProcessingResult } from './helpers';

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
  status: 'synced' | 'low_confidence' | 'skipped' | 'error';
  message: string;
  output: string | null;
  confidence: number | null;
}

export async function generateClaudesynchroSubtitles(
  srtPath: string,
  videoPath: string,
  onLog?: (line: string) => void,
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
  if (existsSync(outputPath)) {
    return { success: true, message: `Skipping ${outputPath} - already processed`, skipped: true };
  }

  const timeout = parseInt(process.env.CLAUDESYNCHRO_TIMEOUT_MS || '10800000', 10);
  const args = ['sync', '--video', videoPath, '--subtitle', srtPath, '--output', outputPath, '--json'];
  console.log(
    `${new Date().toLocaleString()} Processing: claudesynchro ${args.map((a) => JSON.stringify(a)).join(' ')}`,
  );

  return new Promise((resolve) => {
    const child = spawn('claudesynchro', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let pending = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeout);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr = (stderr + text).slice(-20000);
      pending += text;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      lines.filter((line) => line.trim()).forEach((line) => onLog?.(line));
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ success: false, message: `Could not start claudesynchro: ${error.message}`, stderr });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({ success: false, message: `Timeout: claudesynchro took longer than ${timeout / 60000} min`, stderr });
        return;
      }
      const lastLine = stdout.trim().split('\n').pop() || '';
      let parsed: ClaudesynchroJson | null = null;
      try {
        parsed = JSON.parse(lastLine) as ClaudesynchroJson;
      } catch {
        parsed = null;
      }
      const message = parsed?.message || `claudesynchro exited with code ${code}`;
      if (code === 0 && parsed?.status === 'synced') {
        resolve({ success: true, message, stdout: lastLine });
      } else if (code === 3 || parsed?.status === 'skipped') {
        resolve({ success: true, skipped: true, message: `Skipped: ${message}` });
      } else {
        resolve({ success: false, message, stdout: lastLine || undefined, stderr: stderr || undefined });
      }
    });
  });
}
