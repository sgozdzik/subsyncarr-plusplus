import { basename, dirname, join } from 'path';
import { existsSync } from 'fs';
import { EngineOptions, ProcessingResult, runEngineCommand } from './helpers';

export function alassOutputPath(srtPath: string): string {
  return join(dirname(srtPath), `${basename(srtPath, '.srt')}.alass.srt`);
}

export async function generateAlassSubtitles(
  srtPath: string,
  videoPath: string,
  options: EngineOptions,
): Promise<ProcessingResult> {
  const outputPath = alassOutputPath(srtPath);

  // Check if synced subtitle already exists
  if (!options.force && existsSync(outputPath)) {
    return {
      success: true,
      message: `Skipping ${outputPath} - already processed`,
      skipped: true,
    };
  }

  return runEngineCommand('alass', 'alass', [videoPath, srtPath, outputPath], outputPath, options);
}
