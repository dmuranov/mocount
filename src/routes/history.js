// History endpoint — SPEC §9.
// GET /api/history/:yyyymm?client=&country=  (auth)
//
// Loads numbers + volumes for the month and feeds them into the pure
// buildHistoryMatrix. Filters are passed through as-is (matrix does
// the case-folding). MTD truncation lives in the service.

import express from 'express';
import * as XLSX from 'xlsx';
import { requireAuth } from '../auth/middleware.js';
import { supabase } from '../supabase.js';
import { buildHistoryMatrix } from '../services/history.js';
import { monthBounds } from '../services/calc.js';
import { fetchVolumesInRange } from '../util/volumes.js';

export const historyRouter = express.Router();

const YYYYMM_RE = /^\d{4}-\d{2}$/;

async function loadMatrix(ym, query) {
  if (!YYYYMM_RE.test(ym)) {
    const e = new Error('Path must be YYYY-MM (e.g. 2026-04)');
    e.status = 400; throw e;
  }
  const bounds = monthBounds(ym);
  const sb = supabase();
  const { data: numbers, error: numErr } = await sb
    .from('numbers').select('id, number, type, country, client, purchase_price_per_mo, selling_price_per_mo, active');
  if (numErr) throw new Error(numErr.message);
  const volumes = await fetchVolumesInRange(sb, bounds.firstDay, bounds.lastDay);
  return buildHistoryMatrix({
    numbers: numbers || [],
    volumes,
    month: ym,
    client: query.client ? String(query.client) : null,
    country: query.country ? String(query.country) : null,
  });
}

historyRouter.get('/api/history/:yyyymm', requireAuth, async (req, res) => {
  try {
    const matrix = await loadMatrix(String(req.params.yyyymm || '').trim(), req.query);
    res.json({ ok: true, ...matrix });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message });
  }
});

// ── GET /api/history/:yyyymm/xlsx ───────────────────────────
// One sheet per type (SC, LVN). Columns are days of the month;
// rows are numbers. Cells contain volume (the metric the export
// commits to — adding revenue would double the row count or need a
// second sheet, deferring until someone asks).
historyRouter.get('/api/history/:yyyymm/xlsx', requireAuth, async (req, res) => {
  try {
    const ym = String(req.params.yyyymm || '').trim();
    const matrix = await loadMatrix(ym, req.query);
    const days = matrix.days;
    const dayCols = days.map((d) => d.slice(8, 10)); // '01', '02', ...
    const wb = XLSX.utils.book_new();

    for (const type of ['SC', 'LVN']) {
      const sect = matrix.sections[type];
      const rows = (sect?.rows || []).map((r) => {
        const row = {
          Number: r.number,
          country: r.country || '',
          client: r.client || '',
        };
        days.forEach((d, i) => { row[dayCols[i]] = r.byDay[d]?.volume || 0; });
        row.Total = r.totals.volume;
        return row;
      });
      // Section subtotal row.
      if (sect?.rows.length) {
        const totalRow = { Number: `${type} TOTAL`, country: '', client: '' };
        days.forEach((d, i) => { totalRow[dayCols[i]] = sect.byDay[d]?.volume || 0; });
        totalRow.Total = sect.totals.volume;
        rows.push({});
        rows.push(totalRow);
      }
      const header = ['Number', 'country', 'client', ...dayCols, 'Total'];
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows, { header }), type);
    }

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="mocount-history-${ym}.xlsx"`);
    res.send(buf);
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message });
  }
});
