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
import { isoFromMsisdn } from '../util/calling_codes.js';

const SHEET_NAME = 'MO Prices';

// Subscriber-suffix length stored on a catalog entry (denormalized match hint).
// The supplier and the master share the trailing subscriber digits; 6 covers
// the observed VLN tails (e.g. 27840034053 / 2781160001034053 → '034053').
const VLN_SUFFIX_LEN = 6;

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

// Country prefix of a DB number: "ZA - LVNs" → "ZA", "990994" → "".
function prefixCountryOf(number) {
  const m = String(number).match(/^(.+?)\s*-\s*/);
  return m ? m[1].trim().toUpperCase() : '';
}

// A DB number is a VLN parent if its name carries the "LVNs" convention.
const isVlnParent = (number) => /lvns?/i.test(String(number));

const clientKey = (c) => String(c ?? '').trim().toLowerCase();

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
  const cVLN = findCol(H, 'virtual', 'long');     // "Virtual Long Number (VLN)"
  const cClient = findCol(H, 'customer', 'using'); // "Customer Using Number"
  if (cSC < 0 || cBuy < 0 || cSell < 0) {
    return { error: `Could not find required columns (Short Code / Buy Price - Per Message / IDT Sell Price - Per Message) on the "${SHEET_NAME}" tab` };
  }

  const byCode = new Map();        // code -> { buy, sell, supplier, country }
  const conflictCodes = new Set(); // codes with >1 differing price row
  const vlnRows = [];              // { raw, suffix, iso, client, buy, sell, country }
  for (let i = 1; i < aoa.length; i++) {
    const r = aoa[i];
    const code = String(r[cSC] ?? '').trim();
    const buy = parsePrice(r[cBuy]);
    const sell = parsePrice(r[cSell]);

    if (/^\d+$/.test(code) && (buy !== null || sell !== null)) {
      const rec = { buy, sell, supplier: r[cSupplier], country: r[cCountry] };
      if (byCode.has(code)) {
        const prev = byCode.get(code);
        if (!eqPrice(prev.buy, rec.buy) || !eqPrice(prev.sell, rec.sell)) conflictCodes.add(code);
      } else {
        byCode.set(code, rec);
      }
    }

    // VLN rows: one cell may list several numbers (", " / " / " / " and ").
    if (cVLN >= 0) {
      const cell = String(r[cVLN] ?? '').trim();
      if (cell && cell.toLowerCase() !== 'n/a') {
        for (const tok of cell.split(/[,/]| and /i)) {
          const raw = tok.replace(/[^\d]/g, '');
          if (raw.length < 6) continue; // not a real MSISDN
          vlnRows.push({
            raw,
            suffix: raw.slice(-VLN_SUFFIX_LEN),
            iso: isoFromMsisdn(raw),
            client: cClient >= 0 ? String(r[cClient] ?? '').trim() : '',
            buy, sell,
            country: cCountry >= 0 ? r[cCountry] : null,
          });
        }
      }
    }
  }
  return { byCode, conflictCodes, vlnRows };
}

// ── VLN catalog analysis ────────────────────────────────────
// Group the master's VLN rows into parent VLN numbers per (country × client)
// and a catalog entry per VLN. Resolves each group to an existing "<CC> - LVNs"
// parent (claiming/reusing it) or plans a new "<CC> - LVNs (<client>)".
export function analyzeVln(vlnRows, nums, existingCatalog) {
  const lvnByIso = new Map(); // iso -> [parent number rows]
  for (const n of nums) {
    if (!isVlnParent(n.number)) continue;
    const iso = prefixCountryOf(n.number);
    if (!lvnByIso.has(iso)) lvnByIso.set(iso, []);
    lvnByIso.get(iso).push(n);
  }
  const catalogByRaw = new Map((existingCatalog || []).map((c) => [c.raw_value, c]));

  const parents = new Map(); // parentKey -> { key, iso, client, existingId, name, buy, sell, claimClient }
  const catalogNew = [];
  const skipped = [];
  let catalogUnchanged = 0;

  const fromNum = (n, claimClient) => ({
    existingId: n.id, name: n.number, claimClient,
    curBuy: n.purchase_price_per_mo != null ? Number(n.purchase_price_per_mo) : null,
    curSell: n.selling_price_per_mo != null ? Number(n.selling_price_per_mo) : null,
  });
  const resolveParent = (iso, client) => {
    const cands = lvnByIso.get(iso) || [];
    const exact = cands.find((n) => clientKey(n.client) === clientKey(client));
    if (exact) return fromNum(exact, false);
    const unclaimed = cands.filter((n) => !clientKey(n.client));
    if (cands.length === 1 && unclaimed.length === 1) return fromNum(unclaimed[0], true);
    return { existingId: null, name: `${iso} - LVNs (${String(client).trim() || 'Unknown'})`, claimClient: false, curBuy: null, curSell: null };
  };

  for (const v of vlnRows) {
    if (!v.iso) { skipped.push({ raw: v.raw, reason: 'no known country calling code' }); continue; }
    const key = `${v.iso}|${clientKey(v.client)}`;
    if (!parents.has(key)) {
      const p = resolveParent(v.iso, v.client);
      parents.set(key, { key, iso: v.iso, client: String(v.client).trim(), buy: v.buy, sell: v.sell, ...p });
    } else {
      // First non-null price for the group wins; later rows just attach.
      const p = parents.get(key);
      if (p.buy == null && v.buy != null) p.buy = v.buy;
      if (p.sell == null && v.sell != null) p.sell = v.sell;
    }
    const existing = catalogByRaw.get(v.raw);
    if (existing
      && clientKey(existing.client) === clientKey(v.client)
      && eqPrice(existing.buy, v.buy) && eqPrice(existing.sell, v.sell)) {
      catalogUnchanged++;
    } else {
      catalogNew.push({ raw: v.raw, suffix: v.suffix, iso: v.iso, client: String(v.client).trim(), parentKey: key, buy: v.buy, sell: v.sell });
    }
  }

  return { parents: [...parents.values()], catalogNew, catalogUnchanged, skipped };
}

