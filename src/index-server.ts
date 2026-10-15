import { captureConsole } from './debugLog';
import { ProcessingEngine } from './processingEngine';
import { StateManager } from './stateManager';
import { ProcessingCoordinator } from './coordinator';
import { SubsyncarrPlusServer } from './server';
import { getRetentionConfig } from './config';
import { Scheduler } from './scheduler';
import { Library } from './library';

// Keep recent log lines for the Diagnostics page.
captureConsole();

async function main() {
  const dbPath = process.env.DB_PATH || '/app/data/subsyncarr-plus.db';
  const port = parseInt(process.env.WEB_PORT || '3000', 10);
  const host = process.env.WEB_HOST || '127.0.0.1';

  console.log(`[${new Date().toISOString()}] Initializing Subsyncarr Plus Server...`);

  const stateManager = new StateManager(dbPath);
  const engine = new ProcessingEngine();
  const coordinator = new ProcessingCoordinator(engine, stateManager);
  // Scheduled runs: daily time set in the UI (Warsaw time) or CRON_SCHEDULE
  const scheduler = new Scheduler(stateManager.settings, async () => {
    console.log(`[${new Date().toISOString()}] Starting scheduled run`);
    try {
      await coordinator.startRun({ source: 'scheduled' });
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Scheduled run failed:`, error);
    }
  });
  scheduler.apply();

  const library = new Library(stateManager);
  const server = new SubsyncarrPlusServer(coordinator, stateManager, scheduler, library, dbPath);

  // Start HTTP server
  server.start(port, host);

  // Setup periodic database cleanup
  const retentionConfig = getRetentionConfig();
  const cleanupIntervalMs = retentionConfig.cleanupIntervalHours * 60 * 60 * 1000;

  setInterval(() => {
    console.log(`[${new Date().toISOString()}] Running database cleanup...`);

    const db = stateManager.getDatabase();
    const logFileManager = stateManager.getLogFileManager();

    // Trim old logs first (database field is now unused but kept for compatibility)
    const trimmed = db.trimOldLogs(retentionConfig.trimLogsDays, retentionConfig.maxLogSizeBytes);
    if (trimmed > 0) {
      console.log(`[${new Date().toISOString()}] Trimmed logs for ${trimmed} runs`);
    }

    // Delete old log files
    const deletedLogFiles = logFileManager.deleteOldLogs(retentionConfig.keepRunsDays);
    if (deletedLogFiles > 0) {
      console.log(`[${new Date().toISOString()}] Deleted ${deletedLogFiles} old log files`);
    }

    // Delete very old runs
    const deleted = db.deleteOldRuns(retentionConfig.keepRunsDays);
    if (deleted > 0) {
      console.log(`[${new Date().toISOString()}] Deleted ${deleted} old runs`);
      db.vacuum(); // Reclaim space
      console.log(`[${new Date().toISOString()}] Database vacuumed`);
    }

    const stats = db.getDatabaseStats();
    console.log(`[${new Date().toISOString()}] Database size: ${(stats.sizeBytes / 1024 / 1024).toFixed(2)} MB`);
  }, cleanupIntervalMs);

  // Run cleanup on startup after 5 seconds
  setTimeout(() => {
    console.log(`[${new Date().toISOString()}] Running initial database cleanup...`);
    const db = stateManager.getDatabase();
    const logFileManager = stateManager.getLogFileManager();
    db.trimOldLogs(retentionConfig.trimLogsDays, retentionConfig.maxLogSizeBytes);
    logFileManager.deleteOldLogs(retentionConfig.keepRunsDays);
    db.deleteOldRuns(retentionConfig.keepRunsDays);
    db.vacuum();
  }, 5000);

  // Log memory usage periodically
  setInterval(
    () => {
      const usage = process.memoryUsage();
      console.log(
        `[${new Date().toISOString()}] Memory: RSS=${(usage.rss / 1024 / 1024).toFixed(1)}MB, Heap=${(usage.heapUsed / 1024 / 1024).toFixed(1)}MB/${(usage.heapTotal / 1024 / 1024).toFixed(1)}MB`,
      );
    },
    5 * 60 * 1000,
  ); // Every 5 minutes

  // Graceful shutdown
  process.on('SIGTERM', () => {
    console.log(`[${new Date().toISOString()}] SIGTERM received, shutting down gracefully...`);
    server.close();
    stateManager.close();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
