// Combined xlsx import — one workbook holds Number metadata, fees,
// AND daily volumes. Each row is keyed by Number; the same Number
// can repeat across rows for different days.
//
// Convention:
//   • The FIRST occurrence of a Number defines its metadata + fees.
//     Subsequent rows for that Number only contribute (date, volume).
//   • A row contributes a volume only when *both* date AND volume
//     are present. Date-only or volume-only rows raise a row error.
//   • Fees are queued from the first row whose corresponding columns
//     are filled. Duplicates (same number/side/type/effective_from)
//     are deduped silently.
//
// Two-pass shape unchanged: parseAndAnalyze → preview, commit re-runs
// the parse and applies. Closed-month volumes surface as preview
// errors; the DB trigger remains the no-bypass guarantee.

import * as XLSX from 'xlsx';
import { supabase } from '../supabase.js';
import { auditLog } from '../util/audit.js';
import { parseDate, parseBool, canonHeader } from '../util/xlsx_helpers.js';

const VALID_TYPES = new Set(['SC', 'VLN']);

// Metadata + fee columns mirror the original numbers spreadsheet.
// Volume columns (date, volume) added on the same row.
const HEADER_ALIASES = new Map(Object.entries({
  number: 'number',
  num: 'number',
  msisdn: 'number',
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
  cost_yearly_fee: 'cost_yearly_fee',
  cost_yearly_from: 'cost_yearly_from',
  cost_setup_fee: 'cost_setup_fee',
  cost_setup_date: 'cost_setup_date',
  sale_monthly_fee: 'sale_monthly_fee',
  sale_monthly_from: 'sale_monthly_from',
  sale_yearly_fee: 'sale_yearly_fee',
  sale_yearly_from: 'sale_yearly_from',
  sale_setup_fee: 'sale_setup_fee',
  sale_setup_date: 'sale_setup_date',
  active: 'active',
  date: 'date',
  day: 'date',
  volume: 'volume',
  vol: 'volume',
  count: 'volume',
  messages: 'volume',
}));

// Fee column groups: each tuple = [amountKey, dateKey, side, type].
const FEE_GROUPS = [
  ['cost_monthly_fee', 'cost_monthly_from', 'cost', 'monthly'],
  ['cost_yearly_fee',  'cost_yearly_from',  'cost', 'yearly'],
  ['cost_setup_fee',   'cost_setup_date',   'cost', 'setup'],
  ['sale_monthly_fee', 'sale_monthly_from', 'sale', 'monthly'],
  ['sale_yearly_fee',  'sale_yearly_from',  'sale', 'yearly'],
  ['sale_setup_fee',   'sale_setup_date',   'sale', 'setup'],
];

