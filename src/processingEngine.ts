import EventEmitter from 'events';
import { existsSync } from 'fs';
import { extname } from 'path';
import { getScanConfig } from './config';
import { RunSource } from './database';
import { findAllSrtFiles } from './findAllSrtFiles';
import { findMatchingVideoFile } from './findMatchingVideoFile';
import { generateFfsubsyncSubtitles } from './generateFfsubsyncSubtitles';
import { generateAutosubsyncSubtitles } from './generateAutosubsyncSubtitles';
import { generateAlassSubtitles } from './generateAlassSubtitles';
import { generateClaudesynchroSubtitles } from './generateClaudesynchroSubtitles';
import { EngineOptions, ProcessingResult } from './helpers';
import { StateManager } from './stateManager';

/** What to process: the whole library, specific folders, or files picked in the Library page. */
export interface RunRequest {
  source: RunSource;
  paths?: string[];
  files?: string[];
  engines?: string[];
  /** Re-create outputs that already exist. */
  force?: boolean;
}

const ENGINES: Record<
  string,
  (srtPath: string, videoPath: string, options: EngineOptions) => Promise<ProcessingResult>
> = {
  ffsubsync: generateFfsubsyncSubtitles,
  autosubsync: generateAutosubsyncSubtitles,
  alass: generateAlassSubtitles,
  claudesynchro: generateClaudesynchroSubtitles,
};

export class ProcessingEngine extends EventEmitter {
  private cancelledFiles: Set<string> = new Set();
  private running: Map<string, AbortController> = new Map();
  private maxConcurrent: number;
  private logBuffer: string[] = [];
  private maxLogBufferSize: number;
  public stateManager?: StateManager;

  constructor() {
    super();
    this.maxConcurrent = parseInt(process.env.MAX_CONCURRENT_SYNC_TASKS || '1', 10);
    this.maxLogBufferSize = parseInt(process.env.LOG_BUFFER_SIZE || '1000', 10);
  }

  private log(message: string): void {
    console.log(message);

    // Ring buffer - remove oldest if at capacity
    if (this.logBuffer.length >= this.maxLogBufferSize) {
      this.logBuffer.shift(); // Remove oldest
    }

    this.logBuffer.push(message);
    this.emit('log', message);
  }

  getLogs(): string[] {
    return [...this.logBuffer];
  }

  clearLogs(): void {
    this.logBuffer = [];
  }

  async processRun(request: RunRequest, engines: string[]): Promise<void> {
    let srtFiles: string[];
    if (request.files) {
      srtFiles = request.files.filter((file) => existsSync(file));
      this.log(`[${new Date().toISOString()}] Processing ${srtFiles.length} selected file(s)`);
    } else {
      const scanConfig = request.paths ? { includePaths: request.paths, excludePaths: [] } : getScanConfig();
      this.log(`[${new Date().toISOString()}] Scanning for subtitle files...`);
      this.log(`[${new Date().toISOString()}] Scan paths: ${JSON.stringify(scanConfig.includePaths)}`);
      srtFiles = await findAllSrtFiles(scanConfig);
      this.log(`[${new Date().toISOString()}] Found ${srtFiles.length} subtitle files`);
    }

    this.emit('run:files_found', srtFiles);

    // Process in batches
    this.log(`[${new Date().toISOString()}] Processing with concurrency: ${this.maxConcurrent}`);
    this.log(
      `[${new Date().toISOString()}] Engines: ${engines.join(', ')}${request.force ? ' (re-creating existing results)' : ''}`,
    );

    for (let i = 0; i < srtFiles.length; i += this.maxConcurrent) {
      const batch = srtFiles.slice(i, i + this.maxConcurrent);
      this.log(
        `[${new Date().toISOString()}] Processing batch ${Math.floor(i / this.maxConcurrent) + 1}/${Math.ceil(srtFiles.length / this.maxConcurrent)} (${batch.length} files)`,
      );
      await Promise.all(batch.map((file) => this.processFile(file, request, engines)));
    }

    this.log(`[${new Date().toISOString()}] All files processed`);
  }

  private engineOptions(engine: string, request: RunRequest, signal: AbortSignal): EngineOptions {
    return {
      timeoutMs:
        this.stateManager?.settings.engineTimeoutMs(engine) ?? (engine === 'claudesynchro' ? 3600000 : 1800000),
      signal,
      force: request.force,
      onLog:
        engine === 'claudesynchro'
          ? (line) => this.log(`[${new Date().toISOString()}]   claudesynchro ${line}`)
          : undefined,
    };
  }

