import type Stripe from 'stripe';

import type { AuthPort, Repository, StoragePort } from './db/repository.js';
import type { AppEnv } from './env.js';
import type { Logger } from './logger.js';
import type { CrmSyncService } from './crm/syncPurchase.js';

/** Everything the app talks to, injected so tests can swap the whole world. */
export type AppDeps = {
  env: AppEnv;
  repo: Repository;
  storage: StoragePort;
  auth: AuthPort;
  stripe: Stripe;
  crm: CrmSyncService;
  log: Logger;
};
