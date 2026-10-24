-- Privileges for the API's database role. Idempotent: re-run after every migration
-- that adds tables (`npm run db:grants`). Requires the vigil_app role to exist.

grant usage on schema public to vigil_app;

-- Regular tables: full read/write
grant select, insert, update, delete on
  users, accounts, transactions, cases, rules, ground_truth, model_metrics_daily, device_tokens
to vigil_app;

-- audit_log is append-only: INSERT and SELECT, never UPDATE or DELETE
revoke all on audit_log from vigil_app;
grant select, insert on audit_log to vigil_app;

grant select on mv_hourly_stats to vigil_app;
grant usage, select on all sequences in schema public to vigil_app;
grant execute on function refresh_hourly_stats() to vigil_app;
