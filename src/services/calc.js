// Single source of truth for SPEC §3 math. Pure functions, no DB.
// Reports, dashboard cards, and the daily Slack post all compose from
// here — if a number is wrong on screen, fix it in this file and
// everything downstream re-aligns.
//
// Money: per-day prices live at 4 decimals (purchase/selling); month
// totals at 2 decimals. Volume is integer. Margin is purely derived
// (selling − purchase) and is never persisted.

// ── Money helpers ───────────────────────────────────────────
// JavaScript floats turn 0.04 - 0.02 into 0.020000000000000004. We
// pin every multiply/subtract through these helpers so a 1000-number
// month doesn't drift by cents.
function r4(n) {
  return Math.round((Number(n) || 0) * 10000) / 10000;
}
function r2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

// ── Per-row math ────────────────────────────────────────────
export function margin(purchase_price, selling_price) {
  return r4((Number(selling_price) || 0) - (Number(purchase_price) || 0));
}

// Per-number-per-day shape consumed by the dashboard table and the
// client-billing tab. `volume` is an integer; prices are per-MO at 4
// decimals; rev/cost/sales come back at 2 decimals (display-ready).
export function dayRow({ volume, purchase_price, selling_price }) {
  const v = Number(volume) || 0;
  const m = margin(purchase_price, selling_price);
  return {
    volume: v,
    margin: m,
    revenue: r2(v * m),
    cost: r2(v * (Number(purchase_price) || 0)),
    sales: r2(v * (Number(selling_price) || 0)),
  };
}

// ── Month boundaries ────────────────────────────────────────
// Both `'YYYY-MM'` and `'YYYY-MM-DD'` accepted; we slice to month.
export function monthBounds(monthOrDate) {
  const m = String(monthOrDate || '').slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(m)) {
    throw new Error(`Invalid month "${monthOrDate}" (expected YYYY-MM)`);
  }
  const [yStr, moStr] = m.split('-');
  const y = Number(yStr), mo = Number(moStr);
  // Last day = day 0 of next month, in UTC.
  const last = new Date(Date.UTC(y, mo, 0));
  const dd = String(last.getUTCDate()).padStart(2, '0');
  return { month: m, firstDay: `${m}-01`, lastDay: `${m}-${dd}` };
}

// ── Fee resolution ──────────────────────────────────────────
// Active monthly fee on side S for month M:
//   side === S AND type === 'monthly'
//   AND effective_from <= last_day(M)
//   AND (effective_to IS NULL OR effective_to >= first_day(M))
export function activeMonthlyFees(fees, side, month) {
  const { firstDay, lastDay } = monthBounds(month);
  return (fees || []).filter((f) =>
    f && f.type === 'monthly' && f.side === side &&
    String(f.effective_from) <= lastDay &&
    (f.effective_to == null || String(f.effective_to) >= firstDay)
  );
}

// Yearly fees billed in month M:
//   side === S AND type === 'yearly'
//   AND the calendar MONTH-OF-YEAR of effective_from === month-of-year of M
//   AND effective_from <= last_day(M)        (it has started)
//   AND (effective_to IS NULL OR effective_to >= first_day(M))
//
// e.g. effective_from='2026-01-15' bills $X every January from 2026 on.
export function yearlyFeesInMonth(fees, side, month) {
  const { firstDay, lastDay } = monthBounds(month);
  const mm = String(month).slice(5, 7);
  return (fees || []).filter((f) =>
    f && f.type === 'yearly' && f.side === side &&
    String(f.effective_from || '').slice(5, 7) === mm &&
    String(f.effective_from) <= lastDay &&
    (f.effective_to == null || String(f.effective_to) >= firstDay)
  );
}

// Setup fees on side S that fall *in* month M (effective_from is in M).
// Setup fees ignore effective_to per SPEC §2.
export function setupFeesInMonth(fees, side, month) {
  const { month: m } = monthBounds(month);
  return (fees || []).filter((f) =>
    f && f.type === 'setup' && f.side === side &&
    String(f.effective_from || '').slice(0, 7) === m
  );
}

export function sumAmount(fees) {
  return r2((fees || []).reduce((acc, f) => acc + (Number(f.amount) || 0), 0));
}

