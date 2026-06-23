// Numbers page — SPEC §4 + §14 step 15.
//   - Full list (active + inactive) with filter row
//   - Click number → opens NumberDrawer (reused from Dashboard)
//   - Admin: + New number (inline form), Import (.xlsx), Export (.xlsx),
//            Deactivate / Reactivate from row actions
//
// Inactive rows render dimmed; the active filter is "All" by default
// so admins can find a deactivated number without thinking about it.

import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import ImportPanel from '../components/ImportPanel.jsx';
import NumberDrawer from '../components/NumberDrawer.jsx';

const TYPES = ['SC', 'LVN'];

export default function Numbers() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';

  const [numbers, setNumbers] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  // Filters
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');     // 'all' | 'SC' | 'LVN'
  const [activeFilter, setActiveFilter] = useState('all'); // 'all' | 'true' | 'false'
  const [countryFilter, setCountryFilter] = useState('');
  const [clientFilter, setClientFilter] = useState('');

  // UI state
  const [importOpen, setImportOpen] = useState(false);
  const [drawerId, setDrawerId] = useState(null);
  const [adding, setAdding] = useState(false);

  // New-number form
  const [newRow, setNewRow] = useState({
    number: '', type: 'SC', country: '', client: '',
    purchase_price_per_mo: '', selling_price_per_mo: '',
  });

  async function load() {
    setError(null);
    try {
      const r = await api.get('/api/numbers');
      setNumbers(r.numbers);
    } catch (e) {
      setError(e.message);
    }
  }

  useEffect(() => { load(); }, []);

  const filtered = useMemo(() => {
    if (!numbers) return [];
    const q = search.trim().toLowerCase();
    return numbers.filter((n) => {
      if (typeFilter !== 'all' && n.type !== typeFilter) return false;
      if (activeFilter === 'true' && !n.active) return false;
      if (activeFilter === 'false' && n.active) return false;
      if (countryFilter && (n.country || '').toUpperCase() !== countryFilter.toUpperCase()) return false;
      if (clientFilter && (n.client || '').toLowerCase() !== clientFilter.toLowerCase()) return false;
      if (q) {
        const hay = [n.number, n.client || '', n.country || ''].join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [numbers, search, typeFilter, activeFilter, countryFilter, clientFilter]);

  const countries = useMemo(() => [...new Set((numbers || []).map((n) => n.country).filter(Boolean))].sort(), [numbers]);
  const clients = useMemo(() => [...new Set((numbers || []).map((n) => n.client).filter(Boolean))].sort(), [numbers]);

  async function addNumber() {
    if (!isAdmin) return;
    setBusy(true);
    setError(null);
    try {
      const body = {
        number: newRow.number.trim(),
        type: newRow.type,
        country: newRow.country.trim() || null,
        client: newRow.client.trim() || null,
        purchase_price_per_mo: Number(newRow.purchase_price_per_mo),
        selling_price_per_mo: Number(newRow.selling_price_per_mo),
      };
      await api.post('/api/numbers', body);
      setAdding(false);
      setNewRow({ number: '', type: 'SC', country: '', client: '', purchase_price_per_mo: '', selling_price_per_mo: '' });
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(n) {
    if (!isAdmin) return;
    setBusy(true);
    setError(null);
    try {
      if (n.active) {
        if (!confirm(`Deactivate ${n.number}? It will be hidden from the dashboard but billing history is preserved.`)) {
          setBusy(false);
          return;
        }
        await api.del(`/api/numbers/${n.id}`);
      } else {
        await api.patch(`/api/numbers/${n.id}`, { active: true });
      }
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      {/* Toolbar */}
      <div className="numbers-toolbar">
        <div className="filter-row">
          <input
            type="text" placeholder="Search number / client / country…"
            value={search} onChange={(e) => setSearch(e.target.value)}
          />
          <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
            <option value="all">All types</option>
            {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <select value={activeFilter} onChange={(e) => setActiveFilter(e.target.value)}>
            <option value="all">All states</option>
            <option value="true">Active only</option>
            <option value="false">Inactive only</option>
          </select>
          <select value={countryFilter} onChange={(e) => setCountryFilter(e.target.value)}>
            <option value="">All countries</option>
            {countries.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <select value={clientFilter} onChange={(e) => setClientFilter(e.target.value)}>
            <option value="">All clients</option>
            {clients.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        {isAdmin && (
          <div className="dash-actions">
            <button className="btn-ghost" onClick={() => setAdding((v) => !v)}>
              {adding ? 'Cancel new' : '+ New number'}
            </button>
            <button className="btn-ghost" onClick={() => setImportOpen(true)}>Import (.xlsx)</button>
            <a className="btn-ghost" href="/api/numbers/export.xlsx">Export (.xlsx)</a>
          </div>
        )}
      </div>

      {error && <div className="err-box" style={{ marginBottom: 14 }}>{error}</div>}

      {/* New-number form */}
      {adding && isAdmin && (
        <div className="new-row">
          <input placeholder="Number"
            value={newRow.number} onChange={(e) => setNewRow({ ...newRow, number: e.target.value })} />
          <select value={newRow.type} onChange={(e) => setNewRow({ ...newRow, type: e.target.value })}>
            {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <input placeholder="Country (e.g. ES)" maxLength={2}
            value={newRow.country} onChange={(e) => setNewRow({ ...newRow, country: e.target.value.toUpperCase() })} />
          <input placeholder="Client"
            value={newRow.client} onChange={(e) => setNewRow({ ...newRow, client: e.target.value })} />
          <input type="number" min="0" step="0.0001" placeholder="Purchase $"
            value={newRow.purchase_price_per_mo}
            onChange={(e) => setNewRow({ ...newRow, purchase_price_per_mo: e.target.value })} />
          <input type="number" min="0" step="0.0001" placeholder="Selling $"
            value={newRow.selling_price_per_mo}
            onChange={(e) => setNewRow({ ...newRow, selling_price_per_mo: e.target.value })} />
          <button className="btn-primary"
            disabled={busy || !newRow.number || !newRow.purchase_price_per_mo || !newRow.selling_price_per_mo}
            onClick={addNumber}>Add</button>
        </div>
      )}

      {/* Table */}
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
              <th>Active</th>
              {isAdmin && <th></th>}
            </tr>
          </thead>
          <tbody>
            {numbers === null && (
              <tr><td colSpan={isAdmin ? 9 : 8} className="mono" style={{ color: 'var(--dim)' }}>loading…</td></tr>
            )}
            {numbers && filtered.length === 0 && (
              <tr><td colSpan={isAdmin ? 9 : 8} className="mono" style={{ color: 'var(--dim)' }}>
                {numbers.length === 0 ? 'No numbers yet — import or add a new one.' : 'No matches for these filters.'}
              </td></tr>
            )}
            {filtered.map((n) => {
              const op = n.has_operator_pricing;
              const buy = op ? n.avg_purchase_price_per_mo : n.purchase_price_per_mo;
              const sell = op ? n.avg_selling_price_per_mo : n.selling_price_per_mo;
              const marg = op ? (sell - buy) : n.margin_per_mo;
              const pfx = op ? '~' : '';
              return (
              <tr key={n.id} className={n.active ? '' : 'inactive'}>
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
                <td>{n.active ? '✓' : '—'}</td>
                {isAdmin && (
                  <td>
                    <button className={'btn-ghost' + (n.active ? ' danger' : '')}
                      disabled={busy} onClick={() => toggleActive(n)}>
                      {n.active ? 'Deactivate' : 'Reactivate'}
                    </button>
                  </td>
                )}
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <NumberDrawer
        numberId={drawerId}
        onClose={() => setDrawerId(null)}
        onChanged={() => load()}
      />

      <ImportPanel
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onDone={() => load()}
        endpoint="/api/import"
        title="Import (.xlsx) — numbers, fees, volumes, members"
        summarize={(p) => (
          <ul className="preview-list">
            <li>Numbers to create: <b>{p.toCreate?.length ?? 0}</b></li>
            <li>Numbers to update: <b>{p.toUpdate?.length ?? 0}</b></li>
            <li>Fees to create: <b>{p.feesToCreate?.length ?? 0}</b></li>
            <li>Volumes to upsert: <b>{p.volumesToUpsert?.length ?? 0}</b></li>
            <li>VLN members to add: <b>{p.members?.toCreate?.length ?? 0}</b></li>
            <li>VLN members to remove: <b>{p.members?.toDeactivate?.length ?? 0}</b></li>
            <li>Errors: <b>{p.errors?.length ?? 0}</b></li>
            {p.members?.warnings?.length > 0 && (
              <li style={{ color: 'var(--danger-fg)' }}>
                <details open><summary>Member warnings ({p.members.warnings.length})</summary>
                  <pre className="result-pre">{p.members.warnings.join('\n')}</pre>
                </details>
              </li>
            )}
            {p.errors?.length > 0 && (
              <li style={{ color: 'var(--danger-fg)' }}>
                <details><summary>Show errors</summary>
                  <pre className="result-pre">{p.errors.map((e) => `row ${e.idx}: ${e.error}`).join('\n')}</pre>
                </details>
              </li>
            )}
          </ul>
        )}
      />
    </div>
  );
}
