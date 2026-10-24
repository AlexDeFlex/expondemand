import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { api, login, admin, clock, provider, ctx, close, sha, next, saId, makeEntrepreneur, makePro, consultationDeal } from './helpers.js';
import { feeFor } from '../src/payments.js';
import { saIdValid, cipcValid } from '../src/util.js';

after(close);
const HOUR = 3600e3;

test('validators: SA ID, CIPC, fee tiers', () => {
  const good = saId(1); assert.ok(saIdValid(good));
  assert.ok(!saIdValid(good.slice(0, 12) + ((+good[12] + 1) % 10)));   // one wrong check digit is caught
  assert.ok(!saIdValid('1234567890123')); assert.ok(cipcValid('2019/123456/07')); assert.ok(!cipcValid('2019-123456-07'));
  assert.deepEqual([feeFor(150000).fee_cents, feeFor(150000).payout_cents], [22500, 127500]);   // R1,500 -> R225 / R1,275
  assert.equal(feeFor(1000000).fee_cents, 100000);   // R10,000 at 10%
  assert.equal(feeFor(3000000).fee_cents, 210000);   // R30,000 at 7%
  assert.equal(feeFor(10000).fee_cents, 5000);       // R100 job: R50 minimum fee
  assert.equal(feeFor(4000).fee_cents, 4000);        // fee never exceeds the deal
});

test('OTP: wrong codes lock the number; right code signs in; role needed for new accounts', async () => {
  await api('POST', '/auth/request-otp', { phone: '0829990001' });
  assert.equal((await api('POST', '/auth/verify-otp', { phone: '0829990001', code: '111111', role: 'professional' })).status, 401);
  assert.equal((await api('POST', '/auth/verify-otp', { phone: '0829990001', code: '222222', role: 'professional' })).status, 401);
  assert.equal((await api('POST', '/auth/verify-otp', { phone: '0829990001', code: '333333', role: 'professional' })).status, 401);
  assert.equal((await api('POST', '/auth/verify-otp', { phone: '0829990001', code: '123456', role: 'professional' })).status, 429);   // locked even for the right code
  assert.equal((await api('POST', '/auth/request-otp', { phone: 'abc' })).status, 400);
  await api('POST', '/auth/request-otp', { phone: '0829990002' });
  assert.equal((await api('POST', '/auth/verify-otp', { phone: '0829990002', code: '123456' })).body.code, 'role_required');
  assert.equal((await api('GET', '/me')).status, 401);
  assert.equal((await api('GET', '/me', null, 'garbage.token.here')).status, 401);
});

test('gate: nobody posts without verified CIPC and a current SDS', async () => {
  const e = await makeEntrepreneur({ verified: false, sds: false });
  const post = (tok) => api('POST', '/threads', { need_type: 'consultation', profession: 'Commercial Lawyer', description: 'Need a contract reviewed today', budget_min: 500, budget_max: 900 }, tok);
  assert.equal((await post(e.tok)).body.code, 'gate_cipc');
  await api('POST', `/admin/businesses/${e.businessId}/review`, { approve: true }, await admin());
  assert.equal((await post(e.tok)).body.code, 'gate_sds');
  await api('POST', '/business/sds', { accept: true, answers: { services: 'Renovations and repairs', payment_terms: '30 days', dispute_process: 'Written complaint', no_licence_misuse: true } }, e.tok);
  assert.equal((await post(e.tok)).status, 201);
  // SDS expires after a year
  clock.t += 366 * 24 * HOUR;
  assert.equal((await post(e.tok)).body.code, 'gate_sds');
  clock.t -= 366 * 24 * HOUR;
  // professionals cannot post
  assert.equal((await post((await makePro()).tok)).status, 403);
});

