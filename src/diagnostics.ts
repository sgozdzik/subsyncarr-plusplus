import { execFile } from 'child_process';
import { readFileSync, statfsSync } from 'fs';
import os from 'os';
import { dirname, join } from 'path';
import { getScanConfig } from './config';
import { ProcessingCoordinator } from './coordinator';
import { recentServerLog } from './debugLog';
import { getEnabledEngines } from './engines';
import { Scheduler } from './scheduler';
import { StateManager } from './stateManager';

const ENV_KEYS = [
  'SCAN_PATHS',
  'EXCLUDE_PATHS',
  'INCLUDE_ENGINES',
  'CRON_SCHEDULE',
  'SCHEDULE_TIMEZONE',
  'TZ',
  'MAX_CONCURRENT_SYNC_TASKS',
  'SYNC_ENGINE_TIMEOUT_MS',
  'ENGINE_MAX_FAILURES',
  'NODE_OPTIONS',
  'DB_PATH',
  'WEB_HOST',
  'WEB_PORT',
  'PUID',
  'PGID',
];
const ENV_PREFIXES = ['CLAUDESYNCHRO_', 'WHISPER_', 'OPENROUTER_'];
const TOOLS_CACHE_MS = 10 * 60 * 1000;

interface ToolInfo {
  name: string;
  ok: boolean;
  version: string;
}

let toolsCache: { at: number; tools: ToolInfo[]; claudesynchro: unknown } | null = null;

function run(command: string, args: string[], timeout = 20000): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
      const output = `${stdout || ''}${stderr || ''}`.trim();
      resolve({ ok: !error, output: error && !output ? error.message : output });
    });
  });
}

function mask(key: string, value: string): string {
  if (/KEY|TOKEN|SECRET|PASSWORD/i.test(key) && value) {
    return value.length > 8 ? `***${value.slice(-4)}` : '***';
  }
  return value;
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return null;
  }
}

function cpuFlags(): Record<string, boolean> | null {
  const info = readText('/proc/cpuinfo');
  const line = info?.split('\n').find((l) => l.startsWith('flags'));
  if (!line) {
    return null;
  }
  const flags = new Set(line.split(':')[1].trim().split(/\s+/));
  return Object.fromEntries(['sse4_2', 'avx', 'avx2', 'avx512f', 'f16c', 'fma'].map((f) => [f, flags.has(f)]));
}

function containerMemory(): { limit: number | null; usage: number | null } {
  const limitText = readText('/sys/fs/cgroup/memory.max') ?? readText('/sys/fs/cgroup/memory/memory.limit_in_bytes');
  const usageText =
    readText('/sys/fs/cgroup/memory.current') ?? readText('/sys/fs/cgroup/memory/memory.usage_in_bytes');
  const limit = limitText && /^\d+$/.test(limitText) && Number(limitText) < 2 ** 60 ? Number(limitText) : null;
  return { limit, usage: usageText && /^\d+$/.test(usageText) ? Number(usageText) : null };
}

function disk(path: string): { path: string; freeBytes: number | null; totalBytes: number | null } {
  try {
    const s = statfsSync(path);
    return { path, freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize };
  } catch {
    return { path, freeBytes: null, totalBytes: null };
  }
}

async function tools(): Promise<{ tools: ToolInfo[]; claudesynchro: unknown }> {
  if (toolsCache && Date.now() - toolsCache.at < TOOLS_CACHE_MS) {
    return toolsCache;
  }
  const firstLine = (text: string) => text.split('\n')[0].slice(0, 200);
  const checks: Array<[string, string, string[]]> = [
    ['ffmpeg', 'ffmpeg', ['-version']],
    ['ffprobe', 'ffprobe', ['-version']],
    ['ffsubsync', 'ffsubsync', ['--version']],
    ['autosubsync', 'autosubsync', ['--help']],
    ['alass', 'alass', ['--version']],
  ];
  const results = await Promise.all(
    checks.map(async ([name, cmd, args]) => {
      const r = await run(cmd, args);
      return { name, ok: r.ok, version: name === 'autosubsync' && r.ok ? 'installed' : firstLine(r.output) };
    }),
  );
  const doctor = await run('claudesynchro', ['doctor', '--json'], 60000);
  let claudesynchro: unknown;
  try {
    claudesynchro = JSON.parse(doctor.output.split('\n').filter(Boolean).pop() || '');
  } catch {
    claudesynchro = { error: doctor.output.slice(-2000) };
  }
  results.push({ name: 'claudesynchro', ok: doctor.ok, version: doctor.ok ? 'see below' : 'not working' });
  toolsCache = { at: Date.now(), tools: results, claudesynchro };
  return toolsCache;
}

function appVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
    return pkg.version;
  } catch {
    return 'unknown';
  }
}

export interface DiagnosticsDeps {
  stateManager: StateManager;
  coordinator: ProcessingCoordinator;
  scheduler: Scheduler;
  dbPath: string;
}

