import { createApp } from './app.js';
import { loadEnv } from './env.js';
import { createLogger } from './logger.js';
import { createRuntime } from './runtime.js';

const env = loadEnv();
const log = createLogger('server');

const app = createApp(createRuntime(env, log));

app.listen(env.port, () => {
  log.info('listening', {
    port: env.port,
    appBaseUrl: env.appBaseUrl,
    webhookPath: '/api/webhook',
    zohoSimulateFailure: env.zohoSimulateFailure,
  });
});