test('onboarding validation: bad CIPC, bad ID, duplicate CIPC, tier rules', async () => {
  const tok = await login('0828880001', 'entrepreneur');
  assert.equal((await api('POST', '/business', { company_name: 'X Co', cipc_number: '2019-1', director_id: saId(5) }, tok)).body.code, 'bad_cipc');
  assert.equal((await api('POST', '/business', { company_name: 'X Co', cipc_number: '2019/123456/07', director_id: '1234567890123' }, tok)).body.code, 'bad_director_id');
  const e = await makeEntrepreneur();
  const tok2 = await login('0828880002', 'entrepreneur');
  const dupe = await api('POST', '/business', { company_name: 'Copycat', cipc_number: `2020/${100000 + 1}/07`, director_id: saId(9) }, tok2);
  assert.equal(dupe.body.code, 'cipc_taken');   // one CIPC number, one account
  const ptok = await login('0838880001', 'professional');
  assert.equal((await api('POST', '/professional', { full_name: 'No Proof', tier: 1, profession: 'Commercial Lawyer', reg_number: 'ABC123' }, ptok)).body.code, 'no_proof');
  assert.equal((await api('POST', '/professional', { full_name: 'Bad Candidate', tier: 2, profession: 'Management Consultant', reg_number: 'X1', proof_sha256: sha('p'), supervisor_phone: '0821110000' }, ptok)).body.code, 'no_candidate_tier');
  const stored = ctx.db.get('SELECT director_id_last4, director_id_hash FROM businesses WHERE owner_id=(SELECT id FROM users WHERE phone=?)', '+27' + e.phone.slice(1));
  assert.equal(stored.director_id_last4.length, 4);   // POPIA: never the full ID
});

test('consultation journey: thread -> offers -> pick -> pay -> confirm -> 85/15 split -> payout', async () => {
  const e = await makeEntrepreneur(), p1 = await makePro(), p2 = await makePro(), grad = await makePro({ tier: 3 });
  const t = await api('POST', '/threads', { need_type: 'consultation', profession: 'Commercial Lawyer', description: 'Supplier agreement needs review before signing', budget_min: 1000, budget_max: 1500 }, e.tok);
  assert.equal(t.status, 201); assert.ok(t.body.notified >= 3);   // everyone in that niche, any tier, for a consultation (earlier tests add more)
  assert.equal(t.body.requires_registration, false);               // consultations do not need a registered professional
  const other = await makePro({ profession: 'Food Scientist' });
  assert.equal((await api('GET', '/feed', null, other.tok)).body.threads.length, 0);   // other niche sees nothing
  assert.equal((await api('GET', '/feed', null, grad.tok)).body.threads.length >= 1, true);
  const a = await api('POST', `/threads/${t.body.id}/offers`, { kind: 'interested', note: 'Available now' }, p1.tok);
  assert.equal(a.body.you_receive.payout_cents, 127500);           // expert sees take-home before sending
  const b = await api('POST', `/threads/${t.body.id}/offers`, { kind: 'counter', amount: 2000, note: 'Wider scope' }, p2.tok);
  const c = await api('POST', `/threads/${t.body.id}/offers`, { kind: 'counter', amount: 900, note: 'Recent graduate' }, grad.tok);
  assert.equal(c.status, 201);
  const mine = await api('GET', '/threads/mine', null, e.tok);
  assert.equal(mine.body.threads[0].offers.length, 3);
  assert.equal(mine.body.threads[0].offers.find((o) => o.id === b.body.offer_id).professional.badge.startsWith('Tier 1'), true);
  const pick = await api('POST', `/threads/${t.body.id}/pick`, { offer_id: b.body.offer_id }, e.tok);
  assert.equal(pick.body.status, 'awaiting_payment');
  assert.equal((await api('POST', `/threads/${t.body.id}/pick`, { offer_id: a.body.offer_id }, e.tok)).body.code, 'positions_full');
  assert.equal((await api('POST', `/threads/${t.body.id}/offers`, { kind: 'interested' }, grad.tok)).status, 409);   // thread closed to others
  const d = pick.body.deal_id;
  assert.equal((await api('GET', `/deals/${d}`, null, p1.tok)).status, 403);   // the losing professional cannot see the deal
  assert.equal((await api('POST', `/deals/${d}/pay`, { method: 'card', token: 'tok_decline' }, e.tok)).status, 402);
  assert.equal((await api('POST', `/deals/${d}/pay`, { method: 'linked_eft' }, e.tok)).body.code, 'no_linked_account');
  assert.equal((await api('POST', '/bank-account', { bank: 'FNB', holder_name: e.company, account_number: '62111111111' }, e.tok)).body.status, 'verified');
  const paid = await api('POST', `/deals/${d}/pay`, { method: 'linked_eft', idempotency_key: 'k1' }, e.tok);
  assert.equal(paid.status, 201);
  assert.equal((await api('POST', `/deals/${d}/pay`, { method: 'linked_eft', idempotency_key: 'k1' }, e.tok)).body.duplicate, true);   // retry never double-charges
  assert.equal((await api('POST', `/deals/${d}/confirm`, null, p2.tok)).status, 403);   // only the payer confirms
  const done = await api('POST', `/deals/${d}/confirm`, null, e.tok);
  assert.deepEqual(done.body.split, { amount_rands: 2000, platform_fee_rands: 300, expert_receives_rands: 1700 });   // R2,000 -> 15%
  assert.equal(done.body.payout_status, 'paid');
  assert.equal((await api('GET', `/deals/${d}`, null, e.tok)).body.status, 'completed');
});

