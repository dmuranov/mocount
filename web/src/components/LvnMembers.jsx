// LVN members panel — change request §3.
//
// Renders inside NumberDrawer only when the parent number is type
// 'LVN'. Active members are shown by default; admins can flip a
// "Show removed" toggle to see soft-deleted ones with a Restore
// button.
//
// Server is the source of truth for validation; we mirror the regex
// here just to give immediate feedback before submitting.

import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';

const PHONE_RE = /^\+?\d{6,20}$/;

export default function LvnMembers({ numberId, onChanged }) {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [members, setMembers] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [phone, setPhone] = useState('');
  const [showRemoved, setShowRemoved] = useState(false);

  async function load() {
    setError(null);
    try {
      const r = await api.get(`/api/numbers/${numberId}/members`);
      setMembers(r.members);
    } catch (e) {
      setError(e.message);
    }
  }

  useEffect(() => { if (numberId) load(); }, [numberId]);

  async function add() {
    const p = phone.trim();
    if (!PHONE_RE.test(p)) {
      setError('Phone must be 6–20 digits, optional leading +');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/numbers/${numberId}/members`, { phone: p });
      setPhone('');
      setAdding(false);
      await load();
      onChanged?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(memberId, phoneStr) {
    if (!confirm(`Remove VLN ${phoneStr}? It will no longer count for this group.`)) return;
    setBusy(true);
    setError(null);
    try {
      await api.del(`/api/lvn-members/${memberId}`);
      await load();
      onChanged?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function restore(memberId) {
    setBusy(true);
    setError(null);
    try {
      await api.patch(`/api/lvn-members/${memberId}`, { active: true });
      await load();
      onChanged?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (members === null) {
    return (
      <section className="drawer-sect">
        <h4>VLN members</h4>
        <p className="mono" style={{ color: 'var(--dim)' }}>loading…</p>
      </section>
    );
  }

  const visible = members.filter((m) => m.active || showRemoved);
  const activeCount = members.filter((m) => m.active).length;
  const removedCount = members.length - activeCount;

  return (
    <section className="drawer-sect">
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
        <h4 style={{ margin: 0 }}>VLN members ({activeCount})</h4>
        {removedCount > 0 && (
          <label className="tick" style={{ fontSize: 11 }}>
            <input type="checkbox" checked={showRemoved} onChange={(e) => setShowRemoved(e.target.checked)} />
            Show removed ({removedCount})
          </label>
        )}
      </div>

      {error && <div className="err-box" style={{ marginTop: 10 }}>{error}</div>}

      {visible.length === 0 && (
        <p className="mono" style={{ color: 'var(--dim)', marginTop: 8 }}>// no VLN members yet</p>
      )}

      <ul className="member-list">
        {visible.map((m) => (
          <li key={m.id} className={'member-row' + (m.active ? '' : ' inactive')}>
            <span className="mono">{m.phone}</span>
            {!m.active && <span className="mono" style={{ color: 'var(--dim)' }}>(removed)</span>}
            {isAdmin && (
              m.active
                ? <button className="btn-ghost danger" disabled={busy} onClick={() => remove(m.id, m.phone)}>×</button>
                : <button className="btn-ghost" disabled={busy} onClick={() => restore(m.id)}>Restore</button>
            )}
          </li>
        ))}
      </ul>

      {isAdmin && (
        adding ? (
          <div className="fee-add">
            <input
              type="text" placeholder="639191610468"
              value={phone} onChange={(e) => setPhone(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') add(); }}
            />
            <button className="btn-primary" disabled={busy || !phone.trim()} onClick={add}>Add</button>
            <button className="btn-ghost" onClick={() => { setAdding(false); setPhone(''); setError(null); }}>Cancel</button>
          </div>
        ) : (
          <button className="btn-ghost" onClick={() => setAdding(true)}>+ Add VLN</button>
        )
      )}
    </section>
  );
}
