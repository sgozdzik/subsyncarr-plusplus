import { basename } from 'path';
import { findMatchingVideoFile } from './findMatchingVideoFile';
import { generateAutosubsyncSubtitles } from './generateAutosubsyncSubtitles';
import { generateFfsubsyncSubtitles } from './generateFfsubsyncSubtitles';
import { generateAlassSubtitles } from './generateAlassSubtitles';
import { generateClaudesynchroSubtitles } from './generateClaudesynchroSubtitles';
import { getEnabledEngines } from './engines';

// The one-shot CLI (dist/index.js) has no database; timeouts come from the environment.
const legacyOptions = (engine: string) => {
  const env = engine === 'claudesynchro' ? process.env.CLAUDESYNCHRO_TIMEOUT_MS : process.env.SYNC_ENGINE_TIMEOUT_MS;
  return { timeoutMs: parseInt(env || '', 10) || (engine === 'claudesynchro' ? 3600000 : 1800000) };
};

export const processSrtFile = async (srtFile: string) => {
  const videoFile = findMatchingVideoFile(srtFile);
  const includeEngines = getEnabledEngines();

  if (videoFile) {
    if (includeEngines.includes('ffsubsync')) {
      const startTime = Date.now();
      const ffsubsyncResult = await generateFfsubsyncSubtitles(srtFile, videoFile, legacyOptions('ffsubsync'));
      const duration = Date.now() - startTime;
      console.log(`${new Date().toLocaleString()} ffsubsync result: ${ffsubsyncResult.message} (${duration}ms)`);
    }
    if (includeEngines.includes('autosubsync')) {
      const startTime = Date.now();
      const autosubsyncResult = await generateAutosubsyncSubtitles(srtFile, videoFile, legacyOptions('autosubsync'));
      const duration = Date.now() - startTime;
      console.log(`${new Date().toLocaleString()} autosubsync result: ${autosubsyncResult.message} (${duration}ms)`);
    }
    if (includeEngines.includes('alass')) {
      const startTime = Date.now();
      const alassResult = await generateAlassSubtitles(srtFile, videoFile, legacyOptions('alass'));
      const duration = Date.now() - startTime;
      console.log(`${new Date().toLocaleString()} alass result: ${alassResult.message} (${duration}ms)`);
    }
    if (includeEngines.includes('claudesynchro')) {
      const startTime = Date.now();
      const result = await generateClaudesynchroSubtitles(srtFile, videoFile, legacyOptions('claudesynchro'));
      const duration = Date.now() - startTime;
      console.log(`${new Date().toLocaleString()} claudesynchro result: ${result.message} (${duration}ms)`);
    }
  } else {
    console.log(`${new Date().toLocaleString()} No matching video file found for: ${basename(srtFile)}`);
  }
};
