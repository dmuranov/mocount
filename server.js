// mocount — Express bootstrap.
// Step 3 wires Google SSO + allowlist + middleware + /api/me + the
// /access-denied page. The React shell that consumes /api/me lands in
// step 13; until then `/` is a static placeholder so the smoke test
// works.

import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import { CONFIG, requireAuthEnv } from './src/config.js';
import { authRouter } from './src/routes/auth.js';
import { usersRouter } from './src/routes/users.js';
import { numbersRouter } from './src/routes/numbers.js';
import { feesRouter } from './src/routes/fees.js';
import { volumesRouter } from './src/routes/volumes.js';
import { loadUser } from './src/auth/middleware.js';

requireAuthEnv();

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(cookieParser());

// Auth: /auth/google, /auth/callback, /auth/logout, /api/me
app.use(authRouter);
// Users CRUD (admin) + Users page
app.use(usersRouter);
// Numbers CRUD (auth read, admin write); UI lands in step 15
app.use(numbersRouter);
// Fees CRUD (auth read, admin write); UI lands in step 14 (NumberDetail)
app.use(feesRouter);
// Volumes CRUD (auth read, admin write); xlsx import lands in step 8b
app.use(volumesRouter);

// Health endpoint — pm2/Caddy/uptime monitors hit this.
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'mocount',
    version: process.env.npm_package_version || '0.0.0',
    uptime_s: Math.round(process.uptime()),
  });
});

// ── Public pages ─────────────────────────────────────────────
// These are inline HTML for now. The React shell (step 13) will
// take over with routed components; until then, raw HTML is the
// least-surprising way to wire up the auth flow.

app.get('/login', (_req, res) => {
  res.type('html').send(loginHtml());
});

app.get('/access-denied', (_req, res) => {
  res.type('html').send(accessDeniedHtml());
});

// Landing — show signed-in state if we can resolve the user, else
// route to /login. The full dashboard arrives in step 13.
app.get('/', loadUser, (req, res) => {
  if (!req.user) return res.redirect('/login');
  res.type('html').send(dashboardPlaceholder(req.user));
});

// Users admin page — vanilla HTML now, React Users.jsx replaces it in step 13.
app.get('/users', loadUser, (req, res) => {
  if (!req.user) return res.redirect('/login');
  if (req.user.role !== 'admin') return res.redirect('/');
  res.type('html').send(usersPageHtml(req.user));
});

app.listen(CONFIG.PORT, () => {
  console.log(`mocount listening on ${CONFIG.APP_URL} (port ${CONFIG.PORT})`);
});

// ── Inline HTML helpers ──────────────────────────────────────

