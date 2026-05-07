// Auth context — single fetch of /api/me at app boot, shared across
// all routed pages. Avoids every page re-pinging the same endpoint.
//
// Shape exposed:
//   { status: 'loading' | 'anon' | 'ok' | 'err', user, refresh, signOut }

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api } from './api.js';

const AuthCtx = createContext(null);

export function AuthProvider({ children }) {
  const [state, setState] = useState({ status: 'loading' });

  const refresh = useCallback(async () => {
    try {
      const data = await api.get('/api/me');
      setState(data.user ? { status: 'ok', user: data.user } : { status: 'anon' });
    } catch (e) {
      setState({ status: 'err', error: e.message, code: e.status });
    }
  }, []);

  const signOut = useCallback(async () => {
    try { await api.post('/auth/logout'); } catch { /* fall through */ }
    setState({ status: 'anon' });
    window.location.href = '/login';
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  return (
    <AuthCtx.Provider value={{ ...state, refresh, signOut }}>
      {children}
    </AuthCtx.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
