// Volumes xlsx import (SPEC §8). Same two-pass shape as the numbers
// importer: parseAndAnalyze + commitVolumesImport. Header set is much
// smaller — { Number, date, volume }.
//
// Closed-month rows are reported as errors in the dry-run preview and
// skipped on commit. The DB trigger remains the no-bypass guarantee.

import * as XLSX from 'xlsx';
import { supabase } from '../supabase.js';
import { auditLog } from '../util/audit.js';

const HEADER_ALIASES = new Map(Object.entries({
  number: 'number',
  num: 'number',
  msisdn: 'number',
  date: 'date',
  day: 'date',
  volume: 'volume',
  vol: 'volume',
  count: 'volume',
  messages: 'volume',
}));

function canonHeader(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, '_');
}

function pad2(n) { return String(n).padStart(2, '0'); }
function toIsoDate(d) {
  const yr = d.getUTCFullYear();
  return `${yr}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

// Same multi-format parser as the numbers importer. Returns a
// 'YYYY-MM-DD' or null.
function parseDate(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date && !isNaN(v.getTime())) return toIsoDate(v);
  if (typeof v === 'number' && Number.isFinite(v)) {
    const ms = Math.round((v - 25569) * 86400 * 1000);
    const d = new Date(ms);
    return isNaN(d.getTime()) ? null : toIsoDate(d);
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;
  m = s.match(/^(\d{1,2})[\/.](\d{1,2})[\/.](\d{4})$/);
  if (m) return `${m[3]}-${pad2(m[2])}-${pad2(m[1])}`;
  return null;
}

function parseVolume(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return null;
  return n;
}

function readSheetRows(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) return { rows: [], headerMap: {} };
  const sheet = wb.Sheets[sheetName];
  const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: true });
  if (!aoa.length) return { rows: [], headerMap: {} };

  const headerRow = aoa[0];
  const headerMap = {};
  for (let i = 0; i < headerRow.length; i++) {
    const canon = canonHeader(headerRow[i]);
    const mapped = HEADER_ALIASES.get(canon);
    if (mapped) headerMap[mapped] = i;
  }
  const rows = [];
  for (let i = 1; i < aoa.length; i++) {
    const r = aoa[i];
    if (!r || r.every((c) => c === '' || c == null)) continue;
    rows.push(r);
  }
  return { rows, headerMap };
}

// ── parseAndAnalyze ─────────────────────────────────────────
// Returns { toUpsert, errors, totalRows, closedMonths } where
// toUpsert has { number, date, volume } (number is the *string*, not
// the id — we resolve to id at commit time). Closed-month rows go to
// errors with a clear message; the rest go to toUpsert.
export async function parseAndAnalyze(buffer) {
  const { rows, headerMap } = readSheetRows(buffer);

  const required = ['number', 'date', 'volume'];
  const missing = required.filter((k) => !(k in headerMap));
  if (missing.length) {
    return {
      toUpsert: [], errors: [{ idx: -1, error: `Missing required column(s): ${missing.join(', ')}` }],
      totalRows: rows.length, closedMonths: [],
    };
  }

  // Pull every referenced number string in one query so we can resolve
  // ids at commit. Inactive numbers are still allowed — the DB doesn't
  // care about active for a volume insert.
  const numberStrings = [...new Set(rows.map((r) => String(r[headerMap.number] || '').trim()).filter(Boolean))];
  const idByNumber = new Map();
  if (numberStrings.length) {
    const { data, error } = await supabase()
      .from('numbers').select('id, number').in('number', numberStrings);
    if (error) {
      return { toUpsert: [], errors: [{ idx: -1, error: 'Number lookup failed: ' + error.message }], totalRows: rows.length, closedMonths: [] };
    }
    for (const n of data || []) idByNumber.set(n.number, n.id);
  }

  const toUpsert = [];
  const errors = [];
  const monthsSeen = new Set();

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const number = String(r[headerMap.number] ?? '').trim();
    const dateRaw = r[headerMap.date];
    const volRaw = r[headerMap.volume];

    if (!number) { errors.push({ idx: i, error: 'number is empty' }); continue; }
    const id = idByNumber.get(number);
    if (!id) { errors.push({ idx: i, error: `Number "${number}" not found in database` }); continue; }

    const date = parseDate(dateRaw);
    if (!date) { errors.push({ idx: i, error: `Invalid date "${dateRaw}"` }); continue; }

    const volume = parseVolume(volRaw);
    if (volume === null) { errors.push({ idx: i, error: `Invalid volume "${volRaw}" (must be non-negative integer)` }); continue; }

    monthsSeen.add(date.slice(0, 7));
    toUpsert.push({ idx: i, number, number_id: id, date, volume });
  }

  // Closed-month filter (approved or sent). Errors stay in errors array
  // so the UI shows the user exactly which rows can't be committed.
  let closedMonths = [];
  if (monthsSeen.size) {
    const { data, error } = await supabase()
      .from('monthly_closes')
      .select('month, status')
      .in('month', [...monthsSeen])
      .in('status', ['approved', 'sent']);
    if (error) {
      return { toUpsert: [], errors: [{ idx: -1, error: 'Closed-month check failed: ' + error.message }], totalRows: rows.length, closedMonths: [] };
    }
    closedMonths = (data || []).map((c) => c.month);
    if (closedMonths.length) {
      const closedSet = new Set(closedMonths);
      const writable = [];
      for (const u of toUpsert) {
        if (closedSet.has(u.date.slice(0, 7))) {
          errors.push({ idx: u.idx, error: `Month ${u.date.slice(0, 7)} is closed; row refused` });
        } else {
          writable.push(u);
        }
      }
      toUpsert.length = 0;
      toUpsert.push(...writable);
    }
  }

  return { toUpsert, errors, totalRows: rows.length, closedMonths };
}

// ── commitVolumesImport ─────────────────────────────────────
// Re-runs analyze (single source of truth) then upserts in chunks of
// 500 to keep PostgREST request size sane. Audits one row per
// volume that actually changed.
export async function commitVolumesImport(buffer, userId) {
  const plan = await parseAndAnalyze(buffer);
  if (plan.errors.some((e) => e.idx === -1)) {
    return { ok: false, error: plan.errors[0].error };
  }
  if (!plan.toUpsert.length) {
    return { ok: true, written: 0, changed: 0, unchanged: 0, errors: plan.errors, closedMonths: plan.closedMonths };
  }

  // Snapshot prior values for audit.
  const numberIds = [...new Set(plan.toUpsert.map((r) => r.number_id))];
  const dates = [...new Set(plan.toUpsert.map((r) => r.date))];
  const sb = supabase();
  const { data: prior, error: priorErr } = await sb
    .from('daily_volumes')
    .select('number_id, date, volume')
    .in('number_id', numberIds)
    .in('date', dates);
  if (priorErr) return { ok: false, error: priorErr.message };
  const priorMap = new Map((prior || []).map((p) => [`${p.number_id}|${p.date}`, Number(p.volume)]));

  const nowIso = new Date().toISOString();
  let changed = 0, unchanged = 0;
  const written = plan.toUpsert.length;

  // Chunked upsert.
  for (let i = 0; i < plan.toUpsert.length; i += 500) {
    const chunk = plan.toUpsert.slice(i, i + 500).map((r) => ({
      number_id: r.number_id,
      date: r.date,
      volume: r.volume,
      entered_by: userId,
      entered_at: nowIso,
    }));
    const { error: upErr } = await sb
      .from('daily_volumes')
      .upsert(chunk, { onConflict: 'number_id,date' });
    if (upErr) return { ok: false, error: upErr.message };
  }

  for (const r of plan.toUpsert) {
    const prev = priorMap.get(`${r.number_id}|${r.date}`);
    if (prev === r.volume) { unchanged++; continue; }
    changed++;
    await auditLog({
      userId,
      action: 'volume.upsert',
      entity: 'daily_volume',
      entityId: `${r.number_id}|${r.date}`,
      diff: { source: 'xlsx_import', number: r.number, date: r.date, volume: [prev ?? null, r.volume] },
    });
  }

  return { ok: true, written, changed, unchanged, errors: plan.errors, closedMonths: plan.closedMonths };
}
