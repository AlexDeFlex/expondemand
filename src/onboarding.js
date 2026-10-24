import { config } from './config.js';
import { HttpError, bad, conflict, forbidden, notFound, uid, str, need, cipcValid, saIdValid, hmac, normName, normPhone, json, parse } from './util.js';
import { audit } from './notify.js';
import { getProfession } from './professions.js';
import { bindIdentity } from './identity.js';

/* ---------------- Entrepreneur: business, SDS ---------------- */
export function createBusiness(ctx, user, b) {
  const company = str(b.company_name, 'company_name', 2, 120);
  const cipc = str(b.cipc_number, 'cipc_number', 5, 20);
  need(cipcValid(cipc), 'CIPC number format is YYYY/NNNNNN/NN, e.g. 2019/123456/07', 'bad_cipc');
  const dirId = String(b.director_id || '');
  need(saIdValid(dirId), 'Director ID number is not a valid South African ID', 'bad_director_id');
  if (listBusinesses(ctx, user.id).length >= config.maxBusinessesPerPerson) throw conflict(`You can register up to ${config.maxBusinessesPerPerson} businesses`, 'too_many_businesses');
  if (ctx.db.get('SELECT id FROM businesses WHERE cipc_number=?', cipc)) throw conflict('That CIPC number is already registered on the platform', 'cipc_taken');
  bindIdentity(ctx, user.id, dirId);   // several businesses are fine, but only for the same person's ID
  const id = uid(), now = ctx.clock.now();
  // POPIA data minimisation: keep only the last 4 digits plus a keyed hash (to detect reuse). Never the full ID.
  ctx.db.run(`INSERT INTO businesses(id,owner_id,company_name,cipc_number,director_id_last4,director_id_hash,status,created_at,verified_at)
              VALUES(?,?,?,?,?,?,?,?,?)`, id, user.id, company, cipc, dirId.slice(-4), hmac(dirId, config.jwtSecret),
    config.autoVerify ? 'verified' : 'pending', now, config.autoVerify ? now : null);
  audit(ctx, user.id, 'business.created', 'business', id);
  return ctx.db.get('SELECT * FROM businesses WHERE id=?', id);
}

/** Ask the business register whether this company exists. The answer helps staff; it is not blindly trusted. */
export async function runRegistryCheck(ctx, biz) {
  if (ctx.registry?.enabled) {
    const r = await ctx.registry.check({ cipc_number: biz.cipc_number, company_name: biz.company_name });
    ctx.db.run('UPDATE businesses SET registry_check=? WHERE id=?', r.status, biz.id);
    audit(ctx, biz.owner_id, 'business.registry_check', 'business', biz.id, { status: r.status, provider: ctx.registry.name });
    if (r.status === 'match' && ctx.registry.autoApprove && biz.status === 'pending') {
      ctx.db.run(`UPDATE businesses SET status='verified', verified_at=? WHERE id=?`, ctx.clock.now(), biz.id);
      ctx.notify.push(biz.owner_id, 'business.verified', { note: 'Matched on the business register' });
    }
  }
  const b = ctx.db.get('SELECT * FROM businesses WHERE id=?', biz.id);
  return { id: b.id, company_name: b.company_name, cipc_number: b.cipc_number, status: b.status, registry_check: b.registry_check };   // never return the stored ID hash
}
export const listBusinesses = (ctx, ownerId) => ctx.db.all('SELECT * FROM businesses WHERE owner_id=? ORDER BY created_at', ownerId);

/** Which of this person's businesses is meant. Optional when they have only one. */
export function pickBusiness(ctx, userId, businessId) {
  const list = listBusinesses(ctx, userId);
  if (businessId) { const b = list.find((x) => x.id === businessId); if (!b) throw forbidden('That business is not yours'); return b; }   // someone else's id is refused outright
  if (!list.length) throw bad('Register your business first', 'no_business');
  if (list.length === 1) return list[0];
  throw bad('Choose which of your businesses this is for', 'business_required');
}
function gateOf(ctx, biz) {
  if (biz.status !== 'verified') return { ok: false, reason: 'CIPC verification is not complete', step: 'cipc', sds_ok: false };
  const sds = ctx.db.get('SELECT * FROM sds WHERE business_id=? ORDER BY signed_at DESC LIMIT 1', biz.id);
  if (!sds || sds.version !== config.sdsVersion || sds.expires_at < ctx.clock.now()) return { ok: false, reason: 'Service Delivery Standards missing or out of date', step: 'sds', sds_ok: false };
  return { ok: true, sds_ok: true };
}
export function businessView(ctx, b) {
  const g = gateOf(ctx, b);
  return { id: b.id, company_name: b.company_name, cipc_number: b.cipc_number, status: b.status, registry_check: b.registry_check, sds_ok: g.sds_ok, can_post: g.ok, blocked_at: g.ok ? null : g.step, reason: g.reason || null };
}

