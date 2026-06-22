// MO Messages report import — a volumes-only feed in the supplier's
// "MO Messages" export shape. One workbook, one sheet, columns:
//
//   Date | Receiver | Customer | Customer Account | Supplier |
//   Supplier Account | MCC-MNC | Messages
//
// The SAME Receiver (an SC short code, or a VLN member MSISDN) appears
// across MANY rows for a single day — one row per destination network
// (MCC-MNC). The daily volume is the SUM of Messages across all of that
// day's rows. A trailing "Total" footer row (blank Date / Receiver =
// "Total") carries the grand total and is skipped.
//
// Receiver → number resolution (the report carries bare codes; the DB
// stores "<COUNTRY> - <code>"):
//   1. VLN member MSISDN  → its parent "<CC> - LVNs" number. Per-member
//      message counts are summed into the parent's daily volume (the
//      schema tracks VLN volume at the parent, not per member).
//   2. Bare code, unique  → the single matching number by code-suffix.
//   3. Bare code, ambiguous (same code under >1 country, e.g. 10020 is
//      both "BG - 10020" and "EG - 10020") → disambiguated by the row's
//      MCC (mobile country code). MCC 602 = EG picks "EG - 10020".
//   4. Anything unresolved → reported as a skipped warning, never
//      created (the report has no type/price metadata).
//
// This importer ONLY writes daily_volumes. Two-pass shape mirrors the
// combined importer: parseAndAnalyze → preview, commitImport re-runs the
// parse and applies. Closed-month volumes surface as preview errors; the
// DB trigger remains the no-bypass guarantee.

import * as XLSX from 'xlsx';
import { supabase } from '../supabase.js';
import { auditLog } from '../util/audit.js';
import { parseDate, canonHeader } from '../util/xlsx_helpers.js';

// Canonical header → field. Only Date / Receiver / Messages are
// required; MCC-MNC is used to disambiguate shared codes.
const HEADER_ALIASES = new Map(Object.entries({
  date: 'date',
  receiver: 'number',
  number: 'number',
  msisdn: 'number',
  messages: 'volume',
  volume: 'volume',
  count: 'volume',
  'mcc-mnc': 'mcc',
  mcc_mnc: 'mcc',
  mcc: 'mcc',
  customer: 'customer',
  customer_account: 'customer_acct',
}));

// Observability / monitoring traffic is synthetic — SCs we run to
// simulate and watch the MO setup. It must never count as real volume.
// Identified by either the Customer or Customer Account naming it.
function isObservability(customer, account) {
  return /observability/i.test(String(customer ?? '')) || /observability/i.test(String(account ?? ''));
}

// MCC (mobile country code) → ISO-3166 alpha-2, used only to break ties
// when a bare code maps to more than one country. Covers every MCC seen
// in the report plus common neighbours; extend as new countries appear.
const MCC_TO_ISO2 = new Map(Object.entries({
  '226': 'RO', '228': 'CH', '250': 'RU', '276': 'AL', '278': 'MT',
  '310': 'US', '334': 'MX', '410': 'PK', '414': 'MM', '425': 'IL',
  '429': 'NP', '432': 'IR', '440': 'JP', '450': 'KR', '452': 'VN',
  '456': 'KH', '460': 'CN', '502': 'MY', '505': 'AU', '510': 'ID',
  '520': 'TH', '602': 'EG', '603': 'DZ', '608': 'SN', '609': 'MR',
  '620': 'GH', '621': 'NG', '630': 'CD', '635': 'RW', '640': 'TZ',
  '645': 'ZM', '652': 'BW', '653': 'SZ', '655': 'ZA', '722': 'AR',
  '724': 'BR', '730': 'CL', '748': 'UY',
}));

// DB country codes that aren't ISO alpha-2 → their ISO equivalent, so
// MCC disambiguation lines up. (DRC = DR Congo = ISO "CD".)
const COUNTRY_ALIAS = new Map(Object.entries({ DRC: 'CD' }));
function normCountry(c) {
  const u = String(c || '').trim().toUpperCase();
  return COUNTRY_ALIAS.get(u) || u;
}

