# ExpOnDemand: Expert On Demand

**New here? Read `docs/GETTING_STARTED.md` first.** It takes you from unzipping to running in VS Code to building the mobile app.

Verified entrepreneurs meet verified professionals for **consultations** (fast, paid, per job) and **licensing partnerships** (a registered professional fronts regulated work). Built for the FNB App Academy hackathon.

This is the working app: a server (API, business rules, 34 automated tests) and a mobile-first web app that installs on phones like a native app. The `/public` folder is the app itself; the server hosts it.

## Run it

Needs **Node 22.5 or newer**. No database to install (SQLite is built in).

```bash
npm install
npm test            # 36 tests, including the real screens driven end to end
ADMIN_PHONE=0821110000 npm run dev     # http://localhost:3000
npm run seed        # demo accounts, requests and an offer (prints the logins)
```

Dev mode uses the fixed one-time code `123456`. Open the address on a phone on the same Wi-Fi to try it. See `docs/DEPLOY.md` to put it online and `docs/MOBILE.md` for the phone app. Two-day schedule: `docs/TWO_DAY_PLAN.md`.

## What is built

| Area | What it does |
|---|---|
| **Sign-in** | Phone OTP, expiring codes, 3-strike lockout, send limits, signed 12-hour sessions |
| **Trust gate** | Entrepreneurs must be CIPC-verified (format + director ID check + staff review) **and** hold a current Service Delivery Standards signature before they can post |
| **930 professions** | Searchable, grouped by demand, each with its registration body. Registration is optional for consultations, required for regulated licensing cover |
| **AI intake** | `POST /intake` turns a rambling request into a structured one. Uses Claude if `ANTHROPIC_API_KEY` is set, otherwise an offline matcher. The model can only choose from our list |
| **Matching** | Post thread, alert only eligible experts, interest or counter-offer (3 rounds max), entrepreneur picks (atomic: only one pick can win) |
| **Money** | Escrow-style hold, tiered fee (15% / 10% / 7%, R50 minimum), 85/15-style split, idempotent payments, dispute hold, 48h auto-release, payout retry, 48h hold after bank-detail changes |
| **Licensing deals** | Both lock terms (tamper-evident hash), both swear affidavits, staff verify, each reads the other's **redacted, watermarked, logged** copy, both confirm, then formalised. Changing terms voids old affidavits |
| **Safety** | Risk-scored meetups, opt-in trusted contacts, check-in/out, SOS, escalation ladder (prompt, SMS, contact, staff) |
| **POPIA** | Data export (`GET /me/export`), erasure (`DELETE /me`), data minimisation (last 4 of ID only), audit log |
| **Hiring more, cancelling, removing** | Hire several experts on one request, cancel before payment alone or after payment by agreement (full refund), end a formalised deal by agreement, remove finished deals from your own list |
| **One person per phone** | A phone number can run several businesses and hold both the entrepreneur and professional sides, but only for the same 13-digit ID. A different person's ID is refused, you cannot answer your own request, and (outside demo mode) one ID cannot sit on two phone numbers |
| **Sessions** | 30-day device sessions with sign-out, and a fresh code required to change bank details |
| **The app** | Sign-in, onboarding, menu, requests, offers (accept or counter), deals, payments, affidavits, meetings and SOS, inbox, staff review queue, installable on phones |

## Project layout

```
src/     app.js (routes) auth.js onboarding.js threads.js deals.js safety.js intake.js privacy.js payments.js db.js seed.js
public/  the web and mobile app: index.html, style.css, js/ (one file per area), manifest, service worker, icons
mobile/  packaging for Android and iPhone (Capacitor)
data/    professions.json
test/    journey, lifecycle, session and ui tests (the UI tests tap through the real screens)
docs/    ARCHITECTURE  SECURITY_POPIA  DEMO_SCRIPT  ROADMAP  MOBILE  DEPLOY  TWO_DAY_PLAN
```

## What is simulated, and what can be switched on

SMS codes and the business-register check are real adapters: set a variable and they work (`docs/INTEGRATIONS.md`). Payments stay mocked for now.

## What is simulated (swap these for production)

| Mock | Replace with |
|---|---|
| `MockProvider` in `payments.js` | A licensed provider's marketplace/escrow and payouts (Stitch, Ozow, Peach...). Same 4 methods |
| SMS outbox (default) | Real SMS: `SMS_PROVIDER=twilio` or `http`. Push notifications still need Firebase |
| Staff review of CIPC and licences | Optional register check (`REGISTRY_PROVIDER=didit`) feeding the same staff queue |
| Fixed dev OTP | Automatic: it switches off when `NODE_ENV=production` |

No real card data ever touches this server by design: the client sends a provider token.

## Try it with curl

```bash
curl -X POST localhost:3000/auth/request-otp -H 'content-type: application/json' -d '{"phone":"0821234567"}'
curl -X POST localhost:3000/auth/verify-otp  -H 'content-type: application/json' -d '{"phone":"0821234567","code":"123456","role":"entrepreneur"}'
curl "localhost:3000/professions?q=lawyer&limit=5"
```
The full walkthrough is in `test/journey.test.js`.
