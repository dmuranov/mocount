// History matrix — SPEC §4 (History page) + §14 step 10.
//
// Builds the SC/LVN-sectioned grid used by the History page and its
// xlsx export. Pure function: caller does the DB pulls and feeds in
// numbers + volumes (DB scoping happens in the route).
//
// Current-month rule: only show days up to *yesterday* per SPEC §4.
// "Yesterday" is computed against `currentDate` (defaults to now) so
// tests can pin time.

import { dayRow, monthBounds, margin } from './calc.js';

function pad2(n) { return String(n).padStart(2, '0'); }

function todayISO(currentDate) {
  const d = currentDate ? new Date(currentDate) : new Date();
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function yesterdayISO(currentDate) {
  const d = currentDate ? new Date(currentDate) : new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function dayList(firstDay, lastDay) {
  const out = [];
  const a = new Date(firstDay + 'T00:00:00Z');
  const b = new Date(lastDay + 'T00:00:00Z');
  for (let d = new Date(a); d <= b; d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(`${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`);
  }
  return out;
}

// ── buildHistoryMatrix ──────────────────────────────────────
// `numbers`     — full set [{ id, number, type, country, client,
//                            purchase_price_per_mo, selling_price_per_mo, active }]
// `volumes`     — [{ number_id, date, volume }] for the month
// `month`       — 'YYYY-MM'
// `currentDate` — optional ISO datetime; defaults to now (for tests)
// `client`      — optional case-insensitive filter; matches exact client
// `country`     — optional ISO-2 filter; matches exact country
//
// Returns a section-keyed structure consumed by the History page.
export function buildHistoryMatrix({
  numbers, volumes, month, currentDate = null, client = null, country = null,
}) {
  const { month: m, firstDay, lastDay } = monthBounds(month);

  // MTD truncation: if `month` is the current calendar month (UTC),
  // cap the visible last day at yesterday. If the current month has
  // no completed days yet (1st of month), the matrix is empty.
  const today = todayISO(currentDate);
  const todayMonth = today.slice(0, 7);
  let visibleLast = lastDay;
  let isCurrent = false;
  if (m === todayMonth) {
    isCurrent = true;
    const yest = yesterdayISO(currentDate);
    // If we're already past the start of this month, cap at yesterday.
    // If `currentDate` is on day 1 of month, yest is in the prior
    // month — show no days.
    if (yest < firstDay) {
      visibleLast = null;
    } else if (yest < lastDay) {
      visibleLast = yest;
    }
  } else if (m > todayMonth) {
    // Future month — defensive; UI shouldn't allow it but the API
    // should still return zeros instead of failing.
    visibleLast = null;
  }

  const days = visibleLast ? dayList(firstDay, visibleLast) : [];

  // Filter numbers per query.
  const c = client ? String(client).trim().toLowerCase() : null;
  const k = country ? String(country).trim().toUpperCase() : null;
  const filtered = (numbers || []).filter((n) => {
    if (c != null && String(n.client || '').trim().toLowerCase() !== c) return false;
    if (k != null && String(n.country || '').trim().toUpperCase() !== k) return false;
    return true;
  });

  // Index numbers by id, and bucket per type (SC / LVN).
  const byId = new Map(filtered.map((n) => [n.id, n]));
  const sectionsTypes = ['SC', 'LVN'];
  const byType = new Map(sectionsTypes.map((t) => [t, []]));
  for (const n of filtered) {
    if (byType.has(n.type)) byType.get(n.type).push(n);
  }
  // Stable order: number ascending within section.
  for (const arr of byType.values()) arr.sort((a, b) => String(a.number).localeCompare(String(b.number)));

  // Pre-bucket volumes per (number_id, date) for O(1) lookup.
  const volByNumDate = new Map();
  for (const v of volumes || []) {
    if (!v || !v.date || !byId.has(v.number_id)) continue;
    if (v.date < firstDay || v.date > lastDay) continue;
    if (visibleLast && v.date > visibleLast) continue;
    volByNumDate.set(`${v.number_id}|${v.date}`, Number(v.volume) || 0);
  }

  const sections = {};
  let grandVolume = 0, grandRevenue = 0;

  for (const type of sectionsTypes) {
    const rows = [];
    const sectionByDay = Object.fromEntries(days.map((d) => [d, { volume: 0, revenue: 0 }]));
    let sectVolume = 0, sectRevenue = 0;

    for (const n of byType.get(type)) {
      const numByDay = {};
      let numVolume = 0, numRevenue = 0;
      for (const d of days) {
        const v = volByNumDate.get(`${n.id}|${d}`) ?? 0;
        if (v === 0) {
          numByDay[d] = { volume: 0, revenue: 0 };
          continue;
        }
        const m2 = margin(n.purchase_price_per_mo, n.selling_price_per_mo);
        const rev = Math.round(v * m2 * 100) / 100;
        numByDay[d] = { volume: v, revenue: rev };
        numVolume += v;
        numRevenue += rev;
        sectionByDay[d].volume += v;
        sectionByDay[d].revenue += rev;
        sectVolume += v;
        sectRevenue += rev;
      }
      rows.push({
        id: n.id,
        number: n.number,
        country: n.country,
        client: n.client,
        active: n.active,
        purchase_price_per_mo: Number(n.purchase_price_per_mo),
        selling_price_per_mo: Number(n.selling_price_per_mo),
        margin_per_mo: margin(n.purchase_price_per_mo, n.selling_price_per_mo),
        byDay: numByDay,
        totals: { volume: numVolume, revenue: Math.round(numRevenue * 100) / 100 },
      });
    }

    // Round section daily totals to 2dp on revenue (volume already int).
    for (const d of days) sectionByDay[d].revenue = Math.round(sectionByDay[d].revenue * 100) / 100;

    sections[type] = {
      rows,
      byDay: sectionByDay,
      totals: { volume: sectVolume, revenue: Math.round(sectRevenue * 100) / 100 },
    };

    grandVolume += sectVolume;
    grandRevenue += sectRevenue;
  }

  return {
    month: m,
    firstDay,
    lastDay,
    visibleLastDay: visibleLast,
    isCurrent,
    days,
    filters: { client: client || null, country: k || null },
    sections,
    grandTotal: { volume: grandVolume, revenue: Math.round(grandRevenue * 100) / 100 },
  };
}
