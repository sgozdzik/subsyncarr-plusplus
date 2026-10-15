import { format } from 'util';

const MAX_LINES = 2000;
const lines: string[] = [];

function push(level: string, args: unknown[]): void {
  const text = format(...args);
  for (const line of text.split('\n')) {
    lines.push(level === 'log' ? line : `[${level}] ${line}`);
  }
  if (lines.length > MAX_LINES) {
    lines.splice(0, lines.length - MAX_LINES);
  }
}

/** Keeps the last server log lines in memory for the Diagnostics page (console output is unchanged). */
export function captureConsole(): void {
  for (const level of ['log', 'info', 'warn', 'error'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      push(level, args);
      original(...args);
    };
  }
  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled promise rejection:', reason);
  });
}

export function recentServerLog(count = 300): string[] {
  return lines.slice(-count);
}
