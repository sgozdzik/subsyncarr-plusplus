import { basename, dirname, join } from 'path';
import { existsSync } from 'fs';
import { EngineOptions, ProcessingResult, runEngineCommand } from './helpers';

export function ffsubsyncOutputPath(srtPath: string): string {
  return join(dirname(srtPath), `${basename(srtPath, '.srt')}.ffsubsync.srt`);
}

export async function generateFfsubsyncSubtitles(
  srtPath: string,
  videoPath: string,
  options: EngineOptions,
): Promise<ProcessingResult> {
  const outputPath = ffsubsyncOutputPath(srtPath);

  // Check if synced subtitle already exists
  if (!options.force && existsSync(outputPath)) {
    return {
      success: true,
      message: `Skipping ${outputPath} - already processed`,
      skipped: true,
    };
  }

  return runEngineCommand('ffsubsync', 'ffsubsync', [videoPath, '-i', srtPath, '-o', outputPath], outputPath, options);
}
