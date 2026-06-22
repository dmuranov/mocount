// Tiny fetch wrapper. Backends throws { ok:false, error } on errors;
// we surface that as a thrown Error with the server's message so
// callers can `try/catch` and show it directly.

async function request(method, path, body) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (body !== undefined && !(body instanceof FormData)) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  } else if (body instanceof FormData) {
    opts.body = body;
  }
  const res = await fetch(path, opts);
  let data = null;
  try { data = await res.json(); } catch { /* empty body is fine */ }
  if (!res.ok || (data && data.ok === false)) {
    const msg = (data && data.error) || res.statusText || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.data = data;
    // Session expired / not authenticated: send the user to /login
    // (unless they're already on /login or /access-denied, to avoid a loop).
    if (data?.code === 'AUTH_REQUIRED') {
      const here = window.location.pathname;
      if (here !== '/login' && here !== '/access-denied') {
        window.location.href = '/login';
      }
    }
    throw err;
  }
  return data;
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body) => request('POST', path, body),
  patch: (path, body) => request('PATCH', path, body),
  del: (path) => request('DELETE', path),
};
