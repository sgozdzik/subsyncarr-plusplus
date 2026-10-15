import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { ProcessingCoordinator } from './coordinator';
import { StateManager } from './stateManager';
import { join } from 'path';
import { existsSync } from 'fs';
import { getScanConfig } from './config';
import { readFile } from 'fs/promises';
import { claudesynchroReportPath } from './generateClaudesynchroSubtitles';
import { Scheduler } from './scheduler';
import { Library, isInsideScanPaths } from './library';
import { collectDiagnostics, renderReport } from './diagnostics';
import { SCHEDULE_TIMEZONE } from './settings';
import { getEnabledEngines } from './engines';

export class SubsyncarrPlusServer {
  private app = express();
  private httpServer = createServer(this.app);
  private wss = new WebSocketServer({ server: this.httpServer, path: '/ws' });
  private clients: Set<WebSocket> = new Set();

  constructor(
    private coordinator: ProcessingCoordinator,
    private stateManager: StateManager,
    private scheduler: Scheduler,
    private library: Library,
    private dbPath: string,
  ) {
    this.setupMiddleware();
    this.setupRoutes();
    this.setupWebSocket();
  }

  private setupMiddleware() {
    this.app.use(express.json());
    // `extensions` lets /library, /settings and /diagnostics serve the matching .html pages.
    this.app.use(express.static(join(__dirname, '../public'), { extensions: ['html'] }));
  }

  private setupRoutes() {
    // Get configuration status
    this.app.get('/api/config', (req, res) => {
      console.log(`[${new Date().toISOString()}] GET /api/config`);
      const config = getScanConfig();
      const isDefaultPath = config.includePaths.length === 1 && config.includePaths[0] === '/scan_dir';

      res.json({
        paths: config.includePaths,
        excludePaths: config.excludePaths,
        isConfigured: !isDefaultPath,
        schedule: this.scheduler.info(),
        timezone: SCHEDULE_TIMEZONE,
        engines: getEnabledEngines(),
      });
    });

    // Get current status
    this.app.get('/api/status', (req, res) => {
      console.log(`[${new Date().toISOString()}] GET /api/status`);
      const currentRun = this.stateManager.getCurrentRun();
      res.json({
        currentRun,
        files: currentRun ? this.stateManager.getFileResults(currentRun.id) : [],
        isRunning: this.coordinator.isRunning(),
        queued: this.coordinator.getQueue().length,
      });
    });

    // Get run history
    this.app.get('/api/history', (req, res) => {
      const limit = parseInt(req.query.limit as string, 10) || 50;
      console.log(`[${new Date().toISOString()}] GET /api/history (limit: ${limit})`);
      res.json(this.stateManager.getRunHistory(limit));
    });

    // Get specific run details
    this.app.get('/api/runs/:id', (req, res) => {
      console.log(`[${new Date().toISOString()}] GET /api/runs/${req.params.id}`);
      const currentRun = this.stateManager.getCurrentRun();
      const requestedId = req.params.id;

      // Check current run first
      if (currentRun && currentRun.id === requestedId) {
        return res.json({
          run: currentRun,
          files: this.stateManager.getFileResults(currentRun.id),
        });
      }

      // Check history
      const history = this.stateManager.getRunHistory(1000);
      const run = history.find((r) => r.id === requestedId);

      if (!run) {
        return res.status(404).json({ error: 'Run not found' });
      }

      res.json({
        run,
        files: this.stateManager.getFileResults(run.id),
      });
    });

    // Get logs for a specific run
    this.app.get('/api/runs/:id/logs', (req, res) => {
      console.log(`[${new Date().toISOString()}] GET /api/runs/${req.params.id}/logs`);
      const requestedId = req.params.id;

      // Check if run exists (current or historical)
      const currentRun = this.stateManager.getCurrentRun();
      const history = this.stateManager.getRunHistory(1000);
      const run = currentRun?.id === requestedId ? currentRun : history.find((r) => r.id === requestedId);

      if (!run) {
        return res.status(404).json({ error: 'Run not found' });
      }

      // Read logs from file
      const logs = this.stateManager.getRunLogs(requestedId);
      res.json({ logs });
    });

    // Start a new run (queued if another run is in progress)
    this.app.post('/api/run/start', async (req, res) => {
      const { paths } = req.body as { paths?: string[] };
      console.log(
        `[${new Date().toISOString()}] POST /api/run/start${paths ? ` (custom paths: ${paths.join(', ')})` : ' (default paths)'}`,
      );
      try {
        const result = await this.coordinator.submit(
          paths && paths.length > 0 ? { source: 'manual-paths', paths } : { source: 'manual' },
        );
        res.status(result.queued ? 202 : 200).json(result);
      } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
      }
    });

