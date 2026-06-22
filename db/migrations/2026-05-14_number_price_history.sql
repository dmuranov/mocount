-- Track price changes over time so pro forma invoices can split a
-- number into multiple line items when its rate changed mid-month
-- (matches the Google invoice convention: "Apr 1 only @ X / Apr 2-30 @ Y").
--
-- Convention: numbers.purchase_price_per_mo / selling_price_per_mo on the
-- numbers row mirror the LATEST history row's price. The history table is
-- the source of truth for any past month; the numbers row is just the
-- current snapshot for the dashboard table to read fast.

CREATE TABLE IF NOT EXISTS number_price_history (
  id              uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  number_id       uuid           NOT NULL REFERENCES numbers(id) ON DELETE CASCADE,
  side            text           NOT NULL CHECK (side IN ('purchase','selling')),
  price           numeric(10,4)  NOT NULL,
  effective_from  date           NOT NULL,
  effective_to    date,
  created_at      timestamptz    NOT NULL DEFAULT now(),
  created_by      uuid           REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_nph_number_side ON number_price_history(number_id, side);
CREATE INDEX IF NOT EXISTS idx_nph_effective ON number_price_history(effective_from, effective_to);

-- Backfill: every existing number gets one open-ended history row per
-- side, effective_from = '2020-01-01' so any historical month resolves.
-- Idempotent: only inserts rows for (number_id, side) combinations
-- that don't already have an entry.
INSERT INTO number_price_history (number_id, side, price, effective_from)
SELECT n.id, 'purchase', n.purchase_price_per_mo, DATE '2020-01-01'
FROM numbers n
WHERE NOT EXISTS (
  SELECT 1 FROM number_price_history h
  WHERE h.number_id = n.id AND h.side = 'purchase'
);

INSERT INTO number_price_history (number_id, side, price, effective_from)
SELECT n.id, 'selling', n.selling_price_per_mo, DATE '2020-01-01'
FROM numbers n
WHERE NOT EXISTS (
  SELECT 1 FROM number_price_history h
  WHERE h.number_id = n.id AND h.side = 'selling'
);
