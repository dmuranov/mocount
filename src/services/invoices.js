// Pro forma invoice builder.
//
// Given a month + client filter + the raw inputs, produce the invoice
// line items grouped by (number, rate-period). When a number's selling
// price changed mid-month, that number contributes multiple lines —
// one per rate window — matching the convention in the Google sample
// invoice ("Apr 1 only @ X / Apr 2-30 @ Y").
//
// Pure function: caller does the DB pulls. CSV/HTML rendering lives in
// the route layer.

import { monthBounds } from './calc.js';

function r2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

// numbers       — [{ id, number, type, country, client, ... }] (already filtered to active=true)
// volumes       — [{ number_id, date, volume }] for the month (extra rows OK; we filter)
// priceHistory  — [{ number_id, side, price, effective_from, effective_to }] (selling-side)
// month         — 'YYYY-MM'
// client        — exact case-insensitive match against numbers.client
//
// Returns { month, monthStart, monthEnd, lines, grandTotal }.
// `lines` shape:
//   { number_id, number, type, country, fromDate, toDate, qty, rate, amount }
export function buildInvoiceLines({ numbers, volumes, priceHistory, month, client }) {
  const { firstDay, lastDay } = monthBounds(month);

  const target = String(client || '').trim().toLowerCase();
  const filtered = (numbers || []).filter((n) =>
    target === '' || String(n.client || '').trim().toLowerCase() === target
  );

  // Index selling-side history per number_id, sorted by effective_from.
  const sellingByNum = new Map();
  for (const h of priceHistory || []) {
    if (!h || h.side !== 'selling') continue;
    if (!sellingByNum.has(h.number_id)) sellingByNum.set(h.number_id, []);
    sellingByNum.get(h.number_id).push(h);
  }
  for (const arr of sellingByNum.values()) {
    arr.sort((a, b) => String(a.effective_from).localeCompare(String(b.effective_from)));
  }

  // Volumes indexed (number_id) → Map(date → volume).
  const volsByNum = new Map();
  for (const v of volumes || []) {
    if (!v || !v.date) continue;
    if (v.date < firstDay || v.date > lastDay) continue;
    if (!volsByNum.has(v.number_id)) volsByNum.set(v.number_id, new Map());
    volsByNum.get(v.number_id).set(v.date, Number(v.volume) || 0);
  }

  const lines = [];
  let grandTotal = 0;

  for (const n of filtered) {
    const history = sellingByNum.get(n.id) || [];
    const numVols = volsByNum.get(n.id);
    if (!numVols || numVols.size === 0) continue;

    for (const h of history) {
      const start = String(h.effective_from) > firstDay ? String(h.effective_from) : firstDay;
      const end = h.effective_to == null
        ? lastDay
        : (String(h.effective_to) < lastDay ? String(h.effective_to) : lastDay);
      if (end < start) continue; // history window doesn't intersect month

      let qty = 0;
      for (const [date, vol] of numVols.entries()) {
        if (date >= start && date <= end) qty += vol;
      }
      if (qty === 0) continue;

      const rate = Number(h.price) || 0;
      const amount = r2(qty * rate);
      lines.push({
        number_id: n.id,
        number: n.number,
        type: n.type,
        country: n.country,
        fromDate: start,
        toDate: end,
        qty,
        rate,
        amount,
      });
      grandTotal += amount;
    }
  }

  // Stable order: type then number alphabetically. Matches History page.
  lines.sort((a, b) => {
    const t = String(a.type).localeCompare(String(b.type));
    return t !== 0 ? t : String(a.number).localeCompare(String(b.number));
  });

  return {
    month,
    monthStart: firstDay,
    monthEnd: lastDay,
    client: client || null,
    lines,
    grandTotal: r2(grandTotal),
  };
}
