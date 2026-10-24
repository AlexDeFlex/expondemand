# Two days to submission

Principle: **a smooth, honest demo beats a half-finished real integration.** Anything unfinished stays mocked and is labelled as such.

## Day 1: ship it

| Block | Do |
|---|---|
| Morning | Run it locally, seed the demo data, tap through every screen on your own phone (same Wi-Fi, `http://your-laptop-ip:3000`). Write down every bug and awkward moment |
| Midday | Deploy with Docker (DEPLOY.md), `DEMO_MODE=true`, seed. Install the app on two phones from the HTTPS link |
| Afternoon | Fix the bug list, top five first. Check empty states, error messages and slow-signal behaviour. Add your logo and a short About screen |
| Evening | Full rehearsal of the demo flow below, timed. Take screenshots for the slides. Back up the database file |

## Day 2: tell the story

| Block | Do |
|---|---|
| Morning | Record a clean 2-minute video of the whole flow. Build the slides: problem, solution, how it works, trust and safety, POPIA, business model, roadmap, ask |
| Midday | Rehearse the 5-minute pitch three times, out loud, with someone asking the judge questions in DEMO_SCRIPT.md |
| Afternoon | Submission checklist: link, video, slides, repo or zip, team details, any required forms. Read the competition rules on IP and eligibility again |
| Evening | Freeze. No new features. Re-check the live link on mobile data, then submit early |

## The demo flow (about 4 minutes)

1. Entrepreneur signs in (code 123456), taps **New request**, types a rambling request, taps **Suggest**. The right expert and need type appear.
2. Post it. Switch to the expert (second phone): **Jobs for you**, search, respond with a **counter-offer**.
3. Back on the entrepreneur: pick the expert, pay into the secure hold, expert marks delivered, release: show the 85/15 split and the payout.
4. Licensing deal: both sign, swear, staff approve (staff phone), each reads the other's redacted affidavit, formalised.
5. Show a meeting with safety check-ins, **Back** everywhere, and **Account**: download my data (POPIA).

## What to say is mocked (and why that is fine)

Payments, SMS and register checks sit behind swap-in interfaces. The rules, screens and 34 automated tests are real. Say it first, before a judge finds it.

## Do not spend these two days on

Real bank integrations, app-store publishing, new features, or perfecting the AI. Spend them on reliability, the story and rehearsal.