// MCC from an "MCC-MNC" cell like "440-50" → "440"; "Unknown" → null.
function mccOf(v) {
  const m = String(v ?? '').match(/^(\d{3})/);
  return m ? m[1] : null;
}

// Full normalized MCC-MNC, e.g. "722-310" (whitespace stripped). null for
// blank/"Unknown". Used for operator-level routing (see OPERATOR_SPLITS).
function mccMncOf(v) {
  const s = String(v ?? '').replace(/\s+/g, '');
  return /^\d{3}-?\w+$/.test(s) ? s : null;
}

// Operator-level splits: one bare code that intentionally maps to >1 DB
// number distinguished by destination operator (MNC), not country —
// e.g. AR 78887 has a separate "(Claro)" record priced differently. For
// a configured code, each report row routes to the target whose MNC set
// contains the row's MCC-MNC; rows in no rule fall through to `base`.
const OPERATOR_SPLITS = new Map(Object.entries({
  '78887': {
    base: 'AR - 78887',
    rules: [{ number: 'AR - 78887 (Claro)', mncs: new Set(['722-310', '722-320', '722-330']) }],
  },
}));

// Code-suffix of a DB number: "ZA - 33009" → "33009", "990994" → "990994".
function codeOf(number) {
  const m = String(number).match(/-\s*(.+)$/);
  return (m ? m[1] : String(number)).trim();
}

// Country prefix of a DB number: "EG - 10020" → "EG", "990994" → "".
// We trust this over the `country` column for disambiguation — the
// column is sometimes null on numbers whose name clearly carries the
// country (e.g. "EG - 10020" has country=null in the data).
function prefixCountryOf(number) {
  const m = String(number).match(/^(.+?)\s*-\s*/);
  return m ? m[1].trim() : '';
}

function asVolume(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return null;
  return n;
}

