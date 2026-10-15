import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { StateManager } from '../stateManager';
import { Library } from '../library';
import { getEnabledEngines, setEngineOverride } from '../engines';
import { ensureEngineDirsOnPath, runProcess } from '../helpers';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'sspp-'));
}

describe('settings', () => {
  let state: StateManager;

  beforeEach(() => {
    delete process.env.SYNC_ENGINE_TIMEOUT_MS;
    delete process.env.CLAUDESYNCHRO_TIMEOUT_MS;
    delete process.env.ENGINE_MAX_FAILURES;
    delete process.env.INCLUDE_ENGINES;
    process.env.CRON_SCHEDULE = '0 0 * * *';
    setEngineOverride(null);
    state = new StateManager(join(tempDir(), 'test.db'));
  });

  afterEach(() => state.close());

  it('defaults to 30 min per engine, 60 min for claudesynchro and 2 failures', () => {
    expect(state.settings.engineTimeoutMs('alass')).toBe(30 * 60000);
    expect(state.settings.engineTimeoutMs('claudesynchro')).toBe(60 * 60000);
    expect(state.settings.maxFailures()).toBe(2);
  });

  it('lets the UI override the environment, and reset back to it', () => {
    process.env.SYNC_ENGINE_TIMEOUT_MS = String(45 * 60000);
    expect(state.settings.snapshot().engineTimeoutMinutes).toEqual({ value: 45, source: 'env' });
    state.settings.update({ engineTimeoutMinutes: 20 });
    expect(state.settings.snapshot().engineTimeoutMinutes).toEqual({ value: 20, source: 'ui' });
    state.settings.update({ engineTimeoutMinutes: null });
    expect(state.settings.snapshot().engineTimeoutMinutes.source).toBe('env');
  });

  it('turns a daily Warsaw time into a cron schedule', () => {
    state.settings.update({ schedule: { mode: 'daily', time: '03:30' } });
    expect(state.settings.schedule()).toMatchObject({ cron: '30 3 * * *', timezone: 'Europe/Warsaw', source: 'ui' });
    state.settings.update({ schedule: { mode: 'disabled' } });
    expect(state.settings.schedule().cron).toBeNull();
    state.settings.update({ schedule: { mode: 'env' } });
    expect(state.settings.schedule()).toMatchObject({ cron: '0 0 * * *', source: 'env' });
    expect(() => state.settings.update({ schedule: { mode: 'daily', time: '25:00' } })).toThrow();
  });

  it('stores the engines for scheduled runs', () => {
    expect(getEnabledEngines()).toEqual(['ffsubsync', 'autosubsync', 'alass', 'claudesynchro']);
    state.settings.update({ engines: ['claudesynchro', 'alass'] });
    expect(getEnabledEngines()).toEqual(['alass', 'claudesynchro']);
    expect(() => state.settings.update({ engines: [] })).toThrow();
    state.settings.update({ engines: null });
    expect(getEnabledEngines()).toHaveLength(4);
  });

  it('auto-skips an engine after two failures in a row; a success or reset clears it', () => {
    const failure = { success: false, duration: 10, message: 'boom', stderr: 'Traceback ...' };
    const runId = state.startRun(1, ['claudesynchro'], 'manual');
    state.addFile(runId, '/m/a.pl.srt', '/m/a.mkv');
    state.updateFileEngine(runId, '/m/a.pl.srt', 'claudesynchro', failure);
    expect(state.shouldSkipEngine('/m/a.pl.srt', 'claudesynchro')).toBe(false);
    state.updateFileEngine(runId, '/m/a.pl.srt', 'claudesynchro', failure);
    expect(state.shouldSkipEngine('/m/a.pl.srt', 'claudesynchro')).toBe(true);
    const row = state.getDatabase().getEngineStatesForFile('/m/a.pl.srt')[0];
    expect(row).toMatchObject({ last_status: 'failure', last_message: 'boom', last_details: 'Traceback ...' });

    // Cancelled runs do not count.
    state.resetSkipStatus('/m/a.pl.srt');
    state.updateFileEngine(runId, '/m/a.pl.srt', 'claudesynchro', { ...failure, cancelled: true });
    state.updateFileEngine(runId, '/m/a.pl.srt', 'claudesynchro', failure);
    expect(state.shouldSkipEngine('/m/a.pl.srt', 'claudesynchro')).toBe(false);
    state.updateFileEngine(runId, '/m/a.pl.srt', 'claudesynchro', { success: true, duration: 5, message: 'ok' });
    expect(state.getDatabase().getEngineStatesForFile('/m/a.pl.srt')[0].consecutive_failures).toBe(0);
  });
});

