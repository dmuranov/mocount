# mocount — SETUP & DEPLOYMENT

This document is for Claude Code. Read it before generating any code or asking the user about infrastructure. Most decisions are made.

---

## Existing infrastructure (reuse, don't recreate)

The user already runs **TestPilot** on a small Azure VM (West Europe, Ubuntu, IP `51.145.161.85`). mocount will be **co-hosted on the same VM**:

- New PM2 process named `mocount`, listening on **port 3002** (TestPilot is on 3001)
- New Caddy site block for `mocount.com` and `www.mocount.com`, reverse-proxying to `localhost:3002`
- New folder at `/home/azureuser/mocount`
- Caddy auto-issues Let's Encrypt cert on first hit — no manual TLS config

SSH key: `C:\Users\danij\testpilot\Azure key\testpilot-vm_key.pem` (same key as TestPilot — already authorized on the VM).

Do **not** ask the user to provision a new VM. Do **not** generate Azure CLI scripts. Do **not** ask about regions or sizes.

---

## Domain

`mocount.com` — registered at Namecheap by user.

DNS records the user must create at Namecheap → Advanced DNS (one-time, manual; Namecheap has no usable API):

| Type | Host | Value |
|---|---|---|
| A | `@` | `51.145.161.85` |
| A | `www` | `51.145.161.85` |

If the user hasn't done this yet, surface that as a blocker before deployment, not before code.

---

## External services to set up (user-actionable, with order)

mocount needs its own Supabase project and Resend setup. Google OAuth client can be a **new client in the same Google Cloud project as TestPilot**, not a new project.

The user will create these. Do not generate placeholders that need replacement; instead, write `.env.example` with empty values + clear comments, and let the user fill in real ones at deploy time.

### 1. Supabase (new project for mocount)

User actions:
- supabase.com → New project
- Name: `mocount`
- Region: `Europe (Frankfurt)` — closest to West Europe VM
- Strong DB password
- Wait ~2 min for provisioning
- Settings → API → save `Project URL`, `anon public key`, `service_role key`

After project exists, run `db/schema.sql` and `db/seed.sql` against it via Supabase SQL editor or `psql`.

### 2. Google OAuth (new credential in existing TestPilot Google Cloud project)

User actions:
- console.cloud.google.com → switch to existing TestPilot project
- APIs & Services → Credentials → + Create Credentials → OAuth client ID → Web application
- Name: `mocount`
- Authorized JavaScript origins: `https://mocount.com`
- Authorized redirect URIs: `https://mocount.com/auth/callback`
- Save Client ID and Client Secret

OAuth consent screen does **not** need re-verification — same project. But test users (the 5 seed emails) must be added to the consent screen if it's still in "Testing" mode.

### 3. Resend (new domain for mocount.com)

User actions:
- resend.com → API Keys → Create new → save `re_...` key
- Domains → Add `mocount.com` → take the 3 TXT + 1 MX records → add to Namecheap Advanced DNS → wait ~10 min → click Verify

`EMAIL_FROM` will be `mocount@mocount.com` once the domain is verified.

---

## Environment variables

Create `.env.example` in repo root with this exact content. Do not put real values anywhere committed.

```
PORT=3002
NODE_ENV=production
APP_URL=https://mocount.com

# Supabase (new project for mocount)
SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=

# Google OAuth (new client in existing TestPilot GCP project)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=https://mocount.com/auth/callback

# Resend (new domain mocount.com)
RESEND_API_KEY=
EMAIL_FROM=mocount@mocount.com

# Generated locally with: openssl rand -hex 32
SESSION_SECRET=
```

The real `.env` lives only on the VM at `/home/azureuser/mocount/.env`, mode `600`.

---

## Caddy config — what the user must add to the VM

The user's existing Caddyfile already handles TestPilot. Append a new site block for mocount. Do not overwrite anything.

```
mocount.com, www.mocount.com {
    reverse_proxy localhost:3002
    encode gzip
}
```

Reload command: `sudo systemctl reload caddy`. No restart, no downtime for TestPilot.

---

## PM2

App name: `mocount` (TestPilot is `testpilot` — coexists fine).

`ecosystem.config.js` in repo root:

```js
module.exports = {
  apps: [{
    name: 'mocount',
    script: 'server.js',
    cwd: '/home/azureuser/mocount',
    env_file: '.env',
    instances: 1,
    autorestart: true,
    max_memory_restart: '500M',
    error_file: '/home/azureuser/mocount/logs/err.log',
    out_file: '/home/azureuser/mocount/logs/out.log',
    time: true
  }]
};
```

Start once: `pm2 start ecosystem.config.js && pm2 save`.

PM2 startup is already registered on this VM from TestPilot — no need to re-run `pm2 startup`.

---

## Deploy command (matches TestPilot muscle memory)

The user will deploy from Windows PowerShell on their local box. Generate a `deploy.ps1` in repo root:

```powershell
# deploy.ps1 — push local build to VM
$VM_IP = "51.145.161.85"
$KEY   = "C:\Users\danij\testpilot\Azure key\testpilot-vm_key.pem"
$REMOTE = "azureuser@$VM_IP"
$DEST   = "/home/azureuser/mocount"

Write-Host "→ Building web client..." -ForegroundColor Cyan
Push-Location web
npm run build
Pop-Location

Write-Host "→ Uploading to VM..." -ForegroundColor Cyan
# Exclude node_modules, .git, .env, logs
scp -i $KEY -r `
  package.json package-lock.json server.js ecosystem.config.js `
  src/ web/dist/ db/ `
  ${REMOTE}:${DEST}/

Write-Host "→ Restarting on VM..." -ForegroundColor Cyan
ssh -i $KEY $REMOTE "cd $DEST && npm ci --omit=dev && pm2 restart mocount && pm2 save"

Write-Host "✓ Deployed" -ForegroundColor Green
```

The `web/dist/` folder is the built React bundle (Vite output). Express serves it as static at `/` and the API routes at `/api/*`.

---

## First-time VM bootstrap (one-time, when repo first lands on VM)

These steps run **once** on the VM, after the first deploy lands files there:

```bash
ssh -i "C:\Users\danij\testpilot\Azure key\testpilot-vm_key.pem" azureuser@51.145.161.85
cd /home/azureuser/mocount
mkdir -p logs
nano .env                    # paste real values from Supabase/Google/Resend
chmod 600 .env
npm ci --omit=dev
pm2 start ecosystem.config.js
pm2 save

# Add Caddy block (one-time)
sudo nano /etc/caddy/Caddyfile
# (append mocount.com block from this doc)
sudo systemctl reload caddy
```

Then user creates the two A records at Namecheap. Within 5–30 min, `https://mocount.com` is live with HTTPS.

---

## Build order — reminder

Follow `SPEC.md` §14. Each step ends in a working state that can be smoke-tested. Do not skip ahead.

When a step is complete and pushed:
- Local: `git commit` with a short message
- VM: run `./deploy.ps1` from project root
- Test: visit `https://mocount.com` and verify the new behaviour

---

## Important constraints

- **No employer name** in any string, file, repo description, commit message, or log line. mocount is a generic SC volume tracker.
- **All financial mutations** must write `audit_log` rows. No exceptions.
- **No browser storage** in the React app — use server state via `/api/*`. (Not localStorage, not sessionStorage.)
- **Service role key never reaches the browser**. It lives in `.env` server-side only.
- **No employer-IP code reuse**. Build everything from scratch in this repo.

---

## When in doubt

Ask the user. They prefer the **GO pattern**: batch all questions, get answers, then execute. Do not ping for tiny clarifications mid-build.
