# mocount — Build Spec (final)

**Repo:** `mocount`
**Domain:** `mocount.com`
**Stack:** Node 20 + Express + Supabase + Caddy + PM2 + node-cron + Resend + xlsx
**Hosting:** New Azure VM (West Europe), separate from existing infra
**Auth:** Google SSO via Supabase Auth, **admin-managed allowlist only — no self-registration**
**Currency:** USD only, no FX
**Branding:** Generic — no employer name anywhere in code, UI, repo, commits, or logs.

---

## 1. Roles & access control

Two roles only: `admin`, `viewer`.

**Critical rule: there is no signup, no self-registration, no auto-account-creation.**

Login flow:
1. User clicks "Sign in with Google" on `/login`.
2. OAuth callback returns Google identity to the server.
3. Server checks `users` table: row with that email AND `active = true`?
   - **Hit** → session created, user is in.
   - **Miss** → no DB write, no row created, redirect to `/access-denied` with message "Contact your administrator." That's it.
4. On every authenticated request, middleware re-checks `users.active = true`. Deactivating a user logs them out on next request.

The only way an account exists is if an admin created it via the Users page.

### Seed users on first deploy

| Email | Role | Receives monthly email |
|---|---|---|
| danijel.muranovic@idt.net | admin | true |
| laura.hernandez@idt.net | admin | true |
| greg.henderson@gmail.com | viewer | false |
| peter.broes@idt.net | viewer | false |
| chiara.ferraro@idt.net | viewer | false |

Admins manage all users via the Users page: add, edit role, toggle `receives_monthly_email`, deactivate (soft delete).

---

## 2. Data model

### `users`
```
id              uuid pk
email           text unique not null
name            text
role            text check (role in ('admin','viewer'))
receives_monthly_email  boolean default false
active          boolean default true
created_at      timestamptz default now()
created_by      uuid references users(id)
```

### `numbers` (one row per SC/VLN)
```
id                      uuid pk
number                  text unique not null     -- e.g. '26220' or '+34600123456'
type                    text check (type in ('SC','VLN')) not null
country                 text                     -- ISO-3166 alpha-2, uppercase ('ES','IT',...)
client                  text
purchase_price_per_mo   numeric(10,4) not null
selling_price_per_mo    numeric(10,4) not null
active                  boolean default true
created_at              timestamptz default now()
updated_at              timestamptz default now()
updated_by              uuid references users(id)
```

`margin_per_mo` is **derived**, never stored:
`margin = selling_price_per_mo − purchase_price_per_mo`.

### `daily_volumes`
```
id              uuid pk
number_id       uuid references numbers(id) not null
date            date not null
volume          bigint not null check (volume >= 0)
entered_by      uuid references users(id)
entered_at      timestamptz default now()
unique (number_id, date)
```

### `fees`
```
id              uuid pk
number_id       uuid references numbers(id) not null
type            text check (type in ('monthly','setup')) not null
side            text check (side in ('cost','sale')) not null
amount          numeric(10,2) not null    -- USD; 0 means deliberately eaten
effective_from  date not null
effective_to    date                      -- null = ongoing (monthly only)
created_at      timestamptz default now()
created_by      uuid references users(id)
```

Constraints (enforced in service layer):
- `setup` fees ignore `effective_to`. They count only in the calendar month of `effective_from`.
- `monthly` fees count every calendar month from `effective_from` to `effective_to` inclusive (or forever if null).
- At most one **active** fee per (number, type, side) at any moment. Editing creates a new row + closes the previous via `effective_to`.

Three states for any (side, type) cell on the dashboard / detail page:
- **No fee row** = never charged this fee.
- **Amount = 0** = deliberately eaten this fee, audited.
- **Amount > 0** = charging it.

### `monthly_closes`
```
id              uuid pk
month           text unique not null      -- 'YYYY-MM'
status          text check (status in ('pending','approved','sent'))
snapshot        jsonb
prepared_at     timestamptz
approved_at     timestamptz
approved_by     uuid references users(id)
email_sent_at   timestamptz
```

Once `approved`, daily volumes for that month are locked at the service layer.

### `slack_config`
```
id              uuid pk
webhook_url     text
enabled         boolean default false
send_time_utc   text default '06:00'
last_sent_for   date
updated_at      timestamptz
```
Single row, upsert pattern.

### `audit_log`
```
id          uuid pk
user_id     uuid references users(id)
action      text             -- 'fee.create','number.update','volume.upsert','user.create',...
entity      text
entity_id   text
diff        jsonb
at          timestamptz default now()
```

