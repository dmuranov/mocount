// Monthly report — SPEC §5. Pure function: takes the data, returns
// the four-tab structure used by the web view AND the xlsx export.
//
// No MTD truncation here — the report is an end-of-month artifact.
// If you call it mid-month, the data is just partial; that's by
// design (matches what gets snapshotted in monthly_closes).

import { margin, monthBounds, activeMonthlyFees, yearlyFeesInMonth, setupFeesInMonth } from './calc.js';

function r2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function r4(n) { return Math.round((Number(n) || 0) * 10000) / 10000; }

// ── buildMonthReport ────────────────────────────────────────
// Inputs:
//   numbers — full set [{ id, number, type, country, client,
//                         purchase_price_per_mo, selling_price_per_mo, active }]
//   volumes — [{ number_id, date, volume }] for the month (caller scopes)
//   fees    — [{ number_id, type, side, amount, effective_from, effective_to }]
//   month   — 'YYYY-MM'
//
//   split   — optional { splitIds:Set, perMonth:Map } from loadSplitPricing;
//             split SCs take exact per-operator sales/cost/margin from there.
//
// Returns:
//   { month, summary, perNumber, costs, clientBilling }
export function buildMonthReport({ numbers, volumes, fees, month, split = null }) {
  const { firstDay, lastDay } = monthBounds(month);
  const numbersList = numbers || [];
  const byId = new Map(numbersList.map((n) => [n.id, n]));

  // Volume per number for the month.
  const volByNumber = new Map();
  let monthVolume = 0;
  for (const v of volumes || []) {
    if (!v || !v.date) continue;
    if (v.date < firstDay || v.date > lastDay) continue;
    if (!byId.has(v.number_id)) continue;
    const cur = volByNumber.get(v.number_id) || 0;
    volByNumber.set(v.number_id, cur + (Number(v.volume) || 0));
    monthVolume += Number(v.volume) || 0;
  }

  // Resolve active monthly + yearly + in-month setup fees, indexed per number/side.
  const monthlyByNumberSide = new Map(); // 'numId|side' -> sum amount
  const yearlyByNumberSide  = new Map();
  const setupByNumberSide   = new Map();
  function addInto(map, key, amt) { map.set(key, (map.get(key) || 0) + amt); }
  for (const side of ['cost', 'sale']) {
    for (const f of activeMonthlyFees(fees || [], side, month)) {
      addInto(monthlyByNumberSide, `${f.number_id}|${side}`, Number(f.amount) || 0);
    }
    for (const f of yearlyFeesInMonth(fees || [], side, month)) {
      addInto(yearlyByNumberSide, `${f.number_id}|${side}`, Number(f.amount) || 0);
    }
    for (const f of setupFeesInMonth(fees || [], side, month)) {
      addInto(setupByNumberSide, `${f.number_id}|${side}`, Number(f.amount) || 0);
    }
  }

  // ── Per-number derived row (used by tabs 2/3/4) ──
  // Sorted SC-then-LVN, then by number for stable diffing.
  const sortedNumbers = [...numbersList].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'SC' ? -1 : 1;
    return String(a.number).localeCompare(String(b.number));
  });
  const perRow = sortedNumbers.map((n) => {
    const volume = volByNumber.get(n.id) || 0;
    const monthlyCost = monthlyByNumberSide.get(`${n.id}|cost`) || 0;
    const yearlyCost  = yearlyByNumberSide.get(`${n.id}|cost`) || 0;
    const setupCost   = setupByNumberSide.get(`${n.id}|cost`) || 0;
    const monthlySale = monthlyByNumberSide.get(`${n.id}|sale`) || 0;
    const yearlySale  = yearlyByNumberSide.get(`${n.id}|sale`) || 0;
    const setupSale   = setupByNumberSide.get(`${n.id}|sale`) || 0;

    // Split SC → exact per-operator sales/cost (UNROUNDED raws, so the
    // *_total below fold fees in before a single round). Displayed prices
    // become the volume-weighted blend. Else: flat snapshot price × volume.
    const pm = split && split.splitIds.has(n.id) ? split.perMonth.get(n.id) : null;
    let purchase, selling, m, costVolRaw, salesVolRaw, revenue;
    if (pm) {
      const qty = pm.qty || 0;
      purchase = qty ? r4(pm.cost / qty) : (Number(n.purchase_price_per_mo) || 0);
      selling  = qty ? r4(pm.sales / qty) : (Number(n.selling_price_per_mo) || 0);
      m = r4(selling - purchase);
      costVolRaw = pm.cost;
      salesVolRaw = pm.sales;
      revenue = r2(pm.margin);
    } else {
      purchase = Number(n.purchase_price_per_mo) || 0;
      selling = Number(n.selling_price_per_mo) || 0;
      m = margin(n.purchase_price_per_mo, n.selling_price_per_mo);
      costVolRaw = volume * purchase;
      salesVolRaw = volume * selling;
      revenue = r2(volume * m);
    }
    return {
      id: n.id,
      number: n.number,
      type: n.type,
      country: n.country,
      client: n.client,
      volume,
      purchase_price: purchase,
      selling_price: selling,
      margin: m,
      revenue,
      cost_volume: r2(costVolRaw),
      cost_monthly_fee: r2(monthlyCost),
      cost_yearly_fee: r2(yearlyCost),
      cost_setup_fee: r2(setupCost),
      cost_total: r2(costVolRaw + monthlyCost + yearlyCost + setupCost),
      sales_volume: r2(salesVolRaw),
      sale_monthly_fee: r2(monthlySale),
      sale_yearly_fee: r2(yearlySale),
      sale_setup_fee: r2(setupSale),
      sale_total: r2(salesVolRaw + monthlySale + yearlySale + setupSale),
    };
  });

  // ── Tab 1 — Summary / P&L ──
  // Build line items: one per active cost-monthly fee, one per
  // in-month cost-setup fee. Lines reference Number for traceability.
  const debitLines = [];
  let monthlyCostTotal = 0;
  let yearlyCostTotal = 0;
  let setupCostTotal = 0;
  const KIND_ORDER = { cost_monthly: 0, cost_yearly: 1, cost_setup: 2 };
  for (const f of activeMonthlyFees(fees || [], 'cost', month)) {
    const n = byId.get(f.number_id);
    if (!n) continue;
    const amt = Number(f.amount) || 0;
    monthlyCostTotal += amt;
    debitLines.push({ kind: 'cost_monthly', number_id: n.id, number: n.number, label: `Monthly fee — ${n.number}`, amount: r2(amt) });
  }
  for (const f of yearlyFeesInMonth(fees || [], 'cost', month)) {
    const n = byId.get(f.number_id);
    if (!n) continue;
    const amt = Number(f.amount) || 0;
    yearlyCostTotal += amt;
    debitLines.push({ kind: 'cost_yearly', number_id: n.id, number: n.number, label: `Yearly fee — ${n.number}`, amount: r2(amt) });
  }
  for (const f of setupFeesInMonth(fees || [], 'cost', month)) {
    const n = byId.get(f.number_id);
    if (!n) continue;
    const amt = Number(f.amount) || 0;
    setupCostTotal += amt;
    debitLines.push({ kind: 'cost_setup', number_id: n.id, number: n.number, label: `Setup fee — ${n.number}`, amount: r2(amt), effective_from: f.effective_from });
  }
  debitLines.sort((a, b) => {
    if (a.kind !== b.kind) return KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
    return String(a.number).localeCompare(String(b.number));
  });

  const totalRevenue = r2(perRow.reduce((acc, r) => acc + r.revenue, 0));
  const totalCostFees = r2(monthlyCostTotal + yearlyCostTotal + setupCostTotal);
  const summary = {
    headline: {
      total_volume: monthVolume,
      total_revenue: totalRevenue,
      total_cost_fees: totalCostFees,
      net: r2(totalRevenue - totalCostFees),
    },
    credit: { total_revenue: totalRevenue },
    debit: {
      lines: debitLines,
      monthly_total: r2(monthlyCostTotal),
      yearly_total:  r2(yearlyCostTotal),
      setup_total:   r2(setupCostTotal),
      total: totalCostFees,
    },
    net: r2(totalRevenue - totalCostFees),
  };

  // ── Tab 2 — Per SC/LVN ──
  const perNumberRows = perRow.map((r) => ({
    number: r.number,
    type: r.type,
    country: r.country,
    client: r.client,
    volume: r.volume,
    margin: r.margin,
    revenue: r.revenue,
  }));
  const perNumber = {
    rows: perNumberRows,
    totals: {
      volume: perNumberRows.reduce((acc, x) => acc + x.volume, 0),
      revenue: r2(perNumberRows.reduce((acc, x) => acc + x.revenue, 0)),
    },
  };

  // ── Tab 3 — Costs ──
  const costRows = perRow.map((r) => ({
    number: r.number,
    type: r.type,
    country: r.country,
    client: r.client,
    volume: r.volume,
    purchase_price: r.purchase_price,
    cost: r.cost_volume,
    monthly_fee: r.cost_monthly_fee,
    yearly_fee: r.cost_yearly_fee,
    setup_fee: r.cost_setup_fee,
    total_cost: r.cost_total,
  }));
  const costs = {
    rows: costRows,
    totals: {
      volume: costRows.reduce((acc, x) => acc + x.volume, 0),
      cost: r2(costRows.reduce((acc, x) => acc + x.cost, 0)),
      monthly_fee: r2(costRows.reduce((acc, x) => acc + x.monthly_fee, 0)),
      yearly_fee: r2(costRows.reduce((acc, x) => acc + x.yearly_fee, 0)),
      setup_fee: r2(costRows.reduce((acc, x) => acc + x.setup_fee, 0)),
      total_cost: r2(costRows.reduce((acc, x) => acc + x.total_cost, 0)),
    },
  };

  // ── Tab 4 — Client billing (grouped) ──
  // Numbers without a client land in a synthetic '(no client)' bucket
  // so the report is exhaustive — easier to spot a missing client tag.
  const groups = new Map();
  for (const r of perRow) {
    const key = (r.client || '').trim() || '(no client)';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({
      number: r.number,
      country: r.country,
      volume: r.volume,
      selling_price: r.selling_price,
      sales: r.sales_volume,
      monthly_fee: r.sale_monthly_fee,
      yearly_fee: r.sale_yearly_fee,
      setup_fee: r.sale_setup_fee,
      total: r.sale_total,
    });
  }
  const clientBilling = {
    groups: [...groups.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([client, rows]) => ({
        client,
        rows,
        subtotal: {
          volume: rows.reduce((acc, x) => acc + x.volume, 0),
          sales: r2(rows.reduce((acc, x) => acc + x.sales, 0)),
          monthly_fee: r2(rows.reduce((acc, x) => acc + x.monthly_fee, 0)),
          yearly_fee: r2(rows.reduce((acc, x) => acc + x.yearly_fee, 0)),
          setup_fee: r2(rows.reduce((acc, x) => acc + x.setup_fee, 0)),
          total: r2(rows.reduce((acc, x) => acc + x.total, 0)),
        },
      })),
  };
  // Grand totals across clients.
  clientBilling.grandTotal = {
    volume: clientBilling.groups.reduce((acc, g) => acc + g.subtotal.volume, 0),
    sales: r2(clientBilling.groups.reduce((acc, g) => acc + g.subtotal.sales, 0)),
    monthly_fee: r2(clientBilling.groups.reduce((acc, g) => acc + g.subtotal.monthly_fee, 0)),
    yearly_fee: r2(clientBilling.groups.reduce((acc, g) => acc + g.subtotal.yearly_fee, 0)),
    setup_fee: r2(clientBilling.groups.reduce((acc, g) => acc + g.subtotal.setup_fee, 0)),
    total: r2(clientBilling.groups.reduce((acc, g) => acc + g.subtotal.total, 0)),
  };

  return {
    month,
    firstDay,
    lastDay,
    summary,
    perNumber,
    costs,
    clientBilling,
  };
}
