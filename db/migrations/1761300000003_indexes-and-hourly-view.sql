-- Up Migration

-- Indexes the dashboard and rules depend on
create index transactions_created_at_idx   on transactions (created_at desc);
create index transactions_from_account_idx on transactions (from_account_id, created_at desc);  -- velocity rules
create index transactions_band_idx         on transactions (risk_band, created_at desc);
-- Partial index: only the live queue is indexed, so it stays small as cases are resolved
create index cases_queue_idx on cases (priority, opened_at) where status in ('open', 'in_review');

-- Hourly roll-up for charts, refreshed every 5 minutes
create materialized view mv_hourly_stats as
select date_trunc('hour', created_at)                    as hour,
       count(*)                                          as txn_count,
       count(*) filter (where status <> 'approved')      as flagged_count,
       sum(amount) filter (where status = 'blocked')     as blocked_amount,
       avg(risk_score)                                   as avg_risk
from transactions
group by 1;

create unique index mv_hourly_stats_hour_idx on mv_hourly_stats (hour);  -- required for REFRESH ... CONCURRENTLY

-- Only the view owner may refresh a materialized view. The API role is not the owner,
-- so it calls this SECURITY DEFINER function instead (no extra privileges granted).
create function refresh_hourly_stats() returns void
language sql security definer set search_path = public
as $$ refresh materialized view concurrently mv_hourly_stats $$;

-- Down Migration

drop function refresh_hourly_stats();
drop materialized view mv_hourly_stats;
drop index cases_queue_idx;
drop index transactions_band_idx;
drop index transactions_from_account_idx;
drop index transactions_created_at_idx;