function readWorkbook(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) return { rows: [], headerMap: {} };
  const aoa = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: '', raw: true });
  if (!aoa.length) return { rows: [], headerMap: {} };

  const headerRow = aoa[0];
  const headerMap = {};
  for (let i = 0; i < headerRow.length; i++) {
    const mapped = HEADER_ALIASES.get(canonHeader(headerRow[i]));
    if (mapped && !(mapped in headerMap)) headerMap[mapped] = i;
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

function errPlan(message, totalRows = 0) {
  return {
    volumesToUpsert: [],
    unknownReceivers: [],
    ambiguousResolved: [],
    ambiguousUnresolved: [],
    excludedObservability: { receivers: 0, messages: 0 },
    vln: { membersMatched: 0, parentsTouched: 0 },
    closedMonths: [],
    errors: [{ idx: -1, error: message }],
    totalRows,
    matchedNumbers: 0,
    totalMessages: 0,
  };
}

// ── parseAndAnalyze ─────────────────────────────────────────
export async function parseAndAnalyze(buffer) {
  const { rows, headerMap } = readWorkbook(buffer);

  for (const required of ['date', 'number', 'volume']) {
    if (!(required in headerMap)) {
      const label = required === 'number' ? 'Receiver' : required === 'volume' ? 'Messages' : 'Date';
      return errPlan(`Missing required column '${label}'`, rows.length);
    }
  }
  const hasMcc = 'mcc' in headerMap;

  // ── Parse rows into clean entries ──
  const errors = [];
  const entries = []; // { date, receiver, mcc, volume }
  const obsReceivers = new Set();
  let obsMessages = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const receiver = String(getCell(r, headerMap, 'number') ?? '').trim();
    if (!receiver || receiver.toLowerCase() === 'total') continue; // footer / total

    // Drop observability/monitoring traffic entirely — it's synthetic and
    // must not reach daily_volumes. Tracked only for the preview summary.
    if (isObservability(getCell(r, headerMap, 'customer'), getCell(r, headerMap, 'customer_acct'))) {
      obsReceivers.add(receiver);
      obsMessages += asVolume(getCell(r, headerMap, 'volume')) || 0;
      continue;
    }

    const dateRaw = getCell(r, headerMap, 'date');
    const date = parseDate(dateRaw);
    if (!date) { errors.push({ idx: i, error: `Invalid or missing date "${dateRaw ?? ''}" for receiver ${receiver}` }); continue; }

    const volume = asVolume(getCell(r, headerMap, 'volume'));
    if (volume === null) { errors.push({ idx: i, error: `Invalid Messages for ${receiver} on ${date} (must be a non-negative integer)` }); continue; }

    const mccCell = hasMcc ? getCell(r, headerMap, 'mcc') : null;
    entries.push({ date, receiver, mcc: mccOf(mccCell), mccMnc: mccMncOf(mccCell), volume });
  }

  const receivers = [...new Set(entries.map((e) => e.receiver))];
  if (!receivers.length) {
    return {
      volumesToUpsert: [], unknownReceivers: [], ambiguousResolved: [], ambiguousUnresolved: [],
      excludedObservability: { receivers: obsReceivers.size, messages: obsMessages },
      vln: { membersMatched: 0, parentsTouched: 0 }, closedMonths: [], errors, totalRows: rows.length,
      matchedNumbers: 0, totalMessages: 0,
    };
  }

  // ── Build resolution indexes ──
  const sb = supabase();

  // VLN members: MSISDN → parent number_id (+ label). Phones are matched
  // exactly. If a phone somehow maps to >1 parent, first wins + warning.
  const memberToParent = new Map(); // phone -> { id, label }
  {
    const { data, error } = await sb.from('lvn_members').select('phone, number_id').in('phone', receivers);
    if (error) return errPlan('VLN-member lookup failed: ' + error.message, rows.length);
    const parentIds = [...new Set((data || []).map((m) => m.number_id))];
    const parentLabel = new Map();
    if (parentIds.length) {
      const { data: pn, error: pe } = await sb.from('numbers').select('id, number').in('id', parentIds);
      if (pe) return errPlan('VLN-parent lookup failed: ' + pe.message, rows.length);
      for (const n of pn || []) parentLabel.set(n.id, n.number);
    }
    for (const m of data || []) {
      if (memberToParent.has(m.phone)) continue;
      memberToParent.set(m.phone, { id: m.number_id, label: parentLabel.get(m.number_id) || '(VLN parent)' });
    }
  }

  // Numbers indexed by code-suffix. code -> [{ id, number, country }].
  // numberByString resolves an exact DB label (used by operator splits).
  const codeIndex = new Map();
  const numberByString = new Map();
  {
    const { data, error } = await sb.from('numbers').select('id, number, country');
    if (error) return errPlan('Numbers lookup failed: ' + error.message, rows.length);
    for (const n of data || []) {
      numberByString.set(n.number, { id: n.id, number: n.number });
      const code = codeOf(n.number);
      if (!codeIndex.has(code)) codeIndex.set(code, []);
      // `country` here is the prefix from the number string, not the
      // (sometimes-null) country column — see prefixCountryOf.
      codeIndex.get(code).push({ id: n.id, number: n.number, country: prefixCountryOf(n.number) });
    }
  }

  // ── Resolve every entry to a target number_id ──
  // resolved: key 'number_id|date' -> { number_id, label, date, volume }
  const resolved = new Map();
  const labelById = new Map();
  const addResolved = (id, label, date, volume) => {
    labelById.set(id, label);
    const k = `${id}|${date}`;
    if (!resolved.has(k)) resolved.set(k, { number_id: id, label, date, volume: 0 });
    resolved.get(k).volume += volume;
  };

  const unknownAgg = new Map();      // receiver -> { receiver, totalMessages, days:Set }
  const deferred = [];               // ambiguous entries needing dominant-country fallback
  const ambResolvedNote = new Map(); // code -> { code, chosen, via, ignored:Set }
  const vlnParents = new Set();
  let vlnMembersMatched = 0;

  const splitTargetsMissing = new Set();
  for (const e of entries) {
    // 0. Operator split (intentional same-code, different-operator records,
    //    e.g. AR 78887 vs AR 78887 (Claro)). Route by the row's MCC-MNC.
    const split = OPERATOR_SPLITS.get(e.receiver);
    if (split) {
      let targetStr = split.base;
      for (const rule of split.rules) { if (e.mccMnc && rule.mncs.has(e.mccMnc)) { targetStr = rule.number; break; } }
      const tgt = numberByString.get(targetStr);
      if (tgt) { addResolved(tgt.id, tgt.number, e.date, e.volume); continue; }
      // Configured target not in DB → surface it rather than silently drop.
      splitTargetsMissing.add(targetStr);
      if (!unknownAgg.has(e.receiver)) unknownAgg.set(e.receiver, { receiver: e.receiver, totalMessages: 0, days: new Set() });
      const u = unknownAgg.get(e.receiver); u.totalMessages += e.volume; u.days.add(e.date);
      continue;
    }
    // 1. VLN member → parent
    const parent = memberToParent.get(e.receiver);
    if (parent) {
      addResolved(parent.id, parent.label, e.date, e.volume);
      vlnParents.add(parent.id);
      vlnMembersMatched++;
      continue;
    }
    // 2/3. Code match
    const cands = codeIndex.get(e.receiver);
    if (!cands) {
      if (!unknownAgg.has(e.receiver)) unknownAgg.set(e.receiver, { receiver: e.receiver, totalMessages: 0, days: new Set() });
      const u = unknownAgg.get(e.receiver); u.totalMessages += e.volume; u.days.add(e.date);
      continue;
    }
    if (cands.length === 1) {
      addResolved(cands[0].id, cands[0].number, e.date, e.volume);
      continue;
    }
    // Ambiguous: disambiguate by MCC → country.
    const iso = e.mcc ? MCC_TO_ISO2.get(e.mcc) : null;
    const pick = iso ? cands.find((c) => normCountry(c.country) === iso) : null;
    if (pick) {
      addResolved(pick.id, pick.number, e.date, e.volume);
      if (!ambResolvedNote.has(e.receiver)) ambResolvedNote.set(e.receiver, { code: e.receiver, chosen: pick.number, via: `MCC ${e.mcc} → ${iso}`, ignored: new Set() });
      for (const c of cands) if (c.id !== pick.id) ambResolvedNote.get(e.receiver).ignored.add(c.number);
    } else {
      deferred.push(e); // resolve after we know the receiver's dominant country
    }
  }

  for (const t of splitTargetsMissing) {
    errors.push({ idx: -1, error: `Operator-split target "${t}" not found in numbers — create it or fix the split config` });
  }

  // Deferred ambiguous rows (no MCC match, e.g. "Unknown" MCC): assign to
  // the candidate that already received the most of that receiver's
  // messages. If none did, it stays unresolved → warning.
  const ambiguousUnresolved = [];
  if (deferred.length) {
    const byReceiver = new Map();
    for (const e of deferred) {
      if (!byReceiver.has(e.receiver)) byReceiver.set(e.receiver, []);
      byReceiver.get(e.receiver).push(e);
    }
    for (const [receiver, es] of byReceiver) {
      const cands = codeIndex.get(receiver) || [];
      let best = null, bestVol = -1;
      for (const c of cands) {
        let v = 0;
        for (const [k, r] of resolved) if (r.number_id === c.id) v += r.volume;
        if (v > bestVol) { bestVol = v; best = c; }
      }
      if (best && bestVol > 0) {
        for (const e of es) addResolved(best.id, best.number, e.date, e.volume);
        const note = ambResolvedNote.get(receiver) || { code: receiver, chosen: best.number, via: 'dominant country', ignored: new Set() };
        ambResolvedNote.set(receiver, note);
      } else {
        const total = es.reduce((s, e) => s + e.volume, 0);
        ambiguousUnresolved.push({ receiver, totalMessages: total, candidates: cands.map((c) => c.number) });
      }
    }
  }

  // ── Closed-month filter ──
  let closedMonths = [];
  const monthsSeen = new Set([...resolved.values()].map((r) => r.date.slice(0, 7)));
  if (monthsSeen.size) {
    const { data, error } = await sb.from('monthly_closes').select('month, status')
      .in('month', [...monthsSeen]).in('status', ['approved', 'sent']);
    if (error) return errPlan('Closed-month check failed: ' + error.message, rows.length);
    closedMonths = (data || []).map((c) => c.month);
  }
  const closedSet = new Set(closedMonths);

  const volumesToUpsert = [];
  for (const r of resolved.values()) {
    if (closedSet.has(r.date.slice(0, 7))) {
      errors.push({ idx: -1, error: `Month ${r.date.slice(0, 7)} is closed; volume for ${r.label} on ${r.date} (${r.volume}) refused` });
      continue;
    }
    volumesToUpsert.push({ number_id: r.number_id, number: r.label, date: r.date, volume: r.volume });
  }

  const unknownReceivers = [...unknownAgg.values()]
    .map((u) => ({ receiver: u.receiver, totalMessages: u.totalMessages, days: u.days.size }))
    .sort((a, b) => b.totalMessages - a.totalMessages);
  const ambiguousResolved = [...ambResolvedNote.values()].map((a) => ({ code: a.code, chosen: a.chosen, via: a.via, ignored: [...a.ignored] }));

  return {
    volumesToUpsert,
    unknownReceivers,
    ambiguousResolved,
    ambiguousUnresolved,
    excludedObservability: { receivers: obsReceivers.size, messages: obsMessages },
    vln: { membersMatched: vlnMembersMatched, parentsTouched: vlnParents.size },
    closedMonths,
    errors,
    totalRows: rows.length,
    matchedNumbers: new Set(volumesToUpsert.map((v) => v.number_id)).size,
    totalMessages: volumesToUpsert.reduce((s, v) => s + v.volume, 0),
  };
}

