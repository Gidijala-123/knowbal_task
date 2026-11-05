import { createApp } from './app.js';
import { loadEnv } from './env.js';
import { createLogger } from './logger.js';
import { createRuntime } from './runtime.js';

const env = loadEnv();
const log = createLogger('server');

const app = createApp(createRuntime(env, log));

const server = app.listen(env.port, () => {
  log.info('listening', {
    port: env.port,
    appBaseUrl: env.appBaseUrl,
    trustProxy: env.trustProxy,
    webhookPath: '/api/webhook',
    zohoSimulateFailure: env.zohoSimulateFailure,
    supabaseProject: env.supabaseUrl.replace('https://', '').split('.')[0],
  });
});

// A platform sends SIGTERM to roll a deploy. Stop accepting connections and
// drop idle keep-alive sockets so in-flight requests can finish, then force
// after the deadline — a hung client socket must not block the new version.
const SHUTDOWN_TIMEOUT_MS = 10_000;

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    log.info('shutdown started', { signal, timeoutMs: SHUTDOWN_TIMEOUT_MS });
    server.close((err) => {
      if (err) {
        log.error('shutdown with error', { error: err instanceof Error ? err.message : String(err) });
        process.exitCode = 1;
        return;
      }
      log.info('shutdown complete');
    });
    server.closeIdleConnections();
    setTimeout(() => {
      log.warn('forcing exit, connections still open', { timeoutMs: SHUTDOWN_TIMEOUT_MS });
      server.closeAllConnections();
    }, SHUTDOWN_TIMEOUT_MS).unref();
  });
}
