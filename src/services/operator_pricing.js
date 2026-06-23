// Operator-level pricing resolver.
//
// A split SC keeps a single `numbers` row with a DEFAULT purchase/selling rate.
// Optional operator override groups (number_operator_prices) carry a different
// rate for a set of MNCs. Volume is stored per MCC-MNC (daily_volume_operators),
// so each operator's traffic is priced by its matching group, falling back to
// the number's default rate for any MNC that isn't in a group.
//
// Revenue and cost are summed EXACTLY. The blended per-message rate
// (revenue / qty) is what the pro forma line shows — rounded for display only,
// never used to recompute the amount.
//
// Pure functions: callers do the DB pulls.

import { monthBounds } from './calc.js';

function r2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

// MNC portion of an 'MCC-MNC' string: '722-310' -> '310'. No dash -> whole.
export function mncOf(mccMnc) {
  const s = String(mccMnc ?? '').trim();
  const i = s.indexOf('-');
  return i >= 0 ? s.slice(i + 1) : s;
}

// Price effective on `date` (YYYY-MM-DD) for a side, from a history array of
// { side, price, effective_from, effective_to }. Windows are contiguous and
// non-overlapping (a new rate closes the prior to the day before), with
// inclusive ends — mirrors invoices.js. Open effective_to = still in effect.
// Returns null if no window covers the date.
export function priceAt(history, side, date) {
  let price = null;
  for (const h of history || []) {
    if (h.side !== side) continue;
    const from = String(h.effective_from);
    const to = h.effective_to == null ? '9999-12-31' : String(h.effective_to);
    if (date >= from && date <= to) price = Number(h.price);
  }
  return price;
}

// Normalize a group's MNC list into a Set of strings for fast lookup.
export function toGroup(g) {
  return { ...g, mncSet: new Set((g.mncs || []).map((m) => String(m).trim())) };
}

// Price a number's per-operator volume for some window.
//
//   defaultHistory — number_price_history rows with operator_group_id = null
//   groups         — [{ label, mncSet:Set, history:[group rows] }] (use toGroup)
//   opVolumes      — [{ date, mcc_mnc, volume }] already filtered to the window
//
// Returns:
//   slices — one per mcc_mnc seen: { mcc_mnc, label, qty, purchase, selling,
//            revenue, cost } where purchase/selling are the slice's effective
//            (volume-weighted) per-message rates.
//   totals — { qty, revenue, cost, blendedSell, blendedBuy }
export function priceOperatorVolumes({ defaultHistory, groups, opVolumes }) {
  const grps = (groups || []).map((g) => (g.mncSet ? g : toGroup(g)));
  const byKey = new Map(); // mcc_mnc -> accumulator
  let qty = 0, revenue = 0, cost = 0;

  for (const v of opVolumes || []) {
    const vol = Number(v.volume) || 0;
    if (vol <= 0) continue;
    const mnc = mncOf(v.mcc_mnc);
    const grp = grps.find((g) => g.mncSet.has(mnc)) || null;
    const hist = grp ? grp.history : defaultHistory;
    const sell = priceAt(hist, 'selling', v.date) ?? 0;
    const buy = priceAt(hist, 'purchase', v.date) ?? 0;

    qty += vol; revenue += vol * sell; cost += vol * buy;

    const key = String(v.mcc_mnc);
    if (!byKey.has(key)) byKey.set(key, { mcc_mnc: key, label: grp ? grp.label : 'default', qty: 0, revenue: 0, cost: 0 });
    const s = byKey.get(key);
    s.qty += vol; s.revenue += vol * sell; s.cost += vol * buy;
  }

  const slices = [...byKey.values()]
    .map((s) => ({
      ...s,
      selling: s.qty ? s.revenue / s.qty : 0,
      purchase: s.qty ? s.cost / s.qty : 0,
    }))
    .sort((a, b) => b.revenue - a.revenue);

  return {
    slices,
    totals: {
      qty,
      revenue,
      cost,
      blendedSell: qty ? revenue / qty : 0,
      blendedBuy: qty ? cost / qty : 0,
    },
  };
}

