-- Operator-level pricing — one SC row priced per destination operator (MNC),
-- replacing the duplicate-number approach (AR 78887 (Claro), MX 43800/43902
-- tiers). The number keeps its default purchase/selling (catch-all + normal
-- SCs); override groups layer per-operator rates on top, and volume is captured
-- per MCC-MNC so each operator's traffic can be priced and summed under the hood.

-- 1. Operator override groups (current-state config; price history below).
CREATE TABLE IF NOT EXISTS number_operator_prices (
  id                     uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  number_id              uuid          NOT NULL REFERENCES numbers(id) ON DELETE CASCADE,
  label                  text          NOT NULL,               -- 'Claro', 'Telcel', ...
  mncs                   text[]        NOT NULL DEFAULT '{}',  -- MNCs in this group (MCC = the number's)
  purchase_price_per_mo  numeric(10,4) NOT NULL,
  selling_price_per_mo   numeric(10,4) NOT NULL,
  active                 boolean       NOT NULL DEFAULT true,
  created_at             timestamptz   NOT NULL DEFAULT now(),
  updated_at             timestamptz   NOT NULL DEFAULT now(),
  updated_by             uuid          REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_nop_number ON number_operator_prices(number_id);

-- 2. Per-group price history. NULL operator_group_id = the number's default
--    rate (existing rows, unchanged); set = that override group's rate window.
ALTER TABLE number_price_history
  ADD COLUMN IF NOT EXISTS operator_group_id uuid
  REFERENCES number_operator_prices(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_nph_group ON number_price_history(operator_group_id);

-- 3. Per-operator daily volume detail. daily_volumes keeps the per-number
--    rollup (unchanged consumers); this preserves the MCC-MNC breakdown the
--    importer used to discard, so split SCs can be priced per operator.
CREATE TABLE IF NOT EXISTS daily_volume_operators (
  number_id   uuid        NOT NULL REFERENCES numbers(id) ON DELETE CASCADE,
  date        date        NOT NULL,
  mcc_mnc     text        NOT NULL,
  volume      integer     NOT NULL DEFAULT 0,
  entered_by  uuid        REFERENCES users(id) ON DELETE SET NULL,
  entered_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (number_id, date, mcc_mnc)
);
CREATE INDEX IF NOT EXISTS idx_dvo_number_date ON daily_volume_operators(number_id, date);
