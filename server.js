// mocount — Express bootstrap.
// Step 1 only ships the foundation: env loading, health check, listen on PORT.
// Auth, routes, and services land in subsequent build steps (SPEC §14).

import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';

const PORT = Number(process.env.PORT) || 3002;
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(cookieParser());

// Bare landing for the smoke test before the React shell is wired up
// (build step 13). Returns a tiny HTML so a browser hit at the domain shows
// "alive", not a blank tab.
app.get('/', (_req, res) => {
  res.type('html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>mocount</title>
<style>body{background:#0b0b0b;color:#e6e6e6;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.box{text-align:center;padding:32px}
h1{font-size:22px;font-weight:700;letter-spacing:.5px;margin:0 0 6px}
p{font-size:12px;color:#888;font-family:monospace;margin:0}</style></head>
<body><div class="box"><h1>mocount</h1><p>// online — UI lands in step 13</p></div></body></html>`);
});

// Health endpoint — pm2/Caddy/uptime monitors hit this.
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'mocount',
    version: process.env.npm_package_version || '0.0.0',
    uptime_s: Math.round(process.uptime()),
  });
});

app.listen(PORT, () => {
  console.log(`mocount listening on ${APP_URL} (port ${PORT})`);
});