// ── commitImport ────────────────────────────────────────────
export async function commitImport(buffer, userId) {
  const plan = await parseAndAnalyze(buffer);
  const fatal = plan.errors.find((e) => e.idx === -1 && /Missing required column|lookup failed|check failed/.test(e.error));
  if (fatal) return { ok: false, error: fatal.error };

  const base = {
    unknownReceivers: plan.unknownReceivers,
    ambiguousResolved: plan.ambiguousResolved,
    ambiguousUnresolved: plan.ambiguousUnresolved,
    excludedObservability: plan.excludedObservability,
    vln: plan.vln,
    closedMonths: plan.closedMonths,
    errors: plan.errors,
  };
  if (!plan.volumesToUpsert.length) {
    return { ok: true, volumes: { written: 0, changed: 0, unchanged: 0 }, ...base };
  }

  const sb = supabase();
  const numberIds = [...new Set(plan.volumesToUpsert.map((v) => v.number_id))];
  const dates = [...new Set(plan.volumesToUpsert.map((v) => v.date))];

  const { data: prior, error: priorErr } = await sb.from('daily_volumes')
    .select('number_id, date, volume').in('number_id', numberIds).in('date', dates);
  if (priorErr) return { ok: false, error: priorErr.message };
  const priorMap = new Map((prior || []).map((p) => [`${p.number_id}|${p.date}`, Number(p.volume)]));

  // (number_id, date) is already unique out of parseAndAnalyze; dedupe
  // defensively all the same — last write wins.
  const nowIso = new Date().toISOString();
  const dedupedMap = new Map();
  for (const v of plan.volumesToUpsert) {
    dedupedMap.set(`${v.number_id}|${v.date}`, { number_id: v.number_id, date: v.date, volume: v.volume, entered_by: userId, entered_at: nowIso });
  }
  const upsertRows = [...dedupedMap.values()];

  for (let i = 0; i < upsertRows.length; i += 500) {
    const chunk = upsertRows.slice(i, i + 500);
    const { error } = await sb.from('daily_volumes').upsert(chunk, { onConflict: 'number_id,date' });
    if (error) return { ok: false, error: error.message };
  }

  let changed = 0, unchanged = 0;
  for (const row of upsertRows) {
    const prev = priorMap.get(`${row.number_id}|${row.date}`);
    if (prev === row.volume) { unchanged++; continue; }
    changed++;
    await auditLog({
      userId,
      action: 'volume.upsert',
      entity: 'daily_volume',
      entityId: `${row.number_id}|${row.date}`,
      diff: { source: 'momessages_import', date: row.date, volume: [prev ?? null, row.volume] },
    });
  }

  return { ok: true, volumes: { written: upsertRows.length, changed, unchanged }, ...base };
}