---

## 3. Calculations (single source of truth)

```
revenue_per_number_per_day = volume × margin              (margin = selling − purchase)
cost_per_number_per_day    = volume × purchase_price
sales_per_number_per_day   = volume × selling_price        (for client billing tab)

day_revenue   = sum over all numbers
day_volume    = sum over all numbers
mtd_*         = sum from month_start to yesterday

For a given month M:
  active monthly fees on side S =
      fees where side=S, type='monthly',
            effective_from <= last_day(M)
            AND (effective_to IS NULL OR effective_to >= first_day(M))

  setup fees on side S in M =
      fees where side=S, type='setup', effective_from in M

P&L (our keep):
  CREDIT  = month_revenue                                  (volume × margin)
  DEBIT   = sum of cost-side monthly fees active in M
          + sum of cost-side setup fees in M
  NET     = CREDIT − DEBIT
```

All money stored as USD `numeric`, displayed with 2 decimals (per-MO prices: 4 decimals).

---

## 4. UI

### Login (`/login`)
Google SSO button. After callback: allowlist hit → in. Miss → friendly access-denied page.

### Dashboard (`/`)

Top cards: Yesterday volume, Yesterday revenue, MTD volume, MTD revenue.

Main table — **one row per active number**, columns:

| Number (clickable) | type | country | client | Purchase price | Selling price | Margin (Δ) | Volume (input) |

- Margin computed and shown read-only — sanity check when prices change.
- Volume cell is the per-day input. Date picker at top of page selects which date is being entered (defaults to today, can pick any past date in an open month).
- Save button persists all volume rows to `daily_volumes` (upsert).
- Viewers see same table, no input cells, no save button.

Below table: chart of daily revenue last 30 days, totals row.

### Number Detail (popup / drawer, opens on Number click)

```
┌─ {number} {type} {country} ──────────────────────┐
│  Country: __   Client: ____   Active: ☑   [Save] │
│                                                  │
│  Pricing (per MO, USD)                           │
│   Purchase price: 0.0200                         │
│   Selling price:  0.0300                         │
│   Margin (auto):  0.0100                         │
│                                                  │
│  Cost-side fees (we pay supplier)                │
│   Monthly:  $100   from 2026-01-01    [edit][×]  │
│   Setup:    $500   on   2026-01-15    [edit][×]  │
│   [+ Add cost monthly]  [+ Add cost setup]       │
│                                                  │
│  Sale-side fees (we charge client)               │
│   Monthly:  $0       from 2026-04-01  (eaten)    │
│   Setup:    $750     on   2026-01-15             │
│   [+ Add sale monthly]  [+ Add sale setup]       │
│                                                  │
│  History                                         │
│   2026-04-10  selling price 0.028 → 0.030        │
│   2026-04-01  sale monthly closed (set to 0)     │
│   2026-01-15  setup fees added                   │
└──────────────────────────────────────────────────┘
```

Edit a fee → asks "apply from this month or next month?" before writing `effective_to` on the old row and creating new one.

### Volumes by-date (`/volumes`)
Same as dashboard's volume input but with explicit date picker UI for back-filling. Refuses any date inside an approved month.

### Numbers (`/numbers`)
Full CRUD list. Add new SC/VLN. **Import xlsx** (preview → commit). Export current list to xlsx.

### History (`/history`)

Month picker at top. Defaults to current month (shows MTD up to yesterday). Pick any past month → shows full month.

Layout:

