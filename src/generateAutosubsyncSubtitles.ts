import { basename, dirname, join } from 'path';
import { existsSync } from 'fs';
import { EngineOptions, ProcessingResult, runEngineCommand } from './helpers';

export function autosubsyncOutputPath(srtPath: string): string {
  return join(dirname(srtPath), `${basename(srtPath, '.srt')}.autosubsync.srt`);
}

export async function generateAutosubsyncSubtitles(
  srtPath: string,
  videoPath: string,
  options: EngineOptions,
): Promise<ProcessingResult> {
  const outputPath = autosubsyncOutputPath(srtPath);

  // Check if synced subtitle already exists
  if (!options.force && existsSync(outputPath)) {
    return {
      success: true,
      message: `Skipping ${outputPath} - already processed`,
      skipped: true,
    };
  }

  return runEngineCommand('autosubsync', 'autosubsync', [videoPath, srtPath, outputPath], outputPath, options);
}
