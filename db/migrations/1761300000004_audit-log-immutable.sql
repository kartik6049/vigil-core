-- Up Migration

-- Defence in depth for the append-only audit log. Grants (db/grants.sql) already withhold
-- UPDATE/DELETE from the app role; this trigger also stops mistakes by any other role
-- that is not the table owner doing a TRUNCATE (used only by the demo-reset job).
create function audit_log_block_mutation() returns trigger
language plpgsql as $$
begin
  raise exception 'audit_log is append-only (% not allowed)', tg_op
    using errcode = 'insufficient_privilege';
end;
$$;

create trigger audit_log_no_update_delete
  before update or delete on audit_log
  for each row execute function audit_log_block_mutation();

-- Down Migration

drop trigger audit_log_no_update_delete on audit_log;
drop function audit_log_block_mutation();
