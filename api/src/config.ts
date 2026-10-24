import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().int().default(3000),
  APP_DATABASE_URL: z.string().optional(),
  DATABASE_URL: z.string().optional(),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  SERVICE_KEY: z.string().min(8, 'SERVICE_KEY must be at least 8 characters'),
  CORS_ORIGIN: z.string().default('http://localhost:8080'),
  ML_SCORE_URL: z.string().optional(),
  ML_TIMEOUT_MS: z.coerce.number().int().positive().default(800),
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  RATE_LIMIT_DISABLED: z.enum(['true', 'false']).default('false'),
  MV_REFRESH_SECONDS: z.coerce.number().int().positive().default(300),
});

export interface Config {
  port: number;
  databaseUrl: string;
  jwtSecret: string;
  serviceKey: string;
  corsOrigins: string[];
  mlScoreUrl?: string;
  mlTimeoutMs: number;
  trustProxy: number;
  rateLimitDisabled: boolean;
  mvRefreshSeconds: number;
}

/** Reads and validates environment variables once, at startup. Throws on bad config. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const e = envSchema.parse(env);
  const databaseUrl = e.APP_DATABASE_URL || e.DATABASE_URL;
  if (!databaseUrl) throw new Error('Set APP_DATABASE_URL (or DATABASE_URL)');
  return {
    port: e.PORT,
    databaseUrl,
    jwtSecret: e.JWT_SECRET,
    serviceKey: e.SERVICE_KEY,
    corsOrigins: e.CORS_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean),
    mlScoreUrl: e.ML_SCORE_URL ? e.ML_SCORE_URL : undefined,
    mlTimeoutMs: e.ML_TIMEOUT_MS,
    trustProxy: e.TRUST_PROXY,
    rateLimitDisabled: e.RATE_LIMIT_DISABLED === 'true',
    mvRefreshSeconds: e.MV_REFRESH_SECONDS,
  };
}
