import express from 'express';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { HttpError, notFound, forbidden } from './util.js';
import { makeNotifier } from './notify.js';
import { openDb } from './db.js';
import { MockProvider } from './payments.js';
import { makeGateway } from './sms.js';
import { makeRegistry } from './registry.js';
import * as auth from './auth.js';
import * as onb from './onboarding.js';
import * as threads from './threads.js';
import * as deals from './deals.js';
import * as safety from './safety.js';
import { intake } from './intake.js';
import * as privacy from './privacy.js';
import { searchProfessions, groups } from './professions.js';

export function createContext({ db = openDb(config.dbPath), provider = new MockProvider(), clock = { now: () => Date.now() }, sms = makeGateway(), registry = makeRegistry() } = {}) {
  const ctx = { db, provider, clock, sms, registry };
  ctx.notify = makeNotifier(db, clock, sms);
  auth.seedAdmin(ctx);
  return ctx;
}

/** Tiny in-memory rate limiter (per IP). Swap for Redis when you run more than one server. */
function limiter(max, windowMs) {
  const hits = new Map();
  return (req, _res, next) => {
    const key = req.ip, now = Date.now(), h = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (h.length >= max) return next(new HttpError(429, 'Too many requests. Slow down.', 'rate_limited'));
    h.push(now); hits.set(key, h); next();
  };
}

/** The website is same-origin. The packaged mobile app calls from its own origin, so allow exactly the origins listed in CORS_ORIGIN. */
function corsFor(req) {
  const allowed = config.corsOrigin.split(',').map((s) => s.trim()).filter(Boolean), o = req.headers.origin;
  if (allowed.includes('*')) return '*';
  return o && allowed.includes(o) ? o : allowed[0] || 'null';
}

