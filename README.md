# mocount

SC/LVN message-volume + cost tracker. Daily volumes in, monthly P&L out.

## Stack

Node 20 · Express · Supabase · Caddy · PM2 · node-cron · Resend · xlsx · React+Vite (web/)

## Local dev

```bash
npm ci
cp .env.example .env       # fill in real values
npm run dev
# → http://localhost:3002
```

## Build status

Following SPEC §14 incrementally. Current: **Step 1 — bootstrap.**

Each step ends in a smoke-testable working state. See `SPEC.md` and `SETUP.md` (in repo root after first commit) for canonical references.

## Deploy

`./deploy.ps1` from repo root pushes to the production VM and restarts pm2. See `SETUP.md` for the one-time bootstrap.

## Notes

- All money in USD. Per-MO prices stored as `numeric(10,4)`.
- Auth is admin-managed allowlist only — no self-registration. OAuth callback verifies, never inserts.
- All financial mutations write to `audit_log`.
- HTTPS only via Caddy auto-TLS.
