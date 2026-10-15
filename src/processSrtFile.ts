import { basename } from 'path';
import { findMatchingVideoFile } from './findMatchingVideoFile';
import { generateAutosubsyncSubtitles } from './generateAutosubsyncSubtitles';
import { generateFfsubsyncSubtitles } from './generateFfsubsyncSubtitles';
import { generateAlassSubtitles } from './generateAlassSubtitles';
import { generateClaudesynchroSubtitles } from './generateClaudesynchroSubtitles';
import { getEnabledEngines } from './engines';

export const processSrtFile = async (srtFile: string) => {
  const videoFile = findMatchingVideoFile(srtFile);
  const includeEngines = getEnabledEngines();

  if (videoFile) {
    if (includeEngines.includes('ffsubsync')) {
      const startTime = Date.now();
      const ffsubsyncResult = await generateFfsubsyncSubtitles(srtFile, videoFile);
      const duration = Date.now() - startTime;
      console.log(`${new Date().toLocaleString()} ffsubsync result: ${ffsubsyncResult.message} (${duration}ms)`);
    }
    if (includeEngines.includes('autosubsync')) {
      const startTime = Date.now();
      const autosubsyncResult = await generateAutosubsyncSubtitles(srtFile, videoFile);
      const duration = Date.now() - startTime;
      console.log(`${new Date().toLocaleString()} autosubsync result: ${autosubsyncResult.message} (${duration}ms)`);
    }
    if (includeEngines.includes('alass')) {
      const startTime = Date.now();
      const alassResult = await generateAlassSubtitles(srtFile, videoFile);
      const duration = Date.now() - startTime;
      console.log(`${new Date().toLocaleString()} alass result: ${alassResult.message} (${duration}ms)`);
    }
    if (includeEngines.includes('claudesynchro')) {
      const startTime = Date.now();
      const result = await generateClaudesynchroSubtitles(srtFile, videoFile);
      const duration = Date.now() - startTime;
      console.log(`${new Date().toLocaleString()} claudesynchro result: ${result.message} (${duration}ms)`);
    }
  } else {
    console.log(`${new Date().toLocaleString()} No matching video file found for: ${basename(srtFile)}`);
  }
};
