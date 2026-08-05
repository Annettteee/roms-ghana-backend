# ROMS Ghana — Backend + App + Marketing Site

A real, tested, multi-tenant backend for the ROMS Ghana restaurant operations
platform, plus the two frontends that talk to it:

- `public/index.html` — the marketing/landing page
- `public/app.html` — the product: login/signup + dashboard, inventory, dish
  costing, waste tracker, suppliers, invoices, customers, staff, reports, settings
- everything else — the Node/Express API and SQLite database

Every business that signs up gets its own private, empty workspace. No demo
data is ever inserted anywhere. This was tested directly (not just written):
two businesses were registered, data added to one, and confirmed the other's
tables came back completely empty (`[]`).

---

## 1. Run it locally

Requires Node.js 18+.

```bash
cd roms-backend
npm install
cp .env.example .env
# open .env and set JWT_SECRET to a long random string, e.g.:
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
npm start
```

Open:
- **http://localhost:4000/** — marketing site
- **http://localhost:4000/app.html** — the app

Delete `db/roms.sqlite` any time to wipe everything and start fresh.

---

## 1a. Will customer accounts still work after I update the code?

**Yes, as long as you keep the same `db/roms.sqlite` file.** Everything —
every business, login, dish, invoice — lives in that one file. Updating the
code (pulling new changes, redeploying) never touches it unless you
explicitly delete it. On Render/Railway with the persistent disk set up per
section 3 below, this is automatic: one server, one database, running
continuously, completely unaffected by how many times you push new code.

**What trips people up while testing locally:** every zip of this project you
download is a fresh folder, and it deliberately does **not** include a
database file inside it — you never want to ship a test database. So each
time you unzip a new version into a new folder, that folder starts with an
empty database, and any account you created in a previous version's folder
simply isn't there — it's not lost, it's just in the *other* folder's
`db/roms.sqlite`. If you want to carry test accounts forward between local
zips, copy your old `db/roms.sqlite` file into the new folder's `db/`
directory before running `npm start`.

**Schema migrations are handled automatically.** Early in building this, a
real gap got caught: if you kept using the same database file while the code
changed to add new columns (like `branch_id` when multi-branch support was
added), the app would crash the first time it tried to use a column that
didn't exist yet in an older database. This is now fixed — `db/schema.js`
checks every table's actual columns against what the code expects on every
startup, and adds anything missing with a safe default. Tested directly: took
a database built from an earlier version of this project with a real
registered account in it, ran the current code against it, confirmed the
account survived untouched and the previously-crashing operation now works.

---

## 2. How the security works

**Sessions are httpOnly cookies, not JavaScript-visible tokens.**
On login/register, the server sets a cookie (`roms_session`) that:
- `httpOnly` — no JavaScript on the page, including any injected via XSS, can read it
- `sameSite: strict` — never sent on a request originating from another site, which is the main defense against CSRF for this app
- `secure` in production — only ever sent over HTTPS

The frontend never stores or handles the session token directly — every `fetch`
call just sends `credentials: 'include'` and the browser attaches the cookie
automatically. This was tested with `curl` using only a cookie jar and no
`Authorization` header at all, confirmed working, then confirmed a call after
logout correctly returns "Not logged in."

**Per-business data isolation.** Every table has a `business_id` column. Every
route filters by `req.businessId`, which is decoded from the verified cookie —
never trusted from anything the client sends in the request body or query string.

**Password rules.** Minimum 8 characters, must include both a letter and a
number, hashed with bcrypt at 12 salt rounds (up from the library default of 10).

**Optional two-factor authentication (2FA).** Any user can turn this on for
their own login under **Settings → Two-factor authentication**: scan a QR code
with Google Authenticator/Authy, confirm one code, and from then on that login
needs a 6-digit code as well as the password. Tested end-to-end, including a
wrong code being rejected. It's opt-in, not forced on signup — see "Should you
require 2FA?" below for why.

**Invite-gated signup.** Set `PILOT_INVITE_CODE` in `.env` and new business
signups require that code — recommended while you're hand-picking pilot
clients rather than running open public signup. Tested: no code, wrong code,
and correct code (case-insensitive) all behave correctly. Remove the setting
to open signups to anyone.

**Signup notifications.** Set `NOTIFY_WEBHOOK_URL` to a Discord or Slack
incoming webhook URL and you (and Adaiah) get an instant message every time a
new business signs up — no email service or API keys required, just a URL.

