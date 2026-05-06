-- ═══════════════════════════════════════════════════════════════
-- mocount — seed (SPEC §1)
-- Five allowlisted users; created_by left NULL (system seed).
-- Idempotent via ON CONFLICT — re-running keeps existing roles/flags.
-- Run AFTER schema.sql.
-- ═══════════════════════════════════════════════════════════════

-- All five seed users receive the monthly email per project owner override
-- (SPEC §1's table had only the two admins on; the user wants all 5).
INSERT INTO users (email, name, role, receives_monthly_email, active)
VALUES
  ('danijel.muranovic@idt.net', 'Danijel Muranovic', 'admin',  true, true),
  ('laura.hernandez@idt.net',   'Laura Hernandez',   'admin',  true, true),
  ('greg.henderson@gmail.com',  'Greg Henderson',    'viewer', true, true),
  ('peter.broes@idt.net',       'Peter Broes',       'viewer', true, true),
  ('chiara.ferraro@idt.net',    'Chiara Ferraro',    'viewer', true, true)
ON CONFLICT (email) DO NOTHING;

-- Single-row Slack config (disabled by default, admin enables in UI).
-- INSERT ... WHERE NOT EXISTS so re-running the seed doesn't pile on rows
-- (the table has no natural unique key — the PK is gen_random_uuid()).
INSERT INTO slack_config (webhook_url, enabled, send_time_utc)
SELECT NULL, false, '06:00'
WHERE NOT EXISTS (SELECT 1 FROM slack_config);
