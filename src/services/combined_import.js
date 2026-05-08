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

const VALID_TYPES = new Set(['SC', 'LVN']);

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
  month: 'month',
}));

// Day-of-month column headers like "1st", "2nd", "5th", "31"
// (with or without ordinal suffix). Lets you upload a sheet whose
// columns mirror a calendar month (one cell per day) without having
// to flatten it to (number, date, volume) rows by hand.
const DAY_HEADER_RE = /^(\d{1,2})(st|nd|rd|th)?$/;
function parseDayHeader(canon) {
  const m = String(canon || '').match(DAY_HEADER_RE);
  if (!m) return null;
  const d = Number(m[1]);
  return d >= 1 && d <= 31 ? d : null;
}

// Fee column groups: each tuple = [amountKey, dateKey, side, type].
const FEE_GROUPS = [
  ['cost_monthly_fee', 'cost_monthly_from', 'cost', 'monthly'],
  ['cost_yearly_fee',  'cost_yearly_from',  'cost', 'yearly'],
  ['cost_setup_fee',   'cost_setup_date',   'cost', 'setup'],
  ['sale_monthly_fee', 'sale_monthly_from', 'sale', 'monthly'],
  ['sale_yearly_fee',  'sale_yearly_from',  'sale', 'yearly'],
  ['sale_setup_fee',   'sale_setup_date',   'sale', 'setup'],
];

function readWorkbook(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) return { wb, rows: [], headerMap: {}, dayCols: {} };
  const sheet = wb.Sheets[sheetName];
  const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: true });
  if (!aoa.length) return { wb, rows: [], headerMap: {}, dayCols: {} };

  const headerRow = aoa[0];
  const headerMap = {};
  const dayCols = {}; // day number (1..31) -> col index
  for (let i = 0; i < headerRow.length; i++) {
    const canon = canonHeader(headerRow[i]);
    const mapped = HEADER_ALIASES.get(canon);
    if (mapped) headerMap[mapped] = i;
    const day = parseDayHeader(canon);
    if (day !== null) dayCols[day] = i;
  }
  const rows = [];
  for (let i = 1; i < aoa.length; i++) {
    const r = aoa[i];
    if (!r || r.every((c) => c === '' || c == null)) continue;
    rows.push(r);
  }
  return { wb, rows, headerMap, dayCols };
}