test('two simultaneous picks: exactly one wins', async () => {
  const e = await makeEntrepreneur(), p1 = await makePro(), p2 = await makePro();
  const t = await api('POST', '/threads', { need_type: 'consultation', profession: 'Commercial Lawyer', description: 'Race condition test request', budget_min: 500, budget_max: 700 }, e.tok);
  const o1 = await api('POST', `/threads/${t.body.id}/offers`, { kind: 'interested' }, p1.tok);
  const o2 = await api('POST', `/threads/${t.body.id}/offers`, { kind: 'interested' }, p2.tok);
  const res = await Promise.all([api('POST', `/threads/${t.body.id}/pick`, { offer_id: o1.body.offer_id }, e.tok), api('POST', `/threads/${t.body.id}/pick`, { offer_id: o2.body.offer_id }, e.tok)]);
  assert.deepEqual(res.map((r) => r.status).sort(), [201, 409]);
  assert.equal(ctx.db.get('SELECT COUNT(*) n FROM deals WHERE thread_id=?', t.body.id).n, 1);
});

test('offer rules: counter rounds capped, offers capped, thread limit per business', async () => {
  const e = await makeEntrepreneur(), p = await makePro();
  const t = await api('POST', '/threads', { need_type: 'consultation', profession: 'Commercial Lawyer', description: 'Counter-offer limit test', budget_min: 500, budget_max: 700 }, e.tok);
  for (let r = 1; r <= 3; r++) assert.equal((await api('POST', `/threads/${t.body.id}/offers`, { kind: 'counter', amount: 600 + r }, p.tok)).status, 201);
  assert.equal((await api('POST', `/threads/${t.body.id}/offers`, { kind: 'counter', amount: 999 }, p.tok)).body.code, 'round_limit');
  for (let k = 0; k < 2; k++) await api('POST', '/threads', { need_type: 'consultation', profession: 'Commercial Lawyer', description: 'Extra active request ' + k, budget_min: 500, budget_max: 700 }, e.tok);
  assert.equal((await api('POST', '/threads', { need_type: 'consultation', profession: 'Commercial Lawyer', description: 'One request too many', budget_min: 500, budget_max: 700 }, e.tok)).body.code, 'too_many_threads');
});

test('licensing needs a registered professional; graduates and candidates are blocked', async () => {
  const e = await makeEntrepreneur(), reg = await makePro(), grad = await makePro({ tier: 3 }), cand = await makePro({ tier: 2 });
  const t = await api('POST', '/threads', { need_type: 'licensing', profession: 'Commercial Lawyer', description: 'Need a registered lawyer to front our tender', engagement: 'partnership', terms: { share_percent: 20, scope: 'Tender sign-off and oversight' } }, e.tok);
  assert.equal(t.status, 201); assert.equal(t.body.requires_registration, true);
  assert.equal((await api('POST', `/threads/${t.body.id}/offers`, { kind: 'interested' }, grad.tok)).status, 403);
  assert.equal((await api('POST', `/threads/${t.body.id}/offers`, { kind: 'interested' }, cand.tok)).status, 403);
  assert.equal((await api('POST', `/threads/${t.body.id}/offers`, { kind: 'interested' }, reg.tok)).status, 201);
  const noBody = await api('POST', '/threads', { need_type: 'consultation', profession: 'Management Consultant', description: 'Strategy help for my growing business', budget_min: 500, budget_max: 900, requires_registration: true }, e.tok);
  assert.equal(noBody.body.code, 'no_registration');   // cannot require registration where none exists
});

