-- Temporary ignore list for MO Messages receivers the operator has triaged as
-- "not ours / no idea / delete". The importer skips these silently (no unknown
-- prompt, no counting). Removable: delete the row (or set active=false) to
-- un-ignore. If an ignored receiver shows sustained traffic (many days) in an
-- import, the importer still surfaces an ALERT so a live number isn't hidden
-- by mistake.

CREATE TABLE IF NOT EXISTS ignored_receivers (
  receiver    text        PRIMARY KEY,          -- exact report receiver (e.g. '56228796547', 'Facebook')
  reason      text,                             -- operator note (from the master "MO Missing" tab)
  active      boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid        REFERENCES users(id) ON DELETE SET NULL
);

NOTIFY pgrst, 'reload schema';
