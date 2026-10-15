import { SubsyncarrPlusDatabase } from './database';
import { ALL_ENGINES, envEngines, setEngineOverride } from './engines';

/** Times entered in the UI are in this timezone (the schedule runs on Warsaw time). */
export const SCHEDULE_TIMEZONE = process.env.SCHEDULE_TIMEZONE || 'Europe/Warsaw';

const DEFAULT_ENGINE_TIMEOUT_MIN = 30;
const DEFAULT_CLAUDESYNCHRO_TIMEOUT_MIN = 60;
const DEFAULT_MAX_FAILURES = 2;

export type SettingSource = 'ui' | 'env' | 'default';

export interface ScheduleSetting {
  /** 'daily' = every day at `time` (SCHEDULE_TIMEZONE), 'disabled', or 'env' = CRON_SCHEDULE. */
  mode: 'daily' | 'disabled' | 'env';
  time: string | null;
  cron: string | null;
  timezone: string | null;
  source: SettingSource;
}

export interface SettingsSnapshot {
  schedule: ScheduleSetting;
  engineTimeoutMinutes: { value: number; source: SettingSource };
  claudesynchroTimeoutMinutes: { value: number; source: SettingSource };
  maxFailures: { value: number; source: SettingSource };
  engines: { value: string[]; source: SettingSource };
}

export interface SettingsUpdate {
  schedule?: { mode: 'daily' | 'disabled' | 'env'; time?: string };
  engineTimeoutMinutes?: number | null;
  claudesynchroTimeoutMinutes?: number | null;
  maxFailures?: number | null;
  /** Engines for scheduled and dashboard runs; `null` goes back to INCLUDE_ENGINES. */
  engines?: string[] | null;
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function envMinutes(name: string): number | null {
  const ms = parseInt(process.env[name] || '', 10);
  return Number.isFinite(ms) && ms > 0 ? Math.round(ms / 60000) : null;
}

function envInt(name: string): number | null {
  const value = parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** Settings editable in the web UI. A UI value overrides the environment variable, which overrides the default. */
export class SettingsStore {
  constructor(private db: SubsyncarrPlusDatabase) {
    setEngineOverride(this.storedEngines());
  }

  private storedEngines(): string[] | null {
    try {
      const value = JSON.parse(this.db.getSetting('engines') || 'null');
      return Array.isArray(value) && value.length > 0 ? value : null;
    } catch {
      return null;
    }
  }

  private number(key: string, envValue: number | null, fallback: number): { value: number; source: SettingSource } {
    const stored = parseInt(this.db.getSetting(key) || '', 10);
    if (Number.isFinite(stored) && stored > 0) {
      return { value: stored, source: 'ui' };
    }
    if (envValue !== null) {
      return { value: envValue, source: 'env' };
    }
    return { value: fallback, source: 'default' };
  }

  schedule(): ScheduleSetting {
    const mode = this.db.getSetting('schedule_mode');
    const time = this.db.getSetting('schedule_time');
    if (mode === 'disabled') {
      return { mode: 'disabled', time, cron: null, timezone: null, source: 'ui' };
    }
    if (mode === 'daily' && time && TIME_RE.test(time)) {
      const [hours, minutes] = time.split(':').map((part) => parseInt(part, 10));
      return { mode: 'daily', time, cron: `${minutes} ${hours} * * *`, timezone: SCHEDULE_TIMEZONE, source: 'ui' };
    }
    const cron = process.env.CRON_SCHEDULE || '0 0 * * *';
    if (cron === 'disabled') {
      return { mode: 'disabled', time: null, cron: null, timezone: null, source: 'env' };
    }
    // Environment cron keeps the upstream behaviour: container time zone (TZ).
    return { mode: 'env', time: null, cron, timezone: process.env.TZ || null, source: 'env' };
  }

  engineTimeoutMs(engine: string): number {
    const minutes =
      engine === 'claudesynchro'
        ? this.number(
            'claudesynchro_timeout_minutes',
            envMinutes('CLAUDESYNCHRO_TIMEOUT_MS'),
            DEFAULT_CLAUDESYNCHRO_TIMEOUT_MIN,
          )
        : this.number('engine_timeout_minutes', envMinutes('SYNC_ENGINE_TIMEOUT_MS'), DEFAULT_ENGINE_TIMEOUT_MIN);
    return minutes.value * 60000;
  }

  maxFailures(): number {
    return this.number('max_failures', envInt('ENGINE_MAX_FAILURES'), DEFAULT_MAX_FAILURES).value;
  }

  snapshot(): SettingsSnapshot {
    return {
      schedule: this.schedule(),
      engineTimeoutMinutes: this.number(
        'engine_timeout_minutes',
        envMinutes('SYNC_ENGINE_TIMEOUT_MS'),
        DEFAULT_ENGINE_TIMEOUT_MIN,
      ),
      claudesynchroTimeoutMinutes: this.number(
        'claudesynchro_timeout_minutes',
        envMinutes('CLAUDESYNCHRO_TIMEOUT_MS'),
        DEFAULT_CLAUDESYNCHRO_TIMEOUT_MIN,
      ),
      maxFailures: this.number('max_failures', envInt('ENGINE_MAX_FAILURES'), DEFAULT_MAX_FAILURES),
      engines: this.storedEngines()
        ? { value: ALL_ENGINES.filter((e) => this.storedEngines()?.includes(e)), source: 'ui' }
        : { value: envEngines(), source: process.env.INCLUDE_ENGINES ? 'env' : 'default' },
    };
  }

  /** Validates and stores an update. `null` for a number resets it to the environment/default value. */
  update(update: SettingsUpdate): void {
    if (update.schedule) {
      const { mode, time } = update.schedule;
      if (mode === 'daily') {
        if (!time || !TIME_RE.test(time)) {
          throw new Error('Time must be HH:MM (24h)');
        }
        this.db.setSetting('schedule_mode', 'daily');
        this.db.setSetting('schedule_time', time);
      } else if (mode === 'disabled') {
        this.db.setSetting('schedule_mode', 'disabled');
      } else if (mode === 'env') {
        this.db.setSetting('schedule_mode', null);
        this.db.setSetting('schedule_time', null);
      } else {
        throw new Error(`Unknown schedule mode: ${String(mode)}`);
      }
    }
    if (update.engines !== undefined) {
      if (update.engines === null) {
        this.db.setSetting('engines', null);
      } else {
        const engines = ALL_ENGINES.filter((e) => update.engines?.includes(e));
        if (engines.length === 0) {
          throw new Error('Pick at least one engine');
        }
        this.db.setSetting('engines', JSON.stringify(engines));
      }
      setEngineOverride(this.storedEngines());
    }
    const numbers: Array<[keyof SettingsUpdate, string, number, number]> = [
      ['engineTimeoutMinutes', 'engine_timeout_minutes', 1, 24 * 60],
      ['claudesynchroTimeoutMinutes', 'claudesynchro_timeout_minutes', 1, 24 * 60],
      ['maxFailures', 'max_failures', 1, 100],
    ];
    for (const [field, key, min, max] of numbers) {
      const value = update[field] as number | null | undefined;
      if (value === undefined) {
        continue;
      }
      if (value === null) {
        this.db.setSetting(key, null);
        continue;
      }
      const n = Number(value);
      if (!Number.isInteger(n) || n < min || n > max) {
        throw new Error(`${field} must be a whole number between ${min} and ${max}`);
      }
      this.db.setSetting(key, String(n));
    }
  }
}
