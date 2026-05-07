-- =============================================================
-- 00-extensions.sql
-- Supabase / PostgreSQL extensions used by this project.
--
-- Exported: 2026-05-07  (reconstructed from observed schema)
-- Environment: Supabase (PostgreSQL 15+)
--
-- NOTE: Most extensions below are enabled by default on every
--       Supabase project.  Run in SQL Editor only if missing.
-- =============================================================

-- uuid_generate_v4() — legacy alias still referenced by some older
-- triggers; gen_random_uuid() (built-in pg15) is preferred for new code.
CREATE EXTENSION IF NOT EXISTS "uuid-ossp"     WITH SCHEMA extensions;

-- pgcrypto — provides gen_random_bytes, crypt(), etc.
CREATE EXTENSION IF NOT EXISTS "pgcrypto"      WITH SCHEMA extensions;

-- pg_stat_statements — query performance insight (Supabase default)
CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA extensions;
