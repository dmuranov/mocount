// Numbers xlsx import (SPEC §8). Two-pass:
//   1. parseAndAnalyze(buffer) → { toCreate, toUpdate, feesToCreate, errors }
//   2. commitNumbersImport(buffer, userId) → applies the changes + audits.
//
// The dry-run is exactly the same parse pass — we just don't write.
// That guarantees the preview the user signs off on matches what
// commit actually does, byte-for-byte.

import * as XLSX from 'xlsx';
import { supabase } from '../supabase.js';
import { auditLog } from '../util/audit.js';

const VALID_TYPES = new Set(['SC', 'VLN']);

// Header alias map → canonical key. Lowercase + trim + collapse spaces
// before lookup so "Selling Price ", "selling_price", "SELLING PRICE"
// all land on `selling_price`.
const HEADER_ALIASES = new Map(Object.entries({
  number: 'number',
  type: 'type',
  country: 'country',
  client: 'client',
  purchase_price: 'purchase_price',
  purchaseprice: 'purchase_price',
  buy_price: 'purchase_price',
  selling_price: 'selling_price',
  sellingprice: 'selling_price',
  sale_price: 'selling_price',
  cost_monthly_fee: 'cost_monthly_fee',
  cost_monthly_from: 'cost_monthly_from',
  cost_setup_fee: 'cost_setup_fee',
  cost_setup_date: 'cost_setup_date',
  sale_monthly_fee: 'sale_monthly_fee',
  sale_monthly_from: 'sale_monthly_from',
  sale_setup_fee: 'sale_setup_fee',
  sale_setup_date: 'sale_setup_date',
  active: 'active',
}));

function canonHeader(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, '_');
}