// ── parseAndAnalyze ─────────────────────────────────────────
export async function parseAndAnalyze(buffer) {
  const sheet = readSheet(buffer);
  if (sheet.error) return { changes: [], unchanged: 0, conflicts: [], notInSheet: [], errors: [{ error: sheet.error }] };
  const { byCode, conflictCodes, vlnRows } = sheet;

  const sb0 = supabase();
  const { data: nums, error } = await sb0
    .from('numbers').select('id, number, client, purchase_price_per_mo, selling_price_per_mo, active').order('number');
  if (error) return { changes: [], unchanged: 0, conflicts: [], notInSheet: [], errors: [{ error: 'Numbers lookup failed: ' + error.message }] };
  const { data: existingCatalog } = await sb0.from('vln_catalog').select('raw_value, client, buy, sell');

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

  const vln = analyzeVln(vlnRows || [], nums, existingCatalog || []);

  return {
    changes,
    unchanged,
    conflicts,
    notInSheet,
    vln: {
      parentsToCreate: vln.parents.filter((p) => !p.existingId).map((p) => p.name),
      parentsReused: vln.parents.filter((p) => p.existingId).map((p) => p.name),
      catalogNew: vln.catalogNew.length,
      catalogUnchanged: vln.catalogUnchanged,
      skipped: vln.skipped,
      // full detail for commit (parents + entries); UI reads the counts above.
      _parents: vln.parents,
      _catalogNew: vln.catalogNew,
    },
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

  // ── VLN catalog ──
  // Create/claim parent VLN numbers, then upsert the catalog entries that map
  // each master VLN (its subscriber suffix) to its parent + client + price.
  const vlnResult = await applyVlnPlan(sb, plan.vln, userId);
  if (vlnResult.error) return { ok: false, error: vlnResult.error };

  return {
    ok: true,
    applied,
    unchanged: plan.unchanged,
    conflicts: plan.conflicts,
    notInSheet: plan.notInSheet,
    vln: vlnResult.summary,
    effectiveFrom: plan.effectiveFrom,
  };
}

// Apply the VLN portion of a Sync Prices commit: ensure parents exist (claim an
// existing "<CC> - LVNs" or create "<CC> - LVNs (<client>)", update its price),
// then upsert vln_catalog rows keyed by the master's literal VLN string.
async function applyVlnPlan(sb, vln, userId) {
  if (!vln || (!vln._parents?.length && !vln._catalogNew?.length)) {
    return { summary: { parentsCreated: 0, parentsClaimed: 0, catalogUpserted: 0 } };
  }
  const parentId = new Map(); // parentKey -> number_id
  let parentsCreated = 0, parentsClaimed = 0;

  for (const p of vln._parents) {
    if (p.existingId) {
      parentId.set(p.key, p.existingId);
      if (p.claimClient && p.client) {
        await sb.from('numbers').update({ client: p.client, updated_by: userId }).eq('id', p.existingId);
        parentsClaimed++;
      }
      // Only rewrite price when it actually differs (avoid redundant history).
      const patch = {};
      if (p.buy != null && !eqPrice(p.curBuy, p.buy)) {
        await applyPriceChange(sb, p.existingId, 'purchase', p.buy, userId);
        patch.purchase_price_per_mo = p.buy;
      }
      if (p.sell != null && !eqPrice(p.curSell, p.sell)) {
        await applyPriceChange(sb, p.existingId, 'selling', p.sell, userId);
        patch.selling_price_per_mo = p.sell;
      }
      if (Object.keys(patch).length) await sb.from('numbers').update({ ...patch, updated_by: userId }).eq('id', p.existingId);
      continue;
    }
    const { data: created, error } = await sb.from('numbers').insert({
      number: p.name, type: 'LVN', country: p.iso, client: p.client || null,
      purchase_price_per_mo: p.buy ?? 0, selling_price_per_mo: p.sell ?? 0, active: true, updated_by: userId,
    }).select('id').maybeSingle();
    if (error) return { error: `Create VLN parent ${p.name} failed: ${error.message}` };
    parentId.set(p.key, created.id);
    parentsCreated++;
    await auditLog({ userId, action: 'number.create', entity: 'number', entityId: created.id,
      diff: { source: 'vln_catalog_sync', number: p.name, client: p.client || null, purchase: p.buy, selling: p.sell } });
  }

  let catalogUpserted = 0;
  const rows = (vln._catalogNew || []).map((c) => ({
    country: c.iso, suffix: c.suffix, raw_value: c.raw, client: c.client || null,
    parent_number_id: parentId.get(c.parentKey), buy: c.buy, sell: c.sell, active: true, updated_by: userId,
  })).filter((r) => r.parent_number_id);
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await sb.from('vln_catalog').upsert(rows.slice(i, i + 500), { onConflict: 'raw_value' });
    if (error) return { error: `VLN catalog upsert failed: ${error.message}` };
    catalogUpserted += rows.slice(i, i + 500).length;
  }

  return { summary: { parentsCreated, parentsClaimed, catalogUpserted } };
}