export function signSds(ctx, user, b) {
  const biz = pickBusiness(ctx, user.id, b.business_id);
  need(b.accept === true, 'You must accept the Service Delivery Standards', 'sds_not_accepted');
  const a = b.answers || {};
  const answers = {
    services: str(a.services, 'services', 10, 1000),
    payment_terms: str(a.payment_terms, 'payment_terms', 5, 500),
    dispute_process: str(a.dispute_process, 'dispute_process', 5, 500),
    no_licence_misuse: a.no_licence_misuse === true,
  };
  need(answers.no_licence_misuse, 'You must confirm you will not use a professional’s licence beyond the agreed scope', 'sds_fronting');
  const now = ctx.clock.now(), id = uid();
  ctx.db.run('INSERT INTO sds(id,business_id,version,answers,signed_at,expires_at) VALUES(?,?,?,?,?,?)',
    id, biz.id, config.sdsVersion, json(answers), now, now + config.sdsValidMs);
  audit(ctx, user.id, 'sds.signed', 'business', biz.id, { version: config.sdsVersion });
  return { id, version: config.sdsVersion, expires_at: now + config.sdsValidMs };
}

/** The backend gate, per business. The UI mirrors it, but this is the one that counts. */
export function canPost(ctx, userId, businessId) {
  const list = listBusinesses(ctx, userId);
  if (!list.length) return { ok: false, reason: 'No business registered', step: 'business' };
  const biz = pickBusiness(ctx, userId, businessId);
  const g = gateOf(ctx, biz);
  return g.ok ? { ok: true, business: biz } : { ...g, business: biz };
}

/* ---------------- Professional ---------------- */
export function createProfessional(ctx, user, b) {
  if (ctx.db.get('SELECT user_id FROM professionals WHERE user_id=?', user.id)) throw conflict('Profile already submitted');
  const tier = Number(b.tier);
  need([1, 2, 3].includes(tier), 'Tier must be 1 (registered), 2 (candidate) or 3 (graduate/student)', 'bad_tier');
  const prof = getProfession(b.profession);
  need(prof, 'Pick a profession from the list', 'bad_profession');
  const fullName = str(b.full_name, 'full_name', 3, 100);
  const proof = String(b.proof_sha256 || '');
  need(/^[a-f0-9]{64}$/.test(proof), 'Attach your proof document (send its SHA-256)', 'no_proof');
  let reg = null, inst = null, supervisor = null;
  if (tier === 3) inst = str(b.institution, 'institution', 3, 120);
  else {
    if (tier === 2) need(prof.registered, 'Candidate registration only applies to professions with a statutory body', 'no_candidate_tier');
    if (prof.registered) reg = str(b.reg_number, 'reg_number', 3, 40);
    else reg = b.reg_number ? str(b.reg_number, 'reg_number', 1, 40) : null; // no statutory body: qualification verified by staff
  }
  if (tier === 2) {
    const sup = ctx.db.get(`SELECT u.id FROM users u JOIN professionals p ON p.user_id=u.id WHERE u.phone=? AND p.tier=1 AND p.status='verified'`, normPhone(b.supervisor_phone));
    if (!sup) throw bad('Your supervisor must be a verified Tier 1 professional on the platform', 'bad_supervisor');
    supervisor = sup.id;
  }
  bindIdentity(ctx, user.id, b.id_number);   // the same person as any business registered on this phone number
  ctx.db.run('UPDATE users SET full_name=? WHERE id=?', fullName, user.id);
  ctx.db.run(`INSERT INTO professionals(user_id,tier,profession,body,reg_number,institution,proof_sha256,supervisor_id,status,created_at,verified_at)
              VALUES(?,?,?,?,?,?,?,?,?,?,?)`, user.id, tier, prof.name, prof.body, reg, inst, proof, supervisor,
    config.autoVerify ? 'verified' : 'pending', ctx.clock.now(), config.autoVerify ? ctx.clock.now() : null);
  audit(ctx, user.id, 'professional.submitted', 'professional', user.id, { tier, profession: prof.name });
  return getProfessional(ctx, user.id);
}
export const getProfessional = (ctx, userId) => ctx.db.get('SELECT * FROM professionals WHERE user_id=?', userId);