```
┌─ {Month YYYY}    [Volume ▾] [Filter by client ▾] [Filter by country ▾]   [Export xlsx] ┐
│                                                                                          │
│  [▾] SC                                                                                  │
│      ┌──────────┬────┬────┬────┬────┬─── ... ────┬───────┐                              │
│      │ Number   │ 01 │ 02 │ 03 │ 04 │   ...      │ Total │                              │
│      ├──────────┼────┼────┼────┼────┼────────────┼───────┤                              │
│      │ 26220 ES │ 1k │ 2k │ 1k │ 3k │   ...      │  45k  │                              │
│      │ 25232 IT │  - │ 1k │ 2k │ 1k │   ...      │  32k  │                              │
│      │ ...                                                                              │
│      ├──────────┼────┼────┼────┼────┼────────────┼───────┤                              │
│      │ SC total │ 3k │ 5k │ 4k │ 6k │   ...      │ 120k  │                              │
│      └──────────┴────┴────┴────┴────┴────────────┴───────┘                              │
│                                                                                          │
│  [▾] VLN                                                                                 │
│      (same shape)                                                                        │
│                                                                                          │
│  ════════════════════════════════════════════════════════════════════════════════════ │
│  GRAND TOTAL — {month}                                                                   │
│   Volume:   {total volume across SC + VLN}                                               │
│   Revenue:  ${total revenue}                                                             │
│  ════════════════════════════════════════════════════════════════════════════════════ │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

Behaviors:
- SC and VLN sections collapsible with `[▾]` / `[▸]`. Collapsed → only the section subtotal row visible.
- Both collapsed → only subtotals + grand total. Month-at-a-glance.
- Current month → days only up to yesterday (MTD). Past months → all days.
- **Metric toggle** at top: "Volume / Revenue / Both". Cells show selected metric. Both = stacked.
- **Filter by client** dropdown — narrows table to that client's numbers, totals recompute.
- **Filter by country** dropdown — narrows to numbers in selected country, totals recompute. Combinable with client filter.
- Country shown inline next to Number in row labels.
- Empty cells rendered as `-`.
- **Export xlsx** — downloads current view (with current filters applied).
- View state (collapsed sections, metric, filters, month) persisted in URL query params for shareable links.
- All roles can view. Read-only.

### Users (`/users`, admin only)
List active + inactive users. Add new user (email, name, role, receives_monthly_email). Edit any field. Deactivate (soft delete) — deactivated user can't log in but row + audit history preserved.

### Reports (`/reports`)
List of months with status badges (pending / approved / sent). Click → report detail.

### Report detail (`/reports/{yyyymm}`)
Renders all four tabs (see §5). Admin-only **Approve & Send** button when status is `pending`. Re-send option after sent. Export full xlsx button.

### Slack settings (`/settings/slack`, admin)
Webhook URL, enabled toggle, send time, **Test now** button.

### Audit log (`/audit`, admin)
Filter by entity, user, date range.

---

## 5. Monthly report — four tabs

All four rendered in the web view AND exported as a single xlsx attachment to the monthly email (one sheet per tab).

### Tab 1 — Summary / P&L (our keep)

```
CREDIT
  Total revenue (volume × margin)         $XX,XXX.XX

DEBIT (cost-side)
  Cost monthly — {Number}                    $XXX.XX
  Cost monthly — {Number}                    $XXX.XX
  Cost setup — {Number}                      $XXX.XX
  ...
  Total cost fees                          $X,XXX.XX

NET                                       $XX,XXX.XX
```

Plus headline: total volume, total revenue, total cost fees, net.

### Tab 2 — Per SC/VLN

| Number | type | country | client | volume | margin | revenue |

Bottom: totals.

### Tab 3 — Costs (what we pay supplier)

| Number | type | country | client | volume | purchase price | cost (vol×price) | monthly fee | setup fee | total cost |

Bottom: totals.

### Tab 4 — Client billing (what client pays us)

Grouped by client, with subtotals per client.

| Number | country | volume | selling price | sales (vol×selling) | monthly fee | setup fee | total |

Bottom: grand totals across all clients.

---

## 6. Daily Slack post — `0 6 * * *` UTC

```
📊 mocount — {yesterday}
Volume: 1,234,567 MO
Revenue: $12,345.00

