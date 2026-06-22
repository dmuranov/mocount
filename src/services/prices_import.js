// Price sync from the "MO Costs / Sell Prices" master sheet (xlsx upload).
// Reads the "MO Prices" tab, matches each Short Code to a mocount number
// by code-suffix, and reconciles purchase/selling per-message prices.
//
// SAFE BY DESIGN — this writes to a financial system, so it:
//   • only touches numbers that ALREADY exist in mocount (never creates),
//   • only updates the per-message price (no fees, no metadata),
//   • SKIPS + flags any code that appears more than once in the sheet with
//     conflicting prices (e.g. 78887 base vs Claro, 81818, 440440) so an
//     ambiguous row can never silently overwrite a price,
//   • records every change in number_price_history (effective from today,
//     prior row closed yesterday) + the audit log — same as a manual edit.
//
// Two-pass: parseAndAnalyze → diff preview, commitImport → apply.

import * as XLSX from 'xlsx';
import { supabase } from '../supabase.js';
import { auditLog } from '../util/audit.js';

const SHEET_NAME = 'MO Prices';

function pad2(n) { return String(n).padStart(2, '0'); }
function isoOffset(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}
const todayISO = () => isoOffset(0);
const yesterdayISO = () => isoOffset(-1);

// Pull the leading numeric value out of a price cell: "0.0420 GBP" → 0.042,
// "n/a" → null, 0.015 → 0.015. Negative / non-finite → null.
function parsePrice(v) {
  if (v === null || v === undefined || v === '') return null;
  const m = String(v).replace(/,/g, '').match(/-?\d+(\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  if (!Number.isFinite(n) || n < 0) return null;
  return Number(n.toFixed(4));
}

// Code-suffix of a DB number: "ZA - 33009" → "33009", "990994" → "990994".
function codeOf(number) {
  const m = String(number).match(/-\s*(.+)$/);
  return (m ? m[1] : String(number)).trim();
}

const eqPrice = (a, b) => a != null && b != null && Math.abs(Number(a) - Number(b)) < 1e-9;

function findCol(header, ...needles) {
  for (let i = 0; i < header.length; i++) {
    const h = String(header[i] || '').trim().toLowerCase();
    if (needles.every((n) => h.includes(n))) return i;
  }
  return -1;
}

// Parse the MO Prices tab into code -> { buy, sell, supplier, country }.
// Codes appearing >1x with differing prices are collected as `conflicts`.
function readSheet(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheet = wb.Sheets[SHEET_NAME] || wb.Sheets[wb.SheetNames[0]];
  if (!sheet) return { error: `Sheet "${SHEET_NAME}" not found` };
  const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: true });
  if (aoa.length < 2) return { error: 'Sheet is empty' };

  const H = aoa[0];
  const cSC = findCol(H, 'short', 'code');
  const cBuy = findCol(H, 'buy', 'per message');
  const cSell = findCol(H, 'sell', 'per message');
  const cCountry = findCol(H, 'country');
  const cSupplier = findCol(H, 'supplier');
  if (cSC < 0 || cBuy < 0 || cSell < 0) {
    return { error: `Could not find required columns (Short Code / Buy Price - Per Message / IDT Sell Price - Per Message) on the "${SHEET_NAME}" tab` };
  }

  const byCode = new Map();        // code -> { buy, sell, supplier, country }
  const conflictCodes = new Set(); // codes with >1 differing price row
  for (let i = 1; i < aoa.length; i++) {
    const r = aoa[i];
    const code = String(r[cSC] ?? '').trim();
    if (!/^\d+$/.test(code)) continue; // only numeric short codes
    const rec = { buy: parsePrice(r[cBuy]), sell: parsePrice(r[cSell]), supplier: r[cSupplier], country: r[cCountry] };
    if (rec.buy === null && rec.sell === null) continue;
    if (byCode.has(code)) {
      const prev = byCode.get(code);
      if (!eqPrice(prev.buy, rec.buy) || !eqPrice(prev.sell, rec.sell)) conflictCodes.add(code);
    } else {
      byCode.set(code, rec);
    }
  }
  return { byCode, conflictCodes };
}