// ── loadSplitPricing ────────────────────────────────────────
// DB-touching helper that produces EXACT per-operator figures for every
// number that has operator override groups, for one month. Single source so
// invoices / history / reports / P&L all reconcile.
//
//   sb     — supabase client
//   month  — 'YYYY-MM'
//
// Returns:
//   splitIds — Set<number_id> of numbers that have ≥1 active operator group
//   perDay   — Map('number_id|date' → { sales, cost, margin })  (2dp, for the
//              History day grid)
//   perMonth — Map(number_id → { qty, sales, cost, margin, slices })  where
//              sales = Σ vol·sell, cost = Σ vol·buy, margin = sales − cost
//              (UNROUNDED — callers round at the edge), and slices is the
//              per-MCC-MNC breakdown for the invoice portal table.
//
// "sales" is gross (what the customer is billed → invoice amount). "revenue"
// in history/reports/calc means MARGIN, so those use `margin`.
//
// Reconcile remainder: any rollup volume not present in daily_volume_operators
// (e.g. "Unknown" MCC rows) is priced at the number's default rate, so a
// number's billed qty always equals its daily_volumes total.
export async function loadSplitPricing(sb, month) {
  const { firstDay, lastDay } = monthBounds(month);

  const { data: groupsRaw, error: gErr } = await sb
    .from('number_operator_prices')
    .select('id, number_id, label, mncs, active')
    .eq('active', true);
  if (gErr) throw new Error('operator groups load failed: ' + gErr.message);

  const splitIds = new Set((groupsRaw || []).map((g) => g.number_id));
  if (!splitIds.size) return { splitIds, perDay: new Map(), perMonth: new Map() };
  const ids = [...splitIds];

  const [histRes, opRes, rollRes] = await Promise.all([
    sb.from('number_price_history')
      .select('number_id, operator_group_id, side, price, effective_from, effective_to')
      .in('number_id', ids),
    sb.from('daily_volume_operators')
      .select('number_id, date, mcc_mnc, volume')
      .in('number_id', ids).gte('date', firstDay).lte('date', lastDay),
    sb.from('daily_volumes')
      .select('number_id, date, volume')
      .in('number_id', ids).gte('date', firstDay).lte('date', lastDay),
  ]);
  for (const r of [histRes, opRes, rollRes]) {
    if (r.error) throw new Error('split-pricing load failed: ' + r.error.message);
  }

  // Price history split into default (group_id null) vs per-group.
  const histByNum = new Map();
  for (const h of histRes.data || []) {
    if (!histByNum.has(h.number_id)) histByNum.set(h.number_id, { default: [], byGroup: new Map() });
    const slot = histByNum.get(h.number_id);
    if (h.operator_group_id == null) slot.default.push(h);
    else {
      if (!slot.byGroup.has(h.operator_group_id)) slot.byGroup.set(h.operator_group_id, []);
      slot.byGroup.get(h.operator_group_id).push(h);
    }
  }
  const groupsByNum = new Map();
  for (const g of groupsRaw || []) {
    if (!groupsByNum.has(g.number_id)) groupsByNum.set(g.number_id, []);
    groupsByNum.get(g.number_id).push(g);
  }
  const opByNum = new Map();
  for (const v of opRes.data || []) {
    if (!opByNum.has(v.number_id)) opByNum.set(v.number_id, []);
    opByNum.get(v.number_id).push(v);
  }
  const rollupByNum = new Map(); // number_id -> Map(date -> volume)
  for (const r of rollRes.data || []) {
    if (!rollupByNum.has(r.number_id)) rollupByNum.set(r.number_id, new Map());
    rollupByNum.get(r.number_id).set(r.date, Number(r.volume) || 0);
  }

  const perDay = new Map();
  const perMonth = new Map();
  for (const numberId of ids) {
    const slot = histByNum.get(numberId) || { default: [], byGroup: new Map() };
    const groups = (groupsByNum.get(numberId) || []).map((g) =>
      toGroup({ label: g.label, mncs: g.mncs || [], history: slot.byGroup.get(g.id) || [] }));
    const ov = opByNum.get(numberId) || [];

    // Month aggregate + per-MCC-MNC slices from the tested resolver.
    const agg = priceOperatorVolumes({ defaultHistory: slot.default, groups, opVolumes: ov });

    // Per-day from operator detail.
    const dayAcc = new Map(); // date -> { sales, cost, detailQty }
    for (const v of ov) {
      const vol = Number(v.volume) || 0;
      if (vol <= 0) continue;
      const grp = groups.find((g) => g.mncSet.has(mncOf(v.mcc_mnc))) || null;
      const h = grp ? grp.history : slot.default;
      const sell = priceAt(h, 'selling', v.date) ?? 0;
      const buy = priceAt(h, 'purchase', v.date) ?? 0;
      const d = dayAcc.get(v.date) || { sales: 0, cost: 0, detailQty: 0 };
      d.sales += vol * sell; d.cost += vol * buy; d.detailQty += vol;
      dayAcc.set(v.date, d);
    }

    // Remainder (rollup − detail) priced at default, per date.
    let remSales = 0, remCost = 0, remQty = 0;
    for (const [date, rqty] of rollupByNum.get(numberId) || new Map()) {
      const d = dayAcc.get(date) || { sales: 0, cost: 0, detailQty: 0 };
      const rem = rqty - d.detailQty;
      if (rem > 0) {
        const sell = priceAt(slot.default, 'selling', date) ?? 0;
        const buy = priceAt(slot.default, 'purchase', date) ?? 0;
        d.sales += rem * sell; d.cost += rem * buy;
        remSales += rem * sell; remCost += rem * buy; remQty += rem;
        dayAcc.set(date, d);
      }
    }

    for (const [date, d] of dayAcc) {
      perDay.set(`${numberId}|${date}`, { sales: r2(d.sales), cost: r2(d.cost), margin: r2(d.sales - d.cost) });
    }

    const sales = agg.totals.revenue + remSales;
    const cost = agg.totals.cost + remCost;
    const slices = agg.slices.slice();
    if (remQty > 0) {
      slices.push({
        mcc_mnc: '(unattributed)', label: 'default', qty: remQty,
        revenue: remSales, cost: remCost,
        selling: remQty ? remSales / remQty : 0, purchase: remQty ? remCost / remQty : 0,
      });
    }
    perMonth.set(numberId, { qty: agg.totals.qty + remQty, sales, cost, margin: sales - cost, slices });
  }

  return { splitIds, perDay, perMonth };
}