📅 MTD ({month_start} → {yesterday})
Volume: 23,456,789 MO
Revenue: $234,567.00
```

Idempotent: skip if `slack_config.last_sent_for >= yesterday`. Retry up to 3 times on failure.

---

## 7. Monthly email — approval flow

**Day 1, 06:00 UTC** — `monthly_closes` row created with status `pending` and full report snapshot. System emails admins only: "Monthly report for {month} is ready for review at /reports/{yyyymm}."

**Admin reviews + clicks Approve & Send** in UI → status `approved` → email queued and sent to all users with `receives_monthly_email = true` → status `sent`.

Subject: `mocount — {Month YYYY} Report`

HTML body: Summary + P&L inline, with rendered tables for the four tabs (compact). Full detail in attached xlsx.

Sent via Resend.

---

## 8. Excel imports

### Initial numbers import

Columns (header row, case-insensitive, order-flexible):

| Number | type | country | client | purchase_price | selling_price | cost_monthly_fee | cost_monthly_from | cost_setup_fee | cost_setup_date | sale_monthly_fee | sale_monthly_from | sale_setup_fee | sale_setup_date | active |

Rules:
- `Number` is the unique key — match on it. New row → insert. Existing → update prices/country/client/active and (separately) handle fees.
- `type`: SC or VLN, case-insensitive.
- `country`: ISO-3166 alpha-2 code (e.g. `ES`, `IT`, `DE`, `UK`, `US`). Case-insensitive, normalized to uppercase. Empty allowed.
- Empty fee + empty date cells → no fee created on that side.
- Fee value present + date present → fee row created with `side='cost'` or `'sale'` accordingly.
- Fee value present + date empty → importer flags as error in dryRun preview.
- **Historical setup fees already paid:** put the actual past date (e.g. `2024-06-15`). Fee row is created with that `effective_from`; since setup fees only count in their `effective_from` month, it won't appear in any current/future report — but the audit trail is preserved.
- **Monthly fee `*_from` dates:** any date works; the fee bills every month from that date onward. For ongoing fees that started long ago, just use a past date.
- Date formats accepted: `YYYY-MM-DD`, `DD/MM/YYYY`, `DD.MM.YYYY`, Excel native date serial. Anything else → row error.
- `active`: true/false/1/0/yes/no.

Two-step import:
1. POST `/api/numbers/import?dryRun=true` → returns `{toCreate, toUpdate, feesToCreate, errors}`. UI shows preview.
2. Admin clicks **Confirm** → POST `dryRun=false` → commits.

### Daily volumes import (recurring)

Format TBD — Dado will share sample. Importer designed column-config-driven so we adapt without rewriting.

Skeleton expected: `Number, date, volume`.

Behaviour:
- Upsert on (number, date).
- Reject any row whose date falls in an approved month → returned as errors in dryRun.
- Same two-step preview-then-commit pattern.

---

## 9. Endpoints (Express, all under `/api`)

All require valid Supabase session. Role gates: `requireAdmin` vs `requireAuth`.

```
Auth
  GET  /auth/google
  GET  /auth/callback                         (allowlist check, no auto-create)
  POST /auth/logout
  GET  /api/me

Users (admin)
  GET    /api/users
  POST   /api/users                           (only way to create a user)
  PATCH  /api/users/:id
  DELETE /api/users/:id                       (soft delete, sets active=false)

Numbers
  GET    /api/numbers                         (auth)
  POST   /api/numbers                         (admin)
  PATCH  /api/numbers/:id                     (admin)
  DELETE /api/numbers/:id                     (admin, soft)
  POST   /api/numbers/import                  (admin, multipart, dryRun)

Volumes
  GET   /api/volumes?from=&to=&number_id=     (auth)
  POST  /api/volumes                          (admin) body: [{number_id,date,volume}]
  POST  /api/volumes/import                   (admin, multipart, dryRun)

Fees
  GET    /api/numbers/:id/fees                (auth)
  POST   /api/numbers/:id/fees                (admin)
  PATCH  /api/fees/:id                        (admin)
  DELETE /api/fees/:id                        (admin)

History
  GET /api/history/:yyyymm?client=&country=   (auth)
      → returns { sc: [{number, country, days:{1:vol,2:vol,...}, total}],
                  vln: [...],
                  totals: { sc:{volume,revenue}, vln:{...}, grand:{...} } }

Reports
  GET  /api/reports/today                              (auth)
  GET  /api/reports/month/:yyyymm                      (auth)
  GET  /api/reports/month/:yyyymm/export               (auth, xlsx)
  POST /api/reports/month/:yyyymm/approve              (admin)
  POST /api/reports/month/:yyyymm/reopen               (admin, logged)

Slack
  GET   /api/slack                            (admin)
  PUT   /api/slack                            (admin)
  POST  /api/slack/test                       (admin)

Audit
  GET /api/audit?entity=&from=&to=            (admin)
