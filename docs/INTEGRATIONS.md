# Switching on the real services

Everything stays mocked until you set a variable. Mix and match: you can run real SMS with mocked payments, which is the plan for the hackathon.

| Service | Variable | Default |
|---|---|---|
| Payments | (mock provider in `src/payments.js`) | mocked, on purpose |
| SMS login codes | `SMS_PROVIDER` | `outbox`: nothing is sent |
| Business register check | `REGISTRY_PROVIDER` | `none` |
| Professional licences | staff review queue | manual |

**What is tested and what is not.** Both adapters are tested against fake local servers that check the exact request we send and how we read the reply (`test/adapters.test.js`). They have **not** been run against a live account from here, so do the one-message and one-lookup checks below before you rely on them. Provider details change: confirm each against the provider's current documentation.

## 1. Real SMS

### Option A: Twilio
1. Create an account. Trial accounts can usually only text numbers you have verified in their console: fine for your own team's phones.
2. Note the Account SID and Auth Token, and get a sender (a number, or a Messaging Service).
3. Put in `.env`:
   ```
   SMS_PROVIDER=twilio
   TWILIO_ACCOUNT_SID=AC...
   TWILIO_AUTH_TOKEN=...
   TWILIO_FROM=+1...           # or TWILIO_MESSAGING_SERVICE_SID=MG...
   ```
4. Test: `npm run check:sms -- 0821234567`. A text arrives, or the command tells you why not.

### Option B: a South African provider (Clickatell, BulkSMS, SMSPortal and similar)
Any provider with a JSON REST endpoint works without new code. Copy the request shape from the provider's documentation into three settings. `{{to}}` becomes `+27821234567`, `{{to_digits}}` becomes `27821234567`, `{{text}}` becomes the message:
```
SMS_PROVIDER=http
SMS_HTTP_URL=https://provider.example/api/send
SMS_HTTP_HEADERS={"authorization":"Bearer YOUR_KEY"}
SMS_HTTP_BODY={"to":"{{to_digits}}","content":"{{text}}"}
```
If a provider needs a different shape (form data, query string), tell me which one and I will add a small adapter.

### Things to know about real SMS
- A custom sender name (for example ExpOnDemand) usually needs registering and approval first. Start early.
- Costs are per message. `SMS_DAILY_CAP` stops a flood of fake sign-ups from running up the bill. Per-phone and per-IP limits are already on.
- If the provider fails, the person sees "We could not send your code" instead of waiting for a text that never comes.
- For the **public hackathon link**, keep `DEMO_MODE=true` (fixed code, fake data): real SMS on a public page invites abuse.
- In real production the server refuses to start with SMS set to `outbox`.

## 2. Business register check (CIPC)

1. Sign up with a register-verification provider. The adapter is written for Didit's South Africa company registry lookup, which bills per successful query. Check current pricing and any free allowance.
2. Put in `.env`:
   ```
   REGISTRY_PROVIDER=didit
   DIDIT_API_KEY=...
   ```
3. Test: `npm run check:registry -- 2019/123456/07` (use a real number you know).
4. New businesses are checked as they register. Staff see **Register check: matched / no match / check failed / not checked** on each application, and still decide.

`REGISTRY_AUTO_APPROVE=true` approves on a full match without staff. Leave it off while you are learning how the provider behaves: a company registry shows the company exists, not that the person registering owns it. That is why we also keep the director ID check and the staff decision.

A provider outage never stops someone from registering: the check shows "check failed" and staff review as usual.

## 3. Professional licences
There is no single API for SACAP, ECSA, SAPC, HPCSA and the others. Staff look each licence up on the body's public register from the review queue. Automating individual bodies is a later job, one at a time.

## 4. Payments (staying mocked)
Keep this label on slide one: "Payments are simulated; the hold, split, refund and payout rules are real and tested." The real adapter later replaces `MockProvider` in `src/payments.js` (four methods: charge, refund, payout, verifyAccount). Nothing else changes.

## Safe backups
`npm run backup` writes a consistent copy of the database while the server runs, and keeps the newest 14.
