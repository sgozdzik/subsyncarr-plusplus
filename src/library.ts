import { Dirent } from 'fs';
import { readdir, stat } from 'fs/promises';
import { basename, extname, join, resolve, sep } from 'path';
import { getScanConfig } from './config';
import { EngineFailureTracking } from './database';
import { ALL_ENGINES, getEnabledEngines } from './engines';
import { findMatchingVideoName } from './findMatchingVideoFile';
import { alassOutputPath } from './generateAlassSubtitles';
import { autosubsyncOutputPath } from './generateAutosubsyncSubtitles';
import {
  claudesynchroLanguages,
  claudesynchroOutputPath,
  looksLikeSubtitleText,
  subtitleLanguageTag,
} from './generateClaudesynchroSubtitles';
import { ffsubsyncOutputPath } from './generateFfsubsyncSubtitles';
import { StateManager } from './stateManager';

const ENGINE_OUTPUT_TAGS = ['.ffsubsync.', '.alass.', '.autosubsync.', '.claudesynchro.'];

export type EngineStatus = 'done' | 'failed' | 'auto-skipped' | 'not-run' | 'n/a';

export interface LibraryEngineState {
  status: EngineStatus;
  failures: number;
  lastMessage: string | null;
  lastRunTime: number | null;
  note?: string;
}

export interface LibraryFile {
  path: string;
  name: string;
  dir: string;
  root: string;
  video: string | null;
  language: string | null;
  size: number;
  mtime: number;
  engines: Record<string, LibraryEngineState>;
}

export interface LibrarySnapshot {
  roots: string[];
  files: LibraryFile[];
  engines: string[];
  enabledEngines: string[];
  maxFailures: number;
  scannedAt: number;
  durationMs: number;
  errors: string[];
}

function outputPathFor(engine: string, subtitle: string, video: string | null): string {
  switch (engine) {
    case 'ffsubsync':
      return ffsubsyncOutputPath(subtitle);
    case 'autosubsync':
      return autosubsyncOutputPath(subtitle);
    case 'alass':
      return alassOutputPath(subtitle);
    default:
      return claudesynchroOutputPath(subtitle, video ?? subtitle);
  }
}

/** True when `filePath` is inside one of the configured scan paths (guards the manual-run API). */
export function isInsideScanPaths(filePath: string): boolean {
  const target = resolve(filePath);
  return getScanConfig().includePaths.some((root) => {
    const base = resolve(root);
    return target === base || target.startsWith(base.endsWith(sep) ? base : base + sep);
  });
}

/** The scanned library: every subtitle file with its video and per-engine status. Cached until refreshed. */
export class Library {
  private cache: LibrarySnapshot | null = null;
  private scanning: Promise<LibrarySnapshot> | null = null;

  constructor(private stateManager: StateManager) {}

  /** Statuses change after runs; the next request rescans. */
  invalidate(): void {
    this.cache = null;
  }

  async get(refresh = false): Promise<LibrarySnapshot> {
    if (this.cache && !refresh) {
      return this.cache;
    }
    if (!this.scanning) {
      this.scanning = this.scan().finally(() => {
        this.scanning = null;
      });
    }
    this.cache = await this.scanning;
    return this.cache;
  }

  private engineStates(
    subtitle: string,
    video: string | null,
    language: string | null,
    names: Set<string>,
    tracking: Map<string, EngineFailureTracking>,
    maxFailures: number,
  ): Record<string, LibraryEngineState> {
    const languages = claudesynchroLanguages();
    const states: Record<string, LibraryEngineState> = {};
    for (const engine of ALL_ENGINES) {
      const row = tracking.get(`${engine}\u0000${subtitle}`);
      const state: LibraryEngineState = {
        status: 'not-run',
        failures: row?.consecutive_failures ?? 0,
        lastMessage: row?.last_message ?? null,
        lastRunTime: row?.last_run_time ?? null,
      };
      if (engine !== 'claudesynchro' && extname(subtitle).toLowerCase() !== '.srt') {
        state.status = 'n/a';
        state.note = 'only .srt files';
      } else if (engine === 'claudesynchro' && language !== null && !languages.includes(language)) {
        state.status = 'n/a';
        state.note = `language ${language} is not synced`;
      } else if (names.has(basename(outputPathFor(engine, subtitle, video)))) {
        state.status = 'done';
      } else if (state.failures >= maxFailures) {
        state.status = 'auto-skipped';
      } else if (row?.last_status === 'failure') {
        state.status = 'failed';
      }
      states[engine] = state;
    }
    return states;
  }

  private async scan(): Promise<LibrarySnapshot> {
    const started = Date.now();
    const config = getScanConfig();
    const includeTxt = getEnabledEngines().includes('claudesynchro');
    const maxFailures = this.stateManager.settings.maxFailures();
    const tracking = new Map<string, EngineFailureTracking>();
    for (const row of this.stateManager.getDatabase().getAllEngineStates()) {
      tracking.set(`${row.engine}\u0000${row.file_path}`, row);
    }
    const files: LibraryFile[] = [];
    const errors: string[] = [];

    const walk = async (root: string, directory: string): Promise<void> => {
      if (config.excludePaths.some((excludePath) => directory.startsWith(excludePath))) {
        return;
      }
      let entries: Dirent[];
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        errors.push(`${directory}: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      const names = new Set(entries.map((entry) => entry.name));
      for (const entry of entries) {
        const fullPath = join(directory, entry.name);
        if (entry.isDirectory()) {
          await walk(root, fullPath);
          continue;
        }
        if (!entry.isFile() || ENGINE_OUTPUT_TAGS.some((tag) => entry.name.includes(tag))) {
          continue;
        }
        const ext = extname(entry.name).toLowerCase();
        if (ext !== '.srt' && !(includeTxt && ext === '.txt' && looksLikeSubtitleText(fullPath))) {
          continue;
        }
        const videoName = findMatchingVideoName(basename(entry.name, extname(entry.name)), (n) => names.has(n));
        const video = videoName ? join(directory, videoName) : null;
        const language = subtitleLanguageTag(fullPath, video ?? fullPath);
        let size = 0;
        let mtime = 0;
        try {
          const info = await stat(fullPath);
          size = info.size;
          mtime = info.mtimeMs;
        } catch {
          // listed but gone; keep the entry
        }
        files.push({
          path: fullPath,
          name: entry.name,
          dir: directory,
          root,
          video,
          language,
          size,
          mtime,
          engines: this.engineStates(fullPath, video, language, names, tracking, maxFailures),
        });
      }
    };

    for (const root of config.includePaths) {
      await walk(root, root);
    }
    files.sort((a, b) => a.path.localeCompare(b.path));
    return {
      roots: config.includePaths,
      files,
      engines: ALL_ENGINES,
      enabledEngines: getEnabledEngines(),
      maxFailures,
      scannedAt: Date.now(),
      durationMs: Date.now() - started,
      errors,
    };
  }
}
