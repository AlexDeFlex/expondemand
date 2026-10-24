# Deploying a live demo

Goal: a public HTTPS link judges can open on their phones, plus a backup you can run on your laptop.

## Fastest: one small server with Docker

1. Create a small Linux server (an AWS server works; your credit covers it) and point a domain name at it.
2. Install Docker, copy the project, then:
   ```bash
   cp .env.example .env          # set JWT_SECRET (32+ random characters), ADMIN_PHONE, CORS_ORIGIN
   # for the hackathon demo only: DEMO_MODE=true
   # edit Caddyfile: put your domain
   docker compose up -d --build
   docker compose exec app node --disable-warning=ExperimentalWarning src/seed.js   # demo accounts and requests
   ```
3. Open `https://your-domain`. Caddy gets the HTTPS certificate for you.

## Settings that matter

| Setting | Meaning |
|---|---|
| `JWT_SECRET` | Required in production, 32+ random characters. Never share it |
| `ADMIN_PHONE` | The staff phone number. Sign in with it to see the review queue |
| `DEMO_MODE=true` | Everyone signs in with code 123456 and the screen shows the hint. **Fake data only.** Switch off for real users |
| `AUTO_VERIFY=true` | Skips staff review so new accounts work instantly. Demo only |
| `CORS_ORIGIN` | Your site and the packaged app's origins |

## Before you share the link

- [ ] Strong `JWT_SECRET` set, `.env` not committed
- [ ] DEMO_MODE on only because it is a demo, and the home screen says so
- [ ] Billing alarm set on the cloud account
- [ ] Backup: copy `/data/expondemand.db` somewhere safe (it is a single file)
- [ ] Opened on two real phones, one Android and one iPhone, on mobile data
- [ ] A recorded video of the full demo in case the venue Wi-Fi fails
- [ ] Laptop backup: `npm install && npm run seed && npm start`

## Not yet production

Real SMS codes, real payments and payouts, a Postgres database, encrypted document storage, an independent penetration test and a lawyer's review (see SECURITY_POPIA.md and ROADMAP.md) all come before real customers.
