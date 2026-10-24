process.env.NODE_ENV = 'test';
process.env.ADMIN_PHONE = '0821110000';
process.env.TOKEN_TTL_HOURS ||= '10000';   // tests jump the clock days ahead; sessions must outlive that
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const { createContext, createApp } = await import('../src/app.js');
const { openDb } = await import('../src/db.js');
const { MockProvider } = await import('../src/payments.js');

export const clock = { t: Date.parse('2026-10-19T08:00:00Z'), now() { return this.t; } };   // a Monday morning in SA
export const provider = new MockProvider();
export const ctx = createContext({ db: openDb(':memory:'), provider, clock });
const server = createApp(ctx).listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
export const close = () => server.close();
export const sha = (s) => createHash('sha256').update(s).digest('hex');

export async function api(method, path, body, token) {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}
export async function login(phone, role) {
  await api('POST', '/auth/request-otp', { phone });
  const r = await api('POST', '/auth/verify-otp', { phone, code: '123456', role });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.token;
}
let n = 0;
export const next = () => ++n;
const luhnOk = (s) => { let t = 0, d = false; for (let i = s.length - 1; i >= 0; i--) { let x = +s[i]; if (d) { x *= 2; if (x > 9) x -= 9; } t += x; d = !d; } return t % 10 === 0; };
export const saId = (seed) => { const base12 = '800101' + String(5000 + (seed % 4000)).padStart(4, '0') + '08'; for (let c = 0; c < 10; c++) if (luhnOk(base12 + c)) return base12 + c; };

export async function admin() { return login('0821110000'); }

export async function makeEntrepreneur({ verified = true, sds = true } = {}) {
  const i = next(), phone = `082${String(i).padStart(7, '0')}`;
  const tok = await login(phone, 'entrepreneur');
  const company = `Mokoena Build ${i} (Pty) Ltd`;
  const b = await api('POST', '/business', { company_name: company, cipc_number: `2020/${100000 + i}/07`, director_id: saId(i) }, tok);
  assert.equal(b.status, 201, JSON.stringify(b.body));
  if (verified) assert.equal((await api('POST', `/admin/businesses/${b.body.id}/review`, { approve: true }, await admin())).status, 200);
  if (sds) assert.equal((await api('POST', '/business/sds', { accept: true, answers: { services: 'Construction and renovations', payment_terms: '30 days', dispute_process: 'Written complaint within 7 days', no_licence_misuse: true } }, tok)).status, 201);
  return { tok, phone, company, businessId: b.body.id };
}
export async function makePro({ tier = 1, profession = 'Commercial Lawyer', verified = true, payout = true } = {}) {
  const i = next(), phone = `083${String(i).padStart(7, '0')}`;
  const tok = await login(phone, 'professional');
  const body = { full_name: `Thandi Expert${i}`, tier, profession, proof_sha256: sha('proof' + i), id_number: saId(i + 1000) };
  if (tier === 3) body.institution = 'University of the Witwatersrand'; else body.reg_number = `REG${1000 + i}`;
  if (tier === 2) { const sup = await makePro({ tier: 1, profession }); body.supervisor_phone = sup.phone; }
  const r = await api('POST', '/professional', body, tok);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  if (verified) assert.equal((await api('POST', `/admin/professionals/${r.body.user_id}/review`, { approve: true }, await admin())).status, 200);
  if (verified && payout) assert.equal((await api('POST', '/bank-account', { bank: 'FNB', holder_name: body.full_name, account_number: '6200000' + String(1000 + i), account_type: 'cheque' }, tok)).status, 201);
  return { tok, phone, userId: r.body.user_id, name: body.full_name };
}
export async function consultationDeal({ amount = 1500, profession = 'Commercial Lawyer', pay = true } = {}) {
  const e = await makeEntrepreneur(), p = await makePro({ profession });
  const t = await api('POST', '/threads', { need_type: 'consultation', profession, description: 'Need a supplier agreement reviewed before signing', budget_min: amount - 100, budget_max: amount, urgency: 'today' }, e.tok);
  assert.equal(t.status, 201, JSON.stringify(t.body));
  const o = await api('POST', `/threads/${t.body.id}/offers`, { kind: 'interested', note: '12 years in this field' }, p.tok);
  assert.equal(o.status, 201, JSON.stringify(o.body));
  const pick = await api('POST', `/threads/${t.body.id}/pick`, { offer_id: o.body.offer_id }, e.tok);
  assert.equal(pick.status, 201, JSON.stringify(pick.body));
  const dealId = pick.body.deal_id;
  if (pay) assert.equal((await api('POST', `/deals/${dealId}/pay`, { method: 'card', token: 'tok_visa' }, e.tok)).status, 201);
  return { e, p, threadId: t.body.id, dealId };
}

/** A licensing deal taken all the way to 'formalised' (or stopped earlier). */
export async function licensingDeal({ stopAt = 'formalised' } = {}) {
  const e = await makeEntrepreneur(), p = await makePro();
  const t = await api('POST', '/threads', { need_type: 'licensing', profession: 'Commercial Lawyer', description: 'Registered lawyer needed for oversight of our contracts', engagement: 'partnership', terms: { share_percent: 20, scope: 'Contract oversight' } }, e.tok);
  const o = await api('POST', `/threads/${t.body.id}/offers`, { kind: 'interested' }, p.tok);
  const dealId = (await api('POST', `/threads/${t.body.id}/pick`, { offer_id: o.body.offer_id }, e.tok)).body.deal_id;
  const out = { e, p, threadId: t.body.id, dealId };
  if (stopAt === 'picked') return out;
  await api('POST', `/deals/${dealId}/terms/lock`, null, e.tok); await api('POST', `/deals/${dealId}/terms/lock`, null, p.tok);
  const sworn = { file_sha256: sha('scan' + dealId), commissioner_name: 'Sgt M. Khumalo', commissioned_on: '2026-10-18' };
  await api('POST', `/deals/${dealId}/affidavit`, sworn, e.tok); await api('POST', `/deals/${dealId}/affidavit`, sworn, p.tok);
  for (const a of ctx.db.all(`SELECT id FROM affidavits WHERE deal_id=? AND status='uploaded'`, dealId)) await api('POST', `/admin/affidavits/${a.id}/verify`, { approve: true }, await admin());
  await api('GET', `/deals/${dealId}/affidavit/counterparty`, null, e.tok); await api('GET', `/deals/${dealId}/affidavit/counterparty`, null, p.tok);
  await api('POST', `/deals/${dealId}/affidavit/review`, { decision: 'confirmed' }, e.tok);
  await api('POST', `/deals/${dealId}/affidavit/review`, { decision: 'confirmed' }, p.tok);
  assert.equal((await api('GET', `/deals/${dealId}`, null, e.tok)).body.status, 'formalised');
  return out;
}
