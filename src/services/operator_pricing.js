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
