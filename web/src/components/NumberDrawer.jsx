// NumberDetail drawer — SPEC §4 + §14 step 14.
//
// Slides in from the right. Layout (top → bottom):
//   • Header: number / type / country
//   • Metadata: country + client + active (admin-editable)
//   • Pricing: purchase / selling / margin (read-only)
//   • Four fee buckets: cost monthly, cost setup, sale monthly, sale
//     setup. Each bucket lists past + current fees, with admin-only
//     [Edit] / [×] / [+ Add] controls. New monthly fees auto-close
//     the prior open-ended one (server-side single-active rule).
//   • History: audit entries for this number + its fees (most recent
//     200, server-joined to user email).

import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import LvnMembers from './LvnMembers.jsx';

// Cost-side first (what we pay supplier), then sale-side (what we
// charge client). "Setup" is one-off, charged in the calendar month
// of effective_from. "Monthly" / "Yearly" are recurring with no end
// date by default — adding a new one auto-closes the prior open-
// ended one (single-active rule, server-side).
const BUCKETS = [
  { side: 'cost', type: 'monthly', label: 'Monthly fee',     hint: 'recurring monthly from start date' },
  { side: 'cost', type: 'yearly',  label: 'Yearly fee',      hint: 'recurring once a year, anniversary of start date' },
  { side: 'cost', type: 'setup',   label: 'Setup fee',       hint: 'one-off, charged on the date set' },
  { side: 'sale', type: 'monthly', label: 'Sale monthly fee', hint: 'recurring monthly from start date' },
  { side: 'sale', type: 'yearly',  label: 'Sale yearly fee',  hint: 'recurring once a year, anniversary of start date' },
  { side: 'sale', type: 'setup',   label: 'Sale setup fee',   hint: 'one-off, charged on the date set' },
];

function fmtMoney(n) { return `$${(Number(n) || 0).toFixed(2)}`; }
function fmtDate(iso) { return iso ? iso.slice(0, 10) : '—'; }

