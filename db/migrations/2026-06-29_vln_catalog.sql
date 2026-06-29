-- VLN catalog — the master sheet's "Virtual Long Number (VLN)" rows, ingested
-- by the Sync Prices flow. Each entry maps a master VLN (its subscriber suffix,
-- within a country) to the parent VLN number that carries the client + price.
--
-- The MO Messages importer uses this to SUGGEST a parent for an otherwise-
-- unknown receiver (the supplier reports VLNs in a different number form than
-- the master stores; only the trailing subscriber suffix lines up). A human
-- confirms each suggestion at upload time; confirmed matches become
-- lvn_members rows so future imports resolve directly.

CREATE TABLE IF NOT EXISTS vln_catalog (
  id                uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  country           text          NOT NULL,                 -- ISO-2 / prefix form, e.g. 'ZA'
  suffix            text          NOT NULL,                 -- subscriber digits used to match a reported receiver
  raw_value         text          NOT NULL,                 -- master's literal VLN string (display/audit), natural key
  client            text,                                   -- 'Customer Using Number'
  parent_number_id  uuid          NOT NULL REFERENCES numbers(id) ON DELETE CASCADE,
  buy               numeric(10,4),
  sell              numeric(10,4),
  active            boolean       NOT NULL DEFAULT true,
  created_at        timestamptz   NOT NULL DEFAULT now(),
  updated_at        timestamptz   NOT NULL DEFAULT now(),
  updated_by        uuid          REFERENCES users(id) ON DELETE SET NULL
);

-- Re-sync idempotency: a master VLN string is the natural key.
CREATE UNIQUE INDEX IF NOT EXISTS uq_vln_catalog_raw ON vln_catalog(raw_value);
-- Suggestion lookup path: by country + subscriber suffix.
CREATE INDEX IF NOT EXISTS idx_vln_catalog_country_suffix ON vln_catalog(country, suffix);
CREATE INDEX IF NOT EXISTS idx_vln_catalog_parent ON vln_catalog(parent_number_id);
