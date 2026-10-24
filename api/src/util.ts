import type { QueryResultRow } from 'pg';
import { z } from 'zod';
import { HttpError } from './errors.js';

export function parseId(value: string | undefined, name = 'id'): number {
  const n = Number(value);
  if (!value || !Number.isInteger(n) || n <= 0) {
    throw new HttpError(400, 'invalid_id', `${name} must be a positive integer`);
  }
  return n;
}

export const iso = (d: Date | string): string => (d instanceof Date ? d : new Date(d)).toISOString();

/* ---------- cursor pagination ---------- */

export function encodeCursor(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

export function decodeCursor<T>(raw: string | undefined, schema: z.ZodType<T>): T | undefined {
  if (!raw) return undefined;
  try {
    return schema.parse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')));
  } catch {
    throw new HttpError(400, 'invalid_cursor', 'Cursor is invalid');
  }
}

export const limitParam = (def: number, max: number) =>
  z.coerce.number().int().min(1).max(max).default(def);

/** Splits limit+1 fetched rows into a page and a flag saying whether more exist. */
export function paginate<T extends QueryResultRow>(rows: T[], limit: number): { page: T[]; hasMore: boolean } {
  return { page: rows.slice(0, limit), hasMore: rows.length > limit };
}

/* ---------- shared zod pieces ---------- */

/** Money as a plain decimal in rupees: "18500", "18500.5", "18500.50". */
export const moneyString = z
  .union([z.number(), z.string()])
  .transform((v) => String(v))
  .pipe(z.string().regex(/^\d{1,12}(\.\d{1,2})?$/, 'must be a non-negative amount with up to 2 decimals'));

export const isoDate = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)), 'must be an ISO 8601 date or timestamp');