// ── Month roll-up (P&L) ─────────────────────────────────────
// `numbers`  — [{ id, purchase_price_per_mo, selling_price_per_mo, ... }]
// `volumes`  — [{ number_id, date, volume }] for the month
// `fees`     — [{ number_id, type, side, amount, effective_from, effective_to }]
// `month`    — 'YYYY-MM'
//
// Returns the canonical CREDIT/DEBIT/NET shape from SPEC §3 + per-side
// fee breakdowns. Pure — caller does the DB pulls and feeds this in.
export function buildMonthPnL({ numbers, volumes, fees, month, split = null }) {
  const { firstDay, lastDay } = monthBounds(month);
  const byId = new Map((numbers || []).map((n) => [n.id, n]));

  // Revenue = sum over (volume × margin) for every volume row in the month.
  // Split SCs are priced exactly per operator instead — their volume still
  // counts here, but their margin is added from split.perMonth below.
  let revenue = 0;
  let totalVolume = 0;
  for (const v of volumes || []) {
    if (!v || !v.date) continue;
    if (v.date < firstDay || v.date > lastDay) continue;
    const num = byId.get(v.number_id);
    if (!num) continue;
    totalVolume += Number(v.volume) || 0;
    if (split && split.splitIds.has(v.number_id)) continue; // margin added below
    const m = margin(num.purchase_price_per_mo, num.selling_price_per_mo);
    revenue += (Number(v.volume) || 0) * m;
  }
  if (split) {
    for (const [numberId, pm] of split.perMonth) {
      if (byId.has(numberId)) revenue += pm.margin;
    }
  }
  revenue = r2(revenue);

  // Fees per side / type. Aggregate, then expose totals + buckets.
  const monthlyCost = activeMonthlyFees(fees, 'cost', month);
  const monthlySale = activeMonthlyFees(fees, 'sale', month);
  const yearlyCost  = yearlyFeesInMonth(fees, 'cost', month);
  const yearlySale  = yearlyFeesInMonth(fees, 'sale', month);
  const setupCost   = setupFeesInMonth(fees, 'cost', month);
  const setupSale   = setupFeesInMonth(fees, 'sale', month);

  const monthlyCostTotal = sumAmount(monthlyCost);
  const monthlySaleTotal = sumAmount(monthlySale);
  const yearlyCostTotal  = sumAmount(yearlyCost);
  const yearlySaleTotal  = sumAmount(yearlySale);
  const setupCostTotal   = sumAmount(setupCost);
  const setupSaleTotal   = sumAmount(setupSale);

  const credit = revenue;
  const debit = r2(monthlyCostTotal + yearlyCostTotal + setupCostTotal);
  const net = r2(credit - debit);

  return {
    month,
    totalVolume,
    revenue,
    fees: {
      cost: {
        monthly: monthlyCostTotal,
        yearly:  yearlyCostTotal,
        setup:   setupCostTotal,
        total:   r2(monthlyCostTotal + yearlyCostTotal + setupCostTotal),
      },
      sale: {
        monthly: monthlySaleTotal,
        yearly:  yearlySaleTotal,
        setup:   setupSaleTotal,
        total:   r2(monthlySaleTotal + yearlySaleTotal + setupSaleTotal),
      },
    },
    credit,
    debit,
    net,
  };
}

// ── Dashboard cards ─────────────────────────────────────────
// Picked-date day totals + MTD-through-picked-date, for the four
// dashboard cards. Split SCs take their per-day margin from
// `split.perDay` (operator-resolved, same source as History); every
// other number uses its flat snapshot margin. Without `split`, all
// numbers fall back to the flat margin (pre-operator-pricing behavior).
//
// `numbers` — [{ id, purchase_price_per_mo, selling_price_per_mo }]
// `volumes` — daily_volumes rows from month-start → `date` (inclusive)
// `date`    — picked date 'YYYY-MM-DD'
// `split`   — optional { splitIds:Set, perDay:Map } from loadSplitPricing
export function buildDashboardCards({ numbers, volumes, date, split = null }) {
  const byId = new Map((numbers || []).map((n) => [n.id, n]));
  const { firstDay } = monthBounds(String(date).slice(0, 7));
  let dayVol = 0, dayRev = 0, mtdVol = 0, mtdRev = 0;
  for (const v of volumes || []) {
    if (!v || !v.date) continue;
    if (v.date < firstDay || v.date > date) continue; // MTD through picked date
    const num = byId.get(v.number_id);
    if (!num) continue;
    const vol = Number(v.volume) || 0;
    // Split SC: operator-resolved daily margin (matches History to the cent);
    // others: flat snapshot margin.
    const rev = (split && split.splitIds.has(v.number_id))
      ? (split.perDay.get(`${v.number_id}|${v.date}`)?.margin ?? 0)
      : vol * margin(num.purchase_price_per_mo, num.selling_price_per_mo);
    mtdVol += vol;
    mtdRev += rev;
    if (v.date === date) {
      dayVol += vol;
      dayRev += rev;
    }
  }
  return {
    day: { volume: dayVol, revenue: r2(dayRev) },
    mtd: { volume: mtdVol, revenue: r2(mtdRev) },
  };
}

export const _internal = { r2, r4 };
