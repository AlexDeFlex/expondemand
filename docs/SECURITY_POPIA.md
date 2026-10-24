# Security and POPIA notes

This is an engineering checklist, not legal advice. Have a POPIA attorney review it and get an independent penetration test before real users and money.

## Built in

| Control | Where |
|---|---|
| Parameterised SQL everywhere (no string-built queries) | `db.js`, all modules |
| OTP: hashed at rest, expiry, 3-strike lockout, hourly send cap | `auth.js` |
| Signed sessions with constant-time signature check; server re-checks the user on every request | `auth.js` |
| Role checks on every route; object-level checks (party to the deal) on every deal action | `app.js`, `deals.js` |
| Security headers, body size limit, rate limits, no stack traces to clients | `app.js` |
| Production refuses to start without a strong `JWT_SECRET`; fixed OTP is disabled in production | `config.js` |
| Idempotent payments, atomic pick, compensating refund | `deals.js`, `threads.js` |
| Payout never goes to an unverified account; 48h hold after bank-detail change; closed loop (refund to payer account in production) | `deals.js`, `onboarding.js` |
| Audit log of sensitive actions, including every view of a sworn affidavit | `notify.js` |

## POPIA

- **Minimisation:** only the last 4 digits of a director's ID plus a keyed hash (to detect reuse). Card data never reaches us. Bank numbers stay with the provider; we keep a token and last 4.
- **Access and erasure:** `GET /me/export`, `DELETE /me` (blocked while deals are open; financial records kept in anonymised form).
- **Consent for others:** trusted contacts must opt in before any location is sent to them.
- **Location:** only shared on SOS, during a live meeting.

## Still to do before launch

1. Appoint and register an Information Officer; publish the privacy notice and retention schedule.
2. Operator agreements with every provider (payments, SMS, hosting). Check where data is stored.
3. Encrypt the database file and affidavit storage at rest; move secrets to a secrets manager.
4. Incident response plan and breach notification process (Information Regulator and affected users).
5. Independent penetration test; dependency and code scanning in CI.
6. Lawyer review of: affidavit templates, fronting terms, holding customer funds (regulatory position), VAT on commission.
