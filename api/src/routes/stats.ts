import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth.js';
import { asyncHandler, HttpError } from '../errors.js';
import type { AppDeps } from '../types.js';
import { iso, isoDate } from '../util.js';

const RANGES: Record<string, number> = {
  '1h': 3_600_000,
  '6h': 21_600_000,
  '24h': 86_400_000,
  '7d': 7 * 86_400_000,
  '30d': 30 * 86_400_000,
};
const rangeParam = (def: string) => z.enum(['1h', '6h', '24h', '7d', '30d']).default(def as '24h');
const sinceFor = (range: string) => new Date(Date.now() - RANGES[range]);

const hourlyQuery = z.object({ from: isoDate.optional(), to: isoDate.optional() });

export function statsRoutes(deps: AppDeps): Router {
  const { pool, config } = deps;
  const router = Router();
  router.use(requireAuth(config));

  // Headline KPIs for the Overview page.
  router.get(
    '/overview',
    asyncHandler(async (req, res) => {
      const { range } = z.object({ range: rangeParam('24h') }).parse(req.query);
      const since = sinceFor(range);
      const r = await pool.query(
        `select
           (select count(*) from transactions where created_at >= $1)                                  as txn_count,
           (select count(*) from transactions where created_at >= $1 and status <> 'approved')         as flagged_count,
           (select coalesce(sum(amount), 0) from transactions where created_at >= $1 and status = 'blocked') as blocked_amount,
           (select count(*) from cases where status in ('open', 'in_review'))                          as open_cases,
           (select (percentile_cont(0.5) within group (order by extract(epoch from (resolved_at - opened_at))))::float8
              from cases where resolved_at >= $1)                                                      as median_seconds`,
        [since],
      );
      const row = r.rows[0];
      res.json({
        range,
        since: iso(since),
        txn_count: row.txn_count,
        flagged_count: row.flagged_count,
        blocked_amount: Number(row.blocked_amount).toFixed(2),
        open_cases: row.open_cases,
        median_time_to_resolve_seconds: row.median_seconds,
      });
    }),
  );

  // Hourly roll-up from the materialized view (refreshed every few minutes, so it can lag slightly).
  router.get(
    '/hourly',
    asyncHandler(async (req, res) => {
      const q = hourlyQuery.parse(req.query);
      const to = q.to ? new Date(q.to) : new Date();
      const from = q.from ? new Date(q.from) : new Date(to.getTime() - RANGES['24h']);
      if (to.getTime() - from.getTime() > 31 * 86_400_000) {
        throw new HttpError(400, 'range_too_large', 'Maximum range is 31 days');
      }
      const r = await pool.query(
        `select hour, txn_count, flagged_count, blocked_amount, avg_risk::float8 as avg_risk
           from mv_hourly_stats
          where hour >= date_trunc('hour', $1::timestamptz) and hour <= $2::timestamptz
          order by hour`,
        [from, to],
      );
      res.json({
        items: r.rows.map((x) => ({
          hour: iso(x.hour),
          txn_count: x.txn_count,
          flagged_count: x.flagged_count,
          blocked_amount: Number(x.blocked_amount ?? 0).toFixed(2),
          avg_risk: x.avg_risk,
        })),
      });
    }),
  );

  // Share of transactions to each merchant category that were flagged (plus confirmed fraud from delayed labels).
  router.get(
    '/merchants',
    asyncHandler(async (req, res) => {
      const { range } = z.object({ range: rangeParam('7d') }).parse(req.query);
      const r = await pool.query(
        `select a.merchant_category as category,
                count(*)                                   as txn_count,
                count(*) filter (where t.status <> 'approved') as flagged_count,
                count(*) filter (where g.is_fraud)         as confirmed_fraud_count
           from transactions t
           join accounts a on a.id = t.to_account_id and a.kind = 'merchant'
           left join ground_truth g on g.transaction_id = t.id
          where t.created_at >= $1
          group by a.merchant_category
          order by flagged_count desc, category`,
        [sinceFor(range)],
      );
      res.json({
        range,
        items: r.rows.map((x) => ({
          category: x.category ?? 'uncategorised',
          txn_count: x.txn_count,
          flagged_count: x.flagged_count,
          flag_rate: x.txn_count ? x.flagged_count / x.txn_count : 0,
          confirmed_fraud_count: x.confirmed_fraud_count,
        })),
      });
    }),
  );

  // Flagged transactions by city (IP city when known, otherwise the account's home city).
  router.get(
    '/cities',
    asyncHandler(async (req, res) => {
      const { range } = z.object({ range: rangeParam('24h') }).parse(req.query);
      const r = await pool.query(
        `select coalesce(t.ip_city, a.city) as city,
                count(*) filter (where t.status <> 'approved') as flagged_count,
                count(*) filter (where t.status = 'blocked')   as blocked_count,
                count(*)                                       as txn_count
           from transactions t
           join accounts a on a.id = t.from_account_id
          where t.created_at >= $1
          group by 1
         having count(*) filter (where t.status <> 'approved') > 0
          order by flagged_count desc, city`,
        [sinceFor(range)],
      );
      res.json({ range, items: r.rows });
    }),
  );

  return router;
}