// ── parseAndAnalyze ─────────────────────────────────────────
export async function parseAndAnalyze(buffer) {
  const sheet = readSheet(buffer);
  if (sheet.error) return { changes: [], unchanged: 0, conflicts: [], notInSheet: [], errors: [{ error: sheet.error }] };
  const { byCode, conflictCodes } = sheet;

  const { data: nums, error } = await supabase()
    .from('numbers').select('id, number, purchase_price_per_mo, selling_price_per_mo, active').order('number');
  if (error) return { changes: [], unchanged: 0, conflicts: [], notInSheet: [], errors: [{ error: 'Numbers lookup failed: ' + error.message }] };

  const changes = [];
  const conflicts = [];     // mocount numbers whose sheet code is ambiguous → skipped
  const notInSheet = [];    // mocount numbers with no sheet row
  let unchanged = 0;

  for (const n of nums) {
    const code = codeOf(n.number);
    if (conflictCodes.has(code)) { conflicts.push({ number: n.number, code }); continue; }
    const s = byCode.get(code);
    if (!s) { notInSheet.push(n.number); continue; }

    const curBuy = Number(n.purchase_price_per_mo);
    const curSell = Number(n.selling_price_per_mo);
    const newBuy = s.buy, newSell = s.sell;
    const buyChange = newBuy !== null && !eqPrice(curBuy, newBuy);
    const sellChange = newSell !== null && !eqPrice(curSell, newSell);
    if (!buyChange && !sellChange) { unchanged++; continue; }

    changes.push({
      number_id: n.id,
      number: n.number,
      buy: buyChange ? { from: curBuy, to: newBuy } : null,
      sell: sellChange ? { from: curSell, to: newSell } : null,
      supplier: s.supplier || null,
    });
  }

  return {
    changes,
    unchanged,
    conflicts,
    notInSheet,
    effectiveFrom: todayISO(),
    errors: [],
  };
}

async function applyPriceChange(sb, numberId, side, newPrice, userId) {
  const today = todayISO();
  const { data: open } = await sb.from('number_price_history')
    .select('id, effective_from').eq('number_id', numberId).eq('side', side).is('effective_to', null).maybeSingle();
  if (open && open.effective_from === today) {
    await sb.from('number_price_history').update({ price: newPrice, created_by: userId }).eq('id', open.id);
  } else {
    if (open) await sb.from('number_price_history').update({ effective_to: yesterdayISO() }).eq('id', open.id);
    await sb.from('number_price_history').insert({ number_id: numberId, side, price: newPrice, effective_from: today, created_by: userId });
  }
}

// ── commitImport ────────────────────────────────────────────
export async function commitImport(buffer, userId) {
  const plan = await parseAndAnalyze(buffer);
  if (plan.errors.length) return { ok: false, error: plan.errors[0].error };

  const sb = supabase();
  let applied = 0;
  for (const c of plan.changes) {
    const patch = {};
    if (c.buy) { await applyPriceChange(sb, c.number_id, 'purchase', c.buy.to, userId); patch.purchase_price_per_mo = c.buy.to; }
    if (c.sell) { await applyPriceChange(sb, c.number_id, 'selling', c.sell.to, userId); patch.selling_price_per_mo = c.sell.to; }
    if (!Object.keys(patch).length) continue;
    const { error } = await sb.from('numbers').update({ ...patch, updated_by: userId }).eq('id', c.number_id);
    if (error) return { ok: false, error: `Update ${c.number} failed: ${error.message}` };
    applied++;
    await auditLog({
      userId,
      action: 'number.price_sync',
      entity: 'number',
      entityId: c.number_id,
      diff: {
        source: 'price_sheet_sync',
        ...(c.buy ? { purchase_price_per_mo: [c.buy.from, c.buy.to] } : {}),
        ...(c.sell ? { selling_price_per_mo: [c.sell.from, c.sell.to] } : {}),
      },
    });
  }

  return {
    ok: true,
    applied,
    unchanged: plan.unchanged,
    conflicts: plan.conflicts,
    notInSheet: plan.notInSheet,
    effectiveFrom: plan.effectiveFrom,
  };
}