```

---

## 10. File structure

```
mocount/
├── package.json
├── server.js
├── .env.example
├── README.md
├── caddy/Caddyfile.example
├── ecosystem.config.js
├── db/
│   ├── schema.sql
│   ├── seed.sql
│   └── migrations/
├── src/
│   ├── config.js
│   ├── supabase.js
│   ├── auth/
│   │   ├── google.js
│   │   ├── allowlist.js                # checks email against users.active=true, NEVER inserts
│   │   └── middleware.js               # requireAuth, requireAdmin
│   ├── routes/
│   │   ├── auth.js
│   │   ├── users.js
│   │   ├── numbers.js
│   │   ├── volumes.js
│   │   ├── fees.js
│   │   ├── history.js
│   │   ├── reports.js
│   │   ├── slack.js
│   │   └── audit.js
│   ├── services/
│   │   ├── calc.js
│   │   ├── reports.js
│   │   ├── history.js                  # buildHistoryMatrix(yyyymm, client?, country?)
│   │   ├── slack.js
│   │   ├── email.js
│   │   ├── xlsx_import.js
│   │   └── xlsx_export.js
│   ├── jobs/
│   │   ├── daily_slack.js
│   │   ├── monthly_prep.js
│   │   └── scheduler.js
│   └── util/
│       ├── audit.js
│       └── dates.js
└── web/
    ├── index.html
    ├── src/
    │   ├── App.jsx
    │   ├── api.js
    │   ├── pages/
    │   │   ├── Login.jsx
    │   │   ├── AccessDenied.jsx
    │   │   ├── Dashboard.jsx
    │   │   ├── Volumes.jsx
    │   │   ├── Numbers.jsx
    │   │   ├── NumberDetail.jsx
    │   │   ├── History.jsx
    │   │   ├── Users.jsx
    │   │   ├── Reports.jsx
    │   │   ├── ReportDetail.jsx
    │   │   ├── SlackSettings.jsx
    │   │   └── Audit.jsx
    │   └── components/
    └── vite.config.js
```

---

## 11. Environment variables

```
PORT=3000
NODE_ENV=production
APP_URL=https://mocount.com

SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=

GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=https://mocount.com/auth/callback

RESEND_API_KEY=
EMAIL_FROM=mocount@mocount.com

SESSION_SECRET=
```

Slack webhook lives in DB (admin-editable), not in env.

---

## 12. Security

- All API routes behind auth middleware. Role gate explicit per route.
- **No public signup endpoint exists.** OAuth callback only verifies, never inserts into `users`.
- Allowlist enforced server-side on every request (re-check `users.active=true`). Deactivation logs out on next request.
- Service role key never sent to browser.
- All financial mutations (price changes, fee CRUD, volume edits, approvals) write to `audit_log`.
- User mutations (create/update/deactivate) also written to `audit_log`.
- Approved months: writes refused at DB layer (trigger) AND service layer.
- Rate limit on `/auth/*` and import endpoints.
- HTTPS only via Caddy auto-TLS.
- No employer name in any string, file, repo description, commit message, or log line.

---

## 13. Deployment

**VM:** new Azure West Europe, B1s or B2s, Ubuntu 24.04.
**DNS:** mocount.com A record → VM IP.
**Caddy:** auto-TLS, reverse proxy to `localhost:3000`.
**PM2:** `pm2 start ecosystem.config.js && pm2 save && pm2 startup`.

Deploy pattern (matches TestPilot muscle memory):

```powershell
scp -i "C:\Users\danij\mocount\mocount-vm_key.pem" -r ./* azureuser@<IP>:/home/azureuser/mocount
ssh -i "..." azureuser@<IP> "cd /home/azureuser/mocount && npm ci && npm run build && pm2 restart mocount"
```

---

## 14. Build order — paste one block at a time into Claude Code

1. Repo init, package.json, server.js bootstrap, .env.example, README
2. db/schema.sql + seed.sql, run on Supabase, verify
3. Auth: Google SSO + allowlist (no auto-create) + middleware + /api/me + AccessDenied page
4. Users CRUD endpoints + Users page (admin)
5. Numbers CRUD endpoints
6. Numbers xlsx import (preview + commit, including fees)
7. Fees CRUD endpoints + service-layer single-active rule + audit
8. Volumes CRUD + xlsx import + closed-month guard
9. calc.js (margin, cost, active-fee resolution) + unit tests
10. history service: buildHistoryMatrix(yyyymm, client?, country?) + endpoint
11. reports service: buildMonthReport(yyyymm) returning 4 tabs
12. Reports endpoints + xlsx export
13. React shell + Login + Dashboard with table + volume input
14. NumberDetail drawer (pricing + 4 fee buckets + history of changes)
15. Numbers page + import UI + Volumes page
16. History page (collapsible SC/VLN, metric toggle, client + country filters, export)
17. Reports page + ReportDetail with 4 tabs
18. Slack config + postDaily service + daily cron + test button
19. Monthly prep cron + approval flow + Resend monthly email + xlsx attachment
20. Audit log + /audit page
21. VM provision + Caddy + PM2 + DNS + first deploy
22. Smoke test all flows
23. Import real numbers Excel, go live

---

## 15. Open items waiting on Dado

- **Numbers Excel** — sample file with real columns to confirm header names match exactly
- **Daily volume Excel** — format to be shared when you have it
- **Logo** — plain "mocount" wordmark for now, you can drop in an SVG later
