import { readdir } from 'fs/promises';
import { extname, join } from 'path';
import { ScanConfig } from './config';
import { getEnabledEngines } from './engines';
import { looksLikeSubtitleText } from './generateClaudesynchroSubtitles';

const ENGINE_OUTPUT_TAGS = ['.ffsubsync.', '.alass.', '.autosubsync.', '.claudesynchro.'];

export async function findAllSrtFiles(config: ScanConfig): Promise<string[]> {
  const files: string[] = [];
  // Napiprojekt-style .txt subtitles are only understood by claudesynchro.
  const includeTxt = getEnabledEngines().includes('claudesynchro');

  async function scan(directory: string): Promise<void> {
    // Check if this directory should be excluded
    if (config.excludePaths.some((excludePath) => directory.startsWith(excludePath))) {
      return;
    }

    const entries = await readdir(directory, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(directory, entry.name);

      if (entry.isDirectory()) {
        await scan(fullPath);
      } else if (entry.isFile() && !ENGINE_OUTPUT_TAGS.some((tag) => entry.name.includes(tag))) {
        const ext = extname(entry.name).toLowerCase();
        if (ext === '.srt' || (includeTxt && ext === '.txt' && looksLikeSubtitleText(fullPath))) {
          files.push(fullPath);
        }
      }
    }
  }

  // Scan all included paths
  for (const includePath of config.includePaths) {
    await scan(includePath);
  }

  return files;
}
