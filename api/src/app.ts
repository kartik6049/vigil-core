import cors from 'cors';
import express from 'express';
import type { Express } from 'express';
import helmet from 'helmet';
import { requireAuth } from './auth.js';
import { asyncHandler, errorHandler, notFoundHandler } from './errors.js';
import { accountRoutes } from './routes/accounts.js';
import { adminRoutes } from './routes/admin.js';
import { authRoutes } from './routes/auth.js';
import { caseRoutes } from './routes/cases.js';
import { statsRoutes } from './routes/stats.js';
import { transactionRoutes } from './routes/transactions.js';
import type { AppDeps } from './types.js';

/** Builds the Express app from injected dependencies, so tests can pass their own pool and scorer. */
export function createApp(deps: AppDeps): Express {
  const { config, pool, hub } = deps;
  const app = express();

  app.disable('x-powered-by');
  if (config.trustProxy > 0) app.set('trust proxy', config.trustProxy); // needed behind Render's proxy for rate limiting
  app.use(helmet());
  app.use(
    cors({
      origin: config.corsOrigins, // allowlist: only the console's origin(s)
      methods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Service-Key'],
      maxAge: 600,
    }),
  );
  app.use(express.json({ limit: '100kb' }));

  app.get(
    '/health',
    asyncHandler(async (_req, res) => {
      await pool.query('select 1');
      res.json({ status: 'ok' });
    }),
  );

  app.use(authRoutes(deps)); // /auth/login, /me
  app.use('/transactions', transactionRoutes(deps));
  app.use('/accounts', accountRoutes(deps));
  app.use('/cases', caseRoutes(deps));
  app.use('/stats', statsRoutes(deps));
  app.use(adminRoutes(deps)); // /audit, /rules, /model/metrics, /devices/register, /ground-truth

  // Server-Sent Events. Auth is a normal Authorization header (clients use fetch/OkHttp streaming,
  // not the browser EventSource, so the token never has to go in the URL).
  app.get('/stream', requireAuth(config), (_req, res) => hub.add(res));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
