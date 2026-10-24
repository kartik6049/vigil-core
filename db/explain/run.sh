#!/usr/bin/env bash
# Measures the three queries behind the README's EXPLAIN ANALYZE table, with and without their index/view.
# Everything runs in a throwaway database filled with SYNTHETIC rows. Nothing touches your real data.
#
# Usage:  PGHOST=localhost PGPORT=5432 PGUSER=vigil PGPASSWORD=vigil ROWS=1000000 bash db/explain/run.sh
# The role needs CREATEDB. Output: a markdown table on stdout (copy into the README).
set -euo pipefail

ROWS="${ROWS:-1000000}"
RUNS="${RUNS:-7}"
DB="vigil_bench_$$"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/../.."

psql_admin() { psql -X -q -v ON_ERROR_STOP=1 -d postgres "$@"; }
psql_db()    { psql -X -q -v ON_ERROR_STOP=1 -d "$DB" "$@"; }

psql_admin -c "create database $DB"
trap 'psql_admin -c "drop database if exists $DB" >/dev/null' EXIT

# Apply only the "Up" half of every migration, in order.
for f in "$ROOT"/db/migrations/*.sql; do
  awk '/^-- Down Migration/{exit} {print}' "$f" | psql_db -f - >/dev/null
done

# Synthetic data: 150 accounts, $ROWS transactions over 30 days, ~0.5% of them become cases.
psql_db >/dev/null <<SQL
insert into accounts (holder_name, kind, merchant_category, city)
select 'Account ' || g, case when g % 5 = 0 then 'merchant' else 'customer' end,
       case when g % 5 = 0 then 'grocery' end, 'Mumbai' from generate_series(1, 150) g;

insert into transactions (external_ref, from_account_id, to_account_id, type, channel, amount,
                          ip_city, created_at, risk_score, risk_band, status)
select 'bench-' || g,
       1 + (g::bigint * 7919) % 150, 1 + (g::bigint * 104729) % 150,
       'PAYMENT', 'UPI', round((random() * 20000 + 10)::numeric, 2), 'Mumbai',
       now() - (g::float8 / $ROWS) * interval '30 days',
       s, case when s >= 0.7 then 'high' when s >= 0.3 then 'medium' else 'low' end::risk_band,
       case when s >= 0.7 then 'flagged' else 'approved' end::txn_status
  from (select g, random() as s from generate_series(1, $ROWS) g) x;

-- A history of resolved cases plus a small live queue.
insert into cases (transaction_id, status, priority, opened_at, resolved_at, resolution_note)
select id, case when random() < 0.5 then 'blocked' else 'cleared' end::case_status, 2,
       created_at, created_at + interval '1 hour', 'bench'
  from transactions where risk_band = 'high' and random() < 0.1;
insert into cases (transaction_id, status, priority, opened_at)
select t.id, 'open', 1 + (t.id % 2)::int, t.created_at
  from transactions t where t.risk_band = 'high' and not exists (select 1 from cases c where c.transaction_id = t.id)
  order by t.id desc limit 300;
analyze;
SQL

ratio() { awk "BEGIN{ if ($2 <= 0) print \"n/a\"; else printf \"%.1fx\", $1/$2 }"; }

# Median execution time (ms) of a statement, using EXPLAIN (ANALYZE) so the planner's real work is timed.
median_ms() {
  local sql="$1" i out
  local -a t=()
  psql_db -c "$sql" >/dev/null   # warm the cache
  for ((i = 0; i < RUNS; i++)); do
    out=$(psql_db -At -c "explain (analyze, buffers) $sql" | awk '/^Execution Time/{print $3}')
    t+=("$out")
  done
  printf '%s\n' "${t[@]}" | sort -n | awk '{a[NR]=$1} END{print a[int((NR+1)/2)]}'
}
plan_head() { psql_db -At -c "explain $1" | head -3 | sed 's/  */ /g' | tr '\n' ' ' | cut -c1-110; }

Q_VEL="select count(*) from transactions where from_account_id = 42 and created_at > now() - interval '10 minutes' and created_at <= now()"
Q_HIST="select id from transactions where from_account_id = 42 order by created_at desc, id desc limit 20"
Q_QUEUE="select c.id from cases c where c.status in ('open','in_review') order by c.priority, c.opened_at limit 50"
Q_HOUR_RAW="select date_trunc('hour', created_at) as hour, count(*), count(*) filter (where status <> 'approved'), sum(amount) filter (where status = 'blocked'), avg(risk_score) from transactions where created_at >= now() - interval '7 days' group by 1 order by 1"
Q_HOUR_MV="select hour, txn_count, flagged_count, blocked_amount, avg_risk from mv_hourly_stats where hour >= now() - interval '7 days' order by hour"

psql_db -c "refresh materialized view mv_hourly_stats" >/dev/null

# --- BEFORE: drop the supporting structures ---
psql_db -c "drop index transactions_from_account_idx; drop index cases_queue_idx;" >/dev/null
vel_b=$(median_ms "$Q_VEL"); hist_b=$(median_ms "$Q_HIST"); hist_b_plan=$(plan_head "$Q_HIST")
que_b=$(median_ms "$Q_QUEUE"); que_b_plan=$(plan_head "$Q_QUEUE")
hr_b=$(median_ms "$Q_HOUR_RAW")

# --- AFTER: recreate them exactly as the migration does ---
psql_db >/dev/null <<'SQL'
create index transactions_from_account_idx on transactions (from_account_id, created_at desc);
create index cases_queue_idx on cases (priority, opened_at) where status in ('open', 'in_review');
analyze;
SQL
vel_a=$(median_ms "$Q_VEL"); hist_a=$(median_ms "$Q_HIST"); hist_a_plan=$(plan_head "$Q_HIST")
que_a=$(median_ms "$Q_QUEUE"); que_a_plan=$(plan_head "$Q_QUEUE")
hr_a=$(median_ms "$Q_HOUR_MV")

total=$(psql_db -At -c "select count(*) from transactions")
cases_n=$(psql_db -At -c "select count(*) from cases"); live_n=$(psql_db -At -c "select count(*) from cases where status in ('open','in_review')")
ver=$(psql_db -At -c "show server_version")

cat <<MD
Measured on PostgreSQL $ver, $(nproc) vCPU, $total synthetic transactions, $cases_n cases ($live_n live). Median of $RUNS warm runs of \`EXPLAIN (ANALYZE, BUFFERS)\`, execution time only.

| Query | Before | After | Change |
|---|---|---|---|
| Velocity rule, one account, 10-minute window | ${vel_b} ms | ${vel_a} ms | $(ratio $vel_b $vel_a) |
| Account history, last 20 transactions | ${hist_b} ms | ${hist_a} ms | $(ratio $hist_b $hist_a) |
| Case queue (50 live cases, priority then age) | ${que_b} ms | ${que_a} ms | $(ratio $que_b $que_a) |
| 7-day hourly chart | ${hr_b} ms | ${hr_a} ms | $(ratio $hr_b $hr_a) |

Plans (first lines):
- history before: ${hist_b_plan}
- history after: ${hist_a_plan}
- queue before: ${que_b_plan}
- queue after: ${que_a_plan}
MD