**A private admin dashboard for you and Adaiah.** `GET /api/admin/businesses`
(protected by a separate `ADMIN_KEY`, nothing to do with customer logins)
lists every business that's signed up, when, who the owner is, and how much
they're actually using the product — inventory items, dishes costed, invoices
created, customers logged. It deliberately shows *counts*, not the actual
private contents of anyone's invoices or customer lists — enough to see who's
active and who might need a check-in call, without reading a business's
financial data without their knowledge.

To check it: `curl -H "X-Admin-Key: your-admin-key" https://your-app.onrender.com/api/admin/businesses`
(or open that URL in a REST client / browser extension that lets you set a
custom header — plain browser address bars can't send custom headers).

**Rate limiting.** `/api/auth/login`, `/register`, and `/invite` allow 10
attempts per 15 minutes per IP — tested directly: attempt #9 onward returns
`429 Too Many Requests`. A separate, looser limit (120 requests/minute) applies
to the whole API so no single client can degrade service for everyone else.

**Security headers.** `helmet` sets `X-Content-Type-Options`,
`X-Frame-Options`, `Strict-Transport-Security`, and related headers by default.

**Error handling.** A catch-all error handler returns a generic message instead
of leaking stack traces or internal details to the client.

### Should you require 2FA on every signup?

Short answer: **not for your restaurant-owner customers, yes for your own
(and Adaiah's) accounts.**

- For pilot restaurant owners, many of whom are managing this from a shared
  staff phone or aren't especially technical, forcing 2FA at signup adds real
  friction to onboarding for a security benefit that mostly matters once
  there's something valuable to steal (payment info, large transaction
  history) — you're not there yet. Leave it optional; mention it exists.
- For you and Adaiah specifically — the accounts that can see the admin
  dashboard, hold the invite code, and represent the whole business — turn it
  on. You have more to lose if either of your accounts is compromised, and
  you're both technical enough that scanning a QR code once is trivial.
- Revisit this once you're handling real payment data or have enough
  customers that a compromised account could hurt many businesses at once —
  at that point, consider requiring it for everyone.

### Tightening further (worth doing before you're at real scale)

- **Content-Security-Policy.** Currently disabled because `app.html` uses inline
  `<script>`/`<style>` for simplicity. To enable it: move the inline script to a
  separate `app.js` file, then turn CSP back on in `server.js`
  (`helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], fontSrc: ["'self'", "fonts.gstatic.com"], styleSrc: ["'self'", "fonts.googleapis.com"] } } })`).
  This is the single biggest remaining hardening step.
- **2FA** for owner accounts, once you have paying customers with something to lose.
- **Audit log** — a simple `activity_log` table (who did what, when) is cheap to
  add now and very useful once you have real support requests ("why did this
  invoice change?").
- **Backups.** SQLite is a single file — schedule a daily copy of `db/roms.sqlite`
  somewhere off-server (S3, Backblaze) once real business data lives in it.

---

## 2a. Preventing hacking, data theft, and fake/impersonating sites

This section covers what's already built vs. what's a business/operational
step rather than a coding one.

### Already built and tested (see section 2 above for the full list)
httpOnly cookie sessions, per-business data isolation, rate limiting, bcrypt
password hashing, optional 2FA, security headers, invite-gated signup, and —
new this round — a fix for a real **stored XSS vulnerability**: any text a
customer or teammate typed (a customer's name, a dish name, a waste reason)
was being inserted into the page without escaping, which means someone could
have named a "customer" something like `<script>...</script>` and had it
execute in whoever's browser viewed that list next. Every place user-entered
text gets displayed now passes through an `esc()` function first, converting
`<`, `>`, `"`, `'`, `&` into their safe HTML-entity equivalents. Tested
directly: a script-tag payload was submitted as a customer name, confirmed it
gets stored as-is (correct — the database should hold the real value) and
confirmed the escaping function neutralizes it into inert text at render time
(where it actually matters).

### New: an activity log so you can catch unauthorized access
Every login, failed login attempt, 2FA change, settings change, and teammate
invite is now recorded with a timestamp and IP address, visible to any owner
under **Settings → Recent account activity**. If a password ever leaks, this
is how you or a customer would notice — a login from an unfamiliar IP, or a
string of failed attempts.

### What "someone taking ownership of a business" would actually require
With everything above in place, an attacker would need the actual password
(and 2FA code, if enabled) of a real logged-in user — there's no way to
create, delete, or take over a business account by manipulating a request,
since every write is scoped server-side to the ID inside a verified session
cookie, never anything the client claims. The practical risks left are the
human ones below, not code ones.

### Preventing fake/impersonating websites (phishing)
This is mostly not a coding problem — it's about controlling your real domain
and making it obvious which site is really yours:
- **Buy and use your own domain** (you already have `sanobaconsulting.com` via
  Namecheap — do the same for ROMS Ghana, e.g. `romsghana.com`) and only ever
  share that link with restaurant owners. A copycat site at a look-alike
  domain can't get anyone's password unless someone types it in there instead.
- **Always deploy over HTTPS** (Render/Railway do this automatically) — browsers
  flag non-HTTPS sites, and it also protects the cookie in transit.
- Once you send real emails (password resets, receipts), set up SPF/DKIM for
  your sending domain — most email providers (Resend, Mailgun, Google
  Workspace) walk you through this in a few clicks. It stops attackers from
  sending email that appears to come from your domain.
- If you ever notice a suspicious look-alike domain impersonating ROMS Ghana,
  that's a domain/trademark dispute, not something fixable in code — Namecheap
  and most registrars have an abuse-report process for exactly this.

### Two things worth doing before you have real customer data at stake
- **Backups.** SQLite is a single file — schedule a daily copy of
  `db/roms.sqlite` somewhere off-server (S3, Backblaze, even emailing yourself
  a copy weekly at this stage) so a server failure can't lose customer data.
- **Don't reuse the invite code, JWT_SECRET, or ADMIN_KEY anywhere else** —
  treat them like passwords. If you ever suspect one has leaked, change it in
  `.env` and redeploy; existing sessions signed with the old `JWT_SECRET` will
  stop working (a good thing, in that scenario).

---

## 2b. How do customers actually pay you?

Nothing in this app processes payments yet, and I'd deliberately hold off on
building that — accepting real money means a real merchant account and real
compliance obligations, not just code. Here's the realistic path:

**Right now (pilot stage, in-person sales):** Collect payment directly —
MoMo transfer to your own number, or cash — the same way you're already
pitching restaurants in person. Use the admin dashboard to record it:

```
PATCH /api/admin/businesses/:id/payment
Header: X-Admin-Key: your-admin-key
Body: { "subscription_status": "active", "subscription_note": "Paid GHS 100 via MoMo, 26 Jul", "paid_through": "2026-08-26" }
```

This is a manual ledger — it doesn't move money, it just records that you
collected it, so you (and Adaiah) can see who's paid and who's overdue on
`GET /api/admin/businesses`. Tested and working.

**Once you have enough customers that manual collection doesn't scale:**
[Paystack](https://paystack.com) is the standard choice for Ghana — it
supports MoMo, cards, and bank transfer, has a straightforward API, and
plenty of businesses in Ghana already use it, so restaurant owners will
recognize it. Setting it up means: creating a Paystack merchant account
(requires business registration documents), adding their Node SDK, and
building a checkout flow that charges a business's card/MoMo on a schedule.
That's a real feature to build once you're past hand-collecting from your
first 5–10 pilots — happy to build it when you're at that point.

---

## 3. Deploying — step by step

This sandbox can't expose a public URL, so here's exactly how to put this live.
**Render** is the easier of the two for a first deploy.

### Option A: Render.com

1. Create a GitHub repo and push this `roms-backend` folder to it (`git init`,
   `git add .`, `git commit -m "initial commit"`, push to a new repo — the
   included `.gitignore` already excludes `node_modules` and your local `.env`).
2. Go to [render.com](https://render.com) → **New → Web Service** → connect
   that GitHub repo.
3. Settings:
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Instance type:** Free is fine to start.
4. Under **Environment**, add:
   - `JWT_SECRET` = a long random string (generate with the `node -e` command above — never reuse the example one)
   - `NODE_ENV` = `production`
   - `ALLOWED_ORIGIN` = your Render URL once you know it, e.g. `https://roms-ghana.onrender.com` (only needed if you later split the frontend onto a different domain — same-origin deploys like this one don't strictly need it)
5. Under **Disks**, add a persistent disk (e.g. 1GB) mounted at `/opt/render/project/src/db` — **this step matters**: without it, your SQLite database resets every time you redeploy.
6. Click **Create Web Service**. Render builds it, gives you a live HTTPS URL automatically (free SSL, no setup needed).
7. Visit `https://your-app.onrender.com/` — that's your live marketing site; `/app.html` is your live product.

### Option B: Railway.app

1. Push the repo to GitHub the same way.
2. [railway.app](https://railway.app) → **New Project → Deploy from GitHub repo**.
3. Railway auto-detects Node and runs `npm install && npm start`.
4. Under **Variables**, add `JWT_SECRET` and `NODE_ENV=production` the same as above.
5. Under **Settings → Volumes**, attach a volume mounted at `/app/db` so SQLite persists across deploys.
6. Railway gives you a `*.up.railway.app` HTTPS domain automatically, or connect a custom domain under **Settings → Domains**.

### Connecting your own domain (either platform)

Both platforms have a **Custom Domain** setting — add e.g. `app.romsghana.com`,
then add the CNAME record they show you at your domain registrar (Namecheap,
since that's what you used for Sanoba Consulting). HTTPS certificates are
issued automatically once the DNS record resolves.

---

## 4. Turning this into a mobile app — step by step

You don't need to rewrite anything. There are two realistic paths, in order —
do step A first, it costs almost nothing and covers most owners' actual needs;
only move to B once you specifically need Play Store/App Store presence.

### A. Progressive Web App (PWA) — already built into this project

This is already wired up: `public/manifest.json` and `public/sw.js` make
`app.html` installable directly from the browser, no app store needed.

1. Deploy the backend (section 3 above) so it's live over HTTPS — PWAs require
   HTTPS to install (Render/Railway give you this automatically).
2. On an **Android phone**: open the live URL in Chrome → tap the menu (⋮) →
   **"Add to Home Screen" / "Install app."** It installs with its own icon and
   opens full-screen, no browser bar.
3. On an **iPhone**: open the live URL in Safari → tap Share → **"Add to Home
   Screen."** Same result.
4. That's it — owners now have something that looks and feels like a real app,
   updates automatically (no app-store review needed for every change), and
   already has the offline app-shell caching built in (`sw.js`).
5. Optional polish: replace `public/icon-192.png` / `icon-512.png` with your
   real logo at those exact sizes — the ones in this project are simple
   placeholders generated from your brand colors.

**This is genuinely enough for your pilot restaurants.** It's also what your
own product notes said early on: don't build native first, most owners will
just use what's on the phone they already have.

### B. Real Play Store / App Store app — once you need store presence

Once you want it listed in the Play Store or App Store (for discoverability,
or because a client specifically wants "an app"), wrap the same code with
**Capacitor** — it packages your existing HTML/CSS/JS into a real native app
shell without a rewrite.

1. Install Capacitor inside the project:
   ```bash
   npm install @capacitor/core @capacitor/cli @capacitor/android @capacitor/ios
   npx cap init "ROMS Ghana" "com.romsghana.app" --web-dir=public
   ```
2. Point it at your **live, deployed** backend URL (not localhost) — edit
   `public/app.html`'s `const API = ''` line to `const API = 'https://your-app.onrender.com';`
   since the app will now be running from a native shell, not from the same
   origin as the API.
3. Add the platforms and open them in their native IDEs:
   ```bash
   npx cap add android
   npx cap add ios
   npx cap open android   # opens Android Studio
   npx cap open ios       # opens Xcode (Mac only)
   ```
4. Build and test on a real device or emulator from within Android
   Studio/Xcode — Capacitor's docs (capacitorjs.com) cover icons, splash
   screens, and permissions in detail.
5. Publish: Google Play Console (one-time $25 fee) for Android, Apple
   Developer Program ($99/year) for iOS.

**One security note for path B:** cookies can behave inconsistently inside a
native app WebView depending on platform. If you hit login issues after
wrapping with Capacitor, the fix is to add a header-based token fallback for
that specific client (the `requireAuth` middleware already accepts a Bearer
token as a fallback to the cookie — see `middleware/auth.js` — so this is a
small frontend change, not a backend rewrite).

---

## 4a. Automation features (bulk import, templates, chain support, exports)

**Multi-branch / chain support.** Under Settings, add a branch for each
location. Inventory, dishes, customers, staff, and invoices can each be tagged
to a branch when you create them. `GET /api/dashboard/by-branch` rolls
revenue/waste/inventory up per branch — this is what makes the platform fit a
chain like KFC or Papaye structurally (one business account, many branches,
roll-up reporting), without any actual integration with those specific
companies' systems, which isn't something available to build without their
direct involvement.

**CSV/Excel bulk import.** Tested end-to-end with real files.
- Inventory: `name, category, unit, unit_cost, qty_on_hand, reorder_level, shelf_life_days`
- Customers: `name, phone, birthday`
- Dishes: `name, serves, selling_price, target_margin, ingredients` — the
  `ingredients` column is optional, format `label:cost; label:cost`, e.g.
  `"250g rice:3.63; 120g chicken:7.80"`.

Export a spreadsheet from Excel/Google Sheets as CSV with those column headers
(case-insensitive, a few common alternate names like `cost`/`price` also work)
and upload it from the relevant tab.

**Ghanaian starter kit.** One button (on the Inventory tab, shown to any
business with nothing in it yet) seeds 13 common ingredients and 6 common
dishes (jollof, waakye, banku+tilapia, fufu, kelewele, red red) with rough
Accra-market starting costs. It only works once — the server refuses to run it
again once a business has any real inventory or dishes, so it can never
duplicate or overwrite real data.

**PDF export for analysis.** `GET /api/reports/pdf` (also a button on the
Reports tab) generates a real downloadable PDF: revenue, dish margins, top
waste, low-stock items, and branch comparison if the business has more than
one branch. Verified the actual text content comes out correct, not just that
a file gets created.

**Receipt/photo scanning (experimental).** `POST /api/ocr/receipt` accepts a
photo, extracts text, and returns candidate ingredient-name/price guesses for
the owner to review and edit before anything is saved — nothing is added to
inventory automatically. Built using `tesseract.js`. **Important:** this
needs internet access to download OCR language data from a CDN the first
time it runs. That CDN was blocked in the sandbox this was built in, so the
recognition step itself could not be fully tested end-to-end here — only the
upload handling, error handling, and text-parsing logic were verified
directly. Try it after deploying; if it fails, see below.

### Making OCR fully offline-capable (recommended before relying on this in production)

Rather than fetching language data from a CDN on every cold start, download it
once and bundle it locally:

```bash
mkdir -p tessdata
curl -L -o tessdata/eng.traineddata.gz \
  https://github.com/naptha/tessdata/raw/gh-pages/4.0.0_best_int/eng.traineddata.gz
```

Then in `routes/ocr.js`, pass `{ langPath: './tessdata', gzip: true }` as a
third argument to `Tesseract.recognize(...)`. This removes the runtime CDN
dependency entirely — faster, and works even if that CDN is ever unreachable
from your hosting provider.

### On POS (point-of-sale) integration

This wasn't built, deliberately — a real integration means connecting to
whatever specific POS system a restaurant already uses (Square, Loyverse, a
local Ghanaian system, etc.), each with its own API, credentials, and
approval process. That's a project to take on once you have a specific pilot
client naming their specific POS, not something to build speculatively.

## 4b. Data dashboards, tax config, team permissions, and AI brief

**Configurable Ghana taxes.** Settings now has real VAT/NHIL/Tourism Levy
controls — each with its own rate and on/off toggle. Every invoice itemizes
whichever are enabled. Tested: default invoice showed VAT+NHIL; after
enabling Tourism Levy, the next invoice correctly itemized all three.

**Business Health Score, properly broken down.** Seven categories —
Inventory, Waste, Suppliers, Pricing, Customer Loyalty, Staff, Profitability —
each computed with an explainable formula from real data (not a black box),
starting at a neutral 50 until there's enough activity to score fairly.
`GET /api/dashboard/health-score`.

**Real charts on the Reports tab**, via Chart.js: a 7-day revenue trend, a
waste-by-ingredient breakdown, and top-ordered items — all pulled from
`GET /api/dashboard/charts`, all real data, all tested with actual invoices
and waste entries.

**Role-based module permissions.** Under Settings, invite a teammate as
Manager (full access) or Staff (pick exactly which modules — Inventory, Menu,
Customers, Invoices, Reports, Settings — they can use). This is enforced
server-side, not just hidden in the UI: tested directly by inviting a
staff account with only Inventory access and confirming it got a real 403 on
Invoices and Menu, while the owner's account could still reach everything.

**AI Daily Brief** — a real Claude-generated paragraph of specific advice
based on that business's actual revenue, waste, dish margins, and low-stock
items (not a template). Requires `ANTHROPIC_API_KEY` in `.env` (get one at
console.anthropic.com, pay-as-you-go, a few cents per brief) — without it,
the button shows a clear message instead of pretending to work. Tested the
full request path with a placeholder key and confirmed it genuinely reaches
Anthropic's API (got back a real `authentication_error`, not a network
failure) — with a real key, this works as-is.

### On the bigger "38 feature ideas" list

That's a lot of ground, some of it small (a few hours), some of it
genuinely months of work (a real POS-style kitchen display, true offline
sync, competitor web-scraping). Rough map, so you can prioritize instead of
guessing:

**Already have a version of, or just built:** Business Health Score, AI Daily
Brief / Business Coach, Smart Purchasing (Purchase Planner preview),
Franchise/branch permissions (multi-branch + role-based access), HACCP/food
safety logs, Business Timeline (the activity log), Financial Dashboard
(Reports charts), AI Consulting Report (the PDF export).

**Natural next builds** (each a focused, few-hours task once you want them):
Price Simulator (a slider recomputing margin live — mostly frontend, the math
already exists in dish costing), Smart Notifications (rules-based alerts off
data already tracked), Customer Segmentation (grouping the existing customer
list by visit frequency/spend), Recipe Version History (an audit trail on the
dishes table, same pattern as the activity log), Executive Daily Brief by
WhatsApp/email (needs an email/WhatsApp sending service, same shape as the
notify webhook).

**Real, larger projects** (worth scoping separately when you're ready):
AI Chat Assistant (open-ended Q&A over the business's data — more involved
prompt engineering + probably function-calling), AI Fraud Detection (needs a
defined ruleset for what counts as suspicious, tuned over real usage data),
Kitchen Display System (needs real-time updates, a second UI mode for
kitchen screens), Delivery Dashboard / API Integrations (each delivery
platform and accounting tool is its own separate integration and approval
process), Competitor Intelligence (scraping/monitoring other businesses,
which has its own legal and reliability considerations), Voice Input,
Multi-language, true Offline Mode with write-queueing and sync.

**Worth deliberately waiting on:** Restaurant Benchmarking and Multi-Business
Platform ("ROMS OS") both need many real businesses already using this
before they mean anything — benchmarking needs peers to compare against, and
generalizing to other business types is a rebuild you'd want to justify with
real revenue first, not before it.

---

## 5. Project structure

```
roms-backend/
  server.js                # Express app — security middleware, routes, error handling
  db/schema.js               # SQLite schema (CREATE TABLE IF NOT EXISTS, no seed data)
  middleware/auth.js          # httpOnly cookie sessions + per-business scoping
  routes/
    auth.js                  # register / login / logout / me / invite teammate / 2FA
    dishes.js                 # dish costing with nested ingredient lines
    invoices.js                # invoices with line items + tax calc
    dashboard.js                 # aggregate stats + branch roll-up
    crudFactory.js                # generic CRUD builder used for inventory, suppliers, customers, staff, waste, branches
    import.js                      # CSV bulk import for inventory/customers/dishes
    starterKit.js                    # seeds common Ghanaian ingredients/dishes into a brand-new business
    reportsPdf.js                      # PDF report export
    ocr.js                                # experimental receipt photo scanning
    admin.js                              # platform-operator dashboard (separate from customer auth)
  lib/
    notify.js                # Discord/Slack webhook notification on new signups
  public/
    index.html                 # marketing site
    app.html                    # the product (login gate + dashboard)
    manifest.json                # PWA install config
    sw.js                         # service worker — app-shell caching for instant load + basic offline
    icon-192.png / icon-512.png    # app icons (placeholders — swap for your real logo)
```

## Adding a new simple data type

Most tables reuse one factory function instead of hand-written CRUD:

```js
// server.js
const equipmentRouter = makeCrudRouter('equipment_log', ['name', 'condition', 'last_serviced']);
app.use('/api/equipment', equipmentRouter);
```

Add the matching `CREATE TABLE` in `db/schema.js` with a `business_id` column
and it's automatically isolated per company with full GET/POST/PUT/DELETE.

## What's still a static preview, not wired to the database

The Purchase Planner and Menu Engineering Matrix ideas need at least 30 days
of real invoice/sales history to compute anything meaningful — better built
once your first pilot restaurants have been logging real data for a few weeks.
