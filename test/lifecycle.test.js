import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { api, admin, ctx, close, sha, makeEntrepreneur, makePro, consultationDeal, licensingDeal } from './helpers.js';

after(close);
const post = (e, extra = {}) => api('POST', '/threads', { need_type: 'consultation', profession: 'Commercial Lawyer', description: 'Need several experts for supplier contracts', budget_min: 500, budget_max: 900, ...extra }, e.tok);
const offer = (t, p) => api('POST', `/threads/${t}/offers`, { kind: 'interested' }, p.tok);

test('hire more consultants: add a position, earlier offers come back, pick again', async () => {
  const e = await makeEntrepreneur(), a = await makePro(), b = await makePro(), c = await makePro();
  const t = (await post(e)).body.id;
  const oa = (await offer(t, a)).body.offer_id, ob = (await offer(t, b)).body.offer_id;
  const d1 = await api('POST', `/threads/${t}/pick`, { offer_id: oa }, e.tok);
  assert.equal(d1.status, 201); assert.equal(d1.body.still_hiring, false);          // asked for 1, hired 1
  assert.equal((await api('POST', `/threads/${t}/pick`, { offer_id: ob }, e.tok)).body.code, 'positions_full');
  assert.equal((await offer(t, c)).status, 409);                                      // closed to new offers meanwhile
  const more = await api('POST', `/threads/${t}/positions`, { count: 1 }, e.tok);
  assert.equal(more.status, 201); assert.equal(more.body.positions, 2); assert.equal(more.body.revived_offers, 1);
  assert.equal((await api('GET', '/threads/mine', null, e.tok)).body.threads[0].offers.some((o) => o.id === ob), true);   // b's offer is back
  assert.equal((await offer(t, c)).status, 201);                                      // new experts can bid again
  const d2 = await api('POST', `/threads/${t}/pick`, { offer_id: ob }, e.tok);
  assert.equal(d2.status, 201); assert.equal(d2.body.filled, 2);
  assert.notEqual(d1.body.deal_id, d2.body.deal_id);                                  // a separate deal per expert
  assert.equal((await api('GET', '/deals', null, e.tok)).body.deals.length >= 2, true);
  assert.equal(ctx.db.get('SELECT status FROM threads WHERE id=?', t).status, 'matched');
  // both deals finish: the request settles
  for (const d of [d1.body.deal_id, d2.body.deal_id]) { await api('POST', `/deals/${d}/pay`, { method: 'card' }, e.tok); await api('POST', `/deals/${d}/confirm`, null, e.tok); }
  assert.equal(ctx.db.get('SELECT status FROM threads WHERE id=?', t).status, 'formalised');
});

test('ask for several experts up front; limits and licensing rules', async () => {
  const e = await makeEntrepreneur(), a = await makePro(), b = await makePro(), c = await makePro();
  const t = (await post(e, { positions: 2 })).body;
  assert.equal(t.positions, 2);
  const [oa, ob, oc] = [(await offer(t.id, a)).body.offer_id, (await offer(t.id, b)).body.offer_id, (await offer(t.id, c)).body.offer_id];
  const first = await api('POST', `/threads/${t.id}/pick`, { offer_id: oa }, e.tok);
  assert.equal(first.body.still_hiring, true);                                        // others stay open until both places are filled
  assert.equal((await api('GET', '/feed', null, c.tok)).body.threads.length >= 1, true);
  assert.equal((await api('POST', `/threads/${t.id}/pick`, { offer_id: ob }, e.tok)).body.still_hiring, false);
  assert.equal((await api('POST', `/threads/${t.id}/pick`, { offer_id: oc }, e.tok)).body.code, 'positions_full');
  assert.equal((await api('POST', `/threads/${t.id}/positions`, { count: 4 }, e.tok)).body.code, 'too_many_positions');   // cap of 5
  const lic = await api('POST', '/threads', { need_type: 'licensing', profession: 'Commercial Lawyer', description: 'Registered lawyer to front our tender', engagement: 'partnership', terms: { share_percent: 10, scope: 'Tender oversight' }, positions: 4 }, e.tok);
  assert.equal(lic.body.positions, 1);                                                // licensing is always one professional
  assert.equal((await api('POST', `/threads/${lic.body.id}/positions`, { count: 1 }, e.tok)).body.code, 'one_licensing');
  assert.equal((await api('POST', `/threads/${t.id}/positions`, { count: 1 }, (await makeEntrepreneur()).tok)).status, 403);   // only the owner
});

test('cancel before payment: either side can walk away, the place reopens, pick someone else', async () => {
  const e = await makeEntrepreneur(), a = await makePro(), b = await makePro();
  const t = (await post(e)).body.id;
  const oa = (await offer(t, a)).body.offer_id, ob = (await offer(t, b)).body.offer_id;
  const d = (await api('POST', `/threads/${t}/pick`, { offer_id: oa }, e.tok)).body.deal_id;
  assert.equal((await api('POST', `/deals/${d}/cancel`, { reason: 'x' }, a.tok)).status, 400);                  // a reason is required
  assert.equal((await api('POST', `/deals/${d}/cancel`, { reason: 'Something came up' }, (await makePro()).tok)).status, 403);   // strangers cannot
  const out = await api('POST', `/deals/${d}/cancel`, { reason: 'I am no longer available' }, a.tok);          // the expert cancels alone
  assert.equal(out.body.status, 'cancelled'); assert.equal(out.body.request_reopened, true);
  assert.equal((await api('GET', `/deals/${d}`, null, e.tok)).body.status, 'cancelled');
  const mine = (await api('GET', '/threads/mine', null, e.tok)).body.threads[0];
  assert.equal(mine.status, 'has_offers');
  assert.equal(mine.offers.some((o) => o.id === ob), true);                           // the other expert's offer is back
  assert.equal(mine.offers.some((o) => o.id === oa), false);                          // the one who cancelled is not
  assert.equal((await api('POST', `/threads/${t}/pick`, { offer_id: ob }, e.tok)).status, 201);
  assert.equal((await api('POST', `/deals/${d}/cancel`, { reason: 'Again?' }, e.tok)).body.code, 'bad_state');   // already cancelled
});

