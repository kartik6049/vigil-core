import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { EventHub } from './events.js';
import { createScorer } from './scoring/client.js';
import type { Notifier } from './types.js';

const config = loadConfig();
const pool = createPool(config.databaseUrl);
const hub = new EventHub();

// Phase 3 replaces this with a Firebase Admin SDK sender.
const notifier: Notifier = { async priorityCaseOpened() {} };

const app = createApp({ config, pool, scorer: createScorer(config), hub, notifier });
hub.startHeartbeat();

// Refresh the hourly roll-up on a timer. REFRESH ... CONCURRENTLY means readers are never blocked.
// (If your host offers pg_cron, schedule `select refresh_hourly_stats()` there instead.)
async function refreshHourlyStats(): Promise<void> {
  try {
    await pool.query('select refresh_hourly_stats()');
  } catch (err) {
    console.error('mv_hourly_stats refresh failed', err);
  }
}
void refreshHourlyStats();
const refreshTimer = setInterval(refreshHourlyStats, config.mvRefreshSeconds * 1000);
refreshTimer.unref();

const server = app.listen(config.port, () => {
  console.log(`vigil-core api listening on :${config.port} (scoring: ${config.mlScoreUrl ?? 'built-in stub'})`);
});

function shutdown(signal: string): void {
  console.log(`${signal} received, shutting down`);
  hub.stop();
  server.close(() => {
    void pool.end().then(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
