-- ═══════════════════════════════════════════════════════════════
-- mocount — schema (SPEC §2)
-- Idempotent. Safe to re-run on the Supabase project.
-- Run this BEFORE seed.sql.
-- ═══════════════════════════════════════════════════════════════

-- pgcrypto is on by default in Supabase, but assert it for portability.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── users ───────────────────────────────────────────────────
-- Allowlist + RBAC. Auth flow checks active=true on every request.
-- created_by is nullable so the seed entries can be created without
-- a chicken-and-egg reference.
CREATE TABLE IF NOT EXISTS users (
  id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  email                    text        UNIQUE NOT NULL,
  name                     text,
  role                     text        NOT NULL CHECK (role IN ('admin','viewer')),
  receives_monthly_email   boolean     NOT NULL DEFAULT false,
  active                   boolean     NOT NULL DEFAULT true,
  created_at               timestamptz NOT NULL DEFAULT now(),
  created_by               uuid        REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_users_active_email ON users(active, email);

-- ── numbers ─────────────────────────────────────────────────
-- One row per SC or VLN. margin = selling - purchase, derived not stored.
CREATE TABLE IF NOT EXISTS numbers (
  id                      uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  number                  text           UNIQUE NOT NULL,
  type                    text           NOT NULL CHECK (type IN ('SC','VLN')),
  country                 text,
  client                  text,
  purchase_price_per_mo   numeric(10,4)  NOT NULL,
  selling_price_per_mo    numeric(10,4)  NOT NULL,
  active                  boolean        NOT NULL DEFAULT true,
  created_at              timestamptz    NOT NULL DEFAULT now(),
  updated_at              timestamptz    NOT NULL DEFAULT now(),
  updated_by              uuid           REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_numbers_active_type ON numbers(active, type);
CREATE INDEX IF NOT EXISTS idx_numbers_client ON numbers(client) WHERE client IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_numbers_country ON numbers(country) WHERE country IS NOT NULL;

-- ── daily_volumes ───────────────────────────────────────────
-- Upsert key: (number_id, date). Trigger below blocks writes inside
-- approved months — service layer also enforces but the trigger is the
-- last line of defence.
CREATE TABLE IF NOT EXISTS daily_volumes (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  number_id   uuid        NOT NULL REFERENCES numbers(id) ON DELETE CASCADE,
  date        date        NOT NULL,
  volume      bigint      NOT NULL CHECK (volume >= 0),
  entered_by  uuid        REFERENCES users(id) ON DELETE SET NULL,
  entered_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (number_id, date)
);
CREATE INDEX IF NOT EXISTS idx_daily_volumes_date ON daily_volumes(date);
CREATE INDEX IF NOT EXISTS idx_daily_volumes_number_date ON daily_volumes(number_id, date);

-- ── fees ────────────────────────────────────────────────────
-- type IN ('monthly','yearly','setup'); side IN ('cost','sale').
--   monthly — recurring every calendar month from effective_from
--   yearly  — recurring once a year, in the calendar month of effective_from
--   setup   — one-off, charged in the calendar month of effective_from
-- Service layer guarantees at most one ACTIVE recurring fee per
-- (number, type, side) — editing closes the previous via effective_to
-- and inserts a new row. Setup fees aren't "active"; they're per-event.
CREATE TABLE IF NOT EXISTS fees (
  id              uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  number_id       uuid           NOT NULL REFERENCES numbers(id) ON DELETE CASCADE,
  type            text           NOT NULL CHECK (type IN ('monthly','yearly','setup')),
  side            text           NOT NULL CHECK (side IN ('cost','sale')),
  amount          numeric(10,2)  NOT NULL,
  effective_from  date           NOT NULL,
  effective_to    date,
  created_at      timestamptz    NOT NULL DEFAULT now(),
  created_by      uuid           REFERENCES users(id) ON DELETE SET NULL
);

-- Idempotent on a fresh DB; existing DBs need a one-time migration —
-- see db/migrations/2026-05-07_fees_yearly.sql for the live update.
DO $$ BEGIN
  ALTER TABLE fees DROP CONSTRAINT IF EXISTS fees_type_check;
  ALTER TABLE fees ADD CONSTRAINT fees_type_check CHECK (type IN ('monthly','yearly','setup'));
END $$;
CREATE INDEX IF NOT EXISTS idx_fees_number_side_type ON fees(number_id, side, type);
CREATE INDEX IF NOT EXISTS idx_fees_effective ON fees(effective_from, effective_to);

-- ── monthly_closes ──────────────────────────────────────────
-- One row per month ('YYYY-MM'). Status drives the volume-write lock.
CREATE TABLE IF NOT EXISTS monthly_closes (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  month           text        UNIQUE NOT NULL,
  status          text        NOT NULL CHECK (status IN ('pending','approved','sent')),
  snapshot        jsonb,
  prepared_at     timestamptz,
  approved_at     timestamptz,
  approved_by     uuid        REFERENCES users(id) ON DELETE SET NULL,
  email_sent_at   timestamptz
);
CREATE INDEX IF NOT EXISTS idx_monthly_closes_status ON monthly_closes(status);

-- ── slack_config (single-row config, upsert pattern) ───────
CREATE TABLE IF NOT EXISTS slack_config (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_url    text,
  enabled        boolean     NOT NULL DEFAULT false,
  send_time_utc  text        NOT NULL DEFAULT '06:00',
  last_sent_for  date,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- ── audit_log ───────────────────────────────────────────────
-- Every financial mutation + every user mutation lands here.
CREATE TABLE IF NOT EXISTS audit_log (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        REFERENCES users(id) ON DELETE SET NULL,
  action      text        NOT NULL,
  entity      text,
  entity_id   text,
  diff        jsonb,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_log_at ON audit_log(at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log(entity, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_user ON audit_log(user_id);

-- ═══════════════════════════════════════════════════════════════
-- Trigger: refuse daily_volumes writes inside an approved/sent month.
-- SPEC §12: "Approved months: writes refused at DB layer (trigger) AND
-- service layer." Service-layer check is faster + gives nicer errors;
-- this trigger is the no-bypass guarantee.
-- ═══════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION daily_volumes_lock_approved_month()
RETURNS TRIGGER AS $$
DECLARE
  v_status text;
  v_month  text;
BEGIN
  v_month := to_char(NEW.date, 'YYYY-MM');
  SELECT status INTO v_status FROM monthly_closes WHERE month = v_month;
  IF v_status IN ('approved', 'sent') THEN
    RAISE EXCEPTION 'Month % is closed (status=%); daily_volumes writes are locked', v_month, v_status
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_daily_volumes_lock ON daily_volumes;
CREATE TRIGGER trg_daily_volumes_lock
  BEFORE INSERT OR UPDATE ON daily_volumes
  FOR EACH ROW EXECUTE FUNCTION daily_volumes_lock_approved_month();

-- ═══════════════════════════════════════════════════════════════
-- Trigger: keep numbers.updated_at fresh on every update.
-- ═══════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_numbers_touch ON numbers;
CREATE TRIGGER trg_numbers_touch
  BEFORE UPDATE ON numbers
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS trg_slack_config_touch ON slack_config;
CREATE TRIGGER trg_slack_config_touch
  BEFORE UPDATE ON slack_config
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
