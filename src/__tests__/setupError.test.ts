import { once } from 'events';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ProcessingCoordinator } from '../coordinator';
import { ProcessingEngine } from '../processingEngine';
import { StateManager } from '../stateManager';
import { generateClaudesynchroSubtitles } from '../generateClaudesynchroSubtitles';

jest.mock('../generateClaudesynchroSubtitles', () => ({
  generateClaudesynchroSubtitles: jest.fn(async () => ({
    success: false,
    setupError: true,
    message: 'Could not download Xenova/model/tokenizer.json from huggingface.co (CERTIFICATE_VERIFY_FAILED)',
  })),
}));

it('leaves claudesynchro out for the rest of the run after a setup error, without counting it against files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sspp-'));
  const files = ['A', 'B', 'C'].map((name) => {
    writeFileSync(join(root, `${name}.mkv`), 'x');
    const srt = join(root, `${name}.pl.srt`);
    writeFileSync(srt, '1\n00:00:01,000 --> 00:00:02,000\nx\n');
    return srt;
  });
  const state = new StateManager(join(root, 'test.db'));
  const coordinator = new ProcessingCoordinator(new ProcessingEngine(), state);

  const done = once(state, 'run:completed');
  const runId = await coordinator.startRun({ source: 'scheduled', files, engines: ['claudesynchro'] });
  await done;

  expect(generateClaudesynchroSubtitles).toHaveBeenCalledTimes(1);
  const results = Object.fromEntries(
    state.getFileResults(runId).map((f) => [f.file_path, JSON.parse(f.engines).claudesynchro]),
  );
  expect(results[files[0]]).toMatchObject({ success: false, setupError: true });
  expect(results[files[1]]).toMatchObject({
    skipped: true,
    message: expect.stringContaining('cannot run in this container'),
  });
  expect(results[files[2]]).toMatchObject({ skipped: true });

  // Shown in Diagnostics, but never auto-skipped because of it.
  const tracking = state.getDatabase().getEngineStatesForFile(files[0])[0];
  expect(tracking).toMatchObject({ last_status: 'failure', consecutive_failures: 0 });
  expect(tracking.last_message).toContain('CERTIFICATE_VERIFY_FAILED');
  expect(state.shouldSkipEngine(files[0], 'claudesynchro')).toBe(false);
  state.close();
});