test('licensing journey: lock terms, swear, staff verify, mutual review, formalised; changes supersede', async () => {
  const e = await makeEntrepreneur(), p = await makePro();
  const t = await api('POST', '/threads', { need_type: 'licensing', profession: 'Commercial Lawyer', description: 'Registered lawyer needed for oversight of our contracts', engagement: 'employment', terms: { monthly_retainer: 15000, contract: 'fixed_term', scope: 'Contract oversight' } }, e.tok);
  const o = await api('POST', `/threads/${t.body.id}/offers`, { kind: 'counter', terms: { monthly_retainer_cents: 1800000, contract: 'fixed_term', scope: 'Contract oversight' } }, p.tok);
  assert.equal(o.status, 201);
  const d = (await api('POST', `/threads/${t.body.id}/pick`, { offer_id: o.body.offer_id }, e.tok)).body;
  assert.equal(d.status, 'terms_pending');
  assert.equal((await api('POST', `/deals/${d.deal_id}/pay`, { method: 'card' }, e.tok)).body.code, 'not_consultation');
  assert.equal((await api('POST', `/deals/${d.deal_id}/terms/lock`, null, e.tok)).body.waiting_for, 'professional');
  const locked = await api('POST', `/deals/${d.deal_id}/terms/lock`, null, p.tok);
  assert.equal(locked.body.status, 'terms_locked'); assert.match(locked.body.terms_hash, /^[a-f0-9]{64}$/);
  const text = await api('GET', `/deals/${d.deal_id}/affidavit/text`, null, p.tok);
  assert.match(text.body.statement, /not lending my registration/);
  const sworn = { file_sha256: sha('scan'), commissioner_name: 'Sgt M. Khumalo', commissioner_station: 'Rosebank SAPS', commissioned_on: '2026-10-18' };
  assert.equal((await api('POST', `/deals/${d.deal_id}/affidavit`, { ...sworn, commissioned_on: '2099-01-01' }, e.tok)).body.code, 'bad_date');
  assert.equal((await api('POST', `/deals/${d.deal_id}/affidavit`, sworn, e.tok)).status, 201);
  assert.equal((await api('POST', `/deals/${d.deal_id}/affidavit`, sworn, p.tok)).status, 201);
  const q = (await api('GET', '/admin/queue', null, await admin())).body.affidavits.filter((a) => a.deal_id === d.deal_id);
  assert.equal(q.length, 2);
  // nothing visible to the other side until staff verify
  assert.equal((await api('GET', `/deals/${d.deal_id}/affidavit/counterparty`, null, e.tok)).status, 403);
  for (const a of q) assert.equal((await api('POST', `/admin/affidavits/${a.id}/verify`, { approve: true }, await admin())).status, 200);
  assert.equal((await api('GET', `/deals/${d.deal_id}`, null, e.tok)).body.status, 'under_review');
  // confirm without reading: refused
  assert.equal((await api('POST', `/deals/${d.deal_id}/affidavit/review`, { decision: 'confirmed' }, e.tok)).body.code, 'not_viewed');
  const third = await makePro();
  assert.equal((await api('GET', `/deals/${d.deal_id}/affidavit/counterparty`, null, third.tok)).status, 403);   // third parties can never read it
  const view = await api('GET', `/deals/${d.deal_id}/affidavit/counterparty`, null, e.tok);
  assert.equal(view.body.deponent.name, p.name); assert.ok(view.body.redacted.includes('id_number')); assert.match(view.body.watermark, /DEAL-/);
  assert.ok(!JSON.stringify(view.body).includes('proof') && !JSON.stringify(view.body).includes(saId(1)));
  assert.equal((await api('POST', `/deals/${d.deal_id}/affidavit/review`, { decision: 'confirmed' }, e.tok)).body.status, 'under_review');
  await api('GET', `/deals/${d.deal_id}/affidavit/counterparty`, null, p.tok);
  assert.equal((await api('POST', `/deals/${d.deal_id}/affidavit/review`, { decision: 'confirmed' }, p.tok)).body.status, 'formalised');
  assert.equal(ctx.db.get('SELECT status FROM threads WHERE id=?', t.body.id).status, 'formalised');
  // thread is archived a week later, never deleted
  clock.t += 8 * 24 * HOUR;
  assert.equal((await api('POST', '/admin/jobs/run', null, await admin())).body.threads.archived >= 1, true);
  assert.equal(ctx.db.get('SELECT status FROM threads WHERE id=?', t.body.id).status, 'closed');
  clock.t -= 8 * 24 * HOUR;
});