function readSheet(buffer) {
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

function getCell(row, headerMap, key) {
  const idx = headerMap[key];
  if (idx === undefined) return undefined;
  return row[idx];
}

function asPrice(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Number(n.toFixed(4));
}

function asAmount(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Number(n.toFixed(2));
}

function asVolume(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return null;
  return n;
}

// ── parseAndAnalyze ─────────────────────────────────────────
export async function parseAndAnalyze(buffer) {
  const { rows, headerMap } = readSheet(buffer);

  if (!('number' in headerMap)) {
    return {
      toCreate: [], toUpdate: [], feesToCreate: [], volumesToUpsert: [],
      errors: [{ idx: -1, error: "Missing required column 'number'" }],
      closedMonths: [], totalRows: rows.length,
    };
  }

  // Pass 1: bucket rows by canonical number, parse cells, produce
  // per-row issues we want to surface in the preview.
  const byNumber = new Map(); // number -> { metaRow, metaIdx, volumes: [{idx,date,volume}], feeDecls: [{...}] }
  const errors = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const number = String(getCell(r, headerMap, 'number') ?? '').trim();
    if (!number) { errors.push({ idx: i, error: 'number is empty' }); continue; }

    if (!byNumber.has(number)) {
      byNumber.set(number, { number, metaIdx: i, metaRow: r, volumes: [], feeDecls: [] });
    }
    const bucket = byNumber.get(number);

    // Volume cell: date+volume both present == volume row. One of two
    // present (but not both) is a row error.
    const dateRaw = getCell(r, headerMap, 'date');
    const volRaw = getCell(r, headerMap, 'volume');
    const hasDate = dateRaw !== undefined && dateRaw !== '' && dateRaw !== null;
    const hasVol = volRaw !== undefined && volRaw !== '' && volRaw !== null;
    if (hasDate || hasVol) {
      if (!hasDate || !hasVol) {
        errors.push({ idx: i, error: 'date and volume must both be present (or both empty) on a row' });
      } else {
        const date = parseDate(dateRaw);
        const volume = asVolume(volRaw);
        if (!date) errors.push({ idx: i, error: `Invalid date "${dateRaw}"` });
        else if (volume === null) errors.push({ idx: i, error: `Invalid volume "${volRaw}" (must be non-negative integer)` });
        else bucket.volumes.push({ idx: i, date, volume });
      }
    }

    // Fee declarations only from the first row of this number.
    if (i === bucket.metaIdx) {
      for (const [amtKey, dateKey, side, type] of FEE_GROUPS) {
        const amtRaw = getCell(r, headerMap, amtKey);
        const dRaw = getCell(r, headerMap, dateKey);
        const hasAmt = amtRaw !== undefined && amtRaw !== '' && amtRaw !== null;
        const hasD = dRaw !== undefined && dRaw !== '' && dRaw !== null;
        if (!hasAmt && !hasD) continue;
        if (!hasAmt || !hasD) {
          errors.push({ idx: i, error: `${amtKey}/${dateKey} must both be filled or both empty` });
          continue;
        }
        const amount = asAmount(amtRaw);
        const date = parseDate(dRaw);
        if (amount === null) errors.push({ idx: i, error: `Invalid ${amtKey} "${amtRaw}"` });
        else if (!date) errors.push({ idx: i, error: `Invalid ${dateKey} "${dRaw}"` });
        else bucket.feeDecls.push({ side, type, amount, effective_from: date });
      }
    }
  }

  // Pass 2: pull existing numbers + fees so we can categorize create vs update.
  const numberStrings = [...byNumber.keys()];
  const existingByNumber = new Map();
  if (numberStrings.length) {
    const { data, error } = await supabase()
      .from('numbers').select('id, number, type, country, client, purchase_price_per_mo, selling_price_per_mo, active')
      .in('number', numberStrings);
    if (error) {
      return {
        toCreate: [], toUpdate: [], feesToCreate: [], volumesToUpsert: [],
        errors: [{ idx: -1, error: 'Existing-numbers lookup failed: ' + error.message }],
        closedMonths: [], totalRows: rows.length,
      };
    }
    for (const n of data || []) existingByNumber.set(n.number, n);
  }

  const toCreate = [];
  const toUpdate = [];
  const feesToCreate = [];
  const volumesToUpsert = [];

  for (const bucket of byNumber.values()) {
    const meta = bucket.metaRow;
    const i = bucket.metaIdx;

    const typeRaw = String(getCell(meta, headerMap, 'type') ?? '').trim().toUpperCase();
    const countryRaw = getCell(meta, headerMap, 'country');
    const country = countryRaw == null || countryRaw === '' ? null : String(countryRaw).trim().toUpperCase();
    const clientRaw = getCell(meta, headerMap, 'client');
    const client = clientRaw == null ? null : String(clientRaw).trim() || null;
    const purchase = asPrice(getCell(meta, headerMap, 'purchase_price'));
    const selling = asPrice(getCell(meta, headerMap, 'selling_price'));
    const activeRaw = getCell(meta, headerMap, 'active');
    const activeParsed = activeRaw == null || activeRaw === '' ? null : parseBool(activeRaw);

    const existing = existingByNumber.get(bucket.number);

    if (!existing) {
      // Creating a new number: type + prices required.
      if (!VALID_TYPES.has(typeRaw)) errors.push({ idx: i, error: `Number "${bucket.number}" is new — type must be SC or VLN` });
      else if (purchase === null) errors.push({ idx: i, error: `Number "${bucket.number}" is new — purchase_price required` });
      else if (selling === null) errors.push({ idx: i, error: `Number "${bucket.number}" is new — selling_price required` });
      else {
        toCreate.push({
          number: bucket.number,
          type: typeRaw,
          country,
          client,
          purchase_price_per_mo: purchase,
          selling_price_per_mo: selling,
          active: activeParsed === false ? false : true,
        });
      }
    } else {
      // Updating an existing number: only fields that diverge make the patch.
      const patch = {};
      if (typeRaw && VALID_TYPES.has(typeRaw) && typeRaw !== existing.type) patch.type = typeRaw;
      if (country !== undefined && country !== existing.country) patch.country = country;
      if (client !== undefined && client !== existing.client) patch.client = client;
      if (purchase !== null && Number(existing.purchase_price_per_mo) !== purchase) patch.purchase_price_per_mo = purchase;
      if (selling !== null && Number(existing.selling_price_per_mo) !== selling) patch.selling_price_per_mo = selling;
      if (activeParsed !== null && activeParsed !== existing.active) patch.active = activeParsed;
      if (Object.keys(patch).length) {
        toUpdate.push({ id: existing.id, number: bucket.number, patch });
      }
    }

    // Fees: queue declarations. We dedupe against existing fees later
    // at commit time so a re-run doesn't double-insert.
    for (const f of bucket.feeDecls) feesToCreate.push({ number: bucket.number, ...f });

    // Volumes: queue. number_id resolved at commit time (commit may
    // be inserting the number freshly).
    for (const v of bucket.volumes) volumesToUpsert.push({ idx: v.idx, number: bucket.number, date: v.date, volume: v.volume });
  }

  // Closed-month filter on volumes. Volumes for closed months become
  // row errors; the rest stay in volumesToUpsert.
  let closedMonths = [];
  const monthsSeen = new Set(volumesToUpsert.map((v) => v.date.slice(0, 7)));
  if (monthsSeen.size) {
    const { data, error } = await supabase()
      .from('monthly_closes').select('month, status')
      .in('month', [...monthsSeen]).in('status', ['approved', 'sent']);
    if (error) {
      return {
        toCreate: [], toUpdate: [], feesToCreate: [], volumesToUpsert: [],
        errors: [{ idx: -1, error: 'Closed-month check failed: ' + error.message }],
        closedMonths: [], totalRows: rows.length,
      };
    }
    closedMonths = (data || []).map((c) => c.month);
    if (closedMonths.length) {
      const closedSet = new Set(closedMonths);
      const writable = [];
      for (const v of volumesToUpsert) {
        if (closedSet.has(v.date.slice(0, 7))) {
          errors.push({ idx: v.idx, error: `Month ${v.date.slice(0, 7)} is closed; volume row refused` });
        } else {
          writable.push(v);
        }
      }
      volumesToUpsert.length = 0;
      volumesToUpsert.push(...writable);
    }
  }

  return { toCreate, toUpdate, feesToCreate, volumesToUpsert, errors, closedMonths, totalRows: rows.length };
}

