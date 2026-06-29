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
import { isoFromMsisdn, callingCodeOf, commonSuffixLen } from '../util/calling_codes.js';

// A suggested VLN match needs at least this many shared trailing digits — the
// supplier and master agree only on the subscriber suffix (see vln_catalog).
const VLN_SUGGEST_MIN_SUFFIX = 6;

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

// Operator-level pricing is now DATA, not code: a single SC number carries
// optional override groups (number_operator_prices) keyed by MNC, and the
// per-MCC-MNC volume we record below lets each operator's traffic be priced
// under the hood. The importer therefore resolves a code to its ONE active
// number and keeps the row's MCC-MNC, instead of routing to duplicate records.

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

// Comparable client label (so a suffix shared across clients reads as a
// conflict). Empty/unknown collapses to '' — still one "client" bucket.
const clientLabel = (c) => String(c ?? '').trim().toLowerCase();

// ── buildVlnSuggestions ─────────────────────────────────────
// Pure: propose a parent VLN for each unknown receiver from the catalog, by
// country (calling code) + longest shared subscriber suffix.
//   unknownList — [{ receiver, totalMessages, days }]
//   catalog     — [{ country, raw_value, client, parent_number_id, buy, sell }]
//   numById     — Map(number_id -> number string) for display (optional)
// Returns { suggestedVlnMatches, vlnConflicts, unknownReceivers } where a suffix
// matching >1 distinct client is a conflict (no auto-pick) and a receiver with
// no candidate stays in unknownReceivers.
export function buildVlnSuggestions(unknownList, catalog, numById = new Map(), minSuffix = VLN_SUGGEST_MIN_SUFFIX) {
  const nameOf = (id) => (numById && typeof numById.get === 'function' ? numById.get(id) : null) || null;
  const suggestedVlnMatches = [];
  const vlnConflicts = [];
  const stillUnknown = [];

  for (const u of unknownList || []) {
    const iso = isoFromMsisdn(u.receiver);
    const cands = iso
      ? (catalog || [])
        .filter((c) => c.country === iso)
        .map((c) => ({ c, suf: commonSuffixLen(u.receiver, c.raw_value) }))
        .filter((x) => x.suf >= minSuffix)
        .sort((a, b) => b.suf - a.suf)
      : [];
    if (!cands.length) { stillUnknown.push(u); continue; }
    const base = { receiver: u.receiver, totalMessages: u.totalMessages, days: u.days, countryPrefix: callingCodeOf(u.receiver), iso };
    const clients = new Set(cands.map((x) => clientLabel(x.c.client)));
    if (clients.size > 1) {
      vlnConflicts.push({ ...base, candidates: cands.map((x) => ({
        parent_number_id: x.c.parent_number_id, parent_number: nameOf(x.c.parent_number_id),
        client: x.c.client, buy: x.c.buy, sell: x.c.sell, matchedSuffix: x.suf })) });
      continue;
    }
    const best = cands[0];
    suggestedVlnMatches.push({ ...base, matchedSuffix: best.suf, candidate: {
      parent_number_id: best.c.parent_number_id, parent_number: nameOf(best.c.parent_number_id),
      client: best.c.client, buy: best.c.buy, sell: best.c.sell } });
  }
  suggestedVlnMatches.sort((a, b) => b.totalMessages - a.totalMessages);
  vlnConflicts.sort((a, b) => b.totalMessages - a.totalMessages);
  const unknownReceivers = stillUnknown.slice().sort((a, b) => b.totalMessages - a.totalMessages);
  return { suggestedVlnMatches, vlnConflicts, unknownReceivers };
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
    volumeOperatorsToUpsert: [],
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
      volumesToUpsert: [], volumeOperatorsToUpsert: [], unknownReceivers: [], ambiguousResolved: [], ambiguousUnresolved: [],
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
  // ACTIVE only — a deactivated split duplicate must never make a code look
  // ambiguous or capture new volume.
  const codeIndex = new Map();
  const numById = new Map(); // id -> number string (for VLN suggestion display)
  {
    const { data, error } = await sb.from('numbers').select('id, number, country, active').eq('active', true);
    if (error) return errPlan('Numbers lookup failed: ' + error.message, rows.length);
    for (const n of data || []) {
      numById.set(n.id, n.number);
      const code = codeOf(n.number);
      if (!codeIndex.has(code)) codeIndex.set(code, []);
      // `country` here is the prefix from the number string, not the
      // (sometimes-null) country column — see prefixCountryOf.
      codeIndex.get(code).push({ id: n.id, number: n.number, country: prefixCountryOf(n.number) });
    }
  }

  // VLN catalog (from the master sheet via Sync Prices) — used to SUGGEST a
  // parent for unknown receivers by country + shared subscriber suffix.
  const { data: vlnCatalog } = await sb.from('vln_catalog')
    .select('country, suffix, raw_value, client, parent_number_id, buy, sell').eq('active', true);

  // ── Resolve every entry to a target number_id ──
  // resolved:    key 'number_id|date' -> { number_id, label, date, volume } (rollup)
  // resolvedOps: key 'number_id|date|mcc_mnc' -> per-operator volume detail.
  // SC code-matches carry their MCC-MNC into resolvedOps so operator pricing
  // can split them later; VLN parent rollups don't (no single operator).
  const resolved = new Map();
  const resolvedOps = new Map();
  const labelById = new Map();
  const addResolved = (id, label, date, volume, mccMnc) => {
    labelById.set(id, label);
    const k = `${id}|${date}`;
    if (!resolved.has(k)) resolved.set(k, { number_id: id, label, date, volume: 0 });
    resolved.get(k).volume += volume;
    if (mccMnc) {
      const ok = `${id}|${date}|${mccMnc}`;
      if (!resolvedOps.has(ok)) resolvedOps.set(ok, { number_id: id, date, mcc_mnc: mccMnc, volume: 0 });
      resolvedOps.get(ok).volume += volume;
    }
  };

  const unknownAgg = new Map();      // receiver -> { receiver, totalMessages, days:Set }
  const deferred = [];               // ambiguous entries needing dominant-country fallback
  const ambResolvedNote = new Map(); // code -> { code, chosen, via, ignored:Set }
  const vlnParents = new Set();
  let vlnMembersMatched = 0;

  for (const e of entries) {
    // 1. VLN member → parent (rollup only; no per-operator split)
    const parent = memberToParent.get(e.receiver);
    if (parent) {
      addResolved(parent.id, parent.label, e.date, e.volume);
      vlnParents.add(parent.id);
      vlnMembersMatched++;
      continue;
    }
    // 2/3. Code match — keep the row's MCC-MNC for operator-level pricing.
    const cands = codeIndex.get(e.receiver);
    if (!cands) {
      if (!unknownAgg.has(e.receiver)) unknownAgg.set(e.receiver, { receiver: e.receiver, totalMessages: 0, days: new Set() });
      const u = unknownAgg.get(e.receiver); u.totalMessages += e.volume; u.days.add(e.date);
      continue;
    }
    if (cands.length === 1) {
      addResolved(cands[0].id, cands[0].number, e.date, e.volume, e.mccMnc);
      continue;
    }
    // Ambiguous: disambiguate by MCC → country.
    const iso = e.mcc ? MCC_TO_ISO2.get(e.mcc) : null;
    const pick = iso ? cands.find((c) => normCountry(c.country) === iso) : null;
    if (pick) {
      addResolved(pick.id, pick.number, e.date, e.volume, e.mccMnc);
      if (!ambResolvedNote.has(e.receiver)) ambResolvedNote.set(e.receiver, { code: e.receiver, chosen: pick.number, via: `MCC ${e.mcc} → ${iso}`, ignored: new Set() });
      for (const c of cands) if (c.id !== pick.id) ambResolvedNote.get(e.receiver).ignored.add(c.number);
    } else {
      deferred.push(e); // resolve after we know the receiver's dominant country
    }
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
        for (const e of es) addResolved(best.id, best.number, e.date, e.volume, e.mccMnc);
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

  // Per-operator detail mirrors the rollup; closed months already errored above.
  const volumeOperatorsToUpsert = [];
  for (const r of resolvedOps.values()) {
    if (closedSet.has(r.date.slice(0, 7))) continue;
    volumeOperatorsToUpsert.push({ number_id: r.number_id, date: r.date, mcc_mnc: r.mcc_mnc, volume: r.volume });
  }

  // VLN suggestions for unknown receivers (pure; see buildVlnSuggestions).
  const unknownList = [...unknownAgg.values()].map((u) => ({ receiver: u.receiver, totalMessages: u.totalMessages, days: u.days.size }));
  const { suggestedVlnMatches, vlnConflicts, unknownReceivers } =
    buildVlnSuggestions(unknownList, vlnCatalog || [], numById);
  const ambiguousResolved = [...ambResolvedNote.values()].map((a) => ({ code: a.code, chosen: a.chosen, via: a.via, ignored: [...a.ignored] }));

  return {
    volumesToUpsert,
    volumeOperatorsToUpsert,
    unknownReceivers,
    suggestedVlnMatches,
    vlnConflicts,
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

// Persist user-confirmed VLN matches as lvn_members BEFORE the parse, so the
// standard member-resolution path rolls their volume into the parent. Idempotent
// on (phone): a receiver already mapped is left as-is. `approved` is
// [{ receiver, parent_number_id }] from the import confirm step.
async function persistApprovedVlnMatches(sb, approved, userId) {
  const list = (approved || []).filter((a) => a && a.receiver && a.parent_number_id);
  if (!list.length) return 0;
  const phones = list.map((a) => String(a.receiver));
  const { data: existing } = await sb.from('lvn_members').select('phone').in('phone', phones);
  const have = new Set((existing || []).map((m) => String(m.phone)));
  const rows = list
    .filter((a) => !have.has(String(a.receiver)))
    .map((a) => ({ phone: String(a.receiver), number_id: a.parent_number_id, active: true, created_by: userId }));
  if (!rows.length) return 0;
  const { error } = await sb.from('lvn_members').insert(rows);
  if (error) throw new Error('VLN member write failed: ' + error.message);
  for (const r of rows) {
    await auditLog({ userId, action: 'lvn_member.create', entity: 'lvn_member', entityId: `${r.number_id}|${r.phone}`,
      diff: { source: 'momessages_import_confirm', phone: r.phone, number_id: r.number_id } });
  }
  return rows.length;
}

// A receiver this long that carries a known calling code is treated as a VLN
// MSISDN (joins its country group); shorter ones are standalone short codes.
const VLN_MIN_LEN = 9;
const isVlnParentName = (number) => /lvns?/i.test(String(number));
const normP = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : null; };

// Assign unassigned receivers the uploader filled in (client + purchase +
// selling). Long VLN-style numbers join their country's VLN parent (as a
// member); short codes become standalone SC numbers. Created BEFORE the parse
// so the normal code/member paths count their volume this import.
async function applyAssignedReceivers(sb, assigned, userId) {
  const list = (assigned || []).filter((a) => a && a.receiver);
  const out = { scCreated: 0, vlnMembersAdded: 0, skipped: [] };
  if (!list.length) return out;

  const { data: nums } = await sb.from('numbers').select('id, number, client, active');
  const numByName = new Map((nums || []).map((n) => [String(n.number), n]));
  const lvnParents = (nums || []).filter((n) => isVlnParentName(n.number));
  const parentCache = new Map(); // `${iso}|${clientKey}` -> id

  const ensureVlnParent = async (iso, client, buy, sell) => {
    const key = `${iso}|${clientLabel(client)}`;
    if (parentCache.has(key)) return parentCache.get(key);
    const cands = lvnParents.filter((n) => prefixCountryOf(n.number).toUpperCase() === iso);
    const exact = cands.find((n) => clientLabel(n.client) === clientLabel(client));
    let id;
    if (exact) {
      id = exact.id;
    } else {
      const name = `${iso} - LVNs (${String(client).trim() || 'Unknown'})`;
      const existing = numByName.get(name);
      if (existing) { id = existing.id; }
      else {
        const { data: created, error } = await sb.from('numbers').insert({
          number: name, type: 'LVN', country: iso, client: String(client).trim() || null,
          purchase_price_per_mo: buy, selling_price_per_mo: sell, active: true, updated_by: userId,
        }).select('id').maybeSingle();
        if (error) throw new Error(`create VLN parent ${name}: ${error.message}`);
        id = created.id;
        lvnParents.push({ id, number: name, client });
        await auditLog({ userId, action: 'number.create', entity: 'number', entityId: id,
          diff: { source: 'momessages_assign', number: name, client, purchase: buy, selling: sell } });
      }
    }
    parentCache.set(key, id);
    return id;
  };

  const memberPhones = new Set();
  for (const a of list) {
    const receiver = String(a.receiver).trim();
    const digits = receiver.replace(/[^\d]/g, '');
    const buy = normP(a.purchase), sell = normP(a.selling);
    const client = String(a.client ?? '').trim();
    if (!client || buy === null || sell === null) { out.skipped.push({ receiver, reason: 'client/purchase/selling required' }); continue; }

    const iso = isoFromMsisdn(digits);
    if (digits.length >= VLN_MIN_LEN && iso) {
      const parentId = await ensureVlnParent(iso, client, buy, sell);
      if (!memberPhones.has(digits)) {
        const { data: ex } = await sb.from('lvn_members').select('phone').eq('phone', digits).maybeSingle();
        if (!ex) {
          const { error } = await sb.from('lvn_members').insert({ phone: digits, number_id: parentId, active: true, created_by: userId });
          if (error) throw new Error(`assign member ${digits}: ${error.message}`);
          out.vlnMembersAdded++;
          await auditLog({ userId, action: 'lvn_member.create', entity: 'lvn_member', entityId: `${parentId}|${digits}`,
            diff: { source: 'momessages_assign', phone: digits, number_id: parentId } });
        }
        memberPhones.add(digits);
      }
    } else {
      // Standalone short code (country unknown from a bare code → left null).
      if (!numByName.has(receiver)) {
        const { data: created, error } = await sb.from('numbers').insert({
          number: receiver, type: 'SC', country: null, client: client || null,
          purchase_price_per_mo: buy, selling_price_per_mo: sell, active: true, updated_by: userId,
        }).select('id').maybeSingle();
        if (error) throw new Error(`create SC ${receiver}: ${error.message}`);
        numByName.set(receiver, { id: created.id, number: receiver, client });
        out.scCreated++;
        await auditLog({ userId, action: 'number.create', entity: 'number', entityId: created.id,
          diff: { source: 'momessages_assign', number: receiver, client, purchase: buy, selling: sell } });
      }
    }
  }
  return out;
}

// ── commitImport ────────────────────────────────────────────
export async function commitImport(buffer, userId, approvedVlnMatches = [], assignedReceivers = []) {
  // Confirmed VLN matches + uploader-assigned numbers are created FIRST; the
  // parse below then resolves them via the normal member/code paths.
  let vlnMembersAdded = 0;
  let assignResult = { scCreated: 0, vlnMembersAdded: 0, skipped: [] };
  try {
    const sb0 = supabase();
    vlnMembersAdded = await persistApprovedVlnMatches(sb0, approvedVlnMatches, userId);
    assignResult = await applyAssignedReceivers(sb0, assignedReceivers, userId);
  } catch (e) {
    return { ok: false, error: e.message };
  }

  const plan = await parseAndAnalyze(buffer);
  const fatal = plan.errors.find((e) => e.idx === -1 && /Missing required column|lookup failed|check failed/.test(e.error));
  if (fatal) return { ok: false, error: fatal.error };

  const base = {
    unknownReceivers: plan.unknownReceivers,
    suggestedVlnMatches: plan.suggestedVlnMatches,
    vlnConflicts: plan.vlnConflicts,
    ambiguousResolved: plan.ambiguousResolved,
    ambiguousUnresolved: plan.ambiguousUnresolved,
    excludedObservability: plan.excludedObservability,
    vln: { ...plan.vln, membersAdded: vlnMembersAdded },
    assigned: { scCreated: assignResult.scCreated, vlnMembersAdded: assignResult.vlnMembersAdded, skipped: assignResult.skipped },
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

  // Per-operator detail: replace exactly the (number_id, date) pairs we wrote
  // above (delete-then-insert so a network that vanished from the report
  // doesn't leave a stale row), then bulk-insert the fresh breakdown.
  const datesByNumber = new Map();
  for (const v of upsertRows) {
    if (!datesByNumber.has(v.number_id)) datesByNumber.set(v.number_id, new Set());
    datesByNumber.get(v.number_id).add(v.date);
  }
  for (const [numId, dset] of datesByNumber) {
    const { error } = await sb.from('daily_volume_operators').delete().eq('number_id', numId).in('date', [...dset]);
    if (error) return { ok: false, error: 'operator detail clear failed: ' + error.message };
  }
  const opRows = (plan.volumeOperatorsToUpsert || []).map((v) => ({ ...v, entered_by: userId, entered_at: nowIso }));
  for (let i = 0; i < opRows.length; i += 500) {
    const { error } = await sb.from('daily_volume_operators').insert(opRows.slice(i, i + 500));
    if (error) return { ok: false, error: 'operator detail write failed: ' + error.message };
  }

  return { ok: true, volumes: { written: upsertRows.length, changed, unchanged }, ...base };
}