export function createApp(ctx) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  // The web client. Strict CSP: only our own scripts and styles run, nothing inline, nothing from other sites.
  app.use(express.static(fileURLToPath(new URL('../public/', import.meta.url)), { setHeaders: (res) => res.set({
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' }) }));
  app.use(express.json({ limit: '100kb' }));
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store',
      'Strict-Transport-Security': 'max-age=31536000; includeSubDomains', 'Access-Control-Allow-Origin': corsFor(req),
      'Access-Control-Allow-Headers': 'authorization,content-type', 'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS' });
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  if (process.env.NODE_ENV !== 'test') app.use(limiter(300, 60e3));

  if (process.env.NODE_ENV !== 'test') app.use((req, res, next) => {   // one line per request: no bodies, no tokens, no phone numbers
    const t = Date.now();
    res.on('finish', () => console.log(JSON.stringify({ t: new Date().toISOString(), m: req.method, p: req.path.replace(/[0-9a-f-]{36}/g, ':id'), s: res.statusCode, ms: Date.now() - t })));
    next();
  });
  const h = (fn, status = 200) => (req, res, next) => Promise.resolve(fn(req, res)).then((r) => res.status(status).json(r)).catch(next);
  const A = auth.authn(ctx), R = auth.role;
  const E = [A, R('entrepreneur')], P = [A, R('professional')], ADM = [A, R('admin')], ANY = [A, R('entrepreneur', 'professional')];

  app.get('/health', (_q, res) => res.json({ ok: true, time: ctx.clock.now(), demo: !!config.demo }));

  // Public reference data
  app.get('/professions', h((req) => ({ professions: searchProfessions(req.query.q, req.query.group, req.query.limit) })));
  app.get('/professions/groups', h(() => ({ groups: groups() })));

  // Auth
  const authLimit = process.env.NODE_ENV === 'test' ? (_q, _r, n) => n() : limiter(20, 60e3);
  app.post('/auth/request-otp', authLimit, h((req) => auth.requestOtp(ctx, req.body.phone)));
  app.post('/auth/verify-otp', authLimit, h((req) => auth.verifyOtp(ctx, req.body), 200));
  app.get('/me', A, h((req) => ({ user: auth.publicUser(req.user), roles: req.roles,
    businesses: onb.listBusinesses(ctx, req.user.id).map((b) => onb.businessView(ctx, b)),
    professional: onb.getProfessional(ctx, req.user.id) || undefined,
    identity_linked: !!ctx.db.get('SELECT identity_hash FROM users WHERE id=?', req.user.id)?.identity_hash })));
  app.post('/auth/switch-role', A, h((req) => auth.switchRole(ctx, req.user, req.session, req.body.role)));
  app.post('/me/roles', A, h((req) => auth.addRole(ctx, req.user, req.session, req.body)));
  app.post('/auth/logout', A, h((req) => auth.logout(ctx, req.session)));
  app.post('/auth/step-up/request', A, h((req) => auth.stepUpRequest(ctx, req.user)));
  app.post('/auth/step-up/verify', A, h((req) => auth.stepUpVerify(ctx, req.user, req.session, req.body.code)));
  app.get('/me/notifications', A, h((req) => ({ notifications: ctx.db.all(`SELECT id,type,body,at FROM notifications WHERE user_id=? AND channel='push' ORDER BY at DESC LIMIT 50`, req.user.id).map((n) => ({ ...n, body: n.body ? JSON.parse(n.body) : null })) })));
  app.get('/me/export', ANY, h((req) => privacy.exportMyData(ctx, req.user)));
  app.delete('/me', ANY, h((req) => privacy.eraseMe(ctx, req.user)));

  // Entrepreneur onboarding
  app.post('/business', E, h(async (req) => onb.runRegistryCheck(ctx, onb.createBusiness(ctx, req.user, req.body)), 201));
  app.post('/business/sds', E, h((req) => onb.signSds(ctx, req.user, req.body), 201));
  app.get('/businesses', E, h((req) => ({ businesses: onb.listBusinesses(ctx, req.user.id).map((b) => onb.businessView(ctx, b)) })));

  // Professional onboarding
  app.post('/professional', P, h((req) => onb.createProfessional(ctx, req.user, req.body), 201));
  app.patch('/professional/availability', P, h((req) => { ctx.db.run('UPDATE professionals SET available=? WHERE user_id=?', req.body.available ? 1 : 0, req.user.id); return { available: !!req.body.available }; }));

  // Bank accounts (entrepreneur links, professional receives payouts)
  app.post('/bank-account', ANY, h((req) => { auth.requireFresh(ctx, req.session); return onb.linkBankAccount(ctx, req.user, req.body); }, 201));
  app.get('/bank-account', ANY, h((req) => {
    const owner = req.user.role === 'entrepreneur' ? { type: 'business', id: onb.pickBusiness(ctx, req.user.id, req.query.business_id).id } : { type: 'professional', id: req.user.id };
    const a = owner.id && onb.activeAccount(ctx, owner.type, owner.id);
    return { account: a ? { bank: a.bank, last4: a.last4, status: a.status, hold_until: a.hold_until || null } : null };
  }));

  // AI intake
  app.post('/intake', A, h((req) => intake(req.body.text)));

  // Matching
  app.post('/threads', E, h((req) => threads.createThread(ctx, req.user, req.body), 201));
  app.get('/threads/mine', E, h((req) => ({ threads: threads.myThreads(ctx, req.user) })));
  app.get('/feed', P, h((req) => ({ threads: threads.feed(ctx, req.user) })));
  app.get('/offers/mine', P, h((req) => ({ offers: threads.myOffers(ctx, req.user) })));
  app.post('/threads/:id/offers', P, h((req) => threads.submitOffer(ctx, req.user, req.params.id, req.body), 201));
  app.post('/threads/:id/pick', E, h((req) => threads.pickOffer(ctx, req.user, req.params.id, req.body.offer_id), 201));
  app.post('/threads/:id/positions', E, h((req) => threads.addPosition(ctx, req.user, req.params.id, req.body), 201));
  app.post('/threads/:id/close', E, h((req) => threads.closeThread(ctx, req.user, req.params.id)));

  // Deals
  app.get('/deals', ANY, h((req) => ({ deals: deals.myDeals(ctx, req.user) })));
  app.get('/deals/:id', A, h((req) => { const { deal, role } = deals.getDealFor(ctx, req.user, req.params.id); return deals.presentDeal(ctx, deal, role); }));
  app.post('/deals/:id/pay', E, h((req) => deals.pay(ctx, req.user, req.params.id, req.body), 201));
  app.post('/deals/:id/deliver', P, h((req) => deals.deliver(ctx, req.user, req.params.id)));
  app.post('/deals/:id/confirm', E, h((req) => deals.confirm(ctx, req.user, req.params.id)));
  app.post('/deals/:id/cancel', ANY, h((req) => deals.cancelDeal(ctx, req.user, req.params.id, req.body)));
  app.post('/deals/:id/cancel/decline', ANY, h((req) => deals.keepDeal(ctx, req.user, req.params.id)));
  app.delete('/deals/:id', ANY, h((req) => deals.removeDeal(ctx, req.user, req.params.id)));
  app.post('/deals/:id/dispute', ANY, h((req) => deals.dispute(ctx, req.user, req.params.id, req.body)));
  app.put('/deals/:id/terms', ANY, h((req) => deals.updateTerms(ctx, req.user, req.params.id, req.body)));
  app.post('/deals/:id/terms/lock', ANY, h((req) => deals.lockTerms(ctx, req.user, req.params.id)));
  app.get('/deals/:id/affidavit/text', ANY, h((req) => { const { deal, role } = deals.getDealFor(ctx, req.user, req.params.id); return { statement: deals.affidavitText(ctx, deal, role) }; }));
  app.post('/deals/:id/affidavit', ANY, h((req) => deals.uploadAffidavit(ctx, req.user, req.params.id, req.body), 201));
  app.get('/deals/:id/affidavit/counterparty', ANY, h((req) => deals.viewCounterpartyAffidavit(ctx, req.user, req.params.id)));
  app.post('/deals/:id/affidavit/review', ANY, h((req) => deals.reviewAffidavit(ctx, req.user, req.params.id, req.body)));

  // Safety
  app.post('/me/trusted-contacts', ANY, h((req) => safety.addTrustedContact(ctx, req.user, req.body), 201));
  app.get('/me/trusted-contacts', ANY, h((req) => ({ contacts: safety.listContacts(ctx, req.user) })));
  app.get('/deals/:id/meetings', ANY, h((req) => ({ meetings: safety.listMeetings(ctx, req.user, req.params.id) })));
  app.post('/deals/:id/meetings', ANY, h((req) => safety.proposeMeeting(ctx, req.user, req.params.id, req.body), 201));
  app.post('/meetings/:id/confirm', ANY, h((req) => safety.confirmMeeting(ctx, req.user, req.params.id)));
  app.post('/meetings/:id/arrive', ANY, h((req) => safety.arrive(ctx, req.user, req.params.id)));
  app.post('/meetings/:id/checkout', ANY, h((req) => safety.checkout(ctx, req.user, req.params.id)));
  app.post('/meetings/:id/sos', ANY, h((req) => safety.sos(ctx, req.user, req.params.id, req.body)));
  app.post('/meetings/:id/report', ANY, h((req) => safety.reportUser(ctx, req.user, req.params.id, req.body)));
  if (config.devOtp)   // in real production the SMS provider's signed webhook does this
    app.post('/dev/contact-consent', h((req) => safety.consentContact(ctx, req.body.contact_id, req.body.phone)));

  // Staff
  app.get('/admin/queue', ADM, h(() => onb.reviewQueue(ctx)));
  app.post('/admin/businesses/:id/review', ADM, h((req) => onb.reviewBusiness(ctx, req.user, req.params.id, req.body)));
  app.post('/admin/professionals/:id/review', ADM, h((req) => onb.reviewProfessional(ctx, req.user, req.params.id, req.body)));
  app.post('/admin/bank-accounts/:id/review', ADM, h((req) => onb.reviewBankAccount(ctx, req.user, req.params.id, req.body)));
  app.post('/admin/affidavits/:id/verify', ADM, h((req) => deals.verifyAffidavit(ctx, req.user, req.params.id, req.body)));
  app.post('/admin/deals/:id/resolve', ADM, h((req) => deals.resolveDispute(ctx, req.user, req.params.id, req.body)));
  app.post('/admin/jobs/run', ADM, h(async () => ({ threads: threads.runThreadMaintenance(ctx), payments: await deals.runPaymentMaintenance(ctx), safety: safety.runSafetyEscalation(ctx) })));

  app.use((_req, _res, next) => next(notFound('No such route')));
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, code: err.code });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON', code: 'bad_json' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large', code: 'too_large' });
    console.error(err);                                   // details stay in the logs, never in the response
    res.status(500).json({ error: 'Something went wrong', code: 'server_error' });
  });
  return app;
}