describe('library', () => {
  it('lists subtitles with their video and per-engine status', async () => {
    const root = tempDir();
    const movie = join(root, 'Movie (2024)');
    mkdirSync(movie);
    for (const name of [
      'Movie (2024).mkv',
      'Movie (2024).pl.srt',
      'Movie (2024).pl.alass.srt',
      'Movie (2024).en.srt',
      'notes.txt',
    ]) {
      writeFileSync(join(movie, name), name.endsWith('.srt') ? '1\n00:00:01,000 --> 00:00:02,000\nx\n' : 'x');
    }
    writeFileSync(join(movie, 'Movie (2024).txt'), '{10}{20}Cześć\n');
    mkdirSync(join(root, 'Lonely'));
    writeFileSync(join(root, 'Lonely', 'Lonely.pl.srt'), '1\n00:00:01,000 --> 00:00:02,000\nx\n');

    process.env.SCAN_PATHS = root;
    delete process.env.INCLUDE_ENGINES;
    setEngineOverride(null);
    const state = new StateManager(join(tempDir(), 'test.db'));
    const snapshot = await new Library(state).get();
    const byName = Object.fromEntries(snapshot.files.map((f) => [f.name, f]));

    expect(Object.keys(byName).sort()).toEqual([
      'Lonely.pl.srt',
      'Movie (2024).en.srt',
      'Movie (2024).pl.srt',
      'Movie (2024).txt',
    ]);
    const pl = byName['Movie (2024).pl.srt'];
    expect(pl.video).toBe(join(movie, 'Movie (2024).mkv'));
    expect(pl.engines.alass.status).toBe('done');
    expect(pl.engines.claudesynchro.status).toBe('not-run');
    expect(byName['Movie (2024).en.srt'].engines.claudesynchro.status).toBe('n/a');
    expect(byName['Movie (2024).txt'].engines.ffsubsync.status).toBe('n/a');
    expect(byName['Lonely.pl.srt'].video).toBeNull();
    state.close();
  });
});

describe('ensureEngineDirsOnPath', () => {
  const originalPath = process.env.PATH;
  afterEach(() => {
    process.env.PATH = originalPath;
  });

  it('restores engine folders missing from a PATH carried over from an old container', () => {
    const venv = tempDir();
    const optBin = tempDir();
    process.env.PATH = '/home/node/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
    expect(ensureEngineDirsOnPath([venv, '/home/node/.local/bin', optBin, '/does/not/exist'])).toEqual([venv, optBin]);
    expect(process.env.PATH).toBe(
      `${venv}:${optBin}:/home/node/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    );
    // Already present (also with a trailing slash): nothing changes.
    process.env.PATH = `${venv}/:${optBin}:/usr/bin`;
    expect(ensureEngineDirsOnPath([venv, optBin])).toEqual([]);
    expect(process.env.PATH).toBe(`${venv}/:${optBin}:/usr/bin`);
  });
});

describe('runProcess', () => {
  it('kills the whole process group on timeout', async () => {
    const started = Date.now();
    const outcome = await runProcess('sh', ['-c', 'sleep 30 & sleep 30'], { timeoutMs: 300 });
    expect(outcome.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('can be cancelled and streams stderr lines', async () => {
    const controller = new AbortController();
    const lines: string[] = [];
    const promise = runProcess('sh', ['-c', 'echo first >&2; sleep 30'], {
      timeoutMs: 60000,
      signal: controller.signal,
      onLog: (line) => lines.push(line),
    });
    setTimeout(() => controller.abort(), 300);
    const outcome = await promise;
    expect(outcome.cancelled).toBe(true);
    expect(lines).toEqual(['first']);
  });
});
