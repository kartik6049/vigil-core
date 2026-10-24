import type { Pool } from 'pg';
import type { Config } from './config.js';
import type { EventHub } from './events.js';
import type { Scorer } from './scoring/client.js';

/** Hook for Phase 3 (Firebase push). A no-op today. */
export interface Notifier {
  priorityCaseOpened(info: { caseId: number; transactionId: number }): Promise<void>;
}

export interface AppDeps {
  config: Config;
  pool: Pool;
  scorer: Scorer;
  hub: EventHub;
  notifier: Notifier;
}

export type Role = 'analyst' | 'admin';

export interface AuthUser {
  id: string;
  role: Role;
  email: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}
