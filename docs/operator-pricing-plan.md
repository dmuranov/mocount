# Operator-level pricing

Replace the duplicate-number approach (`AR - 78887 (Claro)`, `MX - 43800/43902`
tiers) with **one `numbers` row per SC, priced per destination operator (MNC)**.

Rollback point: git tag `pre-operator-pricing` + `_backup_pre_operator_pricing_*.json`.

## Principle
The number keeps its **default** purchase/selling rate (catch-all + normal SCs).
Split SCs get **operator override groups** (a label + a set of MNCs + their own
rate). Volume is captured per **MCC-MNC** so each operator's traffic is priced
and summed under the hood. Billing is **revenue-identical** to the duplicate
approach — same money, fewer rows.

## Decisions (locked)
- **Invoice**: one line per SC (Google pro forma format). `Qty` = total,
  `Rate` = blended effective rate (revenue ÷ qty) shown to ≤4 dp, **`Amount` =
  exact summed revenue**, **Total = sum of exact line amounts**.
- **Operator detail**: under the hood only. A **"View operator breakdown"** link
  lives on the **mocount portal**, NOT on the customer invoice (it exposes
  purchase/cost).
- **History / P&L**: split SCs show the SC's total volume + revenue (computed
  per-operator under the hood); no per-operator UI.
- **Group shape**: one number = one MCC; groups are MNC sets. A second MCC = a
  separate number.
- **Numbers list**: show `AR - 78887*` (asterisk = priced per network) with the
  simple average of configured rates up front; exact rows in the drawer.

## Schema (`db/migrations/2026-06-23_operator_pricing.sql`)
- `number_operator_prices` — override groups (number_id, label, mncs[], purchase,
  selling, active).
- `number_price_history.operator_group_id` (nullable) — null = default rate;
  set = that group's rate history.
- `daily_volume_operators` — per (number_id, date, mcc_mnc) volume detail.
  `daily_volumes` rollup stays as the per-number sum (unchanged consumers).

## Code
- `src/services/operator_pricing.js` — pure pricing resolver (keystone). Maps
  each MCC-MNC → group (else default), prices at date, returns per-mcc-mnc slices
  + rollup (qty, revenue, cost, blended rates).
- `momessages_import.js` — stop discarding MNC; drop hardcoded `OPERATOR_SPLITS`;
  write both `daily_volume_operators` and the `daily_volumes` rollup.
- `invoices.js`, `history.js`, `reports.js` — use the resolver for split numbers.
- `NumberDrawer.jsx` — admin "Operator pricing" subsection; `Numbers`/`Dashboard`
  asterisk + avg; invoice "operator breakdown" link (portal only).

## Migration (revenue-neutral, dry-runnable)
- AR: `Claro` group on `AR - 78887` (mncs 310/320/330) from the `(Claro)` price;
  move its volume into `daily_volume_operators`; deactivate `AR - 78887 (Claro)`.
- MX: collapse each code's 3 rows into base + Telcel/Movistar groups; migrate
  volume; deactivate the duplicates.
- Backfill `daily_volume_operators` for the merged history so past months price
  correctly; default volume routed to a non-matching MNC so it hits the default.
