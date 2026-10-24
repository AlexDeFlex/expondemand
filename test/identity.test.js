import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { api, login, admin, clock, ctx, close, sha, saId, makePro } from './helpers.js';
import { config } from '../src/config.js';

after(close);
const MIN = 60e3;
const biz = (tok, name, n, id) => api('POST', '/business', { company_name: name, cipc_number: `2018/70${String(n).padStart(4, '0')}/07`, director_id: id }, tok);
const approve = async (id) => api('POST', `/admin/businesses/${id}/review`, { approve: true }, await admin());
const sds = (tok, business_id) => api('POST', '/business/sds', { business_id, accept: true, answers: { services: 'Construction and renovations', payment_terms: 'Within 2 days', dispute_process: 'Written complaint', no_licence_misuse: true } }, tok);
const post = (tok, extra) => api('POST', '/threads', { need_type: 'consultation', profession: 'Commercial Lawyer', description: 'Supplier agreement needs a review', budget_min: 500, budget_max: 900, ...extra }, tok);

test('several businesses on one phone number: allowed for the same person, refused for anyone else', async () => {
  const tok = await login('0824440001', 'entrepreneur'), id = saId(7001);
  const b1 = await biz(tok, 'First Co (Pty) Ltd', 1, id), b2 = await biz(tok, 'Second Co (Pty) Ltd', 2, id);
  assert.equal(b1.status, 201); assert.equal(b2.status, 201);
  const other = await biz(tok, 'Stranger Co (Pty) Ltd', 3, saId(7002));         // a different person's ID on this phone
  assert.equal(other.status, 409); assert.equal(other.body.code, 'identity_mismatch');
  assert.equal(b1.body.director_id_hash, undefined);
  await approve(b1.body.id); await approve(b2.body.id);
  assert.equal((await sds(tok, b1.body.id)).status, 201);                        // only the first business signs its standards
  const me = (await api('GET', '/me', null, tok)).body;
  assert.equal(me.businesses.length, 2); assert.equal(me.identity_linked, true);
  assert.deepEqual(me.businesses.map((b) => [b.can_post, b.blocked_at]), [[true, null], [false, 'sds']]);   // each business has its own gate
  assert.equal((await post(tok)).body.code, 'business_required');               // two businesses: say which one
  assert.equal((await post(tok, { business_id: b2.body.id })).body.code, 'gate_sds');
  assert.equal((await sds(tok)).body.code, 'business_required');
  const t = await post(tok, { business_id: b1.body.id }); assert.equal(t.status, 201);
  assert.equal(ctx.db.get('SELECT business_id FROM threads WHERE id=?', t.body.id).business_id, b1.body.id);
  assert.equal((await sds(tok, b2.body.id)).status, 201);
  assert.equal((await post(tok, { business_id: b2.body.id })).status, 201);     // now the second business can post too
  // each business has its own bank account
  const link = (business_id, n, holder) => api('POST', '/bank-account', { business_id, bank: 'FNB', holder_name: holder, account_number: n }, tok);
  assert.equal((await link(undefined, '62000000111', 'First Co (Pty) Ltd')).body.code, 'business_required');
  assert.equal((await link(b1.body.id, '62000000111', 'First Co (Pty) Ltd')).body.status, 'verified');
  assert.equal((await link(b2.body.id, '62000000222', 'Second Co (Pty) Ltd')).body.status, 'verified');
  assert.equal((await api('GET', `/bank-account?business_id=${b1.body.id}`, null, tok)).body.account.last4, '0111');
  assert.equal((await api('GET', `/bank-account?business_id=${b2.body.id}`, null, tok)).body.account.last4, '0222');
  // nobody else can act for my business
  const rival = await login('0824440002', 'entrepreneur');
  assert.equal((await post(rival, { business_id: b1.body.id })).status, 403);
  assert.equal((await sds(rival, b1.body.id)).status, 403);
});