function shell(title, inner) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title>
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  body{background:#0b0b0b;color:#e6e6e6;font-family:system-ui,-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
  .box{text-align:center;padding:32px;max-width:420px;width:90%}
  h1{font-size:22px;font-weight:700;letter-spacing:.5px;margin:0 0 6px}
  h1 span{color:#7cd44a}
  p{font-size:13px;color:#9a9a9a;margin:8px 0}
  p.mono{font-family:'SF Mono',Monaco,monospace;font-size:12px;color:#666}
  a.btn{display:inline-flex;align-items:center;gap:10px;background:#fff;color:#1a1a1a;padding:12px 20px;border-radius:6px;font-weight:600;font-size:14px;text-decoration:none;margin-top:18px}
  a.btn:hover{background:#f0f0f0}
  a.btn svg{width:18px;height:18px}
  .err-box{background:#2a0e0e;border:1px solid #c0392b;color:#ffb3b3;padding:14px 16px;border-radius:6px;margin-top:16px;font-size:13px}
  a.link{color:#7cd44a;font-size:12px;text-decoration:none}
  a.link:hover{text-decoration:underline}
</style></head><body><div class="box">${inner}</div></body></html>`;
}

function loginHtml() {
  const googleSvg = `<svg viewBox="0 0 48 48"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3c-1.6 4.7-6 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 16 19 13 24 13c3.1 0 5.8 1.2 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.6 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2c-2 1.4-4.5 2.4-7.2 2.4-5.3 0-9.7-3.4-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.3 4.3-4.1 5.6l6.2 5.2c-.4.4 6.6-4.8 6.6-14.8 0-1.3-.1-2.4-.4-3.5z"/></svg>`;
  return shell('mocount — sign in', `
    <h1>mo<span>count</span></h1>
    <p class="mono">// sign in to continue</p>
    <a class="btn" href="/auth/google">${googleSvg}<span>Sign in with Google</span></a>
    <p style="margin-top:24px">Access by invitation only. If your email isn't on the allowlist, contact your administrator.</p>
  `);
}

function accessDeniedHtml() {
  return shell('mocount — access denied', `
    <h1>mo<span>count</span></h1>
    <div class="err-box">Your Google account isn't on the allowlist for mocount.</div>
    <p>Contact your administrator to be added.</p>
    <p style="margin-top:24px"><a class="link" href="/login">← back to sign in</a></p>
  `);
}

function dashboardPlaceholder(user) {
  const role = user.role === 'admin' ? 'admin' : 'viewer';
  const usersLink = user.role === 'admin' ? `<p style="margin-top:14px"><a class="link" href="/users">Manage users →</a></p>` : '';
  return shell('mocount', `
    <h1>mo<span>count</span></h1>
    <p class="mono">// signed in as ${escapeHtml(user.email)} (${role})</p>
    <p>Dashboard arrives in step 13.</p>
    ${usersLink}
    <form method="post" action="/auth/logout" onsubmit="return doLogout(event)">
      <button type="submit" style="background:transparent;color:#9a9a9a;border:1px solid #333;border-radius:4px;padding:8px 14px;font-family:inherit;font-size:12px;cursor:pointer;margin-top:18px">Sign out</button>
    </form>
    <script>
      async function doLogout(e) {
        e.preventDefault();
        await fetch('/auth/logout', { method: 'POST' });
        window.location.href = '/login';
        return false;
      }
    </script>
  `);
}

// Vanilla-HTML Users admin page. Lists all users + lets admin add /
// edit / deactivate / reactivate. Replaced by React Users.jsx in step 13.
function usersPageHtml(currentUser) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>mocount — users</title>
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  body{background:#0b0b0b;color:#e6e6e6;font-family:system-ui,-apple-system,sans-serif;margin:0;padding:24px}
  .wrap{max-width:980px;margin:0 auto}
  header{display:flex;align-items:center;justify-content:space-between;margin-bottom:24px}
  h1{font-size:18px;font-weight:700;margin:0}
  h1 span{color:#7cd44a}
  .me{font-family:'SF Mono',Monaco,monospace;font-size:11px;color:#888}
  a.back{color:#7cd44a;text-decoration:none;font-size:12px;margin-right:14px}
  table{width:100%;border-collapse:collapse;margin-top:12px}
  th,td{text-align:left;padding:10px 8px;border-bottom:1px solid #1f1f1f;font-size:13px;vertical-align:middle}
  th{font-size:11px;color:#888;font-weight:600;text-transform:uppercase;letter-spacing:.5px}
  tr.inactive td{color:#555}
  tr.inactive td:first-child::after{content:" (inactive)";color:#666;font-size:11px}
  input,select{background:#0b0b0b;color:#e6e6e6;border:1px solid #333;border-radius:3px;padding:6px 8px;font-family:inherit;font-size:13px}
  input:focus,select:focus{border-color:#7cd44a;outline:none}
  button{background:#7cd44a;color:#0b0b0b;border:none;border-radius:3px;padding:7px 14px;font-weight:600;font-size:12px;cursor:pointer;font-family:inherit}
  button:hover{opacity:.9}
  button.ghost{background:transparent;color:#9a9a9a;border:1px solid #333}
  button.ghost:hover{color:#fff;border-color:#666}
  button.danger{background:#c0392b;color:#fff}
  button.danger:hover{opacity:.9}
  .new-row{background:#101010;padding:14px;border:1px solid #222;border-radius:4px;margin-top:18px;display:grid;grid-template-columns:1.5fr 1fr 1fr 1fr auto;gap:8px;align-items:center}
  .err{background:#2a0e0e;border:1px solid #c0392b;color:#ffb3b3;padding:10px 12px;border-radius:3px;margin-top:14px;font-size:13px;display:none}
  .err.show{display:block}
  label.tick{display:flex;align-items:center;gap:6px;font-size:12px;color:#9a9a9a}
</style></head><body><div class="wrap">

<header>
  <h1>mo<span>count</span> — users</h1>
  <div><a class="back" href="/">← dashboard</a> <span class="me">${escapeHtml(currentUser.email)}</span></div>
</header>

<div id="err" class="err"></div>

<table id="users-table">
  <thead><tr>
    <th>Email</th><th>Name</th><th>Role</th><th>Monthly email</th><th>Active</th><th></th>
  </tr></thead>
  <tbody id="users-body"><tr><td colspan="6" style="color:#666">Loading…</td></tr></tbody>
</table>

<div class="new-row">
  <input id="n-email" type="email" placeholder="newuser@email.com" />
  <input id="n-name" type="text" placeholder="Name (optional)" />
  <select id="n-role"><option value="viewer">viewer</option><option value="admin">admin</option></select>
  <label class="tick"><input id="n-monthly" type="checkbox" checked /> monthly email</label>
  <button id="add-btn">Add user</button>
</div>

<script>
const ME = ${JSON.stringify({ id: currentUser.id, email: currentUser.email })};
const $err = document.getElementById('err');
function showErr(msg) { $err.textContent = msg; $err.classList.add('show'); setTimeout(() => $err.classList.remove('show'), 4000); }
function clearErr() { $err.classList.remove('show'); }

async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.error || res.statusText);
  return data;
}

function row(u) {
  const isMe = u.id === ME.id;
  const tr = document.createElement('tr');
  if (!u.active) tr.classList.add('inactive');
  tr.dataset.id = u.id;
  tr.innerHTML = \`
    <td>\${escapeHtml(u.email)}\${isMe ? ' <span style="color:#7cd44a;font-size:10px">YOU</span>' : ''}</td>
    <td><input class="f-name" type="text" value="\${escapeHtml(u.name || '')}" \${isMe ? '' : ''} /></td>
    <td>
      <select class="f-role" \${isMe ? 'disabled' : ''}>
        <option value="viewer" \${u.role === 'viewer' ? 'selected' : ''}>viewer</option>
        <option value="admin" \${u.role === 'admin' ? 'selected' : ''}>admin</option>
      </select>
    </td>
    <td><label class="tick"><input class="f-monthly" type="checkbox" \${u.receives_monthly_email ? 'checked' : ''} /></label></td>
    <td>\${u.active ? '✓' : '✗'}</td>
    <td style="white-space:nowrap">
      <button class="ghost btn-save">Save</button>
      \${u.active ? \`<button class="danger btn-deact" \${isMe ? 'disabled' : ''}>Deactivate</button>\`
                  : \`<button class="ghost btn-react">Reactivate</button>\`}
    </td>
  \`;
  tr.querySelector('.btn-save').onclick = () => save(u.id, tr);
  if (u.active && !isMe) tr.querySelector('.btn-deact').onclick = () => deactivate(u.id);
  if (!u.active) tr.querySelector('.btn-react').onclick = () => reactivate(u.id);
  return tr;
}

async function load() {
  try {
    const { users } = await api('GET', '/api/users');
    const body = document.getElementById('users-body');
    body.innerHTML = '';
    for (const u of users) body.appendChild(row(u));
  } catch (e) { showErr(e.message); }
}

async function save(id, tr) {
  try {
    clearErr();
    const patch = {
      name: tr.querySelector('.f-name').value.trim(),
      role: tr.querySelector('.f-role').value,
      receives_monthly_email: tr.querySelector('.f-monthly').checked,
    };
    await api('PATCH', '/api/users/' + id, patch);
    await load();
  } catch (e) { showErr(e.message); }
}

async function deactivate(id) {
  if (!confirm('Deactivate this user? They will be signed out immediately.')) return;
  try { clearErr(); await api('DELETE', '/api/users/' + id); await load(); }
  catch (e) { showErr(e.message); }
}

async function reactivate(id) {
  try { clearErr(); await api('PATCH', '/api/users/' + id, { active: true }); await load(); }
  catch (e) { showErr(e.message); }
}

document.getElementById('add-btn').onclick = async () => {
  try {
    clearErr();
    const body = {
      email: document.getElementById('n-email').value.trim().toLowerCase(),
      name: document.getElementById('n-name').value.trim(),
      role: document.getElementById('n-role').value,
      receives_monthly_email: document.getElementById('n-monthly').checked,
    };
    await api('POST', '/api/users', body);
    document.getElementById('n-email').value = '';
    document.getElementById('n-name').value = '';
    await load();
  } catch (e) { showErr(e.message); }
};

function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }

load();
</script>
</div></body></html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
