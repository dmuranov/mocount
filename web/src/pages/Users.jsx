// Users admin page — SPEC §4. Admin-only.
//
// Same surface as the legacy vanilla HTML version (step 4 era):
// list + edit-in-place + add new + soft-delete (deactivate). The
// server enforces "at least one active admin" + "no self-demote /
// self-deactivate", so the UI doesn't need to mirror those guards
// — wrong moves come back as friendly 4xx errors.

import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';

export default function Users() {
  const { user: me } = useAuth();
  const [users, setUsers] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null); // user id while a mutation is in flight

  // New-user form state
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ email: '', name: '', role: 'viewer', receives_monthly_email: true });

  async function load() {
    setError(null);
    try {
      const r = await api.get('/api/users');
      setUsers(r.users);
    } catch (e) {
      setError(e.message);
    }
  }

  useEffect(() => { load(); }, []);

  async function save(u, patch) {
    setBusy(u.id); setError(null);
    try {
      await api.patch(`/api/users/${u.id}`, patch);
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }

  async function deactivate(u) {
    if (!confirm(`Deactivate ${u.email}? They will be signed out on their next request.`)) return;
    setBusy(u.id); setError(null);
    try {
      await api.del(`/api/users/${u.id}`);
      await load();
    } catch (e) { setError(e.message); }
    finally { setBusy(null); }
  }

  async function reactivate(u) {
    setBusy(u.id); setError(null);
    try {
      await api.patch(`/api/users/${u.id}`, { active: true });
      await load();
    } catch (e) { setError(e.message); }
    finally { setBusy(null); }
  }

  async function add() {
    setBusy('new'); setError(null);
    try {
      await api.post('/api/users', {
        email: draft.email.trim().toLowerCase(),
        name: draft.name.trim() || null,
        role: draft.role,
        receives_monthly_email: draft.receives_monthly_email,
      });
      setDraft({ email: '', name: '', role: 'viewer', receives_monthly_email: true });
      setAdding(false);
      await load();
    } catch (e) { setError(e.message); }
    finally { setBusy(null); }
  }

  return (
    <div className="page">
      <div className="numbers-toolbar">
        <p className="mono" style={{ color: 'var(--dim)', margin: 0 }}>
          // adding a user only allowlists their Google email — they still need to sign in themselves
        </p>
        <div className="dash-actions">
          <button className="btn-ghost" onClick={() => setAdding((v) => !v)}>
            {adding ? 'Cancel new' : '+ New user'}
          </button>
        </div>
      </div>

      {error && <div className="err-box" style={{ marginBottom: 14 }}>{error}</div>}

      {adding && (
        <div className="new-row" style={{ gridTemplateColumns: '2fr 1.5fr 1fr 1fr auto' }}>
          <input type="email" placeholder="email@example.com" value={draft.email}
            onChange={(e) => setDraft({ ...draft, email: e.target.value })} />
          <input type="text" placeholder="Name (optional)" value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          <select value={draft.role} onChange={(e) => setDraft({ ...draft, role: e.target.value })}>
            <option value="viewer">viewer</option>
            <option value="admin">admin</option>
          </select>
          <label className="tick" style={{ fontSize: 12 }}>
            <input type="checkbox" checked={draft.receives_monthly_email}
              onChange={(e) => setDraft({ ...draft, receives_monthly_email: e.target.checked })} />
            monthly email
          </label>
          <button className="btn-primary" disabled={busy === 'new' || !draft.email} onClick={add}>Add</button>
        </div>
      )}

      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Email</th>
              <th>Name</th>
              <th>Role</th>
              <th>Monthly email</th>
              <th>Active</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {users === null && (
              <tr><td colSpan={6} className="mono" style={{ color: 'var(--dim)' }}>loading…</td></tr>
            )}
            {users?.map((u) => (
              <UserRow key={u.id} u={u} me={me} busy={busy === u.id}
                onSave={(patch) => save(u, patch)}
                onDeactivate={() => deactivate(u)}
                onReactivate={() => reactivate(u)}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function UserRow({ u, me, busy, onSave, onDeactivate, onReactivate }) {
  const isMe = u.id === me?.id;
  const [name, setName] = useState(u.name || '');
  const [role, setRole] = useState(u.role);
  const [monthly, setMonthly] = useState(u.receives_monthly_email);
  const dirty = name !== (u.name || '') || role !== u.role || monthly !== u.receives_monthly_email;

  return (
    <tr className={u.active ? '' : 'inactive'}>
      <td className="mono">
        {u.email}
        {isMe && <span style={{ color: 'var(--accent)', fontSize: 10, marginLeft: 6 }}>YOU</span>}
      </td>
      <td>
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
      </td>
      <td>
        <select value={role} onChange={(e) => setRole(e.target.value)} disabled={isMe}>
          <option value="viewer">viewer</option>
          <option value="admin">admin</option>
        </select>
      </td>
      <td>
        <label className="tick" style={{ display: 'inline-flex' }}>
          <input type="checkbox" checked={monthly} onChange={(e) => setMonthly(e.target.checked)} />
        </label>
      </td>
      <td>{u.active ? '✓' : '—'}</td>
      <td style={{ whiteSpace: 'nowrap' }}>
        <button className="btn-ghost" disabled={busy || !dirty}
          onClick={() => onSave({ name: name.trim() || null, role, receives_monthly_email: monthly })}>
          Save
        </button>{' '}
        {u.active ? (
          <button className="btn-ghost danger" disabled={busy || isMe} onClick={onDeactivate}>Deactivate</button>
        ) : (
          <button className="btn-ghost" disabled={busy} onClick={onReactivate}>Reactivate</button>
        )}
      </td>
    </tr>
  );
}