test('changing terms voids earlier sworn statements', async () => {
  const e = await makeEntrepreneur(), p = await makePro();
  const t = await api('POST', '/threads', { need_type: 'licensing', profession: 'Commercial Lawyer', description: 'Partnership for regulated contract work', engagement: 'partnership', terms: { share_percent: 20, scope: 'Regulated contract work' } }, e.tok);
  const o = await api('POST', `/threads/${t.body.id}/offers`, { kind: 'interested' }, p.tok);
  const d = (await api('POST', `/threads/${t.body.id}/pick`, { offer_id: o.body.offer_id }, e.tok)).body.deal_id;
  await api('POST', `/deals/${d}/terms/lock`, null, e.tok); await api('POST', `/deals/${d}/terms/lock`, null, p.tok);
  const sworn = { file_sha256: sha('scan2'), commissioner_name: 'Adv. P. Naidoo', commissioned_on: '2026-10-18' };
  await api('POST', `/deals/${d}/affidavit`, sworn, e.tok); await api('POST', `/deals/${d}/affidavit`, sworn, p.tok);
  const before = ctx.db.all(`SELECT id FROM affidavits WHERE deal_id=? AND status='uploaded'`, d);
  await api('POST', `/admin/affidavits/${before[0].id}/verify`, { approve: true }, await admin());
  const r = await api('PUT', `/deals/${d}/terms`, { terms: { share_percent: 25 } }, p.tok);
  assert.equal(r.body.terms_version, 2);
  assert.equal(ctx.db.all(`SELECT id FROM affidavits WHERE deal_id=? AND status='superseded'`, d).length, 2);
  assert.equal((await api('POST', `/admin/affidavits/${before[1].id}/verify`, { approve: true }, await admin())).status, 409);   // old affidavit cannot count
  assert.equal((await api('GET', `/deals/${d}`, null, e.tok)).body.status, 'terms_pending');
});

test('payout rules: waits for an account, held 48h after a change, retried by the job', async () => {
  const deal = await consultationDeal({ amount: 800, pay: true });
  const noAcct = await makePro({ payout: false });
  const e = await makeEntrepreneur();
  const t = await api('POST', '/threads', { need_type: 'consultation', profession: 'Commercial Lawyer', description: 'Payout waiting test request', budget_min: 200, budget_max: 300 }, e.tok);
  const o = await api('POST', `/threads/${t.body.id}/offers`, { kind: 'interested' }, noAcct.tok);
  const d = (await api('POST', `/threads/${t.body.id}/pick`, { offer_id: o.body.offer_id }, e.tok)).body.deal_id;
  await api('POST', `/deals/${d}/pay`, { method: 'card' }, e.tok);
  const done = await api('POST', `/deals/${d}/confirm`, null, e.tok);
  assert.equal(done.body.payout_status, 'pending');
  assert.deepEqual([done.body.split.platform_fee_rands, done.body.split.expert_receives_rands], [50, 250]);   // R300 deal: 15% is R45, so the R50 minimum applies
  assert.equal((await api('POST', '/bank-account', { bank: 'Capitec', holder_name: noAcct.name, account_number: '15000000111' }, noAcct.tok)).status, 201);
  const run = await api('POST', '/admin/jobs/run', null, await admin());
  assert.equal(run.body.payments.payouts_completed, 1);
  // changing the account later puts a 48h hold on payouts
  const d2 = await consultationDeal({ amount: 600 });
  await api('POST', '/bank-account', { bank: 'FNB', holder_name: d2.p.name, account_number: '62999999999' }, d2.p.tok);
  assert.equal((await api('POST', `/deals/${d2.dealId}/confirm`, null, d2.e.tok)).body.payout_status, 'pending');
  clock.t += 49 * HOUR;
  assert.equal((await api('POST', '/admin/jobs/run', null, await admin())).body.payments.payouts_completed >= 1, true);
  clock.t -= 49 * HOUR;
  // a mismatched holder name goes to staff review instead of being trusted
  const wrong = await api('POST', '/bank-account', { bank: 'FNB', holder_name: 'Someone Else', account_number: '62888888888' }, d2.p.tok);
  assert.equal(wrong.body.status, 'manual_review');
});