    // Run selected files from the Library. These also run engines that were auto-skipped after failures.
    this.app.post('/api/run/files', async (req, res) => {
      const { files, engines, force } = req.body as { files?: unknown; engines?: unknown; force?: unknown };
      if (!Array.isArray(files) || files.length === 0 || !files.every((f) => typeof f === 'string')) {
        return res.status(400).json({ error: 'files must be a non-empty list of paths' });
      }
      const outside = (files as string[]).filter((f) => !isInsideScanPaths(f) || !existsSync(f));
      if (outside.length > 0) {
        return res.status(400).json({ error: `Not a subtitle file in the scan paths: ${outside[0]}` });
      }
      console.log(`[${new Date().toISOString()}] POST /api/run/files (${files.length} file(s))`);
      try {
        const result = await this.coordinator.submit({
          source: 'library',
          files: files as string[],
          engines: Array.isArray(engines) ? (engines as string[]) : undefined,
          force: force === true,
        });
        res.status(result.queued ? 202 : 200).json(result);
      } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
      }
    });

    // Settings edited in the UI (schedule in Warsaw time, timeouts, failure policy)
    this.app.get('/api/settings', (_req, res) => {
      res.json({
        ...this.stateManager.settings.snapshot(),
        scheduleInfo: this.scheduler.info(),
        timezone: SCHEDULE_TIMEZONE,
        envCron: process.env.CRON_SCHEDULE || '0 0 * * *',
      });
    });

    this.app.put('/api/settings', (req, res) => {
      try {
        this.stateManager.settings.update(req.body ?? {});
        this.scheduler.apply();
        this.library.invalidate();
        console.log(`[${new Date().toISOString()}] Settings updated: ${JSON.stringify(req.body)}`);
        res.json({
          ...this.stateManager.settings.snapshot(),
          scheduleInfo: this.scheduler.info(),
          timezone: SCHEDULE_TIMEZONE,
          envCron: process.env.CRON_SCHEDULE || '0 0 * * *',
        });
      } catch (error) {
        res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid settings' });
      }
    });

    // Library: every subtitle file in the scan paths with per-engine status
    this.app.get('/api/library', async (req, res) => {
      try {
        res.json(await this.library.get(req.query.refresh === '1'));
      } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : 'Scan failed' });
      }
    });

    this.app.get('/api/library/file', async (req, res) => {
      const filePath = typeof req.query.path === 'string' ? req.query.path : '';
      if (!filePath || !isInsideScanPaths(filePath)) {
        return res.status(400).json({ error: 'path must be inside the scan paths' });
      }
      const library = await this.library.get();
      const db = this.stateManager.getDatabase();
      let report: unknown = null;
      try {
        report = JSON.parse(await readFile(claudesynchroReportPath(filePath), 'utf8'));
      } catch {
        report = null;
      }
      res.json({
        file: library.files.find((f) => f.path === filePath) ?? null,
        engineStates: db.getEngineStatesForFile(filePath),
        history: db.getFileHistory(filePath, 10).map((h) => ({ ...h, engines: JSON.parse(h.engines || '{}') })),
        claudesynchroReport: report,
        maxFailures: this.stateManager.settings.maxFailures(),
      });
    });

    // Diagnostics for remote debugging
    this.app.get('/api/diagnostics', async (_req, res) => {
      res.json(
        await collectDiagnostics({
          stateManager: this.stateManager,
          coordinator: this.coordinator,
          scheduler: this.scheduler,
          dbPath: this.dbPath,
        }),
      );
    });

    this.app.get('/api/diagnostics/report', async (req, res) => {
      const report = renderReport(
        await collectDiagnostics({
          stateManager: this.stateManager,
          coordinator: this.coordinator,
          scheduler: this.scheduler,
          dbPath: this.dbPath,
        }),
      );
      if (req.query.download === '1') {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        res.setHeader('Content-Disposition', `attachment; filename="subsyncarr-debug-${stamp}.md"`);
      }
      res.type('text/plain; charset=utf-8').send(report);
    });

    // Stop current run
    this.app.post('/api/run/stop', (_req, res) => {
      console.log(`[${new Date().toISOString()}] POST /api/run/stop`);
      try {
        this.coordinator.stopRun();
        res.json({ success: true });
      } catch (error) {
        console.log(
          `[${new Date().toISOString()}] Error stopping run: ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
        res.status(500).json({
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // Skip a file
    this.app.post('/api/file/skip', (req, res) => {
      const { filePath } = req.body;

      if (!filePath) {
        console.log(`[${new Date().toISOString()}] POST /api/file/skip - Missing filePath`);
        return res.status(400).json({ error: 'filePath required' });
      }

      console.log(`[${new Date().toISOString()}] POST /api/file/skip - ${filePath.split('/').pop()}`);
      this.coordinator.skipFile(filePath);
      res.json({ success: true });
    });

    // Clear completed files
    this.app.post('/api/files/clear', (req, res) => {
      console.log(`[${new Date().toISOString()}] POST /api/files/clear`);
      this.stateManager.clearCompletedFiles();

      // Broadcast updated state to all clients
      const currentRun = this.stateManager.getCurrentRun();
      this.broadcast({
        type: 'files:cleared',
        data: {
          currentRun,
          files: currentRun
            ? this.stateManager.getFileResults(currentRun.id).filter((f) => f.status === 'processing')
            : [],
        },
      });

      res.json({ success: true });
    });

    // claudesynchro report for one subtitle file (cuts found, dropped/filled lines, confidence)
    this.app.get('/api/claudesynchro/report', async (req, res) => {
      const filePath = typeof req.query.file === 'string' ? req.query.file : '';
      if (!filePath) {
        return res.status(400).json({ error: 'file required' });
      }
      try {
        const report = await readFile(claudesynchroReportPath(filePath), 'utf8');
        res.type('application/json').send(report);
      } catch {
        res.status(404).json({ error: 'No claudesynchro report for this file yet' });
      }
    });

    // Get skip status statistics
    this.app.get('/api/skip-status', (_req, res) => {
      console.log(`[${new Date().toISOString()}] GET /api/skip-status`);
      const stats = this.stateManager.getFailureStats();
      res.json(stats);
    });

    // Get skip status for specific file
    this.app.get('/api/skip-status/:filePath(*)', (req, res) => {
      const filePath = decodeURIComponent(req.params.filePath);
      console.log(`[${new Date().toISOString()}] GET /api/skip-status/${filePath.split('/').pop()}`);

      const skippedEngines = this.stateManager.getSkippedEngines(filePath);
      res.json({ filePath, skippedEngines });
    });

    // Reset skip status for a file
    this.app.post('/api/skip-status/reset', (req, res) => {
      const { filePath, engine } = req.body;

      if (!filePath) {
        return res.status(400).json({ error: 'filePath required' });
      }

      console.log(
        `[${new Date().toISOString()}] POST /api/skip-status/reset - ${filePath.split('/').pop()}${engine ? ` (${engine})` : ' (all engines)'}`,
      );

      this.stateManager.resetSkipStatus(filePath, engine);
      res.json({ success: true });
    });
  }

  private setupWebSocket() {
    this.wss.on('connection', (ws) => {
      console.log(`[${new Date().toISOString()}] WebSocket client connected (total: ${this.clients.size + 1})`);
      this.clients.add(ws);

      // Send initial state
      const currentRun = this.stateManager.getCurrentRun();
      ws.send(
        JSON.stringify({
          type: 'state',
          data: {
            currentRun,
            files: currentRun ? this.stateManager.getFileResults(currentRun.id) : [],
            isRunning: this.coordinator.isRunning(),
          },
        }),
      );

      ws.on('close', () => {
        this.clients.delete(ws);
        console.log(`[${new Date().toISOString()}] WebSocket client disconnected (total: ${this.clients.size})`);
      });
    });

    // Broadcast state changes to all clients
    this.stateManager.on('run:started', (run) => {
      console.log(`[${new Date().toISOString()}] Broadcasting run:started to ${this.clients.size} clients`);
      this.broadcast({ type: 'run:started', data: run });
    });

    this.stateManager.on('run:completed', (run) => {
      console.log(`[${new Date().toISOString()}] Broadcasting run:completed to ${this.clients.size} clients`);
      this.library.invalidate();
      this.broadcast({ type: 'run:completed', data: run });
    });

    this.stateManager.on('run:cancelled', (run) => {
      console.log(`[${new Date().toISOString()}] Broadcasting run:cancelled to ${this.clients.size} clients`);
      this.library.invalidate();
      this.broadcast({ type: 'run:cancelled', data: run });
    });

    this.stateManager.on('file:updated', ({ file, run }) => {
      this.broadcast({ type: 'file:updated', data: { file, run } });
    });
  }

  private broadcast(message: unknown) {
    const data = JSON.stringify(message);
    this.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    });
  }

  start(port: number = 3000, host: string = '127.0.0.1') {
    this.httpServer.listen(port, host, () => {
      console.log(`[${new Date().toISOString()}] Subsyncarr Plus UI available at http://${host}:${port}`);
    });
  }

  close() {
    this.httpServer.close();
    this.wss.close();
  }
}
