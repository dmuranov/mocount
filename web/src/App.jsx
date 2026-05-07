// Step 13a: minimal React shell. Login + Dashboard + Users land in
// 13b/c. For now we just confirm the bundle is wired and the auth
// session is reachable via /api/me.

import { useEffect, useState } from 'react';
import { api } from './api.js';

export default function App() {
  const [me, setMe] = useState({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    api.get('/api/me')
      .then((data) => {
        if (cancelled) return;
        // /api/me always returns 200 with `{ user }`; user can be null
        // when there's no valid session.
        setMe(data.user ? { status: 'ok', user: data.user } : { status: 'anon' });
      })
      .catch((e) => { if (!cancelled) setMe({ status: 'err', error: e.message, code: e.status }); });
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="app-shell">
      <div className="box">
        <h1 className="brand">mo<span>count</span></h1>
        <p className="mono">// React shell scaffolded — step 13a</p>
        <Status state={me} />
      </div>
    </div>
  );
}

function Status({ state }) {
  if (state.status === 'loading') return <p className="mono">loading…</p>;
  if (state.status === 'anon') {
    return (
      <div>
        <p className="mono">// not signed in</p>
        <a className="mono" href="/auth/google">→ sign in with Google</a>
      </div>
    );
  }
  if (state.status === 'err') {
    return <p className="mono" style={{ color: '#ffb3b3' }}>// /api/me failed: {state.error}</p>;
  }
  return (
    <p className="mono">// signed in as {state.user.email} ({state.user.role})</p>
  );
}
