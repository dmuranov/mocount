// Dashboard — SPEC §4.
//   Top: date picker + 4 cards driven by the picked date
//        (day vol/rev, MTD vol/rev through that date) + admin import buttons.
//   Body: one row per active number with a Volume cell editable by admins.
//   Save persists every edited row via POST /api/volumes (bulk upsert).
//
// Imports (admin only):
//   • Numbers — used once for initial bulk load, also for ongoing edits
//     (price changes, new numbers, fee additions). Header set incl. fees.
//   • Volumes — recurring daily imports. Manual editing in the table is
//     the alternative path for small daily corrections.

import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import ImportPanel from '../components/ImportPanel.jsx';
import VlnConfirm from '../components/VlnConfirm.jsx';
import NumberDrawer from '../components/NumberDrawer.jsx';

function todayISO() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function formatMoney(n) {
  return `$${(Number(n) || 0).toFixed(2)}`;
}
function formatInt(n) {
  return (Number(n) || 0).toLocaleString('en-US');
}

export default function Dashboard() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';

  const [date, setDate] = useState(todayISO());
  const [numbers, setNumbers] = useState(null);   // null = loading
  const [volumes, setVolumes] = useState(new Map()); // number_id -> volume on `date`
  const [edits, setEdits] = useState(new Map());     // number_id -> string (input value)
  const [cards, setCards] = useState(null);          // { day, mtd } from /api/dashboard/cards
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  const [importOpen, setImportOpen] = useState(false);
  const [moImportOpen, setMoImportOpen] = useState(false);
  const [priceSyncOpen, setPriceSyncOpen] = useState(false);
  const [drawerId, setDrawerId] = useState(null);

  async function loadAll(thisDate) {
    setError(null);
    try {
      // Cards come from the server so split SCs are priced through operator
      // pricing (same path as History), not the flat snapshot margin.
      const [{ numbers: nums }, { volumes: vols }, cardData] = await Promise.all([
        api.get('/api/numbers?active=true'),
        api.get(`/api/volumes?from=${thisDate}&to=${thisDate}`),
        api.get(`/api/dashboard/cards?date=${thisDate}`),
      ]);
      setNumbers(nums);
      const map = new Map();
      for (const v of vols) if (v.date === thisDate) map.set(v.number_id, v.volume);
      setVolumes(map);
      setEdits(new Map()); // reset pending edits when the date changes
      setCards({ day: cardData.day, mtd: cardData.mtd });
    } catch (e) {
      setError(e.message);
    }
  }

  useEffect(() => { loadAll(date); }, [date]);

  function setEdit(numberId, value) {
    const next = new Map(edits);
    if (value === '' || value === null || value === undefined) next.delete(numberId);
    else next.set(numberId, value);
    setEdits(next);
  }

  async function saveAll() {
    if (!isAdmin) return;
    if (edits.size === 0) return;
    setSaving(true);
    setError(null);
    try {
      const rows = [];
      for (const [number_id, raw] of edits.entries()) {
        const v = Number(raw);
        if (!Number.isFinite(v) || v < 0 || !Number.isInteger(v)) {
          throw new Error(`Bad volume "${raw}" for one of the rows`);
        }
        rows.push({ number_id, date, volume: v });
      }
      const res = await api.post('/api/volumes', rows);
      // Surface row-level errors (closed-month etc.) without losing the rest.
      if (res.errors?.length) {
        setError(res.errors.map((e) => e.error).join(' • '));
      }
      await loadAll(date);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="page">
      <div className="dash-toolbar">
        <div className="dash-date">
          <label className="mono">date for volume entry</label>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            disabled={!isAdmin && false /* viewers can change date too */}
          />
        </div>
        {isAdmin && (
          <div className="dash-actions">
            <button className="btn-ghost" onClick={() => setImportOpen(true)}>Import (.xlsx)</button>
            <button className="btn-ghost" onClick={() => setMoImportOpen(true)}>Import MO Messages</button>
            <button className="btn-ghost" onClick={() => setPriceSyncOpen(true)}>Sync Prices</button>
          </div>
        )}
      </div>

      {cards && (
        <div className="cards">
          <Card label={`Volume on ${date}`} value={formatInt(cards.day.volume)} />
          <Card label={`Revenue on ${date}`} value={formatMoney(cards.day.revenue)} />
          <Card label={`MTD volume (through ${date})`} value={formatInt(cards.mtd.volume)} />
          <Card label={`MTD revenue (through ${date})`} value={formatMoney(cards.mtd.revenue)} />
        </div>
      )}

      {error && <div className="err-box" style={{ marginBottom: 14 }}>{error}</div>}

      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Number</th>
              <th>type</th>
              <th>country</th>
              <th>client</th>
              <th style={{ textAlign: 'right' }}>Purchase $/MO</th>
              <th style={{ textAlign: 'right' }}>Selling $/MO</th>
              <th style={{ textAlign: 'right' }}>Margin Δ</th>
              <th style={{ textAlign: 'right', width: 140 }}>Volume on {date}</th>
            </tr>
          </thead>
          <tbody>
            {numbers === null && (
              <tr><td colSpan={8} className="mono" style={{ color: 'var(--dim)' }}>loading…</td></tr>
            )}
            {numbers && numbers.length === 0 && (
              <tr><td colSpan={8} className="mono" style={{ color: 'var(--dim)' }}>No active numbers. Import via the button above.</td></tr>
            )}
            {numbers && numbers.map((n) => {
              const persisted = volumes.has(n.id) ? String(volumes.get(n.id)) : '';
              const editVal = edits.has(n.id) ? edits.get(n.id) : persisted;
              const dirty = edits.has(n.id) && editVal !== persisted;
              const op = n.has_operator_pricing;
              const buy = op ? n.avg_purchase_price_per_mo : n.purchase_price_per_mo;
              const sell = op ? n.avg_selling_price_per_mo : n.selling_price_per_mo;
              const marg = op ? (sell - buy) : n.margin_per_mo;
              const pfx = op ? '~' : '';
              return (
                <tr key={n.id} className={dirty ? 'row-dirty' : ''}>
                  <td className="mono">
                    <button className="link-btn" onClick={() => setDrawerId(n.id)}>{n.number}</button>
                    {op && <span title="Priced per network — exact rates in the drawer" style={{ color: 'var(--accent)', fontWeight: 700 }}>*</span>}
                  </td>
                  <td>{n.type}</td>
                  <td>{n.country || '—'}</td>
                  <td>{n.client || '—'}</td>
                  <td style={{ textAlign: 'right' }} className="mono" title={op ? 'average of per-network rates' : ''}>{pfx}{buy.toFixed(4)}</td>
                  <td style={{ textAlign: 'right' }} className="mono" title={op ? 'average of per-network rates' : ''}>{pfx}{sell.toFixed(4)}</td>
                  <td style={{ textAlign: 'right' }} className="mono">{pfx}{marg.toFixed(4)}</td>
                  <td style={{ textAlign: 'right' }}>
                    {isAdmin ? (
                      <input
                        type="number"
                        min="0"
                        step="1"
                        className="vol-input"
                        value={editVal}
                        placeholder="—"
                        onChange={(e) => setEdit(n.id, e.target.value)}
                      />
                    ) : (
                      <span className="mono">{persisted || '—'}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {isAdmin && (
        <div className="save-bar">
          <span className="mono">{edits.size} pending edit{edits.size === 1 ? '' : 's'}</span>
          <button className="btn-primary" disabled={saving || edits.size === 0} onClick={saveAll}>
            {saving ? 'Saving…' : 'Save volumes'}
          </button>
        </div>
      )}

      <NumberDrawer
        numberId={drawerId}
        onClose={() => setDrawerId(null)}
        onChanged={() => loadAll(date)}
      />

      <ImportPanel
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onDone={() => loadAll(date)}
        endpoint="/api/import"
        title="Import (.xlsx) — numbers, fees, volumes"
        summarize={(p) => (
          <ul className="preview-list">
            <li>Numbers to create: <b>{p.toCreate?.length ?? 0}</b></li>
            <li>Numbers to update: <b>{p.toUpdate?.length ?? 0}</b></li>
            <li>Fees to create: <b>{p.feesToCreate?.length ?? 0}</b></li>
            <li>Volumes to upsert: <b>{p.volumesToUpsert?.length ?? 0}</b></li>
            <li>VLN members to add: <b>{p.members?.toCreate?.length ?? 0}</b></li>
            <li>VLN members to remove: <b>{p.members?.toDeactivate?.length ?? 0}</b></li>
            <li>Errors: <b>{p.errors?.length ?? 0}</b></li>
            {p.closedMonths?.length > 0 && (
              <li style={{ color: 'var(--danger-fg)' }}>Closed months in file: {p.closedMonths.join(', ')}</li>
            )}
            {p.members?.warnings?.length > 0 && (
              <li style={{ color: 'var(--danger-fg)' }}>
                <details open>
                  <summary>Member warnings ({p.members.warnings.length})</summary>
                  <pre className="result-pre">{p.members.warnings.join('\n')}</pre>
                </details>
              </li>
            )}
            {p.errors?.length > 0 && (
              <li style={{ color: 'var(--danger-fg)' }}>
                <details>
                  <summary>Show errors</summary>
                  <pre className="result-pre">{p.errors.map((e) => `row ${e.idx}: ${e.error}`).join('\n')}</pre>
                </details>
              </li>
            )}
          </ul>
        )}
      />

      <ImportPanel
        open={moImportOpen}
        onClose={() => setMoImportOpen(false)}
        onDone={() => loadAll(date)}
        endpoint="/api/import/momessages"
        title="Import MO Messages report (.xlsx) — daily volumes only"
        renderExtra={(p, setExtra) => <VlnConfirm plan={p} setExtra={setExtra} />}
        summarize={(p) => (
          <ul className="preview-list">
            <li>Rows read: <b>{p.totalRows ?? 0}</b></li>
            <li>Numbers matched: <b>{p.matchedNumbers ?? 0}</b></li>
            <li>Daily volumes to upsert: <b>{p.volumesToUpsert?.length ?? 0}</b></li>
            <li>Total messages: <b>{(p.totalMessages ?? 0).toLocaleString('en-US')}</b></li>
            <li>VLN members rolled into parents: <b>{p.vln?.membersMatched ?? 0}</b> → <b>{p.vln?.parentsTouched ?? 0}</b> parent number(s)</li>
            {p.suggestedVlnMatches?.length > 0 && (
              <li style={{ color: 'var(--accent)' }}>VLN matches suggested (confirm below): <b>{p.suggestedVlnMatches.length}</b></li>
            )}
            {p.vlnConflicts?.length > 0 && (
              <li style={{ color: 'var(--danger-fg)' }}>VLN conflicts needing a choice: <b>{p.vlnConflicts.length}</b></li>
            )}
            <li>Observability traffic excluded: <b>{p.excludedObservability?.receivers ?? 0}</b> code(s), <b>{(p.excludedObservability?.messages ?? 0).toLocaleString('en-US')}</b> msgs</li>
            <li>Ambiguous codes resolved by MCC: <b>{p.ambiguousResolved?.length ?? 0}</b></li>
            <li>Unknown receivers (skipped): <b>{p.unknownReceivers?.length ?? 0}</b></li>
            <li>Ambiguous unresolved (skipped): <b>{p.ambiguousUnresolved?.length ?? 0}</b></li>
            <li>Errors: <b>{p.errors?.length ?? 0}</b></li>
            {p.closedMonths?.length > 0 && (
              <li style={{ color: 'var(--danger-fg)' }}>Closed months in file: {p.closedMonths.join(', ')}</li>
            )}
            {p.ambiguousResolved?.length > 0 && (
              <li>
                <details>
                  <summary>Ambiguous codes resolved ({p.ambiguousResolved.length})</summary>
                  <pre className="result-pre">{p.ambiguousResolved.map((a) => `${a.code} → ${a.chosen} (${a.via})${a.ignored?.length ? `  [ignored: ${a.ignored.join(', ')}]` : ''}`).join('\n')}</pre>
                </details>
              </li>
            )}
            {p.unknownReceivers?.length > 0 && (
              <li style={{ color: 'var(--danger-fg)' }}>
                <details>
                  <summary>Unknown receivers — not in system, will be skipped ({p.unknownReceivers.length})</summary>
                  <pre className="result-pre">{p.unknownReceivers.map((u) => `${u.receiver} — ${u.totalMessages.toLocaleString('en-US')} msgs over ${u.days} day(s)`).join('\n')}</pre>
                </details>
              </li>
            )}
            {p.errors?.length > 0 && (
              <li style={{ color: 'var(--danger-fg)' }}>
                <details>
                  <summary>Show errors</summary>
                  <pre className="result-pre">{p.errors.map((e) => (e.idx >= 0 ? `row ${e.idx}: ` : '') + e.error).join('\n')}</pre>
                </details>
              </li>
            )}
          </ul>
        )}
      />

      <ImportPanel
        open={priceSyncOpen}
        onClose={() => setPriceSyncOpen(false)}
        onDone={() => loadAll(date)}
        endpoint="/api/import/prices"
        title="Sync Prices — from the MO Prices master sheet (.xlsx)"
        summarize={(p) => (
          <ul className="preview-list">
            <li>Price changes to apply: <b>{p.changes?.length ?? 0}</b> (effective {p.effectiveFrom})</li>
            <li>Already up to date: <b>{p.unchanged ?? 0}</b></li>
            <li>Skipped — ambiguous sheet rows: <b>{p.conflicts?.length ?? 0}</b></li>
            <li>Not in sheet (left alone): <b>{p.notInSheet?.length ?? 0}</b></li>
            <li>VLN catalog — new/updated entries: <b>{p.vln?.catalogNew ?? 0}</b> (unchanged {p.vln?.catalogUnchanged ?? 0})</li>
            {p.vln?.parentsToCreate?.length > 0 && (
              <li>VLN parents to create: <b>{p.vln.parentsToCreate.length}</b> ({p.vln.parentsToCreate.join(', ')})</li>
            )}
            {p.vln?.skipped?.length > 0 && (
              <li style={{ color: 'var(--danger-fg)' }}>VLN rows skipped (no known country): <b>{p.vln.skipped.length}</b></li>
            )}
            {p.changes?.length > 0 && (
              <li>
                <details open>
                  <summary>Changes ({p.changes.length})</summary>
                  <pre className="result-pre">{p.changes.map((c) => {
                    const b = c.buy ? `buy ${c.buy.from}→${c.buy.to}` : '';
                    const s = c.sell ? `sell ${c.sell.from}→${c.sell.to}` : '';
                    return `${c.number.padEnd(20)} ${[b, s].filter(Boolean).join('  ')}`;
                  }).join('\n')}</pre>
                </details>
              </li>
            )}
            {p.conflicts?.length > 0 && (
              <li style={{ color: 'var(--danger-fg)' }}>
                <details>
                  <summary>Skipped — code appears more than once in the sheet ({p.conflicts.length})</summary>
                  <pre className="result-pre">{p.conflicts.map((c) => `${c.number} (code ${c.code})`).join('\n')}</pre>
                </details>
              </li>
            )}
            {p.errors?.length > 0 && (
              <li style={{ color: 'var(--danger-fg)' }}>
                <pre className="result-pre">{p.errors.map((e) => e.error).join('\n')}</pre>
              </li>
            )}
          </ul>
        )}
      />
    </div>
  );
}

function Card({ label, value }) {
  return (
    <div className="card">
      <div className="card-label">{label}</div>
      <div className="card-value">{value}</div>
    </div>
  );
}