export default function NumberDrawer({ numberId, onClose, onChanged }) {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [num, setNum] = useState(null);
  const [fees, setFees] = useState([]);
  const [audit, setAudit] = useState([]);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  // Editable header + pricing fields.
  const [editCountry, setEditCountry] = useState('');
  const [editClient, setEditClient] = useState('');
  const [editActive, setEditActive] = useState(true);
  const [editPurchase, setEditPurchase] = useState('');
  const [editSelling, setEditSelling] = useState('');
  const [headerDirty, setHeaderDirty] = useState(false);
  const [pricingDirty, setPricingDirty] = useState(false);

  async function loadAll() {
    setError(null);
    try {
      const [numRes, feeRes, auditRes] = await Promise.all([
        api.get('/api/numbers'),
        api.get(`/api/numbers/${numberId}/fees`),
        api.get(`/api/audit/by-number/${numberId}`),
      ]);
      const found = numRes.numbers.find((x) => x.id === numberId);
      if (!found) throw new Error('Number not found');
      setNum(found);
      setEditCountry(found.country || '');
      setEditClient(found.client || '');
      setEditActive(found.active);
      setEditPurchase(String(found.purchase_price_per_mo));
      setEditSelling(String(found.selling_price_per_mo));
      setHeaderDirty(false);
      setPricingDirty(false);
      setFees(feeRes.fees);
      setAudit(auditRes.entries);
    } catch (e) {
      setError(e.message);
    }
  }

  useEffect(() => { if (numberId) loadAll(); }, [numberId]);

  async function saveHeader() {
    if (!isAdmin) return;
    setBusy(true);
    setError(null);
    try {
      const patch = {
        country: editCountry || null,
        client: editClient || null,
        active: editActive,
      };
      await api.patch(`/api/numbers/${numberId}`, patch);
      await loadAll();
      onChanged?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function savePricing() {
    if (!isAdmin) return;
    const p = Number(editPurchase);
    const s = Number(editSelling);
    if (!Number.isFinite(p) || p < 0 || !Number.isFinite(s) || s < 0) {
      setError('Prices must be non-negative numbers');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.patch(`/api/numbers/${numberId}`, {
        purchase_price_per_mo: p,
        selling_price_per_mo: s,
      });
      await loadAll();
      onChanged?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function deleteFee(feeId) {
    if (!isAdmin) return;
    if (!confirm('Delete this fee? Audit will keep a snapshot.')) return;
    setBusy(true);
    setError(null);
    try {
      await api.del(`/api/fees/${feeId}`);
      await loadAll();
      onChanged?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function patchFee(feeId, patch) {
    setBusy(true);
    setError(null);
    try {
      await api.patch(`/api/fees/${feeId}`, patch);
      await loadAll();
      onChanged?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function addFee(side, type, amount, effective_from, effective_to) {
    setBusy(true);
    setError(null);
    try {
      const body = { side, type, amount: Number(amount), effective_from };
      if (type === 'monthly' && effective_to) body.effective_to = effective_to;
      await api.post(`/api/numbers/${numberId}/fees`, body);
      await loadAll();
      onChanged?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (!numberId) return null;

  return (
    <div className="drawer-bg" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-hdr">
          <div>
            <h3>{num ? num.number : '…'} <span className="mono">{num ? `${num.type} ${num.country || ''}` : ''}</span></h3>
          </div>
          <button className="btn-ghost" onClick={onClose}>Close</button>
        </div>

        {error && <div className="err-box" style={{ marginBottom: 14 }}>{error}</div>}
        {!num && <p className="mono">loading…</p>}

        {num && (
          <>
            {/* Metadata */}
            <section className="drawer-sect">
              <h4>Metadata</h4>
              <div className="form-grid">
                <label>
                  Country
                  <input
                    value={editCountry}
                    disabled={!isAdmin}
                    onChange={(e) => { setEditCountry(e.target.value.toUpperCase()); setHeaderDirty(true); }}
                    placeholder="e.g. ES"
                    maxLength={2}
                  />
                </label>
                <label>
                  Client
                  <input
                    value={editClient}
                    disabled={!isAdmin}
                    onChange={(e) => { setEditClient(e.target.value); setHeaderDirty(true); }}
                  />
                </label>
                <label className="tick">
                  <input
                    type="checkbox"
                    checked={editActive}
                    disabled={!isAdmin}
                    onChange={(e) => { setEditActive(e.target.checked); setHeaderDirty(true); }}
                  />
                  Active
                </label>
                {isAdmin && (
                  <button className="btn-primary" disabled={busy || !headerDirty} onClick={saveHeader}>
                    {busy ? 'Saving…' : 'Save metadata'}
                  </button>
                )}
              </div>
            </section>

            {/* Pricing — admin can edit purchase + selling. Margin is derived. */}
            <section className="drawer-sect">
              <h4>Pricing (per MO, USD)</h4>
              {isAdmin ? (
                <>
                  <div className="form-grid">
                    <label>
                      Purchase price
                      <input
                        type="number" min="0" step="0.0001" inputMode="decimal"
                        value={editPurchase}
                        onChange={(e) => { setEditPurchase(e.target.value); setPricingDirty(true); }}
                      />
                    </label>
                    <label>
                      Selling price
                      <input
                        type="number" min="0" step="0.0001" inputMode="decimal"
                        value={editSelling}
                        onChange={(e) => { setEditSelling(e.target.value); setPricingDirty(true); }}
                      />
                    </label>
                    <div className="kv-pricing-margin">
                      <span className="kv-label">Margin (auto)</span>
                      <span className="mono">{(Number(editSelling || 0) - Number(editPurchase || 0)).toFixed(4)}</span>
                    </div>
                    <button className="btn-primary" disabled={busy || !pricingDirty} onClick={savePricing}>
                      {busy ? 'Saving…' : 'Save pricing'}
                    </button>
                  </div>
                </>
              ) : (
                <div className="kv">
                  <div><span className="kv-label">Purchase</span><span className="mono">{num.purchase_price_per_mo.toFixed(4)}</span></div>
                  <div><span className="kv-label">Selling</span><span className="mono">{num.selling_price_per_mo.toFixed(4)}</span></div>
                  <div><span className="kv-label">Margin</span><span className="mono">{num.margin_per_mo.toFixed(4)}</span></div>
                </div>
              )}
            </section>

            {/* Operator pricing — SC only: per-network rate overrides */}
            {num.type === 'SC' && (
              <OperatorPricing numberId={numberId} isAdmin={isAdmin} onChanged={onChanged} />
            )}

            {/* LVN members — only for LVN-type parents */}
            {num.type === 'LVN' && (
              <LvnMembers numberId={numberId} onChanged={onChanged} />
            )}

            {/* Fee buckets */}
            {BUCKETS.map((b) => (
              <FeeBucket
                key={`${b.side}-${b.type}`}
                bucket={b}
                fees={fees.filter((f) => f.side === b.side && f.type === b.type)}
                isAdmin={isAdmin}
                busy={busy}
                onAdd={(amount, from, to) => addFee(b.side, b.type, amount, from, to)}
                onDelete={deleteFee}
                onPatch={patchFee}
              />
            ))}

            {/* History */}
            <section className="drawer-sect">
              <h4>History</h4>
              {audit.length === 0 && <p className="mono" style={{ color: 'var(--dim)' }}>// no audit entries</p>}
              <ul className="audit-list">
                {audit.map((e) => (
                  <li key={e.id}>
                    <span className="mono audit-date">{e.at?.slice(0, 19).replace('T', ' ')}</span>
                    <span className="audit-action">{e.action}</span>
                    <span className="mono audit-who">{e.user_email || '—'}</span>
                    <details>
                      <summary>diff</summary>
                      <pre className="result-pre">{JSON.stringify(e.diff, null, 2)}</pre>
                    </details>
                  </li>
                ))}
              </ul>
            </section>
          </>
        )}
      </aside>
    </div>
  );
}

function FeeBucket({ bucket, fees, isAdmin, busy, onAdd, onDelete, onPatch }) {
  const [adding, setAdding] = useState(false);
  const [amount, setAmount] = useState('');
  const [from, setFrom] = useState('');

  const isRecurring = bucket.type === 'monthly' || bucket.type === 'yearly';
  const sorted = [...fees].sort((a, b) => (b.effective_from || '').localeCompare(a.effective_from || ''));

  function reset() { setAdding(false); setAmount(''); setFrom(''); }

  async function submit() {
    if (!amount || !from) return;
    // Setup fees: one-off, never carry effective_to.
    // Recurring fees: leave effective_to=null on creation; later edits
    // can close it. Adding a new recurring auto-closes the prior one.
    await onAdd(amount, from, null);
    reset();
  }

  const dateLabel = bucket.type === 'setup' ? 'on' : 'starts';

  return (
    <section className="drawer-sect">
      <h4>{bucket.label}</h4>
      {bucket.hint && <p className="mono" style={{ color: 'var(--dim)', marginTop: '-6px', marginBottom: 8 }}>// {bucket.hint}</p>}
      {sorted.length === 0 && (
        <p className="mono" style={{ color: 'var(--dim)' }}>// none</p>
      )}
      <ul className="fee-list">
        {sorted.map((f) => (
          <FeeRow key={f.id} fee={f} bucket={bucket} isAdmin={isAdmin} busy={busy}
            onDelete={() => onDelete(f.id)} onPatch={(patch) => onPatch(f.id, patch)} />
        ))}
      </ul>
      {isAdmin && (
        adding ? (
          <div className="fee-add">
            <input type="number" min="0" step="0.01" placeholder="amount" value={amount}
              onChange={(e) => setAmount(e.target.value)} />
            <input type="date" placeholder={dateLabel} value={from}
              onChange={(e) => setFrom(e.target.value)} />
            <button className="btn-primary" disabled={busy || !amount || !from} onClick={submit}>Add</button>
            <button className="btn-ghost" onClick={reset}>Cancel</button>
          </div>
        ) : (
          <button className="btn-ghost" onClick={() => setAdding(true)}>+ Add {bucket.label.toLowerCase()}</button>
        )
      )}
    </section>
  );
}

function FeeRow({ fee, bucket, isAdmin, busy, onDelete, onPatch }) {
  const [editing, setEditing] = useState(false);
  const [amount, setAmount] = useState(fee.amount);
  const [from, setFrom] = useState(fee.effective_from || '');
  const [to, setTo] = useState(fee.effective_to || '');

  async function submit() {
    const patch = {};
    if (Number(amount) !== Number(fee.amount)) patch.amount = Number(amount);
    if (from !== (fee.effective_from || '')) patch.effective_from = from;
    if ((to || '') !== (fee.effective_to || '')) patch.effective_to = to || null;
    if (Object.keys(patch).length === 0) { setEditing(false); return; }
    await onPatch(patch);
    setEditing(false);
  }

  const isRecurring = bucket.type === 'monthly' || bucket.type === 'yearly';

  if (editing) {
    return (
      <li className="fee-row fee-edit">
        <input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        {isRecurring && (
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} placeholder="to (optional)" />
        )}
        <button className="btn-primary" disabled={busy} onClick={submit}>Save</button>
        <button className="btn-ghost" onClick={() => setEditing(false)}>Cancel</button>
      </li>
    );
  }

  const eatenLabel = isRecurring && Number(fee.amount) === 0 ? <span className="mono" style={{ color: 'var(--accent)' }}> (eaten)</span> : null;
  const closedLabel = isRecurring && fee.effective_to ? <span className="mono" style={{ color: 'var(--dim)' }}> (closed {fmtDate(fee.effective_to)})</span> : null;

  return (
    <li className="fee-row">
      <span className="mono fee-amt">{fmtMoney(fee.amount)}</span>
      <span className="mono">
        {bucket.type === 'setup' ? `on ${fmtDate(fee.effective_from)}` : `starts ${fmtDate(fee.effective_from)}`}
        {closedLabel}
        {eatenLabel}
      </span>
      {isAdmin && (
        <span className="fee-actions">
          <button className="btn-ghost" disabled={busy} onClick={() => setEditing(true)}>Edit</button>
          <button className="btn-ghost danger" disabled={busy} onClick={onDelete}>×</button>
        </span>
      )}
    </li>
  );
}

// ── Operator pricing (per-network rate overrides) ───────────
// The number's own purchase/selling is the default (catch-all) rate; each
// group overrides it for a set of MNCs. Volume on those networks bills at
// the group rate under the hood; the customer still sees one blended line.
function OperatorPricing({ numberId, isAdmin, onChanged }) {
  const [groups, setGroups] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);

  async function load() {
    setErr(null);
    try {
      const r = await api.get(`/api/numbers/${numberId}/operator-pricing`);
      setGroups(r.groups);
    } catch (e) { setErr(e.message); }
  }
  useEffect(() => { load(); }, [numberId]);

  async function run(fn) {
    setBusy(true); setErr(null);
    try { await fn(); await load(); onChanged?.(); }
    catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }
  const createGroup = (payload) => run(async () => {
    await api.post(`/api/numbers/${numberId}/operator-pricing`, payload);
    setAdding(false);
  });
  const patchGroup = (id, payload) => run(() => api.patch(`/api/operator-pricing/${id}`, payload));
  const deleteGroup = (id) => {
    if (!confirm('Delete this operator group? Its rate history is removed and that network falls back to the default rate.')) return;
    run(() => api.del(`/api/operator-pricing/${id}`));
  };

  return (
    <section className="drawer-sect">
      <h4>Operator pricing (per network)</h4>
      <p className="mono" style={{ color: 'var(--dim)', marginTop: '-6px', marginBottom: 8 }}>
        // override the default rate for specific MNCs — that traffic bills at the group rate
      </p>
      {err && <div className="err-box" style={{ marginBottom: 10 }}>{err}</div>}
      {groups === null && <p className="mono" style={{ color: 'var(--dim)' }}>loading…</p>}
      {groups && groups.length === 0 && !adding && (
        <p className="mono" style={{ color: 'var(--dim)' }}>// none — bills entirely at the default rate above</p>
      )}
      <ul className="fee-list">
        {(groups || []).map((g) => (
          <OperatorRow key={g.id} group={g} isAdmin={isAdmin} busy={busy}
            onSave={(p) => patchGroup(g.id, p)} onDelete={() => deleteGroup(g.id)} />
        ))}
      </ul>
      {isAdmin && (adding
        ? <OperatorAdd busy={busy} onCancel={() => setAdding(false)} onCreate={createGroup} />
        : <button className="btn-ghost" onClick={() => setAdding(true)}>+ Add operator group</button>)}
    </section>
  );
}

function OperatorRow({ group, isAdmin, busy, onSave, onDelete }) {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(group.label);
  const [mncs, setMncs] = useState((group.mncs || []).join(', '));
  const [buy, setBuy] = useState(String(group.purchase_price_per_mo));
  const [sell, setSell] = useState(String(group.selling_price_per_mo));

  async function submit() {
    const p = { label, mncs };
    if (Number(buy) !== Number(group.purchase_price_per_mo)) p.purchase_price_per_mo = Number(buy);
    if (Number(sell) !== Number(group.selling_price_per_mo)) p.selling_price_per_mo = Number(sell);
    await onSave(p);
    setEditing(false);
  }

  if (editing) {
    return (
      <li className="fee-row fee-edit" style={{ flexWrap: 'wrap', gap: 6 }}>
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="label" style={{ width: 90 }} />
        <input value={mncs} onChange={(e) => setMncs(e.target.value)} placeholder="MNCs e.g. 310,320" style={{ width: 150 }} />
        <input type="number" min="0" step="0.0001" value={buy} onChange={(e) => setBuy(e.target.value)} placeholder="buy" style={{ width: 80 }} />
        <input type="number" min="0" step="0.0001" value={sell} onChange={(e) => setSell(e.target.value)} placeholder="sell" style={{ width: 80 }} />
        <button className="btn-primary" disabled={busy} onClick={submit}>Save</button>
        <button className="btn-ghost" onClick={() => setEditing(false)}>Cancel</button>
      </li>
    );
  }
  const m = (Number(group.selling_price_per_mo) - Number(group.purchase_price_per_mo)).toFixed(4);
  return (
    <li className="fee-row">
      <span className="mono"><b>{group.label}</b> · {(group.mncs || []).join(', ') || '(no MNCs)'}</span>
      <span className="mono">buy {group.purchase_price_per_mo.toFixed(4)} · sell {group.selling_price_per_mo.toFixed(4)} · Δ {m}</span>
      {isAdmin && (
        <span className="fee-actions">
          <button className="btn-ghost" disabled={busy} onClick={() => setEditing(true)}>Edit</button>
          <button className="btn-ghost danger" disabled={busy} onClick={onDelete}>×</button>
        </span>
      )}
    </li>
  );
}

function OperatorAdd({ busy, onCancel, onCreate }) {
  const [label, setLabel] = useState('');
  const [mncs, setMncs] = useState('');
  const [buy, setBuy] = useState('');
  const [sell, setSell] = useState('');
  const valid = label.trim() && mncs.trim() && buy !== '' && sell !== '';
  return (
    <div className="fee-add" style={{ flexWrap: 'wrap', gap: 6 }}>
      <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="label e.g. Claro" style={{ width: 90 }} />
      <input value={mncs} onChange={(e) => setMncs(e.target.value)} placeholder="MNCs e.g. 310,320,330" style={{ width: 160 }} />
      <input type="number" min="0" step="0.0001" value={buy} onChange={(e) => setBuy(e.target.value)} placeholder="buy" style={{ width: 80 }} />
      <input type="number" min="0" step="0.0001" value={sell} onChange={(e) => setSell(e.target.value)} placeholder="sell" style={{ width: 80 }} />
      <button className="btn-primary" disabled={busy || !valid}
        onClick={() => onCreate({ label, mncs, purchase_price_per_mo: Number(buy), selling_price_per_mo: Number(sell) })}>Add</button>
      <button className="btn-ghost" onClick={onCancel}>Cancel</button>
    </div>
  );
}
