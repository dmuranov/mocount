// Authenticated app chrome: brand + nav + signed-in identity + sign
// out. Used by every route except /login and /access-denied.
//
// Admin-only nav items are hidden for viewers (server still gates).

import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from './auth.jsx';

const NAV = [
  { to: '/',         label: 'Dashboard', adminOnly: false },
  { to: '/numbers',  label: 'Numbers',   adminOnly: false },
  { to: '/volumes',  label: 'Volumes',   adminOnly: true },
  { to: '/history',  label: 'History',   adminOnly: false },
  { to: '/reports',  label: 'Reports',   adminOnly: false },
  { to: '/users',    label: 'Users',     adminOnly: true },
  { to: '/audit',    label: 'Audit',     adminOnly: true },
];

export default function Layout() {
  const { user, signOut } = useAuth();
  const isAdmin = user?.role === 'admin';

  return (
    <div className="layout">
      <header className="hdr">
        <div className="hdr-left">
          <span className="brand">mo<span>count</span></span>
          <nav className="nav">
            {NAV.filter((i) => !i.adminOnly || isAdmin).map((i) => (
              <NavLink
                key={i.to}
                to={i.to}
                end={i.to === '/'}
                className={({ isActive }) => 'nav-link' + (isActive ? ' active' : '')}
              >
                {i.label}
              </NavLink>
            ))}
          </nav>
        </div>
        <div className="hdr-right">
          <span className="me mono">{user?.email}{isAdmin ? ' · admin' : ''}</span>
          <button className="btn-ghost" onClick={signOut}>Sign out</button>
        </div>
      </header>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}
