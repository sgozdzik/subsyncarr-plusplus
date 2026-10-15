import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  claudesynchroOutputPath,
  generateClaudesynchroSubtitles,
  looksLikeSubtitleText,
  subtitleLanguageTag,
} from '../generateClaudesynchroSubtitles';

describe('claudesynchro helpers', () => {
  const video = '/movies/Movie (2024)/Movie (2024).mkv';

  it('reads language tags from subtitle names', () => {
    expect(subtitleLanguageTag('/movies/Movie (2024)/Movie (2024).pl.srt', video)).toBe('pl');
    expect(subtitleLanguageTag('/movies/Movie (2024)/Movie (2024).eng.sdh.srt', video)).toBe('en');
    expect(subtitleLanguageTag('/movies/Movie (2024)/Movie (2024).srt', video)).toBeNull();
    expect(subtitleLanguageTag('/movies/It (2017)/It (2017).srt', '/movies/It (2017)/It (2017).mkv')).toBeNull();
  });

  it('names outputs like the other engines and adds the language to untagged files', () => {
    expect(claudesynchroOutputPath('/movies/Movie (2024)/Movie (2024).pl.srt', video)).toBe(
      '/movies/Movie (2024)/Movie (2024).pl.claudesynchro.srt',
    );
    expect(claudesynchroOutputPath('/movies/Movie (2024)/Movie (2024).txt', video)).toBe(
      '/movies/Movie (2024)/Movie (2024).pl.claudesynchro.srt',
    );
  });

  it('recognises Napiprojekt-style .txt subtitles', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cs-'));
    const microdvd = join(dir, 'a.txt');
    const notes = join(dir, 'b.txt');
    writeFileSync(microdvd, '{100}{200}Cześć|Jak się masz?\n');
    writeFileSync(notes, 'Release notes: 1080p WEB-DL\n');
    expect(looksLikeSubtitleText(microdvd)).toBe(true);
    expect(looksLikeSubtitleText(notes)).toBe(false);
  });

  it('skips subtitles in other languages without starting Python', async () => {
    const result = await generateClaudesynchroSubtitles('/movies/Movie (2024)/Movie (2024).en.srt', video);
    expect(result.skipped).toBe(true);
    expect(result.message).toContain('"en"');
  });
});
