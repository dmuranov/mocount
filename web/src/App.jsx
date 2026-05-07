// Root router + auth guard. AuthProvider does one /api/me on mount,
// then route guards branch on the cached state:
//   loading → splash
//   anon    → redirect to /login (except on /login or /access-denied)
//   ok      → render the matched route inside <Layout>

import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth.jsx';
import Layout from './Layout.jsx';
import Login from './pages/Login.jsx';
import AccessDenied from './pages/AccessDenied.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Numbers from './pages/Numbers.jsx';
import Volumes from './pages/Volumes.jsx';
import Placeholder from './pages/Placeholder.jsx';

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/access-denied" element={<AccessDenied />} />

          <Route element={<RequireAuth><Layout /></RequireAuth>}>
            <Route path="/" element={<Dashboard />} />
            <Route path="/numbers" element={<Numbers />} />
            <Route path="/numbers/:id" element={<Placeholder title="Number detail" step={14} />} />
            <Route path="/volumes" element={<RequireAdmin><Volumes /></RequireAdmin>} />
            <Route path="/history" element={<Placeholder title="History" step={16} />} />
            <Route path="/reports" element={<Placeholder title="Reports" step={17} />} />
            <Route path="/reports/:yyyymm" element={<Placeholder title="Report detail" step={17} />} />
            <Route path="/users" element={<RequireAdmin><Placeholder title="Users" step={13} /></RequireAdmin>} />
            <Route path="/audit" element={<RequireAdmin><Placeholder title="Audit log" step={20} /></RequireAdmin>} />
            <Route path="/settings/slack" element={<RequireAdmin><Placeholder title="Slack settings" step={18} /></RequireAdmin>} />
          </Route>

          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}

function RequireAuth({ children }) {
  const { status, error } = useAuth();
  const loc = useLocation();
  if (status === 'loading') return <Splash />;
  if (status === 'err') return <BootError error={error} />;
  if (status === 'anon') return <Navigate to="/login" replace state={{ from: loc }} />;
  return children;
}

function RequireAdmin({ children }) {
  const { user } = useAuth();
  if (user?.role !== 'admin') return <Navigate to="/" replace />;
  return children;
}

function Splash() {
  return (
    <div className="app-shell">
      <div className="box">
        <h1 className="brand">mo<span>count</span></h1>
        <p className="mono">loading…</p>
      </div>
    </div>
  );
}

function BootError({ error }) {
  return (
    <div className="app-shell">
      <div className="box">
        <h1 className="brand">mo<span>count</span></h1>
        <div className="err-box">Failed to reach the server: {error}</div>
        <p style={{ marginTop: 18 }}><a className="mono" href="/login">→ go to login</a></p>
      </div>
    </div>
  );
}

function NotFound() {
  return (
    <div className="app-shell">
      <div className="box">
        <h1 className="brand">mo<span>count</span></h1>
        <p className="mono">// 404 — no route here</p>
        <p><a className="mono" href="/">← dashboard</a></p>
      </div>
    </div>
  );
}
