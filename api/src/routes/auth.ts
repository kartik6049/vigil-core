import bcrypt from 'bcrypt';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { requireAuth, signToken } from '../auth.js';
import { asyncHandler, HttpError } from '../errors.js';
import type { AppDeps } from '../types.js';

const loginBody = z.object({
  email: z.string().trim().min(1).max(254),
  password: z.string().min(1).max(200),
});

// A real bcrypt hash (cost 12) of a throwaway string, computed once. Compared against when the
// email is unknown, so "no such user" and "wrong password" take the same time (no user enumeration).
const dummyHash: Promise<string> = bcrypt.hash('vigil-dummy-password', 12);

export function authRoutes(deps: AppDeps): Router {
  const { pool, config } = deps;
  const router = Router();

  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: () => config.rateLimitDisabled,
    handler: (_req, res) => {
      res.status(429).json({ error: { code: 'rate_limited', message: 'Too many login attempts, try again later' } });
    },
  });

  router.post(
    '/auth/login',
    loginLimiter,
    asyncHandler(async (req, res) => {
      const { email, password } = loginBody.parse(req.body);
      const r = await pool.query(
        'select id, email, name, role, password_hash from users where lower(email) = lower($1)',
        [email],
      );
      const row = r.rows[0];
      const ok = await bcrypt.compare(password, row ? (row.password_hash as string) : await dummyHash);
      if (!row || !ok) throw new HttpError(401, 'invalid_credentials', 'Incorrect email or password');

      const user = { id: row.id as string, email: row.email as string, name: row.name as string, role: row.role as 'analyst' | 'admin' };
      res.json({ token: signToken(config, user), user });
    }),
  );

  router.get(
    '/me',
    requireAuth(config),
    asyncHandler(async (req, res) => {
      const r = await pool.query('select id, email, name, role from users where id = $1', [req.user!.id]);
      if (!r.rows[0]) throw new HttpError(401, 'unauthorized', 'User no longer exists');
      res.json(r.rows[0]);
    }),
  );

  return router;
}
