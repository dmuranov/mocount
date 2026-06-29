// VLN match confirmation — shown in the MO Messages import preview.
//
// The importer proposes a parent VLN for each unknown receiver (by country +
// shared subscriber suffix). The uploader confirms per row, or "Yes to all"
// for a whole country prefix. Cross-client suffix collisions appear as
// conflicts and require an explicit client pick. Approved rows are sent as
// `approvedVlnMatches` on commit and saved as permanent members.

import { useEffect, useMemo, useState } from 'react';

export default function VlnConfirm({ plan, setExtra }) {
  const suggestions = plan?.suggestedVlnMatches || [];
  const conflicts = plan?.vlnConflicts || [];

  // receiver -> chosen parent_number_id (null/undefined = "No, skip").
  // Suggestions default to Yes; conflicts default to unset (must choose).
  const [sel, setSel] = useState(() => {
    const m = {};
    for (const s of suggestions) m[s.receiver] = s.candidate.parent_number_id;
    return m;
  });

  useEffect(() => {
    const approved = Object.entries(sel)
      .filter(([, pid]) => pid)
      .map(([receiver, parent_number_id]) => ({ receiver, parent_number_id }));
    setExtra({ approvedVlnMatches: JSON.stringify(approved) });
  }, [sel, setExtra]);

  // Group suggestions by country prefix for the "Yes to all" control.
  const groups = useMemo(() => {
    const g = new Map();
    for (const s of suggestions) {
      const k = s.countryPrefix || '??';
      if (!g.has(k)) g.set(k, []);
      g.get(k).push(s);
    }
    return [...g.entries()];
  }, [suggestions]);

  if (!suggestions.length && !conflicts.length) return null;

  const setOne = (receiver, pid) => setSel((p) => ({ ...p, [receiver]: pid }));
  const setGroup = (items, on) =>
    setSel((p) => {
      const next = { ...p };
      for (const s of items) next[s.receiver] = on ? s.candidate.parent_number_id : null;
      return next;
    });

  const approvedCount = Object.values(sel).filter(Boolean).length;
  const fmt = (n) => (Number(n) || 0).toLocaleString('en-US');

  return (
    <div className="vln-confirm" style={{ marginTop: 16, borderTop: '1px solid var(--border, #333)', paddingTop: 12 }}>
      <p className="mono" style={{ fontWeight: 700 }}>
        VLN matches to confirm — {approvedCount} of {suggestions.length} suggestion(s) selected
        {conflicts.length ? `, ${conflicts.length} conflict(s) need a choice` : ''}
      </p>

      {groups.map(([prefix, items]) => (
        <details key={prefix} open className="vln-group" style={{ marginBottom: 10 }}>
          <summary style={{ cursor: 'pointer' }}>
            +{prefix} — {items.length} number(s){' '}
            <button type="button" className="btn-ghost" style={{ marginLeft: 8 }}
              onClick={(e) => { e.preventDefault(); setGroup(items, true); }}>Yes to all +{prefix}</button>
            <button type="button" className="btn-ghost" style={{ marginLeft: 6 }}
              onClick={(e) => { e.preventDefault(); setGroup(items, false); }}>No to all</button>
          </summary>
          <table className="data" style={{ width: '100%', marginTop: 6 }}>
            <thead>
              <tr>
                <th>Receiver</th><th style={{ textAlign: 'right' }}>Msgs</th>
                <th>→ Parent</th><th>Client</th><th style={{ textAlign: 'right' }}>buy/sell</th><th>Confirm</th>
              </tr>
            </thead>
            <tbody>
              {items.map((s) => {
                const on = !!sel[s.receiver];
                return (
                  <tr key={s.receiver} className={on ? '' : 'row-dim'} style={on ? {} : { opacity: 0.5 }}>
                    <td className="mono">{s.receiver}</td>
                    <td style={{ textAlign: 'right' }}>{fmt(s.totalMessages)}</td>
                    <td className="mono">{s.candidate.parent_number || '—'}</td>
                    <td>{s.candidate.client || '—'}</td>
                    <td style={{ textAlign: 'right' }} className="mono">{s.candidate.buy}/{s.candidate.sell}</td>
                    <td>
                      <label style={{ marginRight: 8 }}>
                        <input type="radio" name={`v_${s.receiver}`} checked={on}
                          onChange={() => setOne(s.receiver, s.candidate.parent_number_id)} /> Yes
                      </label>
                      <label>
                        <input type="radio" name={`v_${s.receiver}`} checked={!on}
                          onChange={() => setOne(s.receiver, null)} /> No
                      </label>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </details>
      ))}

      {conflicts.length > 0 && (
        <details className="vln-conflicts" style={{ marginTop: 8 }}>
          <summary style={{ cursor: 'pointer', color: 'var(--danger-fg, #c66)' }}>
            {conflicts.length} conflict(s) — suffix maps to more than one client; pick one or skip
          </summary>
          <table className="data" style={{ width: '100%', marginTop: 6 }}>
            <thead>
              <tr><th>Receiver</th><th style={{ textAlign: 'right' }}>Msgs</th><th>Choose client / parent</th></tr>
            </thead>
            <tbody>
              {conflicts.map((c) => (
                <tr key={c.receiver}>
                  <td className="mono">{c.receiver}</td>
                  <td style={{ textAlign: 'right' }}>{fmt(c.totalMessages)}</td>
                  <td>
                    <select value={sel[c.receiver] || ''} onChange={(e) => setOne(c.receiver, e.target.value || null)}>
                      <option value="">— skip —</option>
                      {c.candidates.map((cand) => (
                        <option key={cand.parent_number_id} value={cand.parent_number_id}>
                          {cand.client || '?'} → {cand.parent_number || cand.parent_number_id} ({cand.buy}/{cand.sell})
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </div>
  );
}
