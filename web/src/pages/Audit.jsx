// Audit page — SPEC §4.
// Admin-only. Filters by entity, user, action, and date range.
// View state lives in URL params for shareable links.

import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api.js';

export default function Audit() {
  const [params, setParams] = useSearchParams();
  const entity   = params.get('entity')   || '';
  const action   = params.get('action')   || '';
  const userId   = params.get('user_id')  || '';
  const from     = params.get('from')     || '';
  const to       = params.get('to')       || '';

  const [opts, setOpts] = useState({ users: [], entities: [], actions: [] });
  const [entries, setEntries] = useState(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api.get('/api/audit/options').then(setOpts).catch((e) => setError(e.message));
  }, []);

  async function load() {
    setLoading(true); setError(null);
    try {
      const q = new URLSearchParams();
      if (entity) q.set('entity', entity);
      if (action) q.set('action', action);
      if (userId) q.set('user_id', userId);
      if (from)   q.set('from', from);
      if (to)     q.set('to', to);
      q.set('limit', '200');
      const r = await api.get(`/api/audit${q.toString() ? '?' + q.toString() : ''}`);
      setEntries(r.entries);
      setMore(r.more);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [entity, action, userId, from, to]);

  function update(patch) {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v === '' || v == null) next.delete(k);
      else next.set(k, v);
    }
    setParams(next, { replace: true });
  }

  const userById = useMemo(() => {
    const m = new Map();
    for (const u of opts.users) m.set(u.id, u.email);
    return m;
  }, [opts.users]);

  return (
    <div className="page">
      <div className="numbers-toolbar">
        <div className="filter-row">
          <select value={entity} onChange={(e) => update({ entity: e.target.value })}>
            <option value="">All entities</option>
            {opts.entities.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
          <select value={action} onChange={(e) => update({ action: e.target.value })}>
            <option value="">All actions</option>
            {opts.actions.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
          <select value={userId} onChange={(e) => update({ user_id: e.target.value })}>
            <option value="">All users</option>
            {opts.users.map((u) => <option key={u.id} value={u.id}>{u.email}</option>)}
          </select>
          <label className="mono" style={{ color: 'var(--muted)' }}>from</label>
          <input type="date" value={from} onChange={(e) => update({ from: e.target.value })} />
          <label className="mono" style={{ color: 'var(--muted)' }}>to</label>
          <input type="date" value={to} onChange={(e) => update({ to: e.target.value })} />
          <button className="btn-ghost" onClick={() => setParams(new URLSearchParams())}>Clear</button>
        </div>
        <div className="dash-actions">
          <span className="mono" style={{ color: 'var(--dim)' }}>
            {entries === null ? '' : `${entries.length}${more ? '+ (more, narrow filters)' : ''} entries`}
          </span>
        </div>
      </div>

      {error && <div className="err-box" style={{ marginBottom: 14 }}>{error}</div>}
      {loading && entries === null && <p className="mono">loading…</p>}

      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>When (UTC)</th>
              <th>Action</th>
              <th>Entity</th>
              <th>Entity ID</th>
              <th>Who</th>
              <th>Diff</th>
            </tr>
          </thead>
          <tbody>
            {entries?.length === 0 && (
              <tr><td colSpan={6} className="mono" style={{ color: 'var(--dim)' }}>No entries match these filters.</td></tr>
            )}
            {entries?.map((e) => (
              <tr key={e.id}>
                <td className="mono" style={{ whiteSpace: 'nowrap' }}>{e.at?.slice(0, 19).replace('T', ' ')}</td>
                <td className="mono">{e.action}</td>
                <td>{e.entity}</td>
                <td className="mono" style={{ maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis' }} title={e.entity_id}>{e.entity_id}</td>
                <td className="mono">{e.user_email || (e.user_id ? userById.get(e.user_id) : '—') || '—'}</td>
                <td>
                  <details>
                    <summary className="mono" style={{ color: 'var(--muted)' }}>show</summary>
                    <pre className="result-pre">{JSON.stringify(e.diff, null, 2)}</pre>
                  </details>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
