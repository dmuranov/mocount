-- Step 14 add-on: yearly fees.
--
-- Run this once on the live Supabase. It widens the fees.type check
-- constraint to allow 'yearly' alongside the existing 'monthly' /
-- 'setup'. Safe to re-run (DROP CONSTRAINT IF EXISTS).

ALTER TABLE fees DROP CONSTRAINT IF EXISTS fees_type_check;
ALTER TABLE fees ADD CONSTRAINT fees_type_check CHECK (type IN ('monthly','yearly','setup'));
