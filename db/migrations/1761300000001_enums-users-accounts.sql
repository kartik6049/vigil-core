-- Up Migration

create type user_role   as enum ('analyst', 'admin');
create type txn_type    as enum ('PAYMENT', 'TRANSFER', 'CASH_OUT', 'CASH_IN', 'DEBIT');
create type txn_channel as enum ('UPI', 'CARD', 'NETBANKING', 'WALLET');
create type txn_status  as enum ('approved', 'flagged', 'blocked', 'cleared');
create type risk_band   as enum ('low', 'medium', 'high');
create type case_status as enum ('open', 'in_review', 'blocked', 'cleared');

create table users (
  id            uuid primary key default gen_random_uuid(),
  email         text unique not null,
  name          text not null,
  password_hash text not null,
  role          user_role not null default 'analyst',
  created_at    timestamptz not null default now()
);

create table accounts (
  id                bigserial primary key,
  holder_name       text not null,
  kind              text not null check (kind in ('customer', 'merchant')),
  merchant_category text,
  city              text not null,
  status            text not null default 'active' check (status in ('active', 'blocked')),
  created_at        timestamptz not null default now()
);

-- Down Migration

drop table accounts;
drop table users;
drop type case_status;
drop type risk_band;
drop type txn_status;
drop type txn_channel;
drop type txn_type;
drop type user_role;
