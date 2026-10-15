import { existsSync } from 'fs';
import { basename, dirname, extname, join } from 'path';

type VideoExtension = '.mkv' | '.mp4' | '.avi' | '.mov';
const VIDEO_EXTENSIONS: VideoExtension[] = ['.mkv', '.mp4', '.avi', '.mov'];

/**
 * Video file name for a subtitle base name ("Movie.pl" -> "Movie.mkv"), checked with `exists`.
 * Tries an exact match first, then removes dot-separated tags from the end one at a time.
 */
export function findMatchingVideoName(subtitleBaseName: string, exists: (name: string) => boolean): string | null {
  const segments = subtitleBaseName.split('.');
  while (segments.length > 0) {
    const baseNameToTry = segments.join('.');
    for (const ext of VIDEO_EXTENSIONS) {
      if (exists(`${baseNameToTry}${ext}`)) {
        return `${baseNameToTry}${ext}`;
      }
    }
    if (segments.length === 1) {
      break;
    }
    segments.pop(); // Remove the last segment
  }
  return null;
}

export function findMatchingVideoFile(srtPath: string): string | null {
  const directory = dirname(srtPath);
  const name = findMatchingVideoName(basename(srtPath, extname(srtPath)), (candidate) =>
    existsSync(join(directory, candidate)),
  );
  return name ? join(directory, name) : null;
}