/** Everything useful for debugging a problem remotely; also rendered as a copyable text report. */
export async function collectDiagnostics(deps: DiagnosticsDeps) {
  const { stateManager, coordinator, scheduler } = deps;
  const db = stateManager.getDatabase();
  const settings = stateManager.settings;
  const scan = getScanConfig();
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && (ENV_KEYS.includes(key) || ENV_PREFIXES.some((p) => key.startsWith(p)))) {
      env[key] = mask(key, value);
    }
  }
  const toolInfo = await tools();
  const memory = process.memoryUsage();
  const currentRun = stateManager.getCurrentRun();
  return {
    generatedAt: new Date().toISOString(),
    app: {
      name: 'Subsyncarr++',
      version: appVersion(),
      commit: process.env.APP_COMMIT || 'dev',
      buildDate: process.env.APP_BUILD_DATE || null,
      node: process.version,
      uptimeSeconds: Math.round(process.uptime()),
      memory: { rss: memory.rss, heapUsed: memory.heapUsed },
    },
    system: {
      platform: `${os.platform()} ${os.release()} ${os.arch()}`,
      cpu: os.cpus()[0]?.model ?? 'unknown',
      cores: os.cpus().length,
      cpuFlags: cpuFlags(),
      loadAverage: os.loadavg().map((v) => Math.round(v * 100) / 100),
      memoryTotal: os.totalmem(),
      memoryFree: os.freemem(),
      container: containerMemory(),
      disks: [disk(dirname(deps.dbPath)), ...scan.includePaths.map(disk)],
    },
    tools: toolInfo.tools,
    claudesynchro: toolInfo.claudesynchro,
    config: {
      env,
      settings: settings.snapshot(),
      enabledEngines: getEnabledEngines(),
      scanPaths: scan.includePaths,
      excludePaths: scan.excludePaths,
    },
    schedule: scheduler.info(),
    state: {
      running: coordinator.isRunning(),
      currentRun,
      queue: coordinator.getQueue().map((r) => ({
        source: r.source,
        files: r.files?.length ?? null,
        paths: r.paths ?? null,
        engines: r.engines ?? null,
        force: !!r.force,
      })),
    },
    recentRuns: stateManager.getRunHistory(5).map((r) => ({
      id: r.id,
      source: r.source,
      status: r.status,
      start: new Date(r.start_time).toISOString(),
      durationSeconds: r.end_time ? Math.round((r.end_time - r.start_time) / 1000) : null,
      files: r.total_files,
      completed: r.completed,
      skipped: r.skipped,
      failed: r.failed,
    })),
    failures: db.getRecentFailures(30).map((f) => ({
      file: f.file_path,
      engine: f.engine,
      failuresInARow: f.consecutive_failures,
      time: f.last_failure_time ? new Date(f.last_failure_time).toISOString() : null,
      message: f.last_message,
      details: f.last_details ? f.last_details.slice(-1500) : null,
    })),
    autoSkipped: db.getAutoSkipped(settings.maxFailures()).map((f) => ({
      file: f.file_path,
      engine: f.engine,
      failuresInARow: f.consecutive_failures,
    })),
    serverLog: recentServerLog(200),
  };
}

export type Diagnostics = Awaited<ReturnType<typeof collectDiagnostics>>;

const mb = (bytes: number | null | undefined) => (bytes == null ? '?' : `${Math.round(bytes / 1024 / 1024)} MB`);

/** Plain-text report for pasting into a chat or issue. */
export function renderReport(d: Diagnostics): string {
  const out: string[] = [];
  out.push(`# Subsyncarr++ debug report`, `Generated: ${d.generatedAt}`, '');
  out.push(
    `## App`,
    `version ${d.app.version} · commit ${d.app.commit} · built ${d.app.buildDate ?? '?'} · node ${d.app.node} · up ${d.app.uptimeSeconds}s · rss ${mb(d.app.memory.rss)}`,
    '',
  );
  out.push(
    `## System`,
    `${d.system.platform} · ${d.system.cpu} · ${d.system.cores} cores · load ${d.system.loadAverage.join(' ')}`,
    `cpu flags: ${d.system.cpuFlags ? JSON.stringify(d.system.cpuFlags) : 'n/a'}`,
    `memory: host ${mb(d.system.memoryTotal)} (free ${mb(d.system.memoryFree)}), container limit ${mb(d.system.container.limit)}, usage ${mb(d.system.container.usage)}`,
    ...d.system.disks.map((x) => `disk ${x.path}: free ${mb(x.freeBytes)} of ${mb(x.totalBytes)}`),
    '',
  );
  out.push(`## Tools`, ...d.tools.map((t) => `${t.ok ? 'OK ' : 'ERR'} ${t.name}: ${t.version}`), '');
  out.push('## claudesynchro doctor', '```json', JSON.stringify(d.claudesynchro, null, 1), '```', '');
  out.push('## Config', '```json', JSON.stringify(d.config, null, 1), '```', '');
  out.push(
    `## Schedule`,
    `${d.schedule.description || 'disabled'} · next ${d.schedule.nextRun ? new Date(d.schedule.nextRun).toISOString() : '-'}`,
    '',
  );
  out.push('## State', '```json', JSON.stringify(d.state, null, 1), '```', '');
  out.push('## Recent runs', '```json', JSON.stringify(d.recentRuns, null, 1), '```', '');
  out.push(`## Recent failures (${d.failures.length})`);
  for (const f of d.failures) {
    out.push(`### ${f.engine} × ${f.failuresInARow} · ${f.time} · ${f.file}`, f.message ?? '');
    if (f.details) {
      out.push('```', f.details, '```');
    }
  }
  out.push('', `## Auto-skipped (${d.autoSkipped.length})`, ...d.autoSkipped.map((s) => `${s.engine}: ${s.file}`));
  out.push('', '## Server log (last 200 lines)', '```', ...d.serverLog, '```');
  return out.join('\n');
}