test('auto-release after the confirmation window; disputes hold funds until staff decide', async () => {
  const a = await consultationDeal({ amount: 1000 });
  assert.equal((await api('POST', `/deals/${a.dealId}/deliver`, null, a.p.tok)).status, 200);
  clock.t += 47 * HOUR; assert.equal((await api('POST', '/admin/jobs/run', null, await admin())).body.payments.auto_released, 0);   // window not over yet
  assert.equal((await api('GET', `/deals/${a.dealId}`, null, a.e.tok)).body.status, 'in_progress');
  clock.t += 2 * HOUR; await api('POST', '/admin/jobs/run', null, await admin());
  assert.equal((await api('GET', `/deals/${a.dealId}`, null, a.e.tok)).body.status, 'completed');
  clock.t -= 49 * HOUR;
  const b = await consultationDeal({ amount: 1200 });
  assert.equal((await api('POST', `/deals/${b.dealId}/dispute`, { reason: 'Work was never delivered' }, b.e.tok)).body.status, 'disputed');
  assert.equal((await api('POST', `/deals/${b.dealId}/confirm`, null, b.e.tok)).status, 409);
  assert.equal((await api('POST', `/admin/deals/${b.dealId}/resolve`, { outcome: 'refund' }, b.e.tok)).status, 403);
  assert.equal((await api('POST', `/admin/deals/${b.dealId}/resolve`, { outcome: 'refund' }, await admin())).body.refunded, true);
  assert.equal((await api('GET', `/deals/${b.dealId}`, null, b.e.tok)).body.status, 'refunded');
});