  private async processFile(srtPath: string, request: RunRequest, engines: string[]): Promise<void> {
    const fileName = srtPath.split('/').pop();
    this.log(`[${new Date().toISOString()}] Processing: ${fileName}`);

    // Check if cancelled
    if (this.cancelledFiles.has(srtPath)) {
      this.log(`[${new Date().toISOString()}] Skipped (cancelled): ${fileName}`);
      this.emit('file:skipped', { srtPath, reason: 'cancelled' });
      return;
    }

    const videoPath = findMatchingVideoFile(srtPath);

    this.emit('file:started', { srtPath, videoPath });

    if (!videoPath) {
      this.log(`[${new Date().toISOString()}] No matching video found for: ${fileName}`);
      this.emit('file:no_video', { srtPath });
      return;
    }

    this.log(`[${new Date().toISOString()}] Found video: ${videoPath.split('/').pop()}`);

    // Files picked in the Library run every engine, even those auto-skipped after repeated failures.
    const manualPick = request.source === 'library';
    const controller = new AbortController();
    this.running.set(srtPath, controller);

    // Process with each enabled engine
    let anyEngineSucceeded = false;
    let allEnginesSkipped = true;
    try {
      for (const engine of engines) {
        // Check cancellation before each engine
        if (this.cancelledFiles.has(srtPath)) {
          this.log(`[${new Date().toISOString()}] Skipped (cancelled): ${fileName}`);
          this.emit('file:skipped', { srtPath, reason: 'cancelled' });
          return;
        }

        const generate = ENGINES[engine];
        if (!generate) {
          continue;
        }

        // Check if engine should be skipped due to consecutive failures
        if (!manualPick && this.stateManager?.shouldSkipEngine(srtPath, engine)) {
          const limit = this.stateManager.settings.maxFailures();
          this.log(`[${new Date().toISOString()}] ⊘ Skipping ${engine} (${limit}+ failures in a row): ${fileName}`);
          this.emit('file:engine_completed', {
            srtPath,
            engine,
            result: {
              success: false,
              duration: 0,
              message: `Skipped after ${limit} failures in a row - run it from the Library to retry`,
              skipped: true,
            },
          });
          continue; // Skip to next engine (allEnginesSkipped remains true)
        }

        // Only claudesynchro reads non-SRT subtitles (e.g. MicroDVD/MPL2 .txt from Napiprojekt).
        if (engine !== 'claudesynchro' && extname(srtPath).toLowerCase() !== '.srt') {
          this.emit('file:engine_completed', {
            srtPath,
            engine,
            result: { success: true, duration: 0, message: `${engine} only supports .srt files`, skipped: true },
          });
          continue;
        }

        this.log(`[${new Date().toISOString()}] Starting ${engine} for: ${fileName}`);
        this.emit('file:engine_started', { srtPath, engine });

        const startTime = Date.now();
        let result: ProcessingResult;

        try {
          result = await generate(srtPath, videoPath, this.engineOptions(engine, request, controller.signal));
        } catch (error) {
          result = { success: false, message: error instanceof Error ? error.message : String(error) };
        }
        const duration = Date.now() - startTime;

        if (result.cancelled) {
          this.log(
            `[${new Date().toISOString()}] ⊘ ${engine} cancelled (${(duration / 1000).toFixed(1)}s): ${fileName}`,
          );
          this.emit('file:engine_completed', { srtPath, engine, result: { ...result, duration } });
          this.emit('file:skipped', { srtPath, reason: 'cancelled' });
          return;
        }

        // If this engine was skipped (already processed, wrong language, ...), log and continue
        if (result.skipped) {
          this.log(`[${new Date().toISOString()}] ⊘ ${engine} skipped: ${result.message}`);
          this.emit('file:engine_completed', { srtPath, engine, result: { ...result, duration } });
          continue; // allEnginesSkipped stays true
        }

        // An engine actually ran (not skipped), so not all are skipped
        allEnginesSkipped = false;

        const status = result.success ? '✓' : '✗';
        this.log(
          `[${new Date().toISOString()}] ${status} ${engine} completed (${(duration / 1000).toFixed(1)}s): ${fileName}`,
        );
        if (!result.success) {
          this.log(`[${new Date().toISOString()}]   Error: ${result.message}`);
          // Log stderr if available for debugging
          if (result.stderr) {
            this.log(`[${new Date().toISOString()}]   Stderr: ${result.stderr.slice(-500)}`);
          }
        }

        if (result.success) {
          anyEngineSucceeded = true;
        }

        this.emit('file:engine_completed', { srtPath, engine, result: { ...result, duration } });
      }
    } finally {
      this.running.delete(srtPath);
    }

    if (anyEngineSucceeded) {
      this.log(`[${new Date().toISOString()}] ✓ Completed successfully for: ${fileName}`);
      this.emit('file:completed', { srtPath });
    } else if (allEnginesSkipped) {
      this.log(`[${new Date().toISOString()}] ⊘ All engines skipped for: ${fileName}`);
      this.emit('file:skipped', { srtPath, reason: 'all_engines_skipped' });
    } else {
      this.log(`[${new Date().toISOString()}] ✗ All engines failed for: ${fileName}`);
      this.emit('file:failed', { srtPath });
    }
  }

  /** Skips a file; if an engine is working on it right now, that process is stopped. */
  skipFile(filePath: string): void {
    this.cancelledFiles.add(filePath);
    this.running.get(filePath)?.abort();
    this.emit('file:skip_requested', { filePath });
  }

  stopAllProcessing(allFiles: string[]): void {
    this.log(`[${new Date().toISOString()}] Stop requested - cancelling all remaining files`);
    allFiles.forEach((file) => this.cancelledFiles.add(file));
    this.running.forEach((controller) => controller.abort());
  }

  reset(): void {
    this.cancelledFiles.clear();
    this.clearLogs();
  }
}
