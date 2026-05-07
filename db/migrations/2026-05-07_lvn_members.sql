-- LVN-1: rename VLN -> LVN, add lvn_members table.
--
-- Run once on the live Supabase. Order matters: data update must
-- come before the new constraint, or rows will fail validation.

BEGIN;

-- 1) Drop old constraint, migrate data, add new constraint.
ALTER TABLE numbers DROP CONSTRAINT IF EXISTS numbers_type_check;
UPDATE numbers SET type = 'LVN' WHERE type = 'VLN';
ALTER TABLE numbers ADD CONSTRAINT numbers_type_check CHECK (type IN ('SC','LVN'));

-- 2) Member group table.
CREATE TABLE IF NOT EXISTS lvn_members (
  id          uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  number_id   uuid          NOT NULL REFERENCES numbers(id) ON DELETE CASCADE,
  phone       text          NOT NULL,
  active      boolean       NOT NULL DEFAULT true,
  created_at  timestamptz   NOT NULL DEFAULT now(),
  created_by  uuid          REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (number_id, phone)
);
CREATE INDEX IF NOT EXISTS idx_lvn_members_number_id ON lvn_members(number_id);

COMMIT;