/* ---------------- Staff review queue ---------------- */
export function reviewQueue(ctx) {
  return {
    businesses: ctx.db.all(`SELECT id,company_name,cipc_number,director_id_last4,registry_check,created_at FROM businesses WHERE status='pending' ORDER BY created_at`),
    professionals: ctx.db.all(`SELECT p.user_id,u.full_name,p.tier,p.profession,p.body,p.reg_number,p.institution,p.created_at
                               FROM professionals p JOIN users u ON u.id=p.user_id WHERE p.status='pending' ORDER BY p.created_at`),
    affidavits: ctx.db.all(`SELECT id,deal_id,party_role,commissioner_name,commissioned_on FROM affidavits WHERE status='uploaded' ORDER BY created_at`),
    bank_accounts: ctx.db.all(`SELECT id,owner_type,owner_id,bank,last4,holder_name FROM bank_accounts WHERE status='manual_review'`),
    disputed_payments: ctx.db.all(`SELECT id,deal_id,amount_cents FROM payments WHERE status='disputed'`),
  };
}
export function reviewBusiness(ctx, admin, id, b) {
  const biz = ctx.db.get('SELECT * FROM businesses WHERE id=?', id);
  if (!biz) throw notFound();
  const approve = b.approve === true;
  ctx.db.run('UPDATE businesses SET status=?, review_note=?, verified_at=? WHERE id=?', approve ? 'verified' : 'rejected', b.note || null, approve ? ctx.clock.now() : null, id);
  ctx.notify.push(biz.owner_id, approve ? 'business.verified' : 'business.rejected', { note: b.note || null });
  audit(ctx, admin.id, approve ? 'business.verified' : 'business.rejected', 'business', id);
  return { id, status: approve ? 'verified' : 'rejected' };
}
export function reviewProfessional(ctx, admin, userId, b) {
  const p = getProfessional(ctx, userId);
  if (!p) throw notFound();
  const approve = b.approve === true;
  ctx.db.run('UPDATE professionals SET status=?, review_note=?, verified_at=? WHERE user_id=?', approve ? 'verified' : 'rejected', b.note || null, approve ? ctx.clock.now() : null, userId);
  ctx.notify.push(userId, approve ? 'professional.verified' : 'professional.rejected', { note: b.note || null });
  audit(ctx, admin.id, approve ? 'professional.verified' : 'professional.rejected', 'professional', userId);
  return { user_id: userId, status: approve ? 'verified' : 'rejected' };
}

/* ---------------- Bank accounts (linked account for entrepreneurs, payout account for professionals) ---------------- */
export async function linkBankAccount(ctx, user, b) {
  const bank = str(b.bank, 'bank', 2, 40), holder = str(b.holder_name, 'holder_name', 3, 120);
  const number = String(b.account_number || '');
  need(/^\d{8,11}$/.test(number), 'Account number must be 8 to 11 digits', 'bad_account');
  let ownerType, ownerId, expectName;
  if (user.role === 'entrepreneur') {
    const biz = pickBusiness(ctx, user.id, b.business_id);
    if (biz.status !== 'verified') throw forbidden('Your business must be verified before you link a bank account');
    ownerType = 'business'; ownerId = biz.id; expectName = biz.company_name;
  } else {
    const p = getProfessional(ctx, user.id);
    if (!p || p.status !== 'verified') throw forbidden('You must be verified before you add a payout account');
    ownerType = 'professional'; ownerId = user.id; expectName = user.full_name;
  }
  const res = await ctx.provider.verifyAccount({ bank, number, holder });
  if (!res.ok) throw bad('The bank could not verify that account', 'account_unverified');
  const match = normName(holder) === normName(expectName);
  const now = ctx.clock.now();
  return ctx.db.tx(() => {
    const prev = ctx.db.get(`SELECT id FROM bank_accounts WHERE owner_type=? AND owner_id=? AND status!='replaced'`, ownerType, ownerId);
    if (prev) ctx.db.run(`UPDATE bank_accounts SET status='replaced' WHERE id=?`, prev.id);
    const id = uid();
    // Changing the account triggers a payout hold: the classic account-takeover cash-out is blocked for 48h.
    ctx.db.run(`INSERT INTO bank_accounts(id,owner_type,owner_id,bank,account_type,last4,token,holder_name,name_match,status,hold_until,created_at)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, id, ownerType, ownerId, bank, b.account_type || null, res.last4, res.token, holder,
      match ? 1 : 0, match ? 'verified' : 'manual_review', prev ? now + config.bankChangeHoldMs : 0, now);
    audit(ctx, user.id, 'bank.linked', 'bank_account', id, { replaced: !!prev, name_match: match });
    return { id, bank, last4: res.last4, status: match ? 'verified' : 'manual_review', hold_until: prev ? now + config.bankChangeHoldMs : null };
  });
}
export const activeAccount = (ctx, ownerType, ownerId) =>
  ctx.db.get(`SELECT * FROM bank_accounts WHERE owner_type=? AND owner_id=? AND status!='replaced'`, ownerType, ownerId);
export function reviewBankAccount(ctx, admin, id, b) {
  const a = ctx.db.get('SELECT * FROM bank_accounts WHERE id=?', id);
  if (!a) throw notFound();
  ctx.db.run('UPDATE bank_accounts SET status=? WHERE id=?', b.approve === true ? 'verified' : 'replaced', id);
  audit(ctx, admin.id, 'bank.reviewed', 'bank_account', id, { approve: b.approve === true });
  return { id, status: b.approve === true ? 'verified' : 'rejected' };
}