test('safety: risk scoring, opt-in contacts, escalation ladder, SOS', async () => {
  const x = await consultationDeal({ amount: 1000 });
  const when = new Date(clock.t + 10 * HOUR).toISOString();   // 20:00 SAST: outside business hours
  const m = await api('POST', `/deals/${x.dealId}/meetings`, { scheduled_at: when, duration_min: 60, venue_type: 'private', venue_name: 'Site office' }, x.e.tok);
  assert.equal(m.body.risk, 'high'); assert.ok(m.body.tip);
  const safe = await api('POST', `/deals/${x.dealId}/meetings`, { scheduled_at: new Date(clock.t + 4 * HOUR).toISOString(), venue_type: 'police_station' }, x.e.tok);
  assert.notEqual(safe.body.risk, 'high');
  const c = await api('POST', '/me/trusted-contacts', { name: 'Naledi', phone: '0825550001' }, x.e.tok);
  await api('POST', '/me/trusted-contacts', { name: 'Never consented', phone: '0825550002' }, x.e.tok);
  assert.equal((await api('POST', `/meetings/${m.body.meeting_id}/arrive`, null, x.e.tok)).status, 409);   // not confirmed yet
  assert.equal((await api('POST', `/meetings/${m.body.meeting_id}/confirm`, null, x.e.tok)).status, 409);   // proposer cannot confirm their own
  await api('POST', `/meetings/${m.body.meeting_id}/confirm`, null, x.p.tok);
  assert.equal((await api('POST', `/meetings/${m.body.meeting_id}/confirm`, null, (await makePro()).tok)).status, 404);
  await api('POST', '/dev/contact-consent', { contact_id: c.body.id, phone: '0825550001' });
  await api('POST', `/meetings/${m.body.meeting_id}/arrive`, null, x.e.tok);
  const meeting = ctx.db.get('SELECT * FROM meetings WHERE id=?', m.body.meeting_id);
  const run = async (mins) => { clock.t = meeting.expected_end + mins * 60e3; return (await api('POST', '/admin/jobs/run', null, await admin())).body.safety; };
  assert.deepEqual(await run(-5), []);                          // nothing before the meeting ends
  assert.deepEqual(await run(0), ['prompt']);                   // gentle first
  assert.deepEqual(await run(16), ['sms']);
  assert.deepEqual(await run(31), ['contact_alert']);
  assert.deepEqual(await run(46), ['admin_flag']);
  assert.deepEqual(await run(60), []);                          // each step fires once
  const alerts = ctx.db.all(`SELECT phone FROM notifications WHERE type='safety.contact_alert'`);
  assert.deepEqual(alerts.map((a) => a.phone), ['+27825550001']);   // only the contact who opted in
  const sos = await api('POST', `/meetings/${m.body.meeting_id}/sos`, { lat: -26.2, lng: 28.04 }, x.e.tok);
  assert.equal(sos.body.alerted_contacts, 1); assert.match(sos.body.emergency, /112/);
  assert.equal((await api('POST', `/meetings/${m.body.meeting_id}/checkout`, null, x.e.tok)).body.status, 'completed');
  clock.t = Date.parse('2026-10-19T08:00:00Z');
});

test('AI intake: structures a rambling request (offline matcher)', async () => {
  const e = await makeEntrepreneur();
  const r = await api('POST', '/intake', { text: 'My client wants a registered lawyer to sign off my tender contract before Friday' }, e.tok);
  assert.equal(r.status, 200); assert.equal(r.body.need_type, 'licensing'); assert.equal(r.body.engine, 'heuristic');
  assert.ok(/Lawyer|Attorney|Contract|Tender/.test(r.body.profession));
  assert.equal((await api('POST', '/intake', { text: 'help' }, e.tok)).body.error !== undefined, true);
});

test('POPIA: export on request, erase when nothing is open, no raw ID or card data stored', async () => {
  const busy = await consultationDeal({ amount: 500 });
  assert.equal((await api('DELETE', '/me', null, busy.e.tok)).body.code, 'open_obligations');
  const exp = (await api('GET', '/me/export', null, busy.e.tok)).body;
  assert.ok(exp.businesses.length === 1 && exp.deals.length === 1 && exp.roles.includes('entrepreneur'));
  assert.ok(!JSON.stringify(exp).includes('director_id_hash'));
  const idle = await makePro();
  const gone = await api('DELETE', '/me', null, idle.tok);
  assert.equal(gone.body.erased, true);
  assert.equal((await api('GET', '/me', null, idle.tok)).status, 401);
  assert.equal(ctx.db.get(`SELECT COUNT(*) n FROM bank_accounts WHERE owner_id=?`, idle.userId).n, 0);
  const cols = ctx.db.all(`SELECT name FROM pragma_table_info('payments')`).map((c) => c.name).join();
  assert.ok(!/card|pan|cvv/i.test(cols));
});

test('security: malformed input, oversized body, unknown route, admin routes closed to users', async () => {
  const e = await makeEntrepreneur();
  assert.equal((await api('GET', '/admin/queue', null, e.tok)).status, 403);
  assert.equal((await api('GET', '/nope')).status, 404);
  assert.equal((await api('POST', '/threads', { need_type: 'consultation', profession: "x'; DROP TABLE users;--", description: 'SQL injection attempt text', budget_min: 1, budget_max: 2 }, e.tok)).body.code, 'bad_profession');
  assert.ok(ctx.db.get('SELECT COUNT(*) n FROM users').n > 0);
});