test('one phone number, both roles: the same ID, one hat at a time, never both sides of the same deal', async () => {
  const tok = await login('0824440011', 'entrepreneur'), id = saId(7011);
  const b = await biz(tok, 'Dual Co (Pty) Ltd', 11, id); await approve(b.body.id); await sds(tok, b.body.id);
  const as = (t) => api('GET', '/me', null, t);
  assert.deepEqual((await as(tok)).body.roles, ['entrepreneur']);
  const profile = (extra) => api('POST', '/professional', { full_name: 'Dual Person', tier: 1, profession: 'Commercial Lawyer', reg_number: 'LPC-7011', proof_sha256: sha('p7011'), id_number: id, ...extra }, tok);
  // add the professional hat: must be the same person
  assert.equal((await api('POST', '/me/roles', { role: 'professional', id_number: saId(7099) }, tok)).body.code, 'identity_mismatch');
  assert.equal((await api('POST', '/me/roles', { role: 'professional', id_number: '123' }, tok)).body.code, 'bad_id_number');
  const added = await api('POST', '/me/roles', { role: 'professional', id_number: id }, tok);
  assert.equal(added.status, 200); assert.deepEqual(added.body.roles, ['entrepreneur', 'professional']); assert.equal(added.body.role, 'professional');
  assert.equal((await profile({ id_number: saId(7098) })).body.code, 'identity_mismatch');   // the profile must also be the same person
  const pr = await profile(); assert.equal(pr.status, 201);
  await api('POST', `/admin/professionals/${pr.body.user_id}/review`, { approve: true }, await admin());
  // one hat at a time, on the same sign-in
  assert.equal((await api('GET', '/feed', null, tok)).status, 200);              // professional hat is on
  assert.equal((await post(tok, { business_id: b.body.id })).status, 403);       // cannot post as an entrepreneur right now
  assert.equal((await api('POST', '/auth/switch-role', { role: 'entrepreneur' }, tok)).body.role, 'entrepreneur');
  assert.equal((await api('GET', '/feed', null, tok)).status, 403);
  const own = await post(tok);
  assert.equal(own.status, 201); assert.equal(own.body.notified, 0, 'you are not alerted about your own request');
  // wearing the professional hat, you cannot answer your own request
  await api('POST', '/auth/switch-role', { role: 'professional' }, tok);
  assert.equal((await api('GET', '/feed', null, tok)).body.threads.some((t) => t.id === own.body.id), false);
  const offer = await api('POST', `/threads/${own.body.id}/offers`, { kind: 'interested' }, tok);
  assert.equal(offer.status, 403); assert.equal(offer.body.code, 'own_request');
  assert.equal((await api('POST', '/auth/switch-role', { role: 'admin' }, tok)).body.code, 'role_not_registered');
  // other people are unaffected: a different expert can answer it
  const other = await makePro(); assert.equal((await api('POST', `/threads/${own.body.id}/offers`, { kind: 'interested' }, other.tok)).status, 201);
});

test('signing in with a role you have not added yet is explained, and adding it needs a recent code', async () => {
  const phone = '0824440021', tok = await login(phone, 'professional');
  await api('POST', '/auth/request-otp', { phone });
  const r = await api('POST', '/auth/verify-otp', { phone, code: '123456', role: 'entrepreneur', mode: 'signin' });
  assert.equal(r.status, 200); assert.equal(r.body.missing_role, 'entrepreneur'); assert.deepEqual(r.body.roles, ['professional']);
  assert.equal(r.body.user.role, 'professional');                                // signed in with the role they do have
  assert.equal((await api('POST', '/auth/switch-role', { role: 'entrepreneur' }, r.body.token)).body.code, 'role_not_registered');
  clock.t += 11 * MIN;
  const stale = await api('POST', '/me/roles', { role: 'entrepreneur', id_number: saId(7021) }, r.body.token);
  assert.equal(stale.body.code, 'step_up_required');                             // identity changes need a fresh code
  await api('POST', '/auth/step-up/request', null, r.body.token); await api('POST', '/auth/step-up/verify', { code: '123456' }, r.body.token);
  assert.equal((await api('POST', '/me/roles', { role: 'entrepreneur', id_number: saId(7021) }, r.body.token)).status, 200);
  clock.t -= 11 * MIN; void tok;
});

test('one person, one phone number (outside demo mode); demo mode relaxes it for fake data', async () => {
  const id = saId(7031);
  const a = await login('0824440031', 'entrepreneur'), b = await login('0824440032', 'entrepreneur');
  assert.equal((await biz(a, 'Solo Co (Pty) Ltd', 31, id)).status, 201);
  const clash = await biz(b, 'Clone Co (Pty) Ltd', 32, id);
  assert.equal(clash.status, 409); assert.equal(clash.body.code, 'identity_taken');
  config.demo = true;
  try { assert.equal((await biz(b, 'Clone Co (Pty) Ltd', 32, id)).status, 201); } finally { config.demo = false; }
});

test('a professional must give a valid ID number; erasing an account frees the ID', async () => {
  const tok = await login('0824440041', 'professional');
  const send = (extra) => api('POST', '/professional', { full_name: 'Erase Me', tier: 1, profession: 'Commercial Lawyer', reg_number: 'LPC-1', proof_sha256: sha('p'), ...extra }, tok);
  assert.equal((await send({})).body.code, 'bad_id_number');
  const id = saId(7041); assert.equal((await send({ id_number: id })).status, 201);
  const exp = (await api('GET', '/me/export', null, tok)).body;
  assert.equal(exp.id_number_last4, id.slice(-4)); assert.ok(!JSON.stringify(exp).includes(id));   // never the full ID
  assert.equal((await api('DELETE', '/me', null, tok)).body.erased, true);
  const fresh = await login('0824440042', 'entrepreneur');
  assert.equal((await biz(fresh, 'Reborn Co (Pty) Ltd', 42, id)).status, 201);   // the ID can be used again on a new number
});
