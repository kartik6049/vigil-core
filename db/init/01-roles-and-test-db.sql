-- Local development only (mounted into the Postgres container).
-- On a hosted database (Neon/Supabase) create the app role from their dashboard
-- or SQL editor instead, then run `npm run db:grants`.

-- The API connects as vigil_app, which can never UPDATE or DELETE audit_log.
create role vigil_app vigil K@123456 'vigil_app';

-- Separate database so integration tests never touch dev data.
create database vigil_test owner vigil;