function pad2(n) { return String(n).padStart(2, '0'); }
function defaultCurrentMonth() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`;
}

// Phone validation matches the LVN members API (digits + optional +).
const PHONE_RE = /^\+?\d{6,20}$/;

// Read a member tab: take column A, coerce to string, drop empty
// cells and obvious header rows. Anything that doesn't validate as
// a phone is silently skipped (covers "Phone" headers without
// failing the import on stray label cells).
function readMemberTab(wb, tabName) {
  const sheet = wb.Sheets[tabName];
  if (!sheet) return null;
  const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: true });
  const phones = [];
  for (const row of aoa) {
    if (!row || !row.length) continue;
    const cell = row[0];
    if (cell === null || cell === undefined || cell === '') continue;
    const s = String(cell).trim();
    if (!PHONE_RE.test(s)) continue;
    phones.push(s);
  }
  return phones;
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
  const { wb, rows, headerMap, dayCols } = readWorkbook(buffer);

  const emptyMembers = { toCreate: [], toDeactivate: [], warnings: [] };
  if (!('number' in headerMap)) {
    return {
      toCreate: [], toUpdate: [], feesToCreate: [], volumesToUpsert: [],
      members: emptyMembers,
      errors: [{ idx: -1, error: "Missing required column 'number'" }],
      closedMonths: [], totalRows: rows.length,
    };
  }

  // Default month for day-of-month columns (no per-row 'month' override).
  const fallbackMonth = defaultCurrentMonth();
  const dayColEntries = Object.entries(dayCols);

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

    // Day-of-month columns ("1st", "5th", "31st", ...): each cell is
    // that day's volume. Month comes from a per-row `month` cell if
    // set (YYYY-MM), else current calendar month.
    if (dayColEntries.length) {
      const monthRaw = getCell(r, headerMap, 'month');
      let monthForRow = fallbackMonth;
      if (monthRaw !== undefined && monthRaw !== null && monthRaw !== '') {
        const s = String(monthRaw).trim();
        if (/^\d{4}-\d{2}$/.test(s)) monthForRow = s;
        else { errors.push({ idx: i, error: `Invalid month "${s}" (expected YYYY-MM)` }); }
      }
      for (const [dayStr, colIdx] of dayColEntries) {
        const cell = r[colIdx];
        if (cell === '' || cell === null || cell === undefined) continue;
        const v = asVolume(cell);
        if (v === null) {
          errors.push({ idx: i, error: `Invalid volume "${cell}" on day ${dayStr}` });
          continue;
        }
        if (v === 0) continue; // zero-volume days don't need rows
        const date = `${monthForRow}-${pad2(Number(dayStr))}`;
        bucket.volumes.push({ idx: i, date, volume: v });
      }
    }

    // Fee declarations only from the first row of this number.
    // Filled amount + missing date defaults to 2020-01-01 (an
    // "always-on" anchor far enough back to predate any imports).
    // For yearly/setup that means charged in Jan-of-anniversary or
    // never (past month) — see SPEC §3 fee resolution for details.
    // Filled date + missing amount is an error (date alone is meaningless).
    if (i === bucket.metaIdx) {
      for (const [amtKey, dateKey, side, type] of FEE_GROUPS) {
        const amtRaw = getCell(r, headerMap, amtKey);
        const dRaw = getCell(r, headerMap, dateKey);
        const hasAmt = amtRaw !== undefined && amtRaw !== '' && amtRaw !== null;
        const hasD = dRaw !== undefined && dRaw !== '' && dRaw !== null;
        if (!hasAmt && !hasD) continue;
        if (!hasAmt) {
          errors.push({ idx: i, error: `${dateKey} set without ${amtKey} — fill the amount or clear both` });
          continue;
        }
        const amount = asAmount(amtRaw);
        if (amount === null) {
          errors.push({ idx: i, error: `Invalid ${amtKey} "${amtRaw}"` });
          continue;
        }
        let date = '2020-01-01';
        if (hasD) {
          const parsed = parseDate(dRaw);
          if (!parsed) {
            errors.push({ idx: i, error: `Invalid ${dateKey} "${dRaw}"` });
            continue;
          }
          date = parsed;
        }
        bucket.feeDecls.push({ side, type, amount, effective_from: date });
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
        members: emptyMembers,
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
  const lvnBucketsByNumber = new Map(); // number -> bucket  (LVN parents only)

  for (const bucket of byNumber.values()) {
    const meta = bucket.metaRow;
    const i = bucket.metaIdx;

    // hasCol(k) tells us "this column appeared in the spreadsheet at all".
    // Critical for the update path: a missing column must mean
    // "leave the field alone", NOT "set it to null". The latter wiped
    // 38 numbers' country/client when a volumes-only file was uploaded.
    const hasCol = (k) => k in headerMap;

    const typeRaw = String(getCell(meta, headerMap, 'type') ?? '').trim().toUpperCase();
    const existingType = existingByNumber.get(bucket.number)?.type;
    if (typeRaw === 'LVN' || existingType === 'LVN') lvnBucketsByNumber.set(bucket.number, bucket);
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
      if (!VALID_TYPES.has(typeRaw)) errors.push({ idx: i, error: `Number "${bucket.number}" is new — type must be SC or LVN` });
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
      // Updating an existing number: only fields that (a) the file
      // actually has a column for AND (b) diverge from the DB.
      const patch = {};
      if (hasCol('type') && typeRaw && VALID_TYPES.has(typeRaw) && typeRaw !== existing.type) patch.type = typeRaw;
      if (hasCol('country') && country !== existing.country) patch.country = country;
      if (hasCol('client')  && client  !== existing.client)  patch.client  = client;
      if (hasCol('purchase_price') && purchase !== null && Number(existing.purchase_price_per_mo) !== purchase) patch.purchase_price_per_mo = purchase;
      if (hasCol('selling_price') && selling !== null && Number(existing.selling_price_per_mo) !== selling) patch.selling_price_per_mo = selling;
      if (hasCol('active') && activeParsed !== null && activeParsed !== existing.active) patch.active = activeParsed;
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
        members: emptyMembers,
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

  // ── Members pass ──
  // For every LVN parent (existing or new), look for a sheet with the
  // SAME name as the parent number. Read column A, validate as phones,
  // then diff against the DB members for existing parents. Missing
  // tabs become warnings, not errors — the LVN row still imports.
  const memberToCreate = [];      // [{ number, phone, reactivate_id? }]
  const memberToDeactivate = [];  // [{ number, phone, member_id }]
  const memberWarnings = [];

  if (lvnBucketsByNumber.size) {
    // Fetch current active+inactive members for every existing LVN parent
    // in one round trip.
    const lvnIdsForLookup = [];
    for (const bucket of lvnBucketsByNumber.values()) {
      const ex = existingByNumber.get(bucket.number);
      if (ex) lvnIdsForLookup.push(ex.id);
    }
    const memberByParent = new Map(); // parent_id -> [{id, phone, active}]
    if (lvnIdsForLookup.length) {
      const { data, error } = await supabase()
        .from('lvn_members').select('id, number_id, phone, active')
        .in('number_id', lvnIdsForLookup);
      if (error) {
        return {
          toCreate, toUpdate, feesToCreate, volumesToUpsert,
          members: emptyMembers,
          errors: [{ idx: -1, error: 'Existing-members lookup failed: ' + error.message }],
          closedMonths, totalRows: rows.length,
        };
      }
      for (const m of data || []) {
        if (!memberByParent.has(m.number_id)) memberByParent.set(m.number_id, []);
        memberByParent.get(m.number_id).push(m);
      }
    }

    for (const [number, bucket] of lvnBucketsByNumber.entries()) {
      const tabName = number; // convention: parent's Number == tab name
      const sheetPhones = readMemberTab(wb, tabName);
      if (sheetPhones === null) {
        memberWarnings.push(`${tabName}: no member tab found, group imported with 0 members. Add VLNs from the UI later.`);
        continue;
      }

      const existing = existingByNumber.get(number);
      if (!existing) {
        // New LVN — every sheet phone becomes a fresh insert.
        for (const phone of sheetPhones) memberToCreate.push({ number, phone });
        continue;
      }

      const cur = memberByParent.get(existing.id) || [];
      const dbActiveByPhone = new Map();
      const dbInactiveByPhone = new Map();
      for (const m of cur) {
        if (m.active) dbActiveByPhone.set(m.phone, m.id);
        else dbInactiveByPhone.set(m.phone, m.id);
      }
      const sheetSet = new Set(sheetPhones);

      // In sheet, not active in DB → create or reactivate.
      for (const phone of sheetPhones) {
        if (dbActiveByPhone.has(phone)) continue;
        const reactivate_id = dbInactiveByPhone.get(phone) || null;
        memberToCreate.push({ number, phone, ...(reactivate_id ? { reactivate_id } : {}) });
      }
      // Active in DB, not in sheet → deactivate.
      for (const [phone, member_id] of dbActiveByPhone.entries()) {
        if (!sheetSet.has(phone)) {
          memberToDeactivate.push({ number, phone, member_id });
        }
      }
    }
  }

  return {
    toCreate, toUpdate, feesToCreate, volumesToUpsert,
    members: { toCreate: memberToCreate, toDeactivate: memberToDeactivate, warnings: memberWarnings },
    errors, closedMonths, totalRows: rows.length,
  };
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
    ...(plan.members?.toCreate || []).map((m) => m.number),
    ...(plan.members?.toDeactivate || []).map((m) => m.number),
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

    // Dedupe by (number_id, date) — last write wins. The Postgres
    // upsert refuses if two rows in the same chunk share the conflict
    // key, and a sheet that lists the same number twice (or has both
    // a date+volume pair AND a day-of-month col for the same day)
    // will produce duplicates here.
    const nowIso = new Date().toISOString();
    const dedupedMap = new Map(); // 'number_id|date' -> upsert row
    for (const v of plan.volumesToUpsert) {
      const number_id = idByNumber.get(v.number);
      if (!number_id) continue;
      dedupedMap.set(
        `${number_id}|${v.date}`,
        { number_id, date: v.date, volume: v.volume, entered_by: userId, entered_at: nowIso }
      );
    }
    const upsertRows = [...dedupedMap.values()];
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

  // 6) Members: insert/reactivate/deactivate.
  let membersAdded = 0, membersDeactivated = 0;
  if (plan.members) {
    for (const m of plan.members.toCreate || []) {
      const number_id = idByNumber.get(m.number);
      if (!number_id) continue;
      if (m.reactivate_id) {
        const { error } = await sb.from('lvn_members').update({ active: true }).eq('id', m.reactivate_id);
        if (error) return { ok: false, error: `Reactivate ${m.phone} failed: ${error.message}` };
        membersAdded++;
        await auditLog({
          userId, action: 'lvn_member.add', entity: 'lvn_member', entityId: m.reactivate_id,
          diff: { source: 'xlsx_import', number_id, phone: m.phone, source_action: 'reactivate' },
        });
      } else {
        const { data, error } = await sb.from('lvn_members')
          .insert({ number_id, phone: m.phone, active: true, created_by: userId })
          .select('id').maybeSingle();
        if (error) {
          // Race or duplicate: fall through to a best-effort upsert by
          // setting active=true on the unique row.
          if (error.code === '23505') {
            const { data: existed } = await sb.from('lvn_members')
              .select('id').eq('number_id', number_id).eq('phone', m.phone).maybeSingle();
            if (existed) {
              await sb.from('lvn_members').update({ active: true }).eq('id', existed.id);
              membersAdded++;
              await auditLog({
                userId, action: 'lvn_member.add', entity: 'lvn_member', entityId: existed.id,
                diff: { source: 'xlsx_import', number_id, phone: m.phone, source_action: 'reactivate-on-conflict' },
              });
              continue;
            }
          }
          return { ok: false, error: `Member insert ${m.phone} failed: ${error.message}` };
        }
        membersAdded++;
        await auditLog({
          userId, action: 'lvn_member.add', entity: 'lvn_member', entityId: data.id,
          diff: { source: 'xlsx_import', number_id, phone: m.phone },
        });
      }
    }
    for (const m of plan.members.toDeactivate || []) {
      const { error } = await sb.from('lvn_members').update({ active: false }).eq('id', m.member_id);
      if (error) return { ok: false, error: `Deactivate ${m.phone} failed: ${error.message}` };
      membersDeactivated++;
      await auditLog({
        userId, action: 'lvn_member.remove', entity: 'lvn_member', entityId: m.member_id,
        diff: { source: 'xlsx_import', phone: m.phone, active: [true, false] },
      });
    }
  }

  return {
    ok: true,
    numbers: { created: createdN, updated: updatedN },
    fees: feesN,
    volumes: { written: volumesWritten, changed: volumesChanged, unchanged: volumesUnchanged },
    members: {
      added: membersAdded,
      deactivated: membersDeactivated,
      warnings: plan.members?.warnings || [],
    },
    errors: plan.errors,
    closedMonths: plan.closedMonths,
  };
}
