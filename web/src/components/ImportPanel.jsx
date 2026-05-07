// Two-step import UX shared by Numbers + Volumes:
//   1. Pick file → POST dryRun=true → render preview
//   2. User clicks Confirm → POST dryRun=false → render result + onDone()
//
// Props:
//   open      bool
//   onClose   () => void   — close without committing
//   onDone    (result) => void — called after successful commit
//   endpoint  string       — POST target (.../import?dryRun=...)
//   title     string
//   summarize (plan) => ReactNode  — renders a one-block summary of the dry-run

import { useRef, useState } from 'react';

const STATE_PICK = 'pick';
const STATE_PREVIEW = 'preview';
const STATE_COMMITTING = 'committing';
const STATE_DONE = 'done';

export default function ImportPanel({ open, onClose, onDone, endpoint, title, summarize }) {
  const [phase, setPhase] = useState(STATE_PICK);
  const [plan, setPlan] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [filename, setFilename] = useState('');
  // Hold the actual File object — the <input> unmounts during the
  // PREVIEW phase, so a ref to it goes null on commit.
  const [picked, setPicked] = useState(null);
  const fileRef = useRef(null);

  if (!open) return null;

  function reset() {
    setPhase(STATE_PICK);
    setPlan(null);
    setResult(null);
    setError(null);
    setFilename('');
    setPicked(null);
    if (fileRef.current) fileRef.current.value = '';
  }

  async function onFilePicked(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    setPicked(f);
    setFilename(f.name);
    setError(null);
    const fd = new FormData();
    fd.append('file', f);
    try {
      const res = await fetch(`${endpoint}?dryRun=true`, { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok || data.ok === false) throw new Error(data.error || res.statusText);
      setPlan(data);
      setPhase(STATE_PREVIEW);
    } catch (err) {
      setError(err.message);
    }
  }

  async function commit() {
    setPhase(STATE_COMMITTING);
    setError(null);
    try {
      if (!picked) throw new Error('Lost file reference — please pick again');
      const fd = new FormData();
      fd.append('file', picked);
      const res = await fetch(`${endpoint}?dryRun=false`, { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok || data.ok === false) throw new Error(data.error || res.statusText);
      setResult(data);
      setPhase(STATE_DONE);
      onDone?.(data);
    } catch (err) {
      setError(err.message);
      setPhase(STATE_PREVIEW);
    }
  }

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-hdr">
          <h3>{title}</h3>
          <button className="btn-ghost" onClick={() => { reset(); onClose(); }}>Close</button>
        </div>

        {error && <div className="err-box" style={{ marginBottom: 14 }}>{error}</div>}

        {phase === STATE_PICK && (
          <div>
            <p className="mono">// pick an .xlsx file to preview</p>
            <input ref={fileRef} type="file" accept=".xlsx" onChange={onFilePicked} />
          </div>
        )}

        {phase === STATE_PREVIEW && plan && (
          <div>
            <p className="mono">// {filename}</p>
            {summarize(plan)}
            <div style={{ marginTop: 18, display: 'flex', gap: 8 }}>
              <button className="btn-primary" onClick={commit}>Confirm import</button>
              <button className="btn-ghost" onClick={reset}>Pick a different file</button>
            </div>
          </div>
        )}

        {phase === STATE_COMMITTING && <p className="mono">// committing…</p>}

        {phase === STATE_DONE && result && (
          <div>
            <div className="ok-box">Import complete.</div>
            <pre className="result-pre">{JSON.stringify(result, null, 2)}</pre>
            <div style={{ marginTop: 18, display: 'flex', gap: 8 }}>
              <button className="btn-primary" onClick={() => { reset(); onClose(); }}>Done</button>
              <button className="btn-ghost" onClick={reset}>Import another</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
