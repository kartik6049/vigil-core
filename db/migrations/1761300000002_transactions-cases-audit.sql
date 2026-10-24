-- Up Migration

create table transactions (
  id               bigserial primary key,
  external_ref     text unique not null,            -- idempotency key from the sender
  from_account_id  bigint not null references accounts(id),
  to_account_id    bigint not null references accounts(id),
  type             txn_type not null,
  channel          txn_channel not null,
  amount           numeric(14,2) not null check (amount > 0),
  old_balance_orig numeric(14,2),
  new_balance_orig numeric(14,2),
  old_balance_dest numeric(14,2),
  new_balance_dest numeric(14,2),
  ip_city          text,
  device_id        text,
  created_at       timestamptz not null default now(),
  risk_score       numeric(5,4),
  risk_band        risk_band,
  model_version    text,
  reasons          jsonb not null default '[]',     -- model (SHAP) and rule reasons
  status           txn_status not null default 'approved'
);

create table cases (
  id              bigserial primary key,
  transaction_id  bigint unique not null references transactions(id),
  status          case_status not null default 'open',
  priority        smallint not null default 2,      -- 1 = highest
  assigned_to     uuid references users(id),
  opened_at       timestamptz not null default now(),
  resolved_at     timestamptz,
  resolution_note text,
  version         int not null default 0            -- optimistic locking
);

create table audit_log (                            -- append-only
  id          bigserial primary key,
  actor_id    uuid references users(id),
  action      text not null,                        -- e.g. 'case.claim', 'case.block'
  entity_type text not null,
  entity_id   text not null,
  before      jsonb,
  after       jsonb,
  created_at  timestamptz not null default now()
);

create table rules (
  id      serial primary key,
  name    text unique not null,                     -- e.g. 'velocity_5_in_10m'
  params  jsonb not null,
  enabled boolean not null default true
);

create table ground_truth (                         -- delayed labels, like a chargeback feed
  transaction_id bigint primary key references transactions(id),
  is_fraud       boolean not null,
  reported_at    timestamptz not null
);

create table model_metrics_daily (
  day            date not null,
  model_version  text not null,
  precision_at_t numeric,
  recall_at_t    numeric,
  pr_auc         numeric,
  psi_amount     numeric,
  psi_score      numeric,
  primary key (day, model_version)
);

create table device_tokens (
  fcm_token  text primary key,
  user_id    uuid not null references users(id),
  updated_at timestamptz not null default now()
);

-- Down Migration

drop table device_tokens;
drop table model_metrics_daily;
drop table ground_truth;
drop table rules;
drop table audit_log;
drop table cases;
drop table transactions;