test('cancel after payment needs both sides; refund goes back to the payer; either can decline', async () => {
  const x = await consultationDeal({ amount: 1000 });
  const first = await api('POST', `/deals/${x.dealId}/cancel`, { reason: 'Client changed plans' }, x.e.tok);
  assert.equal(first.body.waiting_for, 'professional'); assert.equal(first.body.cancel_requested_by, 'entrepreneur');
  assert.equal((await api('GET', `/deals/${x.dealId}`, null, x.p.tok)).body.cancel_requested_by, 'entrepreneur');
  assert.equal((await api('POST', `/deals/${x.dealId}/cancel`, { reason: 'again' }, x.e.tok)).body.code, 'already_requested');   // cannot approve your own request
  assert.equal((await api('POST', `/deals/${x.dealId}/cancel/decline`, null, x.p.tok)).status, 200);
  assert.equal((await api('GET', `/deals/${x.dealId}`, null, x.e.tok)).body.status, 'in_progress');             // declined: carries on
  await api('POST', `/deals/${x.dealId}/cancel`, { reason: 'Client changed plans' }, x.e.tok);
  const done = await api('POST', `/deals/${x.dealId}/cancel`, { reason: 'Fine, agreed' }, x.p.tok);
  assert.equal(done.body.status, 'cancelled'); assert.equal(done.body.refunded_rands, 1000);
  const view = (await api('GET', `/deals/${x.dealId}`, null, x.e.tok)).body;
  assert.equal(view.payment.status, 'refunded');
  assert.equal((await api('POST', `/deals/${x.dealId}/confirm`, null, x.e.tok)).status, 409);                   // no payout possible after a refund
  assert.equal(ctx.db.get('SELECT payout_status FROM payments WHERE deal_id=?', x.dealId).payout_status, 'none');
  const finished = await consultationDeal({ amount: 600 });
  await api('POST', `/deals/${finished.dealId}/confirm`, null, finished.e.tok);
  assert.equal((await api('POST', `/deals/${finished.dealId}/cancel`, { reason: 'Too late now' }, finished.e.tok)).body.code, 'bad_state');   // completed deals are final
});

test('formalised licensing deal: end it by agreement, then remove it from your list', async () => {
  const x = await licensingDeal();
  assert.equal((await api('DELETE', `/deals/${x.dealId}`, null, x.e.tok)).body.code, 'cancel_first');            // cannot just delete a sworn deal
  const ask = await api('POST', `/deals/${x.dealId}/cancel`, { reason: 'Partnership ended by agreement' }, x.p.tok);
  assert.equal(ask.body.waiting_for, 'entrepreneur');
  assert.equal((await api('GET', `/deals/${x.dealId}`, null, x.e.tok)).body.status, 'formalised');              // still in force until both agree
  const end = await api('POST', `/deals/${x.dealId}/cancel`, { reason: 'Agreed' }, x.e.tok);
  assert.equal(end.body.status, 'cancelled');
  assert.equal(ctx.db.all(`SELECT id FROM affidavits WHERE deal_id=? AND status='superseded'`, x.dealId).length, 2);   // affidavits kept as evidence, no longer in force
  assert.equal((await api('GET', `/deals/${x.dealId}/affidavit/counterparty`, null, x.e.tok)).status, 403);
  // remove from your list: only you, never the other party's record
  assert.equal((await api('DELETE', `/deals/${x.dealId}`, null, x.e.tok)).body.removed_from_your_list, true);
  assert.equal((await api('GET', '/deals', null, x.e.tok)).body.deals.some((d) => d.id === x.dealId), false);
  assert.equal((await api('GET', '/deals', null, x.p.tok)).body.deals.some((d) => d.id === x.dealId), true);
  assert.equal(ctx.db.get('SELECT COUNT(*) n FROM deals WHERE id=?', x.dealId).n, 1);                           // the record itself is never deleted
  const live = await consultationDeal({ amount: 700 });
  assert.equal((await api('DELETE', `/deals/${live.dealId}`, null, live.e.tok)).body.code, 'bad_state');        // active deals must be cancelled first
  assert.equal((await api('DELETE', `/deals/${live.dealId}`, null, (await makePro()).tok)).status, 403);
});

test('cancelling before formalisation voids pending affidavits', async () => {
  const x = await licensingDeal({ stopAt: 'picked' });
  await api('POST', `/deals/${x.dealId}/terms/lock`, null, x.e.tok); await api('POST', `/deals/${x.dealId}/terms/lock`, null, x.p.tok);
  const sworn = { file_sha256: sha('s'), commissioner_name: 'Adv. P. Naidoo', commissioned_on: '2026-10-18' };
  await api('POST', `/deals/${x.dealId}/affidavit`, sworn, x.e.tok);
  assert.equal((await api('POST', `/deals/${x.dealId}/cancel`, { reason: 'We could not agree on terms' }, x.e.tok)).body.status, 'cancelled');
  const pending = ctx.db.all(`SELECT id FROM affidavits WHERE deal_id=? AND status='uploaded'`, x.dealId);
  assert.equal(pending.length, 0);
});
