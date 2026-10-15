import { spawn } from 'child_process';

export interface ProcessingResult {
  success: boolean;
  message: string;
  stdout?: string;
  stderr?: string;
  skipped?: boolean;
  /** Stopped by the user (Skip / Stop); does not count as a failure. */
  cancelled?: boolean;
}

export interface EngineOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  /** Re-create the output even if it already exists (manual runs from the Library). */
  force?: boolean;
  onLog?: (line: string) => void;
}

export interface ProcessOutcome {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  error?: Error;
}

const MAX_STDOUT = 5 * 1024 * 1024;
const MAX_STDERR = 20000;

/**
 * Runs an engine in its own process group, so a timeout or a Skip/Stop also ends
 * whatever it started (ffmpeg, Python workers). Arguments are passed without a shell.
 */
export function runProcess(command: string, args: string[], options: EngineOptions): Promise<ProcessOutcome> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let pending = '';
    let timedOut = false;
    let cancelled = false;
    let finished = false;

    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true });

    const killGroup = (signal: NodeJS.Signals) => {
      try {
        if (child.pid) {
          process.kill(-child.pid, signal);
        }
      } catch {
        child.kill(signal);
      }
    };
    const stop = () => {
      killGroup('SIGTERM');
      setTimeout(() => !finished && killGroup('SIGKILL'), 10000).unref();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs);
    const onAbort = () => {
      cancelled = true;
      stop();
    };
    if (options.signal?.aborted) {
      onAbort();
    }
    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_STDOUT) {
        stdout += chunk.toString();
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr = (stderr + text).slice(-MAX_STDERR);
      if (options.onLog) {
        pending += text;
        const lines = pending.split(/\r?\n|\r/);
        pending = lines.pop() ?? '';
        lines.filter((line) => line.trim()).forEach((line) => options.onLog?.(line));
      }
    });

    const finish = (code: number | null, error?: Error) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve({ code, stdout, stderr, timedOut, cancelled, error });
    };
    child.on('error', (error) => finish(null, error));
    child.on('close', (code) => finish(code));
  });
}

/** Common result mapping for the command-line engines (ffsubsync, autosubsync, alass). */
export async function runEngineCommand(
  engine: string,
  command: string,
  args: string[],
  outputPath: string,
  options: EngineOptions,
): Promise<ProcessingResult> {
  console.log(`${new Date().toLocaleString()} Processing: ${command} ${args.map((a) => JSON.stringify(a)).join(' ')}`);
  const outcome = await runProcess(command, args, options);
  const stdout = outcome.stdout || undefined;
  const stderr = outcome.stderr || undefined;
  if (outcome.cancelled) {
    return { success: false, cancelled: true, message: `Cancelled: ${engine}`, stdout, stderr };
  }
  if (outcome.timedOut) {
    return {
      success: false,
      message: `Timeout: ${engine} took longer than ${Math.round(options.timeoutMs / 60000)} min`,
      stdout,
      stderr,
    };
  }
  if (outcome.error) {
    return { success: false, message: `Could not start ${command}: ${outcome.error.message}`, stdout, stderr };
  }
  if (outcome.code !== 0) {
    return { success: false, message: `Error processing ${outputPath}: exit code ${outcome.code}`, stdout, stderr };
  }
  return { success: true, message: `Successfully processed: ${outputPath}`, stdout, stderr };
}
