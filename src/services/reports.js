// Monthly report — SPEC §5. Pure function: takes the data, returns
// the four-tab structure used by the web view AND the xlsx export.
//
// No MTD truncation here — the report is an end-of-month artifact.
// If you call it mid-month, the data is just partial; that's by
// design (matches what gets snapshotted in monthly_closes).

import { margin, monthBounds, activeMonthlyFees, setupFeesInMonth } from './calc.js';

function r2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

// ── buildMonthReport ────────────────────────────────────────
// Inputs:
//   numbers — full set [{ id, number, type, country, client,
//                         purchase_price_per_mo, selling_price_per_mo, active }]
//   volumes — [{ number_id, date, volume }] for the month (caller scopes)
//   fees    — [{ number_id, type, side, amount, effective_from, effective_to }]
//   month   — 'YYYY-MM'
//
// Returns:
//   { month, summary, perNumber, costs, clientBilling }
export function buildMonthReport({ numbers, volumes, fees, month }) {
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

  // Resolve active monthly + in-month setup fees, indexed per number/side.
  const monthlyByNumberSide = new Map(); // 'numId|side' -> {amount}
  const setupByNumberSide = new Map();   // 'numId|side' -> sum amount
  function addMonthly(key, amt) {
    // Defensive: if more than one open-ended fee somehow slipped through,
    // sum them (matches what the P&L would do anyway).
    monthlyByNumberSide.set(key, (monthlyByNumberSide.get(key) || 0) + amt);
  }
  function addSetup(key, amt) {
    setupByNumberSide.set(key, (setupByNumberSide.get(key) || 0) + amt);
  }
  for (const side of ['cost', 'sale']) {
    for (const f of activeMonthlyFees(fees || [], side, month)) {
      addMonthly(`${f.number_id}|${side}`, Number(f.amount) || 0);
    }
    for (const f of setupFeesInMonth(fees || [], side, month)) {
      addSetup(`${f.number_id}|${side}`, Number(f.amount) || 0);
    }
  }

  // ── Per-number derived row (used by tabs 2/3/4) ──
  // Sorted SC-then-VLN, then by number for stable diffing.
  const sortedNumbers = [...numbersList].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'SC' ? -1 : 1;
    return String(a.number).localeCompare(String(b.number));
  });
  const perRow = sortedNumbers.map((n) => {
    const volume = volByNumber.get(n.id) || 0;
    const m = margin(n.purchase_price_per_mo, n.selling_price_per_mo);
    const purchase = Number(n.purchase_price_per_mo) || 0;
    const selling = Number(n.selling_price_per_mo) || 0;
    const monthlyCost = monthlyByNumberSide.get(`${n.id}|cost`) || 0;
    const setupCost = setupByNumberSide.get(`${n.id}|cost`) || 0;
    const monthlySale = monthlyByNumberSide.get(`${n.id}|sale`) || 0;
    const setupSale = setupByNumberSide.get(`${n.id}|sale`) || 0;
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
      revenue: r2(volume * m),
      cost_volume: r2(volume * purchase),
      cost_monthly_fee: r2(monthlyCost),
      cost_setup_fee: r2(setupCost),
      cost_total: r2(volume * purchase + monthlyCost + setupCost),
      sales_volume: r2(volume * selling),
      sale_monthly_fee: r2(monthlySale),
      sale_setup_fee: r2(setupSale),
      sale_total: r2(volume * selling + monthlySale + setupSale),
    };
  });

  // ── Tab 1 — Summary / P&L ──
  // Build line items: one per active cost-monthly fee, one per
  // in-month cost-setup fee. Lines reference Number for traceability.
  const debitLines = [];
  let monthlyCostTotal = 0;
  let setupCostTotal = 0;
  for (const f of activeMonthlyFees(fees || [], 'cost', month)) {
    const n = byId.get(f.number_id);
    if (!n) continue;
    const amt = Number(f.amount) || 0;
    monthlyCostTotal += amt;
    debitLines.push({
      kind: 'cost_monthly',
      number_id: n.id,
      number: n.number,
      label: `Cost monthly — ${n.number}`,
      amount: r2(amt),
    });
  }
  for (const f of setupFeesInMonth(fees || [], 'cost', month)) {
    const n = byId.get(f.number_id);
    if (!n) continue;
    const amt = Number(f.amount) || 0;
    setupCostTotal += amt;
    debitLines.push({
      kind: 'cost_setup',
      number_id: n.id,
      number: n.number,
      label: `Cost setup — ${n.number}`,
      amount: r2(amt),
      effective_from: f.effective_from,
    });
  }
  // Stable line order: cost_monthly first then cost_setup, then by number.
  debitLines.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'cost_monthly' ? -1 : 1;
    return String(a.number).localeCompare(String(b.number));
  });

  const totalRevenue = r2(perRow.reduce((acc, r) => acc + r.revenue, 0));
  const totalCostFees = r2(monthlyCostTotal + setupCostTotal);
  const summary = {
    headline: {
      total_volume: monthVolume,
      total_revenue: totalRevenue,
      total_cost_fees: totalCostFees,
      net: r2(totalRevenue - totalCostFees),
    },
    credit: {
      total_revenue: totalRevenue,
    },
    debit: {
      lines: debitLines,
      monthly_total: r2(monthlyCostTotal),
      setup_total: r2(setupCostTotal),
      total: totalCostFees,
    },
    net: r2(totalRevenue - totalCostFees),
  };

  // ── Tab 2 — Per SC/VLN ──
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
    setup_fee: r.cost_setup_fee,
    total_cost: r.cost_total,
  }));
  const costs = {
    rows: costRows,
    totals: {
      volume: costRows.reduce((acc, x) => acc + x.volume, 0),
      cost: r2(costRows.reduce((acc, x) => acc + x.cost, 0)),
      monthly_fee: r2(costRows.reduce((acc, x) => acc + x.monthly_fee, 0)),
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