// Date parsing: accept YYYY-MM-DD, DD/MM/YYYY, DD.MM.YYYY, JS Date,
// Excel serial. Returns 'YYYY-MM-DD' string or null. Never throws —
// throws would tank the whole import on a single bad cell.
function parseDate(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date && !isNaN(v.getTime())) return toIsoDate(v);
  if (typeof v === 'number' && Number.isFinite(v)) {
    // Excel serial (1900 epoch). xlsx with cellDates:true returns Date,
    // but if a number sneaks through we convert it.
    const ms = Math.round((v - 25569) * 86400 * 1000);
    const d = new Date(ms);
    return isNaN(d.getTime()) ? null : toIsoDate(d);
  }
  const s = String(v).trim();
  // YYYY-MM-DD
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;
  // DD/MM/YYYY or DD.MM.YYYY
  m = s.match(/^(\d{1,2})[\/.](\d{1,2})[\/.](\d{4})$/);
  if (m) return `${m[3]}-${pad2(m[2])}-${pad2(m[1])}`;
  return null;
}
function pad2(n) { return String(n).padStart(2, '0'); }
function toIsoDate(d) {
  const yr = d.getUTCFullYear();
  return `${yr}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function parseBool(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'boolean') return v;
  const s = String(v).trim().toLowerCase();
  if (['true', '1', 'yes', 'y'].includes(s)) return true;
  if (['false', '0', 'no', 'n'].includes(s)) return false;
  return null;
}

function parseNum(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ── Parse the workbook into normalized row objects ───────────
function parseWorkbook(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) throw new Error('Workbook has no sheets');
  const sheet = wb.Sheets[sheetName];
  const raw = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: true });

  // Map each row's keys via HEADER_ALIASES. Unknown headers → ignored.
  return raw.map((r, i) => {
    const out = { _rowIdx: i + 2 }; // +2 = header row + 1-based
    for (const k of Object.keys(r)) {
      const canonical = HEADER_ALIASES.get(canonHeader(k));
      if (canonical) out[canonical] = r[k];
    }
    return out;
  });
}

// ── Validate one row → produce a normalized record + per-row errors ──
function validateRow(row) {
  const errors = [];
  const number = String(row.number || '').trim();
  if (!number) errors.push('number is required');

  const type = String(row.type || '').trim().toUpperCase();
  if (!type) errors.push('type is required');
  else if (!VALID_TYPES.has(type)) errors.push(`type must be SC or VLN (got "${row.type}")`);

  const country = (String(row.country || '').trim().toUpperCase()) || null;
  const client = (String(row.client || '').trim()) || null;

  const purchase = parseNum(row.purchase_price);
  if (purchase == null || purchase < 0) errors.push('purchase_price required, non-negative');
  const selling = parseNum(row.selling_price);
  if (selling == null || selling < 0) errors.push('selling_price required, non-negative');

  const active = (() => {
    const b = parseBool(row.active);
    return b == null ? true : b; // default active=true if missing
  })();

  // Fees: 4 buckets. Each = (amount, date) pair. Empty pair → no fee.
  // Amount present + date missing → error.
  const fees = [];
  for (const cfg of [
    { side: 'cost', type: 'monthly', amountKey: 'cost_monthly_fee', dateKey: 'cost_monthly_from' },
    { side: 'cost', type: 'setup',   amountKey: 'cost_setup_fee',   dateKey: 'cost_setup_date'   },
    { side: 'sale', type: 'monthly', amountKey: 'sale_monthly_fee', dateKey: 'sale_monthly_from' },
    { side: 'sale', type: 'setup',   amountKey: 'sale_setup_fee',   dateKey: 'sale_setup_date'   },
  ]) {
    const rawAmt = row[cfg.amountKey];
    const rawDate = row[cfg.dateKey];
    const amt = parseNum(rawAmt);
    const date = parseDate(rawDate);
    const amtPresent = rawAmt !== '' && rawAmt != null;
    const datePresent = rawDate !== '' && rawDate != null;
    if (!amtPresent && !datePresent) continue; // nothing to do
    if (amtPresent && !datePresent) {
      errors.push(`${cfg.amountKey} present but ${cfg.dateKey} is empty`);
      continue;
    }
    if (amt == null || amt < 0) {
      errors.push(`${cfg.amountKey} must be non-negative number`);
      continue;
    }
    if (!date) {
      errors.push(`${cfg.dateKey} not a recognized date (got "${rawDate}")`);
      continue;
    }
    fees.push({
      side: cfg.side, type: cfg.type, amount: amt, effective_from: date,
    });
  }

  return {
    rowIdx: row._rowIdx,
    valid: errors.length === 0,
    errors,
    record: errors.length ? null : { number, type, country, client, purchase, selling, active, fees },
  };
}

// ── Analyze: classify each row vs existing DB state ─────────
async function analyze(rows) {
  const validated = rows.map(validateRow);
  const errors = validated.filter(v => !v.valid).map(v => ({
    row: v.rowIdx, errors: v.errors,
  }));
  const records = validated.filter(v => v.valid).map(v => v.record);

  // Single batch fetch of existing numbers we'd touch.
  const numbers = records.map(r => r.number);
  let existingByNumber = new Map();
  if (numbers.length) {
    const { data, error } = await supabase()
      .from('numbers').select('id, number, country, client, purchase_price_per_mo, selling_price_per_mo, active')
      .in('number', numbers);
    if (error) throw new Error('numbers lookup failed: ' + error.message);
    for (const n of (data || [])) existingByNumber.set(n.number, n);
  }

  const toCreate = [];
  const toUpdate = [];
  const feesToCreate = [];

  for (const r of records) {
    const ex = existingByNumber.get(r.number);
    if (!ex) {
      toCreate.push({
        number: r.number, type: r.type, country: r.country, client: r.client,
        purchase_price_per_mo: r.purchase, selling_price_per_mo: r.selling,
        active: r.active,
      });
    } else {
      // Only flag as "update" if anything actually changed.
      const patch = {};
      if (ex.country !== r.country) patch.country = [ex.country, r.country];
      if (ex.client !== r.client) patch.client = [ex.client, r.client];
      if (Number(ex.purchase_price_per_mo) !== r.purchase) patch.purchase_price_per_mo = [Number(ex.purchase_price_per_mo), r.purchase];
      if (Number(ex.selling_price_per_mo) !== r.selling) patch.selling_price_per_mo = [Number(ex.selling_price_per_mo), r.selling];
      if (ex.active !== r.active) patch.active = [ex.active, r.active];
      if (Object.keys(patch).length) {
        toUpdate.push({ id: ex.id, number: r.number, patch });
      }
    }
    // Fees: queue to create. We don't dedupe against existing fees here
    // because the importer is for INITIAL load — running it twice on
    // the same row would intentionally create duplicate fee history,
    // which we treat as the operator's mistake (audit log shows it).
    for (const f of r.fees) {
      feesToCreate.push({ number: r.number, ...f });
    }
  }

  return { toCreate, toUpdate, feesToCreate, errors, totalRows: rows.length };
}

// ── Public entry: dry-run preview ───────────────────────────
export async function parseAndAnalyze(buffer) {
  const rows = parseWorkbook(buffer);
  return analyze(rows);
}

// ── Public entry: commit (parse + write + audit) ────────────
export async function commitNumbersImport(buffer, userId) {
  const rows = parseWorkbook(buffer);
  const plan = await analyze(rows);
  if (plan.errors.length) {
    return { ok: false, error: 'Errors present — fix and re-preview', plan };
  }

  const sb = supabase();
  let createdN = 0, updatedN = 0, feesN = 0;

  // Inserts: one batch is fine, but we also need the IDs back so we
  // can attach fees that reference number_id. Insert one at a time
  // for clarity — the import is a one-shot operation, not a hot path.
  for (const c of plan.toCreate) {
    const { data, error } = await sb.from('numbers')
      .insert({ ...c, updated_by: userId })
      .select('id, number').maybeSingle();
    if (error) return { ok: false, error: `Insert failed for ${c.number}: ${error.message}` };
    createdN++;
    await auditLog({ userId, action: 'number.create', entity: 'number', entityId: data.id, diff: { source: 'xlsx_import', ...c } });
  }
  for (const u of plan.toUpdate) {
    const apply = {};
    for (const k of Object.keys(u.patch)) apply[k] = u.patch[k][1];
    apply.updated_by = userId;
    const { error } = await sb.from('numbers').update(apply).eq('id', u.id);
    if (error) return { ok: false, error: `Update failed for ${u.number}: ${error.message}` };
    updatedN++;
    await auditLog({ userId, action: 'number.update', entity: 'number', entityId: u.id, diff: { source: 'xlsx_import', ...u.patch } });
  }

  // Fees: need number_id for each. Refetch the numbers we touched.
  if (plan.feesToCreate.length) {
    const allNumbers = [...new Set(plan.feesToCreate.map(f => f.number))];
    const { data: idRows, error: idErr } = await sb.from('numbers')
      .select('id, number').in('number', allNumbers);
    if (idErr) return { ok: false, error: 'Fee number-id lookup failed: ' + idErr.message };
    const idByNumber = new Map((idRows || []).map(r => [r.number, r.id]));

    for (const f of plan.feesToCreate) {
      const number_id = idByNumber.get(f.number);
      if (!number_id) continue;
      const row = {
        number_id,
        type: f.type,
        side: f.side,
        amount: f.amount,
        effective_from: f.effective_from,
        created_by: userId,
      };
      const { data: feeRow, error: feeErr } = await sb.from('fees').insert(row).select('id').maybeSingle();
      if (feeErr) return { ok: false, error: `Fee insert failed (${f.number}/${f.side}/${f.type}): ${feeErr.message}` };
      feesN++;
      await auditLog({ userId, action: 'fee.create', entity: 'fee', entityId: feeRow.id, diff: { source: 'xlsx_import', ...row } });
    }
  }

  return { ok: true, created: createdN, updated: updatedN, fees: feesN, plan };
}
