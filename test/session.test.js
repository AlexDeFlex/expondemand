import './env-session.js';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { api, login, clock, ctx, close, makeEntrepreneur, makePro, consultationDeal } from './helpers.js';

after(close);
const HOUR = 3600e3;

test('sessions: stay signed in for days, sign-out revokes that device only', async () => {
  const phone = '0827770001';
  const t1 = await login(phone, 'professional'), t2 = await login(phone);   // two devices
  clock.t += 3 * 24 * HOUR;
  assert.equal((await api('GET', '/me', null, t1)).status, 200);            // still signed in days later: no new code
  assert.equal((await api('POST', '/auth/logout', null, t1)).body.signed_out, true);
  assert.equal((await api('GET', '/me', null, t1)).status, 401);            // revoked
  assert.equal((await api('GET', '/me', null, t2)).status, 200);            // the other device is untouched
  clock.t += 40 * 24 * HOUR;
  assert.equal((await api('GET', '/me', null, t2)).status, 401);            // sessions do expire (30 days)
  clock.t -= 43 * 24 * HOUR;
});

test('step-up: changing bank details needs a code from the last 10 minutes', async () => {
  const p = await makePro({ payout: false });
  const link = (n) => api('POST', '/bank-account', { bank: 'FNB', holder_name: p.name, account_number: n }, p.tok);
  assert.equal((await link('62000000555')).status, 201);                     // just signed in: fresh
  clock.t += 11 * 60e3;
  assert.equal((await link('62000000666')).body.code, 'step_up_required');   // stale: ask again
  assert.equal((await api('POST', '/auth/step-up/request', null, p.tok)).body.sent, true);
  assert.equal((await api('POST', '/auth/step-up/verify', { code: '000000' }, p.tok)).status, 401);
  assert.equal((await api('POST', '/auth/step-up/verify', { code: '123456' }, p.tok)).body.confirmed, true);
  const second = await link('62000000666');
  assert.equal(second.status, 201); assert.ok(second.body.hold_until);        // and the 48h payout hold still applies
  assert.equal((await api('GET', '/bank-account', null, p.tok)).body.account.last4, '0666');
  clock.t -= 11 * 60e3;
});

test('read endpoints: deal view, offers, meetings, notifications, bank account', async () => {
  const x = await consultationDeal({ amount: 900 });
  const view = (await api('GET', `/deals/${x.dealId}`, null, x.e.tok)).body;
  assert.equal(view.profession, 'Commercial Lawyer'); assert.equal(view.counterparty.name, x.p.name); assert.match(view.counterparty.badge, /Tier 1/);
  assert.equal((await api('GET', `/deals/${x.dealId}`, null, x.p.tok)).body.counterparty.badge, 'Verified business');
  const mine = (await api('GET', '/offers/mine', null, x.p.tok)).body.offers;
  assert.equal(mine[0].status, 'accepted'); assert.equal(mine[0].deal_id, x.dealId);
  const m = await api('POST', `/deals/${x.dealId}/meetings`, { scheduled_at: new Date(clock.t + 4 * HOUR).toISOString(), venue_type: 'office' }, x.e.tok);
  const list = (await api('GET', `/deals/${x.dealId}/meetings`, null, x.p.tok)).body.meetings;
  assert.equal(list.length, 1); assert.equal(list[0].proposed_by_me, false); assert.equal(list[0].id, m.body.meeting_id);
  assert.ok((await api('GET', '/me/notifications', null, x.p.tok)).body.notifications.some((n) => n.type === 'offer.picked'));
  assert.equal((await api('GET', '/bank-account', null, x.e.tok)).body.account, null);   // entrepreneur never linked one
  const e2 = await makeEntrepreneur();
  assert.equal((await api('GET', `/deals/${x.dealId}`, null, e2.tok)).status, 403);
});


test('sign-in only works for registered numbers (demo mode included); sign-up creates the account', async () => {
  const code = async (phone, extra) => { await api('POST', '/auth/request-otp', { phone }); return api('POST', '/auth/verify-otp', { phone, code: '123456', ...extra }); };
  const blocked = await code('0826660001', { mode: 'signin' });
  assert.equal(blocked.status, 404); assert.equal(blocked.body.code, 'no_account'); assert.equal(blocked.body.token, undefined);
  const stillBlocked = await code('0826660001', { mode: 'signin', role: 'professional' });   // a role cannot sneak an account into sign-in
  assert.equal(stillBlocked.body.code, 'no_account');
  assert.equal(ctx.db.get('SELECT COUNT(*) n FROM users WHERE phone=?', '+27826660001').n, 0);
  const made = await code('0826660001', { mode: 'signup', role: 'professional' });
  assert.equal(made.status, 200); assert.equal(made.body.created, true); assert.ok(made.body.token);
  const again = await code('0826660001', { mode: 'signin' });   // now registered: allowed
  assert.equal(again.status, 200); assert.equal(again.body.created, false);
  assert.equal((await code('0826660001', { mode: 'signup', role: 'entrepreneur' })).body.user.role, 'professional');   // signing up twice just signs in, role unchanged
  const wrong = await api('POST', '/auth/verify-otp', { phone: '0826660002', code: '000000', mode: 'signin' });
  assert.equal(wrong.status, 400);   // a wrong or missing code says nothing about whether the number exists
});