// ── commitImport ────────────────────────────────────────────
export async function commitImport(buffer, userId) {
  const plan = await parseAndAnalyze(buffer);
  if (plan.errors.some((e) => e.idx === -1)) {
    return { ok: false, error: plan.errors[0].error };
  }

  const sb = supabase();

  // 1) Create numbers (one at a time; small set, fine).
  let createdN = 0;
  for (const c of plan.toCreate) {
    const { data, error } = await sb.from('numbers').insert({
      number: c.number,
      type: c.type,
      country: c.country,
      client: c.client,
      purchase_price_per_mo: c.purchase_price_per_mo,
      selling_price_per_mo: c.selling_price_per_mo,
      active: c.active,
      updated_by: userId,
    }).select('id').maybeSingle();
    if (error) return { ok: false, error: `Create ${c.number} failed: ${error.message}` };
    createdN++;
    await auditLog({ userId, action: 'number.create', entity: 'number', entityId: data.id, diff: { source: 'xlsx_import', ...c } });
  }

  // 2) Update numbers.
  let updatedN = 0;
  for (const u of plan.toUpdate) {
    const { error } = await sb.from('numbers').update({ ...u.patch, updated_by: userId }).eq('id', u.id);
    if (error) return { ok: false, error: `Update ${u.number} failed: ${error.message}` };
    updatedN++;
    await auditLog({ userId, action: 'number.update', entity: 'number', entityId: u.id, diff: { source: 'xlsx_import', ...u.patch } });
  }

  // 3) Resolve number → id for everything we still need to write.
  const allNumbers = [
    ...plan.toCreate.map((c) => c.number),
    ...plan.toUpdate.map((u) => u.number),
    ...plan.feesToCreate.map((f) => f.number),
    ...plan.volumesToUpsert.map((v) => v.number),
  ];
  const uniqueNumbers = [...new Set(allNumbers)];
  const idByNumber = new Map();
  if (uniqueNumbers.length) {
    const { data, error } = await sb.from('numbers').select('id, number').in('number', uniqueNumbers);
    if (error) return { ok: false, error: 'Number-id resolution failed: ' + error.message };
    for (const n of data || []) idByNumber.set(n.number, n.id);
  }

  // 4) Fees: dedupe against (number_id, side, type, effective_from) already in DB.
  let feesN = 0;
  if (plan.feesToCreate.length) {
    const numberIds = [...new Set(plan.feesToCreate.map((f) => idByNumber.get(f.number)).filter(Boolean))];
    const { data: existingFees, error: efErr } = await sb
      .from('fees')
      .select('number_id, side, type, effective_from')
      .in('number_id', numberIds);
    if (efErr) return { ok: false, error: 'Fee dedupe lookup failed: ' + efErr.message };
    const existKey = new Set((existingFees || []).map((f) => `${f.number_id}|${f.side}|${f.type}|${f.effective_from}`));

    for (const f of plan.feesToCreate) {
      const number_id = idByNumber.get(f.number);
      if (!number_id) continue;
      const key = `${number_id}|${f.side}|${f.type}|${f.effective_from}`;
      if (existKey.has(key)) continue;
      existKey.add(key);
      const row = {
        number_id,
        type: f.type,
        side: f.side,
        amount: f.amount,
        effective_from: f.effective_from,
        created_by: userId,
      };
      const { data, error } = await sb.from('fees').insert(row).select('id').maybeSingle();
      if (error) return { ok: false, error: `Fee insert failed (${f.number}/${f.side}/${f.type}): ${error.message}` };
      feesN++;
      await auditLog({ userId, action: 'fee.create', entity: 'fee', entityId: data.id, diff: { source: 'xlsx_import', ...row } });
    }
  }

  // 5) Volumes: snapshot prior values for audit, then chunked upsert.
  let volumesWritten = 0, volumesChanged = 0, volumesUnchanged = 0;
  if (plan.volumesToUpsert.length) {
    const numberIds = [...new Set(plan.volumesToUpsert.map((v) => idByNumber.get(v.number)).filter(Boolean))];
    const dates = [...new Set(plan.volumesToUpsert.map((v) => v.date))];
    const { data: prior, error: priorErr } = await sb
      .from('daily_volumes').select('number_id, date, volume')
      .in('number_id', numberIds).in('date', dates);
    if (priorErr) return { ok: false, error: priorErr.message };
    const priorMap = new Map((prior || []).map((p) => [`${p.number_id}|${p.date}`, Number(p.volume)]));

    const nowIso = new Date().toISOString();
    const upsertRows = [];
    for (const v of plan.volumesToUpsert) {
      const number_id = idByNumber.get(v.number);
      if (!number_id) continue;
      upsertRows.push({ number_id, date: v.date, volume: v.volume, entered_by: userId, entered_at: nowIso });
    }
    for (let i = 0; i < upsertRows.length; i += 500) {
      const chunk = upsertRows.slice(i, i + 500);
      const { error } = await sb.from('daily_volumes').upsert(chunk, { onConflict: 'number_id,date' });
      if (error) return { ok: false, error: error.message };
    }
    volumesWritten = upsertRows.length;

    for (const row of upsertRows) {
      const prev = priorMap.get(`${row.number_id}|${row.date}`);
      if (prev === row.volume) { volumesUnchanged++; continue; }
      volumesChanged++;
      await auditLog({
        userId,
        action: 'volume.upsert',
        entity: 'daily_volume',
        entityId: `${row.number_id}|${row.date}`,
        diff: { source: 'xlsx_import', date: row.date, volume: [prev ?? null, row.volume] },
      });
    }
  }

  return {
    ok: true,
    numbers: { created: createdN, updated: updatedN },
    fees: feesN,
    volumes: { written: volumesWritten, changed: volumesChanged, unchanged: volumesUnchanged },
    errors: plan.errors,
    closedMonths: plan.closedMonths,
  };
}
